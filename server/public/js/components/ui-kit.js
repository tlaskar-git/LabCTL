import { useState } from 'preact/hooks';
import { html, Icons } from '../ui.js';
import { hostName, OsIcon } from './host-name.js';

export { hostName, OsIcon };
// Display name for a host id from the shared hosts list (display name, else hostname), else the fallback.
export const nameFor = (hosts, id, fallback) => { const h = (hosts || []).find(x => x.id === id); return h ? hostName(h) : (fallback || id || ''); };
export const hostFor = (hosts, id) => (hosts || []).find(x => x.id === id) || null;

// Shared display pieces for the pages: stat tiles, chips, gauges, sparklines, skeletons, empty states, section headers,
// segmented tabs and copy buttons. Styles live in css/components.css under "UI kit".

const svg = paths => () => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
export const KitIcons = {
  Check: svg(html`<polyline points="20 6 9 17 4 12"/>`),
  Alert: svg(html`<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`),
  Copy: svg(html`<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`),
  Plus: svg(html`<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`),
  Chevron: svg(html`<polyline points="9 18 15 12 9 6"/>`),
  Branch: svg(html`<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>`),
  Package: svg(html`<path d="M16.5 9.4 7.5 4.2"/><path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7z"/><polyline points="3.3 7 12 12 20.7 7"/><line x1="12" y1="22" x2="12" y2="12"/>`),
  Filter: svg(html`<polygon points="22 3 2 3 10 12.5 10 19 14 21 14 12.5 22 3"/>`),
  Loader: svg(html`<path d="M21 12a9 9 0 1 1-6.2-8.6"/>`),
};

// Status words used across the API, mapped to one of five tones.
const TONES = {
  ok: ['ok', 'online', 'completed', 'success', 'succeeded', 'done', 'updated', 'active', 'clear'],
  bad: ['bad', 'failed', 'offline', 'error', 'critical', 'timeout', 'send_failed', 'revoked'],
  warn: ['warn', 'warning', 'pending', 'sent', 'waiting', 'skipped_offline', 'silenced', 'rate_limited', 'github_unreachable', 'rolled_back'],
  info: ['info', 'running'],
};
export const toneOf = s => Object.keys(TONES).find(t => TONES[t].includes(String(s || '').toLowerCase())) || 'muted';

export function Chip({ tone, status, dot = false, title, children }) {
  const t = tone || toneOf(status);
  return html`<span class=${`chip chip-${t}${dot ? ' chip-dot' : ''}`} title=${title}>${children ?? status}</span>`;
}

