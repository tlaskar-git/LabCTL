import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { html, Modal, Icons } from '../ui.js';
import { DeployLog } from './deploy-log.js';

const field = (label, input) => html`<div class="form-group"><label class="form-label">${label}</label>${input}</div>`;

// User and secret fields for a redeploy or an offline uninstall. A saved credential makes them optional.
function Creds({ f, set, saved, isAdmin, offerSave }) {
  const text = (k, extra = {}) => ({ class: 'input', value: f[k], onInput: e => set(k, e.target.value), ...extra });
  return html`<div>
    ${saved && html`<div class="page-desc" style=${{ marginBottom: 8 }}>A saved credential exists for this host. Leave these fields empty to use it.</div>`}
    <div class="form-row">
      ${field('User', html`<input ...${text('user')}/>`)}
      ${field('Password', html`<input ...${text('password', { type: 'password', autocomplete: 'new-password' })}/>`)}
    </div>
    ${field('Private key (instead of a password)', html`<textarea class="textarea" rows="3" value=${f.private_key} onInput=${e => set('private_key', e.target.value)}/>`)}
    ${field('sudo password (Linux and Mac, blank: same as the password)', html`<input ...${text('sudo_password', { type: 'password', autocomplete: 'new-password' })}/>`)}
    ${offerSave && isAdmin && html`<label class="checkbox-row"><input type="checkbox" checked=${f.save_credential} onChange=${e => set('save_credential', e.target.checked)}/> Save credential (sealed)</label>`}
  </div>`;
}
const authOf = f => ({ ...(f.user ? { user: f.user } : {}), ...(f.password ? { password: f.password } : {}), ...(f.private_key ? { private_key: f.private_key } : {}),
  ...(f.sudo_password ? { sudo_password: f.sudo_password } : {}) });
const blank = { user: '', password: '', private_key: '', sudo_password: '', save_credential: false, also_remove: false, confirm: '' };

