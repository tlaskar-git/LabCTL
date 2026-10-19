import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons, Modal } from '../ui.js';

// ── Credentials Page ──────────────────────────────────────
export default function CredentialsPage({ hosts, addToast }) {
  const [creds, setCreds] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ host_id: '', username: '', password: '', purpose: 'autologin' });

  const load = async () => { setCreds(await api('/api/credentials')); };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!form.host_id || !form.username || !form.password) {
      addToast('All fields required.', 'error');
      return;
    }
    await api('/api/credentials', { method: 'POST', body: form });
    addToast('Credential saved');
    setShowAdd(false);
    setForm({ host_id: '', username: '', password: '', purpose: 'autologin' });
    load();
  };

  const remove = async (id) => {
    await api(`/api/credentials/${id}`, { method: 'DELETE' });
    addToast('Credential removed');
    load();
  };

  return (
    html`<div>
      <div class="page-header">
        <div>
          <div class="page-title">Credentials</div>
          <div class="page-desc">Auto-login credentials for Windows machines</div>
        </div>
        <button class="btn btn-primary" onClick=${() => setShowAdd(true)}>+ Add Credential</button>
      </div>

      <div class="table-wrap">
        <table>
          <thead><tr><th>Host</th><th>Username</th><th>Purpose</th><th>Actions</th></tr></thead>
          <tbody>
            ${creds.map(c => (
              html`<tr key=${c.id}>
                <td>${c.hostname || c.host_id}</td>
                <td class="mono">${c.username}</td>
                <td>${c.purpose}</td>
                <td><button class="btn btn-sm btn-danger" onClick=${() => remove(c.id)}><${Icons.Trash}/></button></td>
              </tr>`
            ))}
            ${creds.length === 0 && (
              html`<tr><td colSpan=${4} style=${{ textAlign: 'center', padding: 30, color: 'var(--text-dim)' }}>
                No credentials stored.
              </td></tr>`
            )}
          </tbody>
        </table>
      </div>

      ${showAdd && (
        html`<${Modal} title="Add Credential" onClose=${() => setShowAdd(false)}>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Host</label>
              <select class="select input" value=${form.host_id}
                onChange=${e => {
                  const hid = e.target.value;
                  const h = hosts.find(x => x.id === hid);
                  const detectedDomain = h?.system_info?.domain || '';
                  setForm(f => ({ ...f, host_id: hid, domain: detectedDomain }));
                }}>
                <option value="">Select host...</option>
                ${hosts.map(h => html`<option key=${h.id} value=${h.id}>${h.hostname}</option>`)}
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Username</label>
              <input class="input" placeholder="User Name"
                value=${form.username} onInput=${e => setForm(f => ({ ...f, username: e.target.value }))}/>
            </div>
            <div class="form-group">
              <label class="form-label">Password</label>
              <input class="input" type="password"
                value=${form.password} onInput=${e => setForm(f => ({ ...f, password: e.target.value }))}/>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Domain ${form.domain && html`<span style=${{ color: 'var(--green)', fontSize: 10 }}>(auto-detected)</span>`}</label>
              <input class="input" placeholder="e.g. example.test"
                value=${form.domain || ''} onInput=${e => setForm(f => ({ ...f, domain: e.target.value }))}/>
            </div>
          </div>
          <div class="btn-group" style=${{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button class="btn" onClick=${() => setShowAdd(false)}>Cancel</button>
            <button class="btn btn-primary" onClick=${save}>Save</button>
          </div>
        <//>`
      )}
    </div>`
  );
}
