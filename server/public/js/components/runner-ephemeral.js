import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { html } from '../ui.js';
import { toneBadge, fmtDate, arr } from './chart-kit.js';

// Ephemeral mode for one runner (CI runners tab column). The server replaces the runner after each job, see src/ephemeral.js.
export const EPHEMERAL_TIP = 'Ephemeral mode: GitHub removes the runner after one job and LabCTL registers a fresh, clean one (empty _work and _temp). Every job starts clean. The trade-off is a slower start and no warm caches (tool cache, dependency cache, Docker layers on the runner).';

// entry: merged runner entry from /api/hosts/:id/runners (may be undefined). ctl: { hostId, onChange, addToast }.
export function EphemeralCell({ entry, runner, ctl }) {
  const [busy, setBusy] = useState(false);
  if (!entry) return '-';
  const e = entry.ephemeral || {};
  const fail = err => ctl.addToast(err.message || 'Request failed');
  const toggle = async on => {
    setBusy(true);
    try {
      const r = await api('/api/runners/ephemeral', { method: 'PUT', body: { host_id: ctl.hostId, runner, ephemeral: on } });
      ctl.addToast(r.applied ? `Ephemeral mode ${on ? 'on' : 'off'}. The runner is being re-registered` : `Ephemeral mode ${on ? 'on' : 'off'}. Not applied yet: ${r.reason || 're-register the runner'}`);
      ctl.onChange && ctl.onChange();
    } catch (err) { fail(err); } finally { setBusy(false); }
  };
  const reset = async () => {
    try { await api('/api/runners/ephemeral/reset', { method: 'POST', body: { host_id: ctl.hostId, runner } }); ctl.onChange && ctl.onChange(); } catch (err) { fail(err); }
  };
  const events = arr(e.events).slice(-5).reverse();
  return html`<div data-slot="ephemeral">
    <label title=${EPHEMERAL_TIP} style=${{ display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
      <input type="checkbox" checked=${!!e.enabled} disabled=${busy} onChange=${ev => toggle(ev.target.checked)}/>
      <span>${e.enabled ? toneBadge('ok', 'ephemeral') : 'Off'}</span>
    </label>
    ${e.stuck && html`<div><span class="badge badge-failed" title=${e.last_error || ''}>Replacement stuck</span>
      <button class="btn btn-sm" style=${{ marginLeft: 4 }} onClick=${reset}>Retry</button></div>`}
    ${e.enabled && html`<div class="page-desc">Last replaced: ${e.last_replaced_at ? fmtDate(e.last_replaced_at) : 'never'}</div>`}
    ${events.length > 0 && html`<details><summary class="page-desc">Replacements (${events.length})</summary>
      ${events.map(v => html`<div class="page-desc" title=${v.detail || ''}>${fmtDate(v.at)}: ${v.ok ? 'done' : 'failed'}, ${v.reason}</div>`)}</details>`}
  </div>`;
}