// Relative time in plain words. Future times read "in 5 min".
export function relTime(iso, now = Date.now()) {
  if (!iso) return 'never';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return '-';
  const s = Math.round((now - t) / 1000), a = Math.abs(s);
  const txt = a < 45 ? 'just now' : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${Math.round(a / 3600)} h` : a < 86400 * 30 ? `${Math.round(a / 86400)} d` : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  if (a < 45 || a >= 86400 * 30) return txt;
  return s >= 0 ? `${txt} ago` : `in ${txt}`;
}
export const absTime = iso => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '');
export const clockTime = iso => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
// A heading for a day bucket: Today, Yesterday or the date.
export function dayLabel(iso, now = new Date()) {
  const d = new Date(iso);
  const key = x => x.toDateString();
  if (key(d) === key(now)) return 'Today';
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (key(d) === key(y)) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
// rows -> [[label, rows], ...] in input order.
export function groupByDay(rows, field) {
  const out = [];
  for (const r of rows) {
    const label = dayLabel(r[field]);
    if (!out.length || out[out.length - 1][0] !== label) out.push([label, []]);
    out[out.length - 1][1].push(r);
  }
  return out;
}

// A summary tile. With href it is a link, with onClick a toggle button, else static.
export function StatCard({ icon = 'Activity', label, value, tone = '', hint, href, onClick, pressed, spark }) {
  const Icon = Icons[icon] || KitIcons[icon] || Icons.Activity;
  const body = html`<span class="stat-head"><span class="stat-icon"><${Icon}/></span>${label}</span>
    <span class="stat-num">${value ?? '-'}</span>
    ${spark ? html`<${Sparkline} values=${spark} label=${label}/>` : null}
    ${hint ? html`<span class="stat-hint">${hint}</span>` : null}`;
  const cls = `stat${tone ? ` tone-${tone}` : ''}`;
  if (href) return html`<a class=${cls} href=${href}>${body}</a>`;
  if (onClick) return html`<button type="button" class=${cls} aria-pressed=${pressed ? 'true' : 'false'} onClick=${onClick}>${body}</button>`;
  return html`<div class=${cls}>${body}</div>`;
}

// A small ring gauge, 0 to 100. null shows a dash.
export function Gauge({ value, label, size = 56 }) {
  const has = value !== null && value !== undefined && Number.isFinite(Number(value));
  const p = has ? Math.max(0, Math.min(100, Number(value))) : 0;
  const tone = !has ? 'muted' : p >= 90 ? 'bad' : p >= 75 ? 'warn' : 'ok';
  return html`<div class=${`kgauge kgauge-${tone}`} role="img" aria-label=${`${label} ${has ? `${Math.round(p)}%` : 'not reported'}`} style=${{ '--size': `${size}px` }}>
    <svg viewBox="0 0 36 36" aria-hidden="true">
      <circle class="kgauge-track" cx="18" cy="18" r="15.9155" fill="none" stroke-width="3.5"/>
      ${has && html`<circle class="kgauge-fill" cx="18" cy="18" r="15.9155" fill="none" stroke-width="3.5" stroke-linecap="round"
        stroke-dasharray=${`${p} 100`} transform="rotate(-90 18 18)"/>`}
      <text x="18" y="21" text-anchor="middle" class="kgauge-text">${has ? Math.round(p) : '-'}</text>
    </svg>
    <span class="kgauge-label">${label}</span>
  </div>`;
}

// A trend line in plain SVG. values: numbers or null; max defaults to the largest value.
export function Sparkline({ values = [], max, label = 'Trend' }) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v !== null && v !== undefined && Number.isFinite(Number(v)));
  if (pts.length < 2) return html`<span class="spark spark-empty" aria-hidden="true"/>`;
  const top = max ?? Math.max(1, ...pts.map(([, v]) => Number(v)));
  const n = Math.max(1, values.length - 1);
  const line = pts.map(([i, v]) => `${(i / n) * 100},${30 - (Math.min(Number(v), top) / top) * 28}`).join(' ');
  const last = Number(pts[pts.length - 1][1]);
  return html`<svg class="spark" viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label=${`${label} trend, latest ${Math.round(last)}`}>
    <polygon class="spark-area" points=${`${(pts[0][0] / n) * 100},32 ${line} ${(pts[pts.length - 1][0] / n) * 100},32`}/>
    <polyline class="spark-line" points=${line} vector-effect="non-scaling-stroke"/>
  </svg>`;
}

export function Skeleton({ rows = 3, tiles = 0 }) {
  return html`<div aria-busy="true" aria-label="Loading">
    ${tiles > 0 && html`<div class="stat-grid">${Array.from({ length: tiles }, (_, i) => html`<div key=${i} class="skel skel-tile"/>`)}</div>`}
    ${Array.from({ length: rows }, (_, i) => html`<div key=${i} class="skel skel-row"/>`)}
  </div>`;
}

export function EmptyState({ icon = 'Box', title, text, action }) {
  const Icon = Icons[icon] || KitIcons[icon] || Icons.Box;
  return html`<div class="empty">
    <span class="empty-icon"><${Icon}/></span>
    <div class="empty-title">${title}</div>
    ${text && html`<div class="empty-text">${text}</div>`}
    ${action || null}
  </div>`;
}

export function SectionHeader({ title, count, right, id }) {
  return html`<div class="section-head">
    <h2 id=${id}>${title}${count !== undefined && count !== null ? html` <span class="section-count">${count}</span>` : null}</h2>
    ${right || null}
  </div>`;
}

// Segmented control used as tabs. options: [[value, label, count?], ...]. Arrow keys move between options.
export function Segmented({ value, onChange, options, label }) {
  const keys = e => {
    const i = options.findIndex(o => o[0] === value);
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = options[(i + d + options.length) % options.length][0];
    onChange(next);
    e.currentTarget.querySelector(`[data-v="${CSS.escape(String(next))}"]`)?.focus();
  };
  return html`<div class="seg" role="tablist" aria-label=${label} onKeyDown=${keys}>
    ${options.map(([v, l, n]) => html`<button key=${v} type="button" role="tab" data-v=${v} aria-selected=${v === value ? 'true' : 'false'}
      tabindex=${v === value ? 0 : -1} onClick=${() => onChange(v)}>${l}${n !== undefined ? html`<span class="n">${n}</span>` : null}</button>`)}
  </div>`;
}

export function CopyButton({ text, addToast = () => {}, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); addToast('Copied', 'success'); }
    catch { addToast('Copy failed. Select the text and copy it.', 'error'); }
  };
  return html`<button type="button" class="btn btn-sm" onClick=${copy} aria-label=${`${label}: ${done ? 'copied' : 'copy to clipboard'}`}>
    ${done ? html`<${KitIcons.Check}/>` : html`<${KitIcons.Copy}/>`} ${done ? 'Copied' : label}</button>`;
}

export function CopyField({ text, addToast }) {
  return html`<div class="copy-block"><code>${text}</code><${CopyButton} text=${text} addToast=${addToast}/></div>`;
}
