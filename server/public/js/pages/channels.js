import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons, Modal } from '../ui.js';

const MASK = '********';
const DEFAULTS = {
  smtp: { host: '', port: 25, secure: 'none', user: '', password: '', from: '', to: '', reject_unauthorized: true, min_severity: 'info' },
  webhook: { url: '', method: 'POST', headers: '', hmac_secret: '', template: '', min_severity: 'info' },
  telegram: { bot_token: '', chat_id: '', message_thread_id: '', min_severity: 'info' }
};
const when = iso => (iso ? iso.slice(0, 16).replace('T', ' ') : '');

// The API shows secrets as a mask. The form keeps the mask, and the server keeps the stored value when it comes back unchanged.
function toForm(c) {
  const cfg = { ...DEFAULTS[c.kind], ...(c.config || {}) };
  if (c.kind === 'smtp') cfg.to = (cfg.to || []).join(', ');
  if (c.kind === 'webhook') cfg.headers = Object.entries(cfg.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  return { id: c.id, name: c.name, kind: c.kind, enabled: c.enabled, config: cfg };
}

function fromForm(f) {
  const c = { ...f.config };
  if (f.kind === 'smtp') { c.port = Number(c.port) || 25; c.to = String(c.to).split(/[,\s]+/).filter(Boolean); }
  if (f.kind === 'webhook') {
    c.headers = Object.fromEntries(String(c.headers || '').split('\n').map(l => l.split(/:\s*/)).filter(p => p[0].trim()).map(([k, ...v]) => [k.trim(), v.join(': ')]));
  }
  return { name: f.name, enabled: f.enabled, ...(f.id ? {} : { kind: f.kind }), config: c };
}

export default function ChannelsPage({ addToast }) {
  const [list, setList] = useState([]);
  const [form, setForm] = useState(null);
  const [testing, setTesting] = useState('');
  const load = () => api('/api/channels').then(setList).catch(e => addToast(e.message, 'error'));
  useEffect(() => { load(); }, []);
  const cfg = (k, v) => setForm(f => ({ ...f, config: { ...f.config, [k]: v } }));
  const field = (label, k, props = {}) => html`<div class="form-group"><label class="form-label">${label}</label>
    <input class="input" value=${form.config[k] ?? ''} onInput=${e => cfg(k, e.target.value)} ...${props}/></div>`;

  const save = async () => {
    try {
      await api(form.id ? `/api/channels/${form.id}` : '/api/channels', { method: form.id ? 'PUT' : 'POST', body: fromForm(form) });
      addToast('Channel saved'); setForm(null); load();
    } catch (e) { addToast(e.message, 'error'); }
  };
  const test = async c => {
    setTesting(c.id);
    try {
      const r = await api(`/api/channels/${c.id}/test`, { method: 'POST' });
      addToast(r.ok ? `Test sent through ${c.name}` : `Test failed: ${r.error}`, r.ok ? 'success' : 'error');
    } catch (e) { addToast(e.message, 'error'); }
    setTesting(''); load();
  };
  const remove = async c => { await api(`/api/channels/${c.id}`, { method: 'DELETE' }).catch(e => addToast(e.message, 'error')); addToast('Channel deleted'); load(); };

  return html`<div>
    <div class="page-header"><div><div class="page-title">Channels</div><div class="page-desc">Where alerts and recovery notices are sent</div></div>
      <div class="btn-group">${['smtp', 'webhook', 'telegram'].map(k => html`<button key=${k} class="btn btn-primary" onClick=${() => setForm({ name: '', kind: k, enabled: true, config: { ...DEFAULTS[k] } })}>+ ${k === 'smtp' ? 'Email (SMTP)' : k === 'webhook' ? 'Webhook' : 'Telegram'}</button>`)}</div></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Type</th><th>Enabled</th><th>Last result</th><th>Actions</th></tr></thead>
      <tbody>
        ${list.map(c => html`<tr key=${c.id}>
          <td style=${{ fontWeight: 600 }}>${c.name}</td><td>${c.kind}</td>
          <td><span class=${`badge badge-${c.enabled ? 'online' : 'offline'}`}>${c.enabled ? 'on' : 'off'}</span></td>
          <td style=${{ fontSize: 12 }}>${c.last_error ? html`<span style=${{ color: 'var(--red)' }}>${when(c.last_error_at)} ${c.last_error}</span>` : c.last_ok_at ? `OK ${when(c.last_ok_at)}` : 'Not used yet'}</td>
          <td><div class="btn-group">
            <button class="btn btn-sm" disabled=${testing === c.id} onClick=${() => test(c)}>${testing === c.id ? 'Sending...' : 'Test'}</button>
            <button class="btn btn-sm" onClick=${() => setForm(toForm(c))}>Edit</button>
            <button class="btn btn-sm btn-danger" onClick=${() => remove(c)}><${Icons.Trash}/></button></div></td>
        </tr>`)}
        ${list.length === 0 && html`<tr><td colSpan=${5} style=${{ textAlign: 'center', padding: 30, color: 'var(--text-dim)' }}>No channels. Add one, then press Test.</td></tr>`}
      </tbody></table></div>
    ${form && html`<${Modal} title=${`${form.id ? 'Edit' : 'New'} ${form.kind} channel`} onClose=${() => setForm(null)}>
      <div class="form-group"><label class="form-label">Name</label><input class="input" value=${form.name} onInput=${e => setForm(f => ({ ...f, name: e.target.value }))}/></div>
      ${form.kind === 'smtp' && html`
        <div class="form-row">${field('Host', 'host', { placeholder: 'smtp.example.test' })}${field('Port', 'port', { type: 'number' })}
          <div class="form-group"><label class="form-label">Security</label><select class="select input" value=${form.config.secure} onChange=${e => cfg('secure', e.target.value)}>
            <option value="none">None (plain relay)</option><option value="starttls">STARTTLS</option><option value="tls">TLS</option></select></div></div>
        <div class="form-row">${field('User (optional)', 'user')}${field('Password (optional)', 'password', { type: 'password', autocomplete: 'new-password' })}</div>
        ${field('From', 'from', { placeholder: 'labctl@example.test' })}${field('To (comma separated)', 'to', { placeholder: 'ops@example.test' })}
        <label class="checkbox-row"><input type="checkbox" checked=${form.config.reject_unauthorized !== false} onChange=${e => cfg('reject_unauthorized', e.target.checked)}/> Verify the server certificate (TLS and STARTTLS)</label>`}
      ${form.kind === 'webhook' && html`
        <div class="form-row">${field('URL', 'url', { placeholder: 'n8n.example.test/webhook/labctl (start with the scheme)' })}
          <div class="form-group"><label class="form-label">Method</label><select class="select input" value=${form.config.method} onChange=${e => cfg('method', e.target.value)}><option>POST</option><option>PUT</option><option>PATCH</option></select></div></div>
        <div class="form-group"><label class="form-label">Headers (one per line, Name: value, values are stored sealed)</label>
          <textarea class="textarea" rows="3" value=${form.config.headers} onInput=${e => cfg('headers', e.target.value)}/></div>
        ${field('Signing secret (adds X-LabCTL-Signature, HMAC SHA-256)', 'hmac_secret', { type: 'password', autocomplete: 'new-password' })}
        <div class="form-group"><label class="form-label">Body template (JSON, optional). Variables: {{title}} {{rule}} {{host}} {{severity}} {{value}} {{message}} {{since}} {{link}} {{recovery}}</label>
          <textarea class="textarea mono" rows="4" value=${form.config.template} onInput=${e => cfg('template', e.target.value)}/></div>`}
      ${form.kind === 'telegram' && html`${field('Bot token', 'bot_token', { type: 'password', autocomplete: 'new-password' })}
        <div class="form-row">${field('Chat id', 'chat_id')}${field('Topic id (optional)', 'message_thread_id', { type: 'number' })}</div>`}
      <div class="form-row">
        <div class="form-group"><label class="form-label">Send from severity</label><select class="select input" value=${form.config.min_severity} onChange=${e => cfg('min_severity', e.target.value)}>
          <option value="info">info and above</option><option value="warning">warning and above</option><option value="critical">critical only</option></select></div>
        <label class="checkbox-row" style=${{ alignSelf: 'flex-end', marginBottom: 12 }}><input type="checkbox" checked=${form.enabled} onChange=${e => setForm(f => ({ ...f, enabled: e.target.checked }))}/> Enabled</label></div>
      ${form.id && html`<div class="page-desc" style=${{ marginBottom: 10 }}>Secrets show as ${MASK}. Leave them as they are to keep the stored value.</div>`}
      <button class="btn btn-primary" onClick=${save}>Save</button>
    <//>`}
  </div>`;
}
