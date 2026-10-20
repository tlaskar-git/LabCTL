import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { html, Modal } from '../ui.js';

// Runner actions: buttons plus one dialog. Every action that supports it offers "Drain first" (default on).
// Force asks for the host name. Remove always asks for it. The server enforces the same rules.
const DRAIN_NOTE = 'Drain first waits for running jobs to finish before the script acts. GitHub has no cordon API, so a new job can still be assigned in the gap. Drain narrows that race and does not close it.';

export const RUNNER_ACTIONS = [
  { id: 'runner_update', label: 'Update', drain: true, text: 'Installs the latest actions/runner release (SHA-256 checked). LabCTL then waits up to 3 minutes for the runner to show online in GitHub and rolls back if it does not.' },
  { id: 'runner_restart', label: 'Restart', drain: true, text: 'Restarts the runner service and waits for it to run.' },
  { id: 'runner_health_check', label: 'Health check', drain: false, text: 'Service, listener process, version, disk and the latest log lines. Changes nothing.' },
  { id: 'runner_cleanup', label: 'Cleanup', drain: true, text: 'Removes old workspaces, _diag logs, temp files, tool cache and update leftovers. Runs only when the runner is idle.' },
  { id: 'runner_reregister', label: 'Re-register', drain: true, text: 'Replaces the registration with a new one, keeping the runner\'s ephemeral mode. LabCTL fetches the registration token from GitHub and never stores it.' },
  { id: 'runner_remove', label: 'Remove', drain: true, danger: true, confirm: true, text: 'Stops the service, unregisters the runner from GitHub and deletes its folder. Admin only.' }
];

const Check = ({ checked, onChange, children }) => html`<label style=${{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '6px 0', cursor: 'pointer' }}>
  <input type="checkbox" checked=${checked} onChange=${e => onChange(e.target.checked)} style=${{ marginTop: 3 }}/><span>${children}</span></label>`;

const Field = ({ label, children }) => html`<div class="form-group" style=${{ marginBottom: 10 }}><label class="form-label">${label}</label>${children}</div>`;

