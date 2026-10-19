import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Modal } from '../ui.js';

const field = (label, input) => html`<div class="form-group"><label class="form-label">${label}</label>${input}</div>`;

// Form for an agentless SSH host. A typed-in credential is kept in server memory unless "Save credential" is ticked (admin).
export function AddSshHost({ onClose, onCreated, addToast, isAdmin }) {
  const [f, setF] = useState({ name: '', address: '', port: 22, os: 'linux', username: '', auth: 'password', password: '',
    private_key: '', passphrase: '', credential_id: '', save_credential: false, provider: '', region: '', plan: '', notes: '' });
  const [creds, setCreds] = useState([]);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const text = (k, extra = {}) => ({ class: 'input', value: f[k], onInput: e => set(k, e.target.value), ...extra });

  useEffect(() => { if (isAdmin) api('/api/credentials').then(setCreds).catch(() => {}); }, []);

  const submit = async () => {
    setBusy(true);
    try {
      const body = { kind: 'ssh', name: f.name, address: f.address, port: Number(f.port), os: f.os, username: f.username,
        provider: f.provider, region: f.region, plan: f.plan, notes: f.notes };
      if (f.credential_id) body.credential_id = f.credential_id;
      else {
        body.credential = { username: f.username, ...(f.auth === 'key' ? { private_key: f.private_key, passphrase: f.passphrase } : { password: f.password }) };
        body.save_credential = f.save_credential;
      }
      const host = await api('/api/hosts', { method: 'POST', body });
      addToast(host.connect_error ? `Host added, but the first connection failed: ${host.connect_error}` : 'Host added and reachable', host.connect_error ? 'error' : 'success');
      onCreated();
    } catch (e) { addToast(e.message, 'error'); setBusy(false); }
  };

  return html`<${Modal} title="Add SSH host" onClose=${onClose}>
    <div class="page-desc" style=${{ marginBottom: 12 }}>Agentless host. LabCTL runs jobs over SSH and checks its state every minute. The host key is recorded on the first connection.</div>
    <div class="form-row">
      ${field('Name', html`<input ...${text('name', { placeholder: 'vps-1.example.test' })}/>`)}
      ${field('OS', html`<select class="select" value=${f.os} onChange=${e => set('os', e.target.value)}>
        ${['linux', 'windows', 'darwin'].map(o => html`<option key=${o} value=${o}>${o}</option>`)}</select>`)}
    </div>
    <div class="form-row">
      ${field('Address', html`<input ...${text('address', { placeholder: '192.0.2.10' })}/>`)}
      ${field('Port', html`<input class="input" type="number" min="1" max="65535" value=${f.port} onInput=${e => set('port', e.target.value)}/>`)}
      ${field('User', html`<input ...${text('username')}/>`)}
    </div>
    ${isAdmin && creds.length > 0 && field('Use a stored credential', html`<select class="select" value=${f.credential_id} onChange=${e => set('credential_id', e.target.value)}>
      <option value="">Enter one below</option>
      ${creds.map(c => html`<option key=${c.id} value=${c.id}>${c.name || c.hostname} (${c.username})</option>`)}</select>`)}
    ${!f.credential_id && html`
      <div class="form-row" style=${{ marginTop: 12 }}>
        ${field('Sign in with', html`<select class="select" value=${f.auth} onChange=${e => set('auth', e.target.value)}>
          <option value="password">Password</option><option value="key">Private key</option></select>`)}
        ${f.auth === 'password'
          ? field('Password', html`<input ...${text('password', { type: 'password', autocomplete: 'new-password' })}/>`)
          : field('Key passphrase (optional)', html`<input ...${text('passphrase', { type: 'password', autocomplete: 'new-password' })}/>`)}
      </div>
      ${f.auth === 'key' && field('Private key', html`<textarea class="textarea" rows="4" value=${f.private_key} onInput=${e => set('private_key', e.target.value)}/>`)}
      ${isAdmin && html`<label class="checkbox-row" style=${{ margin: '8px 0' }}>
        <input type="checkbox" checked=${f.save_credential} onChange=${e => set('save_credential', e.target.checked)}/>
        Save credential (sealed on the server). Otherwise it lives in server memory until restart.
      </label>`}
    `}
    <div class="form-row" style=${{ marginTop: 12 }}>
      ${field('VPS provider', html`<input ...${text('provider')}/>`)}
      ${field('Region', html`<input ...${text('region')}/>`)}
      ${field('Plan', html`<input ...${text('plan')}/>`)}
    </div>
    ${field('Notes', html`<textarea class="textarea" rows="2" value=${f.notes} onInput=${e => set('notes', e.target.value)}/>`)}
    <div class="btn-group" style=${{ justifyContent: 'flex-end', marginTop: 16 }}>
      <button class="btn" onClick=${onClose} disabled=${busy}>Cancel</button>
      <button class="btn btn-primary" onClick=${submit} disabled=${busy || !f.name || !f.address}>${busy ? 'Connecting...' : 'Add host'}</button>
    </div>
  <//>`;
}
