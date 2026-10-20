import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Modal, Icons } from '../ui.js';
import { CredentialPicker } from './credential-picker.js';
import { DeployLog, useDeployClose } from './deploy-log.js';

const field = (label, input) => html`<div class="form-group"><label class="form-label">${label}</label>${input}</div>`;

// User and secret fields for a redeploy or an offline uninstall. A saved credential makes them optional.
function Creds({ f, set, saved, isAdmin, offerSave }) {
  const text = (k, extra = {}) => ({ class: 'input', value: f[k], onInput: e => set(k, e.target.value), ...extra });
  return html`<div>
    <${CredentialPicker} value=${f.credential_id} onChange=${v => set('credential_id', v.credential_id)} allowInline/>
    ${!f.credential_id && html`<div>
    ${saved && html`<div class="page-desc" style=${{ marginBottom: 8 }}>A saved credential exists for this host. Leave these fields empty to use it.</div>`}
    <div class="form-row">
      ${field('User', html`<input ...${text('user')}/>`)}
      ${field('Password', html`<input ...${text('password', { type: 'password', autocomplete: 'new-password' })}/>`)}
    </div>
    ${field('Private key (instead of a password)', html`<textarea class="textarea" rows="3" value=${f.private_key} onInput=${e => set('private_key', e.target.value)}/>`)}
    ${field('sudo password (Linux and Mac, blank: same as the password)', html`<input ...${text('sudo_password', { type: 'password', autocomplete: 'new-password' })}/>`)}
    ${offerSave && isAdmin && html`<label class="checkbox-row"><input type="checkbox" checked=${f.save_credential} onChange=${e => set('save_credential', e.target.checked)}/> Save credential (sealed)</label>`}
    </div>`}
  </div>`;
}
const authOf = f => (f.credential_id ? { credential_id: f.credential_id } : { ...(f.user ? { user: f.user } : {}), ...(f.password ? { password: f.password } : {}), ...(f.private_key ? { private_key: f.private_key } : {}),
  ...(f.sudo_password ? { sudo_password: f.sudo_password } : {}) });
const blank = { credential_id: '', user: '', password: '', private_key: '', sudo_password: '', save_credential: false, also_remove: false, confirm: '',
  address: '', os: 'linux', port: '' };
const ADDRESS = /^(?!-)[A-Za-z0-9._:-]{1,253}$/; // same rule as the server

// Close button under a running deploy, and the one under a finished one.
const closeRow = (result, close, onDone) => html`<div class="btn-group" style=${{ justifyContent: 'flex-end', marginTop: 12 }}>
  <button class=${`btn ${result ? 'btn-primary' : ''}`} onClick=${() => { if (result) onDone?.(); close(); }}>${result ? 'Close' : 'Hide (the deploy goes on)'}</button>
</div>`;

// Re-runs the install on a host. The host keeps its id. Address, OS and port come prefilled from the server and can be changed.
export function RedeployDialog({ host, isAdmin, addToast, onClose, onDone }) {
  const [f, setF] = useState(blank);
  const [saved, setSaved] = useState(!!host.data?.deploy?.credential_id);
  const [deployId, setDeployId] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const close = useDeployClose(!!deployId && !result, onClose, addToast);
  useEffect(() => {
    api(`/api/hosts/${encodeURIComponent(host.id)}/deploy-target`)
      .then(d => { setF(p => ({ ...p, address: d.address || '', os: d.os || 'linux', port: d.port ? String(d.port) : '' })); setSaved(d.has_credential); })
      .catch(e => setError(`Could not read the saved target: ${e.message}`));
  }, [host.id]);
  const addressOk = ADDRESS.test(f.address.trim());
  const portOk = !f.port || (/^\d{1,5}$/.test(f.port) && Number(f.port) >= 1 && Number(f.port) <= 65535);
  const go = async () => {
    setBusy(true); setError('');
    try {
      setDeployId((await api(`/api/hosts/${encodeURIComponent(host.id)}/redeploy`, { method: 'POST',
        body: { address: f.address.trim(), os: f.os, port: f.port ? Number(f.port) : undefined, auth: authOf(f), save_credential: f.save_credential } })).deploy_id);
    } catch (e) { setError(e.message); setBusy(false); }
  };
  return html`<${Modal} title=${`Redeploy agent on ${host.hostname || host.id}`} onClose=${close}>
    ${!deployId && html`<div>
      <div class="page-desc" style=${{ marginBottom: 12 }}>Reinstalls the agent over the network. The host keeps its id and history. A new deploy token is made for it.</div>
      <div class="form-row">
        ${field('Address', html`<input class="input" value=${f.address} placeholder="192.0.2.10 or host.example.test" onInput=${e => set('address', e.target.value)} aria-invalid=${!addressOk}/>`)}
        ${field('Operating system', html`<select class="select" value=${f.os} onChange=${e => set('os', e.target.value)}>
          <option value="linux">Linux</option><option value="mac">Mac</option><option value="windows">Windows</option></select>`)}
        ${field(f.os === 'windows' ? 'Port (blank: try 22, 5986, 5985)' : 'SSH port (blank: 22)', html`<input class="input" inputmode="numeric" value=${f.port} onInput=${e => set('port', e.target.value.trim())} aria-invalid=${!portOk}/>`)}
      </div>
      ${!addressOk && html`<div class="page-desc" style=${{ marginBottom: 8 }}>${f.address ? 'The address can only hold letters, digits, dots, colons, hyphens and underscores.' : 'LabCTL does not know an address for this host. Enter it.'}</div>`}
      <${Creds} f=${f} set=${set} saved=${saved} isAdmin=${isAdmin} offerSave=${true}/>
      ${error && html`<div style=${{ color: 'var(--red)', fontSize: 13 }} role="alert">${error}</div>`}
      <div class="btn-group" style=${{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button class="btn" onClick=${close}>Cancel</button>
        <button class="btn btn-primary" onClick=${go} disabled=${busy || !addressOk || !portOk || (!saved && !f.credential_id && !f.user)}>${busy ? 'Starting...' : 'Redeploy'}</button>
      </div>
    </div>`}
    ${deployId && html`<${DeployLog} deployId=${deployId} onDone=${d => { setResult(d); addToast(d.state === 'done' ? 'Agent redeployed' : `Redeploy failed: ${d.error}`, d.state === 'done' ? 'success' : 'error'); }}/>`}
    ${deployId && closeRow(result, close, onDone)}
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
  const close = useDeployClose(!!deployId && !result, onClose, addToast);
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
  return html`<${Modal} title=${`Remove agent from ${name}`} onClose=${close}>
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
    ${deployId && closeRow(result, close, onDone)}
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