// Shared form for one template run. fields(state, set) returns extra inputs, params(state) returns the template params.
function RunDialog({ title, text, hostId, hostName, runner, template, canDrain, mustConfirm, danger, extra, params, onClose, onDone, addToast, submitLabel }) {
  const [drain, setDrain] = useState(true);
  const [force, setForce] = useState(false);
  const [dry, setDry] = useState(false);
  const [typed, setTyped] = useState('');
  const [state, setState] = useState(extra ? extra.initial : {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = patch => setState(s => ({ ...s, ...patch }));
  const needTyped = mustConfirm || force;

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const p = params ? params(state) : {};
      if (dry) p.DRY_RUN = true;
      const r = await api('/api/runners/action', { method: 'POST', body: { host_id: hostId, runner, template, params: p, drain: canDrain && drain, force: canDrain && force, confirm: needTyped ? typed : undefined } });
      addToast(r.verify ? 'Job started. LabCTL will check the runner in GitHub afterwards' : 'Job started');
      onDone(r);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return html`<${Modal} title=${title} onClose=${busy ? () => {} : onClose}>
    <p class="page-desc" style=${{ marginBottom: 12 }}>${text}</p>
    ${extra ? extra.fields(state, set) : null}
    ${canDrain && html`<${Check} checked=${drain} onChange=${setDrain}>Drain first <span class="page-desc">(wait for running jobs)</span><//>
      <div class="page-desc" style=${{ margin: '0 0 8px 24px' }}>${DRAIN_NOTE}</div>
      <${Check} checked=${force} onChange=${setForce}>Force <span class="page-desc">(continue even if a build is running)</span><//>`}
    ${template !== 'runner_health_check' && html`<${Check} checked=${dry} onChange=${setDry}>Dry run <span class="page-desc">(report only, change nothing)</span><//>`}
    ${needTyped && html`<${Field} label=${`Type ${hostName} to confirm`}>
      <input class="input" value=${typed} onInput=${e => setTyped(e.target.value)} placeholder=${hostName}/><//>`}
    ${error && html`<div style=${{ color: 'var(--red)', margin: '8px 0' }}>${error}</div>`}
    <div class="btn-group" style=${{ marginTop: 14 }}>
      <button class=${`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled=${busy || (needTyped && typed !== hostName)} onClick=${submit}>${busy ? 'Starting' : submitLabel || title}</button>
      <button class="btn" disabled=${busy} onClick=${onClose}>Cancel</button>
    </div>
  <//>`;
}

const reregisterExtra = disableUpdate => ({
  initial: { labels: '', group: '', disable_update: disableUpdate },
  fields: (s, set) => html`<div>
    <${Field} label="Labels, comma separated (empty keeps the defaults)"><input class="input" value=${s.labels} onInput=${e => set({ labels: e.target.value })}/><//>
    <${Field} label="Runner group (organisation runners)"><input class="input" value=${s.group} onInput=${e => set({ group: e.target.value })}/><//>
    <${Check} checked=${s.disable_update} onChange=${v => set({ disable_update: v })}>Turn off GitHub's built-in runner auto-update<//>
  </div>`
});

const restartExtra = {
  initial: { action: 'restart' },
  fields: (s, set) => html`<${Field} label="Action"><select class="select" value=${s.action} onChange=${e => set({ action: e.target.value })}>
    <option value="restart">Restart</option><option value="stop">Stop</option><option value="start">Start</option></select><//>`
};

// Buttons for one runner. runner: name. disableUpdate: the stored per-runner auto-update setting.
export function RunnerActions({ hostId, hostName, runner, disableUpdate, onDone, addToast }) {
  const [open, setOpen] = useState(null);
  const def = RUNNER_ACTIONS.find(a => a.id === open);
  const done = r => { setOpen(null); onDone && onDone(r); };
  const extra = open === 'runner_reregister' ? reregisterExtra(!!disableUpdate) : open === 'runner_restart' ? restartExtra : null;
  const params = open === 'runner_reregister'
    ? s => ({ ...(s.labels.trim() ? { LABELS: s.labels.trim() } : {}), ...(s.group.trim() ? { RUNNER_GROUP: s.group.trim() } : {}), DISABLE_UPDATE: s.disable_update })
    : open === 'runner_restart' ? s => ({ ACTION: s.action }) : null;
  return html`<div class="btn-group" style=${{ gap: 4 }}>
    ${RUNNER_ACTIONS.map(a => html`<button key=${a.id} class=${`btn btn-sm ${a.danger ? 'btn-danger' : ''}`} onClick=${() => setOpen(a.id)}>${a.label}</button>`)}
    ${def && html`<${RunDialog} title=${`${def.label}: ${runner}`} text=${def.text} hostId=${hostId} hostName=${hostName} runner=${runner} template=${def.id}
      canDrain=${def.drain} mustConfirm=${!!def.confirm} danger=${!!def.danger} extra=${extra} params=${params} submitLabel=${def.label}
      onClose=${() => setOpen(null)} onDone=${done} addToast=${addToast}/>`}
  </div>`;
}

// Add a runner to a host: repository or organisation URL, name, labels, group, ephemeral.
export function AddRunnerButton({ hostId, hostName, onDone, addToast, label = 'Add runner' }) {
  const [open, setOpen] = useState(false);
  const extra = {
    initial: { url: '', name: '', labels: '', group: '', ephemeral: false },
    fields: (s, set) => html`<div>
      <${Field} label="Repository or organisation URL"><input class="input" value=${s.url} onInput=${e => set({ url: e.target.value })} placeholder="Address of the repository or organisation page"/><//>
      <${Field} label="Runner name"><input class="input" value=${s.name} onInput=${e => set({ name: e.target.value })}/><//>
      <${Field} label="Labels, comma separated"><input class="input" value=${s.labels} onInput=${e => set({ labels: e.target.value })}/><//>
      <${Field} label="Runner group (organisation runners)"><input class="input" value=${s.group} onInput=${e => set({ group: e.target.value })}/><//>
      <${Check} checked=${s.ephemeral} onChange=${v => set({ ephemeral: v })}>Ephemeral runner<//>
      <div class="page-desc" style=${{ margin: '0 0 8px 24px' }}>An ephemeral runner takes one job and then GitHub removes it. LabCTL registers a fresh, clean runner after each job, so every job starts clean. The trade-off is a slower start and no warm caches. LabCTL needs the host agent online and the GitHub token to do this. Off by default.</div>
    </div>`
  };
  const params = s => ({ URL: s.url.trim(), NAME: s.name.trim(), ...(s.labels.trim() ? { LABELS: s.labels.trim() } : {}), ...(s.group.trim() ? { RUNNER_GROUP: s.group.trim() } : {}), EPHEMERAL: s.ephemeral });
  return html`<span>
    <button class="btn btn-sm" onClick=${() => setOpen(true)}>${label}</button>
    ${open && html`<${RunDialog} title=${`Add a runner to ${hostName}`} text="LabCTL fetches a registration token from GitHub, downloads and verifies the runner, registers it and installs the service." hostId=${hostId} hostName=${hostName}
      runner=${undefined} template="runner_add" canDrain=${false} extra=${extra} params=${params} submitLabel="Add runner"
      onClose=${() => setOpen(false)} onDone=${r => { setOpen(false); onDone && onDone(r); }} addToast=${addToast}/>`}
  </span>`;
}
