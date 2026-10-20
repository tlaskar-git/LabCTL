import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons, Modal } from '../ui.js';

// Credential library. Shared credentials have a name, a username and a secret, and no host. Host credentials are the
// per-host logins that autologin and deploy save. Secrets are encrypted on the server and never sent back to the browser.
const when = v => (v ? new Date(v).toLocaleString() : 'never');
const BLANK = { name: '', username: '', domain: '', auth: 'password', password: '', private_key: '', passphrase: '', sudo_password: '', note: '' };

function field(label, input, hint) {
  // The label wraps its control, so screen readers name the input by the label text.
  return html`<div class="form-group" style=${{ marginBottom: 10 }}><label><span class="form-label">${label}</span>${input}</label>${hint && html`<div class="page-desc" style=${{ marginTop: 4 }}>${hint}</div>`}</div>`;
}

function CredentialForm({ edit, onClose, onSaved, addToast }) {
  const [f, setF] = useState(edit ? { ...BLANK, name: edit.name, username: edit.username, domain: edit.domain || '', note: edit.note || '', auth: edit.kind === 'ssh_key' ? 'key' : 'password' } : BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const text = (k, extra = {}) => ({ class: 'input', value: f[k], onInput: e => set(k, e.target.value), ...extra });
  const secretGiven = f.auth === 'key' ? !!f.private_key.trim() : !!f.password;
  const ready = f.name.trim() && f.username.trim() && (edit || secretGiven);

  const submit = async () => {
    setBusy(true);
    setError('');
    const body = { name: f.name, username: f.username, domain: f.domain, note: f.note };
    if (f.auth === 'key' ? f.private_key.trim() : f.password) {
      if (f.auth === 'key') Object.assign(body, { private_key: f.private_key, passphrase: f.passphrase });
      else body.password = f.password;
    }
    if (f.sudo_password) body.sudo_password = f.sudo_password;
    try {
      await api(edit ? `/api/credentials/${edit.id}` : '/api/credentials', { method: edit ? 'PUT' : 'POST', body });
      addToast(edit ? 'Credential updated' : 'Credential saved');
      onSaved();
    } catch (e) { setError(e.message); setBusy(false); }
  };

  return html`<${Modal} title=${edit ? `Edit ${edit.name}` : 'Add credential'} onClose=${busy ? () => {} : onClose}>
    <div class="page-desc" style=${{ marginBottom: 12 }}>A named login you can reuse on any host, for example root or domain admin. No host is needed.
      The secret is encrypted and never shown again.</div>
    <div class="form-row">
      ${field('Name', html`<input ...${text('name', { placeholder: 'root', maxLength: 64, autofocus: true })}/>`)}
      ${field('Username', html`<input ...${text('username', { placeholder: 'root', maxLength: 128, autocomplete: 'off' })}/>`)}
    </div>
    <div class="form-row">
      ${field('Domain (optional)', html`<input ...${text('domain', { placeholder: 'corp.example.test', maxLength: 255 })}/>`, 'For DOMAIN\\user logins. Stored in clear.')}
      ${field('Sign in with', html`<select class="select" value=${f.auth} onChange=${e => set('auth', e.target.value)}>
        <option value="password">Password</option><option value="key">Private key</option></select>`)}
    </div>
    ${f.auth === 'password'
      ? field(edit ? 'New password' : 'Password', html`<input ...${text('password', { type: 'password', autocomplete: 'new-password' })}/>`, edit && 'Leave empty to keep the saved secret.')
      : html`${field(edit ? 'New private key' : 'Private key', html`<textarea class="textarea" rows="5" spellcheck="false" placeholder="Paste the private key (PEM)" value=${f.private_key}
          onInput=${e => set('private_key', e.target.value)}/>`, edit && 'Leave empty to keep the saved secret.')}
        ${field('Key passphrase (optional)', html`<input ...${text('passphrase', { type: 'password', autocomplete: 'new-password' })}/>`)}`}
    ${field('Sudo password (optional)', html`<input ...${text('sudo_password', { type: 'password', autocomplete: 'new-password' })}/>`,
      edit ? 'Leave empty to keep the saved sudo password.' : 'Only when sudo needs a password different from the login.')}
    ${field('Note (optional)', html`<input ...${text('note', { maxLength: 500 })}/>`)}
    ${error && html`<div role="alert" style=${{ color: 'var(--red)', margin: '8px 0' }}>${error}</div>`}
    <div class="btn-group" style=${{ justifyContent: 'flex-end', marginTop: 16 }}>
      <button class="btn" onClick=${onClose} disabled=${busy}>Cancel</button>
      <button class="btn btn-primary" onClick=${submit} disabled=${busy || !ready}>${busy ? 'Saving' : 'Save'}</button>
    </div>
  <//>`;
}

function DeleteDialog({ cred, onClose, onDone, addToast }) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/credentials/${cred.id}`, { method: 'DELETE', body: { confirm: typed } });
      addToast('Credential removed');
      onDone();
    } catch (e) { setError(e.message); setBusy(false); }
  };
  return html`<${Modal} title=${`Delete ${cred.name}`} onClose=${busy ? () => {} : onClose}>
    <div class="form-group">
      <label class="form-label">Type <code>${cred.name}</code> to confirm</label>
      <input class="input" autofocus value=${typed} placeholder=${cred.name} onInput=${e => setTyped(e.target.value)}/>
    </div>
    ${error && html`<div role="alert" style=${{ color: 'var(--red)', margin: '8px 0' }}>${error}</div>`}
    <div class="btn-group" style=${{ justifyContent: 'flex-end', marginTop: 16 }}>
      <button class="btn" onClick=${onClose} disabled=${busy}>Cancel</button>
      <button class="btn btn-danger" onClick=${go} disabled=${busy || typed !== cred.name}>Delete</button>
    </div>
  <//>`;
}

