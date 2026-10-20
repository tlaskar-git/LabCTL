import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { api } from '../api.js';
import { html } from '../ui.js';

// Time-series charts on the local uPlot build (vendor/uplot). No CDN. Colours come from the theme variables, and a
// chart is rebuilt when the theme changes. Timestamps are seconds, as the metrics API returns them.
//   <${RangeBar} value=${range} onChange=${setRange}/>
//   <${MetricChart} hostId=${id} range=${range} title="CPU" unit="%" max=${100} series=${[{ key: 'cpu', label: 'CPU' }]}/>
//   <${Chart} data=${{ ts: [...], series: [{ label, values, color? }] }} unit="%" max=${100}/>   (data must be stable between renders)
export const RANGES = ['1h', '24h', '7d', '30d'];
const COLOURS = ['--accent', '--green', '--yellow', '--orange', '--purple', '--red'];

const asset = name => new URL(`../../vendor/uplot/${name}`, import.meta.url).href;
let loading = null;
function loadUplot() {
  if (globalThis.uPlot) return Promise.resolve(globalThis.uPlot);
  loading ||= new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = asset('uPlot.min.css');
    document.head.appendChild(css);
    const style = document.createElement('style');
    style.textContent = `
      .chart-box{position:relative;width:100%}
      .chart-box .u-wrap{max-width:100%}
      .chart-tip{position:absolute;z-index:5;pointer-events:none;display:none;padding:6px 8px;border-radius:6px;font-size:11px;line-height:1.5;
        background:var(--bg-secondary);border:1px solid var(--border);color:var(--text-primary);box-shadow:0 2px 8px rgba(0,0,0,.3);white-space:nowrap}
      .chart-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:11px;color:var(--text-secondary);margin:2px 0 6px}
      .chart-legend i{display:inline-block;width:10px;height:3px;border-radius:2px;margin-right:5px;vertical-align:middle}
      .chart-empty{display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:12px;border:1px dashed var(--border);border-radius:8px}
      .u-legend{display:none}`;
    document.head.appendChild(style);
    const js = document.createElement('script');
    js.src = asset('uPlot.iife.min.js');
    js.onload = () => resolve(globalThis.uPlot);
    js.onerror = () => { loading = null; reject(new Error('Could not load the chart library')); };
    document.head.appendChild(js);
  });
  return loading;
}

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function useTheme() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const mo = new MutationObserver(() => setN(x => x + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return n;
}

export function fmtValue(v, unit) {
  if (v === null || v === undefined) return '-';
  if (unit === 'B/s') {
    const u = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let i = 0, x = v;
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    return `${x.toFixed(x >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
  }
  return `${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)}${unit || ''}`;
}

export function Chart({ data, unit = '', max, height = 170 }) {
  const box = useRef(null);
  const [ready, setReady] = useState(!!globalThis.uPlot);
  const [error, setError] = useState('');
  const theme = useTheme();
  useEffect(() => { loadUplot().then(() => setReady(true), e => setError(e.message)); }, []);

  useEffect(() => {
    if (!ready || !data?.ts?.length || !box.current) return undefined;
    const el = box.current;
    const text = cssVar('--text-secondary');
    const grid = cssVar('--border');
    const series = data.series.map((s, i) => ({ ...s, color: s.color || cssVar(COLOURS[i % COLOURS.length]) }));
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    el.appendChild(tip);
    const axis = (extra = {}) => ({ stroke: text, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 }, font: '11px sans-serif', ...extra });
    const plot = new globalThis.uPlot({
      width: Math.max(200, el.clientWidth), height,
      legend: { show: false },
      cursor: { drag: { x: false, y: false }, points: { size: 6 } },
      scales: { y: { range: (u, lo, hi) => [Math.min(0, lo ?? 0), max ?? Math.max(1, (hi ?? 1) * 1.1)] } },
      axes: [axis(), axis({ size: 56, values: (u, ticks) => ticks.map(t => fmtValue(t, unit)) })],
      series: [{}, ...series.map(s => ({ label: s.label, stroke: s.color, width: 1.6, spanGaps: true, points: { show: false },
        fill: series.length === 1 ? `${s.color}22` : undefined }))],
      hooks: { setCursor: [u => {
        const i = u.cursor.idx;
        if (i == null || u.cursor.left < 0) { tip.style.display = 'none'; return; }
        const when = new Date(data.ts[i] * 1000).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'medium' });
        tip.replaceChildren(Object.assign(document.createElement('div'), { textContent: when }),
          ...series.map(s => Object.assign(document.createElement('div'), { textContent: `${s.label}: ${fmtValue(s.values[i], unit)}` })));
        tip.style.display = 'block';
        const x = u.cursor.left + u.over.offsetLeft;
        tip.style.left = `${x + 12 + tip.offsetWidth > el.clientWidth ? x - tip.offsetWidth - 12 : x + 12}px`;
        tip.style.top = `${u.cursor.top + u.over.offsetTop}px`;
      }] }
    }, [data.ts, ...series.map(s => s.values)], el);
    const ro = new ResizeObserver(() => plot.setSize({ width: Math.max(200, el.clientWidth), height }));
    ro.observe(el);
    return () => { ro.disconnect(); plot.destroy(); tip.remove(); };
  }, [ready, data, unit, max, height, theme]);

  if (error) return html`<div class="chart-empty" style=${{ height }}>${error}</div>`;
  if (!data?.ts?.length) return html`<div class="chart-empty" style=${{ height }}>No data for this range yet</div>`;
  return html`<div>
    ${data.series.length > 1 && html`<div class="chart-legend">${data.series.map((s, i) =>
      html`<span key=${s.label}><i style=${{ background: s.color || `var(${COLOURS[i % COLOURS.length]})` }}/>${s.label}</span>`)}</div>`}
    <div class="chart-box" ref=${box}/>
  </div>`;
}

export function RangeBar({ value, onChange }) {
  return html`<div class="btn-group" role="group" aria-label="Time range">
    ${RANGES.map(r => html`<button key=${r} class=${`btn btn-sm ${r === value ? 'btn-primary' : ''}`} onClick=${() => onChange(r)}>${r}</button>`)}
  </div>`;
}

// Fetches /api/hosts/:id/metrics for the given series and draws them. Refreshes every 30 s.
export function MetricChart({ hostId, range, title, series, unit = '', max, height }) {
  const [res, setRes] = useState(null);
  const [error, setError] = useState('');
  const keys = series.map(s => s.key).join(',');
  useEffect(() => {
    let live = true;
    const load = () => api(`/api/hosts/${encodeURIComponent(hostId)}/metrics?range=${range}&series=${encodeURIComponent(keys)}`)
      .then(r => { if (live) { setRes(r); setError(''); } }, e => live && setError(e.message));
    load();
    const t = setInterval(load, 30000);
    return () => { live = false; clearInterval(t); };
  }, [hostId, range, keys]);
  const data = useMemo(() => res && ({ ts: res.ts, series: series.map(s => ({ label: s.label, color: s.color, values: res.series[s.key] || [] })) }), [res]);
  return html`<div class="card">
    <div class="card-header"><div class="card-title">${title}</div></div>
    ${error ? html`<div class="chart-empty" style=${{ height: height || 170 }}>${error}</div>` : html`<${Chart} data=${data} unit=${unit} max=${max} height=${height}/>`}
  </div>`;
}
