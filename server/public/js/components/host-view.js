import { html } from '../ui.js';
import { fmtBytes, fmtDuration, fmtAgo } from './chart-kit.js';

// Display helpers for host.view (built by server/src/host-view.js). A value the agent did not send renders as '-'
// with a hover hint, never as a guess.
export const NOT_REPORTED = 'not reported by this agent';
export const has = v => v !== null && v !== undefined;
export const Dash = () => html`<span title=${NOT_REPORTED} style=${{ color: 'var(--text-dim)', cursor: 'help' }}>-</span>`;
export const orDash = v => (has(v) && v !== '' ? v : html`<${Dash}/>`);

const tone = p => (p > 85 ? 'var(--red)' : p > 65 ? 'var(--yellow)' : 'var(--accent)');
const clamp = p => Math.max(0, Math.min(100, Number(p)));
const round = p => (p >= 10 ? Math.round(p) : Math.round(p * 10) / 10);

export function Bar({ percent, height = 6 }) {
  if (!has(percent)) return null;
  return html`<div role="meter" aria-valuenow=${round(percent)} aria-valuemin="0" aria-valuemax="100"
    style=${{ background: 'var(--bg-primary)', borderRadius: 4, height, width: '100%', overflow: 'hidden' }}>
    <div style=${{ width: `${clamp(percent)}%`, height: '100%', borderRadius: 4, background: tone(percent) }}/>
  </div>`;
}

// Compact bar plus percent for table cells.
export function MiniBar({ percent, title }) {
  if (!has(percent)) return html`<${Dash}/>`;
  return html`<div title=${title || ''} style=${{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 90 }}>
    <div style=${{ flex: 1, minWidth: 40 }}><${Bar} percent=${percent} height=${5}/></div>
    <span class="mono" style=${{ fontSize: 11, minWidth: 36, textAlign: 'right' }}>${round(percent)}%</span>
  </div>`;
}

export const usedOf = (used, total) => (has(used) && has(total) ? `${fmtBytes(used)} of ${fmtBytes(total)}` : has(total) ? `${fmtBytes(total)} total` : null);
export const uptimeText = s => (has(s) ? fmtDuration(s) : null);
export const loadText = l => (Array.isArray(l) && l.some(has) ? l.map(x => (has(x) ? x.toFixed(2) : '-')).join(' ') : null);
export const osText = v => [v.os_name, v.os_version].filter(Boolean).join(' ') || null;

// "Seen 20s ago" when online, "Last reported 3h 2m ago" when the data is from an offline host.
export function seenText(v, online) {
  const at = v.heartbeat_at || v.last_seen;
  if (!at) return null;
  return `${online ? 'Seen' : 'Last reported'} ${fmtAgo(at)}`;
}