// Re-runs the install on a host. The host keeps its id.
export function RedeployDialog({ host, isAdmin, addToast, onClose, onDone }) {
  const dd = host.data?.deploy || {};
  const [f, setF] = useState(blank);
  const [deployId, setDeployId] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const go = async () => {
    setBusy(true); setError('');
    try { setDeployId((await api(`/api/hosts/${encodeURIComponent(host.id)}/redeploy`, { method: 'POST', body: { auth: authOf(f), save_credential: f.save_credential } })).deploy_id); }
    catch (e) { setError(e.message); setBusy(false); }
  };
  return html`<${Modal} title=${`Redeploy agent on ${host.hostname || host.id}`} onClose=${deployId && !result ? () => {} : onClose}>
    ${!deployId && html`<div>
      <div class="page-desc" style=${{ marginBottom: 12 }}>Reinstalls the agent over the network${dd.address ? ` on ${dd.address}` : ''}. The host keeps its id and history. A new deploy token is made for it.</div>
      <${Creds} f=${f} set=${set} saved=${!!dd.credential_id} isAdmin=${isAdmin} offerSave=${true}/>
      ${error && html`<div style=${{ color: 'var(--red)', fontSize: 13 }}>${error}</div>`}
      <div class="btn-group" style=${{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button class="btn" onClick=${onClose}>Cancel</button>
        <button class="btn btn-primary" onClick=${go} disabled=${busy || (!dd.credential_id && !f.user)}>${busy ? 'Starting...' : 'Redeploy'}</button>
      </div>
    </div>`}
    ${deployId && html`<${DeployLog} deployId=${deployId} onDone=${d => { setResult(d); addToast(d.state === 'done' ? 'Agent redeployed' : `Redeploy failed: ${d.error}`, d.state === 'done' ? 'success' : 'error'); }}/>`}
    ${result && html`<div class="btn-group" style=${{ justifyContent: 'flex-end', marginTop: 12 }}><button class="btn btn-primary" onClick=${() => { onDone?.(); onClose(); }}>Close</button></div>`}
  <//>`;
}

// Removes the agent. The host record stays unless "also remove" is ticked. Offline agents are uninstalled over the network.
export function RemoveAgentDialog({ host, addToast, onClose, onDone }) {
  const dd = host.data?.deploy || {};
  const name = host.hostname || host.id;
  const [f, setF] = useState(blank);
  const [deployId, setDeployId] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const offline = !host.online;
  const go = async () => {
    setBusy(true); setError('');
    try {
      const r = await api(`/api/hosts/${encodeURIComponent(host.id)}/remove-agent`, { method: 'POST',
        body: { confirm: f.confirm, also_remove: f.also_remove, ...(offline && Object.keys(authOf(f)).length ? { auth: authOf(f) } : {}) } });
      if (r.deploy_id) return setDeployId(r.deploy_id);
      addToast(r.removed ? 'Agent uninstalled and host removed' : r.uninstall === 'confirmed' ? 'Agent uninstalled' : 'The agent did not confirm within 30 seconds', r.uninstall === 'confirmed' ? 'success' : 'error');
      onDone?.(); onClose();
    } catch (e) { setError(e.message); setBusy(false); }
  };
  return html`<${Modal} title=${`Remove agent from ${name}`} onClose=${deployId && !result ? () => {} : onClose}>
    ${!deployId && html`<div>
      <div class="page-desc" style=${{ marginBottom: 12 }}>${offline
        ? 'The agent is offline. LabCTL uninstalls it over the network with the saved credential, or the one you enter below.'
        : 'LabCTL tells the agent to uninstall itself and waits up to 30 seconds. The host record stays in LabCTL.'}</div>
      ${offline && html`<${Creds} f=${f} set=${set} saved=${!!dd.credential_id} isAdmin=${false} offerSave=${false}/>`}
      <label class="checkbox-row"><input type="checkbox" checked=${f.also_remove} onChange=${e => set('also_remove', e.target.checked)}/> Also remove the host record and block the host</label>
      <div class="form-group" style=${{ margin: '12px 0' }}>
        <label class="form-label">Type <code>${name}</code> to confirm</label>
        <input class="input" value=${f.confirm} onInput=${e => set('confirm', e.target.value)} placeholder=${name}/>
      </div>
      ${error && html`<div style=${{ color: 'var(--red)', fontSize: 13, marginBottom: 8 }}>${error}</div>`}
      <div class="btn-group" style=${{ justifyContent: 'flex-end' }}>
        <button class="btn" onClick=${onClose} disabled=${busy}>Cancel</button>
        <button class="btn btn-danger" onClick=${go} disabled=${busy || f.confirm !== name}>${busy ? 'Working...' : 'Remove agent'}</button>
      </div>
    </div>`}
    ${deployId && html`<${DeployLog} deployId=${deployId} onDone=${d => { setResult(d); addToast(d.state === 'done' ? 'Agent uninstalled' : `Uninstall failed: ${d.error}`, d.state === 'done' ? 'success' : 'error'); }}/>`}
    ${result && html`<div class="btn-group" style=${{ justifyContent: 'flex-end', marginTop: 12 }}><button class="btn btn-primary" onClick=${() => { onDone?.(); onClose(); }}>Close</button></div>`}
  <//>`;
}

// Two buttons for a host row or settings panel. Admin only, agent hosts only.
//   import { DeployActions } from '../components/deploy-actions.js';
//   <${DeployActions} host=${h} isAdmin=${isAdmin} addToast=${addToast} onDone=${refresh}/>
export function DeployActions({ host, isAdmin, addToast, onDone }) {
  const [open, setOpen] = useState(null);
  if (!isAdmin || host.kind === 'ssh') return null;
  return html`<span>
    <button class="btn btn-sm" title="Reinstall the agent over the network" onClick=${() => setOpen('redeploy')}><${Icons.RefreshCw}/> Redeploy</button>
    <button class="btn btn-sm btn-danger" title="Uninstall the agent, keep the host" onClick=${() => setOpen('remove')}><${Icons.Power}/> Remove agent</button>
    ${open === 'redeploy' && html`<${RedeployDialog} host=${host} isAdmin=${isAdmin} addToast=${addToast} onClose=${() => setOpen(null)} onDone=${onDone}/>`}
    ${open === 'remove' && html`<${RemoveAgentDialog} host=${host} addToast=${addToast} onClose=${() => setOpen(null)} onDone=${onDone}/>`}
  </span>`;
}
