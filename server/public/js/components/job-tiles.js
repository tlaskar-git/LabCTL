import { html } from '../ui.js';

// Host tiles and the aggregate progress bar for a job group summary (GET /api/job-groups/:id).
const COLOUR = { completed: 'var(--green)', success: 'var(--green)', failed: 'var(--red)', cancelled: 'var(--text-dim)',
  running: 'var(--accent)', sent: 'var(--yellow)', pending: 'var(--yellow)', waiting: 'var(--purple)' };

export function fmtDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '-';
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
const elapsed = (h, now) => (h.duration_ms ?? (h.started_at ? (h.completed_at ? new Date(h.completed_at) : now) - new Date(h.started_at) : null));

export function GroupProgress({ sum }) {
  const total = sum.total || 1;
  const seg = (keys, colour) => ({ width: `${100 * keys.reduce((n, k) => n + (sum.counts[k] || 0), 0) / total}%`, background: colour });
  return html`<div>
    <div style=${{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', background: 'var(--bg-input)', border: '1px solid var(--border)' }}
      role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${sum.progress}>
      <div style=${seg(['completed'], 'var(--green)')}/>
      <div style=${seg(['failed', 'cancelled'], 'var(--red)')}/>
      <div style=${seg(['running'], 'var(--accent)')}/>
    </div>
    <div style=${{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
      ${sum.done} of ${sum.total} done (${sum.progress}%)
      ${Object.entries(sum.counts).map(([k, n]) => html` · ${n} ${k}`)}
    </div>
  </div>`;
}

export function JobTiles({ sum, now, onPick }) {
  return html`<div style=${{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 8 }}>
    ${sum.hosts.map(h => html`<button key=${h.job_id} class="host-tile" onClick=${() => onPick(h.job_id)} title=${`Open the log of ${h.hostname}`}
      style=${{ textAlign: 'left', cursor: 'pointer', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', borderLeft: `4px solid ${COLOUR[h.status] || 'var(--text-dim)'}`,
        background: 'var(--bg-card)', color: 'var(--text-primary)', minWidth: 0 }}>
      <div style=${{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 13, fontWeight: 600 }}>
        <span style=${{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${h.hostname}</span>
        <span style=${{ color: COLOUR[h.status], fontSize: 11, fontWeight: 400 }}>${h.status}</span>
      </div>
      <div style=${{ fontFamily: 'Geist Mono, monospace', fontSize: 11, color: 'var(--text-dim)', height: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: '4px 0' }}>
        ${h.last_line || ' '}
      </div>
      <div style=${{ fontSize: 11, color: 'var(--text-secondary)' }}>
        ${fmtDuration(elapsed(h, now))}${h.exit_code !== null && h.exit_code !== undefined ? ` · exit ${h.exit_code}` : ''}
      </div>
    </button>`)}
  </div>`;
}