export default function CredentialsPage({ addToast }) {
  const [creds, setCreds] = useState([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);   // null | {} for add | row for edit
  const [removing, setRemoving] = useState(null);

  const load = () => api('/api/credentials').then(r => { setCreds(r); setError(''); }).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);

  const shared = creds.filter(c => c.scope === 'shared');
  const hostBound = creds.filter(c => c.scope !== 'shared');
  const removeHostCred = async c => {
    try { await api(`/api/credentials/${c.id}`, { method: 'DELETE' }); addToast('Credential removed'); load(); } catch (e) { addToast(e.message, 'error'); }
  };
  const done = () => { setForm(null); setRemoving(null); load(); };

  return html`<div>
    <div class="page-header">
      <div>
        <div class="page-title">Credentials</div>
        <div class="page-desc">Saved logins you can reuse on any host. Secrets are encrypted and never shown again.</div>
      </div>
      <button class="btn btn-primary" onClick=${() => setForm({})}>+ Add credential</button>
    </div>
    ${error && html`<div role="alert" style=${{ color: 'var(--red)', margin: '8px 0' }}>${error}</div>`}

    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Username</th><th>Domain</th><th>Type</th><th>Note</th><th>Last used</th><th>Actions</th></tr></thead>
        <tbody>
          ${shared.map(c => html`<tr key=${c.id}>
            <td><strong>${c.name}</strong></td>
            <td class="mono">${c.username}</td>
            <td class="mono">${c.domain || ''}</td>
            <td>${c.kind === 'ssh_key' ? 'Private key' : 'Password'}</td>
            <td>${c.note || ''}</td>
            <td title=${c.last_purpose || ''}>${when(c.last_used)}</td>
            <td><div class="btn-group">
              <button class="btn btn-sm" aria-label=${`Edit ${c.name}`} onClick=${() => setForm(c)}>Edit</button>
              <button class="btn btn-sm btn-danger" aria-label=${`Delete ${c.name}`} onClick=${() => setRemoving(c)}><${Icons.Trash}/></button>
            </div></td>
          </tr>`)}
          ${!shared.length && html`<tr><td colSpan=${7} style=${{ textAlign: 'center', padding: 30, color: 'var(--text-dim)' }}>
            No shared credentials. Add one such as root or domain admin.</td></tr>`}
        </tbody>
      </table>
    </div>

    <div class="page-title" style=${{ fontSize: 16, margin: '24px 0 4px' }}>Host credentials</div>
    <div class="page-desc" style=${{ marginBottom: 8 }}>Saved for one host by auto-login, deploy or an SSH host. They are managed from those screens.</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Host</th><th>Username</th><th>Purpose</th><th>Last used</th><th>Actions</th></tr></thead>
        <tbody>
          ${hostBound.map(c => html`<tr key=${c.id}>
            <td>${c.hostname || c.host_id}</td>
            <td class="mono">${c.username}</td>
            <td>${c.purpose}</td>
            <td>${when(c.last_used)}</td>
            <td><button class="btn btn-sm btn-danger" aria-label=${`Delete credential for ${c.hostname || c.host_id}`} onClick=${() => removeHostCred(c)}><${Icons.Trash}/></button></td>
          </tr>`)}
          ${!hostBound.length && html`<tr><td colSpan=${5} style=${{ textAlign: 'center', padding: 30, color: 'var(--text-dim)' }}>No host credentials stored.</td></tr>`}
        </tbody>
      </table>
    </div>

    ${form && html`<${CredentialForm} edit=${form.id ? form : null} onClose=${() => setForm(null)} onSaved=${done} addToast=${addToast}/>`}
    ${removing && html`<${DeleteDialog} cred=${removing} onClose=${() => setRemoving(null)} onDone=${done} addToast=${addToast}/>`}
  </div>`;
}
