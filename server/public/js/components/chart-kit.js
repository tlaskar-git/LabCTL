import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html } from '../ui.js';

// Small display helpers shared by the host tabs and the fleet page: formatters, gauges, key/value grids,
// tables, tone badges and the inventory feed. The classes are defined once here.
const style = document.createElement('style');
style.textContent = `
  .kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px 18px;font-size:12px}
  .kv dt{color:var(--text-dim);margin:0}.kv dd{margin:2px 0 0;color:var(--text-primary);word-break:break-word}
  .bar{background:var(--bg-primary);border-radius:4px;height:6px;overflow:hidden}.bar>div{height:100%;border-radius:4px}
  .kit-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
  .logbox{font-family:'Geist Mono',ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.5;background:var(--bg-input);
    border:1px solid var(--border);border-radius:6px;padding:8px 10px;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-all}
  .logbox .err{color:var(--red);background:var(--red-bg)}.logbox .warn{color:var(--yellow)}
  .tile{display:block;width:100%;font:inherit;text-decoration:none;color:inherit}.tile:hover{border-color:var(--accent)}
  .num{font-variant-numeric:tabular-nums;text-align:right}
`;
document.head.appendChild(style);

export const toneBadge = (tone, text) => html`<span class=${`badge badge-${{ ok: 'completed', bad: 'failed', warn: 'pending' }[tone] || 'cancelled'}`}>${text}</span>`;

export function fmtBytes(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0, x = Number(n);
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(x >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
export const fmtPct = v => (v === null || v === undefined ? '-' : `${Number(v).toFixed(Number(v) >= 100 ? 0 : 1)}%`);
export const fmtDate = iso => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '-');
export function fmtDuration(sec) {
  if (sec === null || sec === undefined) return '-';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
export function fmtAgo(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 90 ? `${s}s ago` : `${fmtDuration(s)} ago`;
}
export const daysSince = iso => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null);
export const arr = v => (Array.isArray(v) ? v : []);
export const lineClass = l => (/\b(error|fail(ed|ure)?|fatal|exception)\b/i.test(l) ? 'err' : /\bwarn(ing)?\b/i.test(l) ? 'warn' : '');

export function Gauge({ label, percent, detail }) {
  const p = percent === null || percent === undefined ? null : Math.max(0, Math.min(100, Number(percent)));
  return html`<div class="metric-card">
    <div class="page-desc">${label}</div>
    <div class="metric-value">${p === null ? '-' : `${p.toFixed(p >= 100 ? 0 : 1)}%`}</div>
    <div class="bar" style=${{ margin: '8px 0 4px' }}><div style=${{ width: `${p || 0}%`, background: p > 85 ? 'var(--red)' : p > 65 ? 'var(--yellow)' : 'var(--accent)' }}/></div>
    <div class="page-desc">${detail || ' '}</div>
  </div>`;
}

export function Section({ title, right, children }) {
  return html`<div class="card"><div class="card-header"><div class="card-title">${title}</div>${right || null}</div>${children}</div>`;
}

// rows: [[label, value], ...]. Rows whose value is undefined are dropped; use null to show a dash.
export function KV({ rows }) {
  return html`<dl class="kv">${rows.filter(r => r[1] !== undefined).map(([k, v]) => html`<div key=${k}><dt>${k}</dt><dd>${v === null || v === '' ? '-' : v}</dd></div>`)}</dl>`;
}

// cols: [{ h, f: row => content, num }]. empty: text shown when there are no rows.
export function DataTable({ cols, rows, empty = 'Nothing to show' }) {
  if (!rows.length) return html`<div class="page-desc">${empty}</div>`;
  return html`<div class="table-wrap"><table>
    <thead><tr>${cols.map(c => html`<th key=${c.h} class=${c.num ? 'num' : ''}>${c.h}</th>`)}</tr></thead>
    <tbody>${rows.map((r, i) => html`<tr key=${i}>${cols.map(c => html`<td key=${c.h} class=${c.num ? 'num' : ''}>${c.f(r)}</td>`)}</tr>`)}</tbody>
  </table></div>`;
}

export function LogBox({ lines }) {
  return html`<div class="logbox">${lines.length ? lines.map((l, i) => html`<div key=${i} class=${lineClass(l)}>${l}</div>`) : 'No lines'}</div>`;
}

// Latest inventory for a host, refreshed every 15 s. data is null until the agent has sent one.
export function useInventory(hostId) {
  const [state, setState] = useState({ loading: true, data: null, at: null, error: '' });
  useEffect(() => {
    let live = true;
    const load = () => api(`/api/hosts/${encodeURIComponent(hostId)}/inventory`)
      .then(r => live && setState({ loading: false, data: r.data, at: r.at, error: '' }), e => live && setState(s => ({ ...s, loading: false, error: e.message })));
    load();
    const t = setInterval(load, 15000);
    return () => { live = false; clearInterval(t); };
  }, [hostId]);
  return state;
}

// Wraps a tab: shows loading, error or the "no inventory yet" notice, else calls children(inv).
export function InventoryGate({ hostId, children }) {
  const s = useInventory(hostId);
  if (s.loading) return html`<div class="page-desc">Loading</div>`;
  if (s.error) return html`<div class="card">${s.error}</div>`;
  if (!s.data) return html`<div class="card empty-state"><div class="empty-state-title">No inventory yet</div>
    <div class="empty-state-desc">The agent sends a full inventory every 5 minutes after it connects.</div></div>`;
  return children(s.data, s.at);
}
