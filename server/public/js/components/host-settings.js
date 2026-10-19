import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Modal } from '../ui.js';

const field = (label, input) => html`<div class="form-group"><label class="form-label">${label}</label>${input}</div>`;

// Host settings: tags, groups, notes, VPS fields, runner folders and, for SSH hosts, the connection.
export function HostSettings({ host, groups, onClose, onSaved, addToast, isAdmin }) {
  const isSsh = host.kind === 'ssh';
  const [f, setF] = useState({
    name: host.hostname || '', kind: host.kind, tags: host.tags.map(t => t.name).join(', '), groups: host.groups.map(g => g.id),
    notes: host.notes, provider: host.provider, region: host.region, plan: host.plan, runner_folders: host.runner_folders.join('\n'),
    address: host.ssh?.address || '', port: host.ssh?.port || 22, username: host.ssh?.username || '',
    credential_id: host.ssh?.credential_id || '', os: host.os || 'linux'
  });
  const [creds, setCreds] = useState([]);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const text = k => ({ class: 'input', value: f[k], onInput: e => set(k, e.target.value) });

  useEffect(() => { if (isSsh && isAdmin) api('/api/credentials').then(setCreds).catch(() => {}); }, []);

  const save = async (extra = {}) => {
    setBusy(true);
    try {
      const body = {
        tags: f.tags.split(',').map(s => s.trim()).filter(Boolean), groups: f.groups, notes: f.notes,
        provider: f.provider, region: f.region, plan: f.plan,
        runner_folders: f.runner_folders.split('\n').map(s => s.trim()).filter(Boolean), kind: f.kind
      };
      if (isSsh) {
        Object.assign(body, { name: f.name, os: f.os, ssh: { address: f.address, port: Number(f.port), username: f.username,
          credential_id: f.credential_id || null, ...extra } });
      }
      await api(`/api/hosts/${encodeURIComponent(host.id)}`, { method: 'PATCH', body });
      addToast(extra.reset_host_key ? 'Host key reset. It is recorded again on the next connection' : 'Host saved');
      onSaved();
    } catch (e) { addToast(e.message, 'error'); setBusy(false); }
  };

  const toggleGroup = id => set('groups', f.groups.includes(id) ? f.groups.filter(g => g !== id) : [...f.groups, id]);

  return html`<${Modal} title=${`Settings: ${host.hostname || host.id}`} onClose=${onClose}>
    ${isSsh && html`
      <div class="form-row">
        ${field('Name', html`<input ...${text('name')}/>`)}
        ${field('OS', html`<select class="select" value=${f.os} onChange=${e => set('os', e.target.value)}>
          ${['linux', 'windows', 'darwin'].map(o => html`<option key=${o} value=${o}>${o}</option>`)}</select>`)}
      </div>
      <div class="form-row">
        ${field('Address', html`<input ...${text('address')}/>`)}
        ${field('Port', html`<input class="input" type="number" min="1" max="65535" value=${f.port} onInput=${e => set('port', e.target.value)}/>`)}
        ${field('User', html`<input ...${text('username')}/>`)}
      </div>
      <div class="form-row">
        ${isAdmin && field('Stored credential', html`<select class="select" value=${f.credential_id} onChange=${e => set('credential_id', e.target.value)}>
          <option value="">Session only or none</option>
          ${creds.map(c => html`<option key=${c.id} value=${c.id}>${c.name || c.hostname} (${c.username})</option>`)}</select>`)}
        ${field('Host key (recorded on first connect)', html`<div style=${{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <code style=${{ fontSize: 11, wordBreak: 'break-all' }}>${host.ssh?.host_key || 'not recorded yet'}</code>
          ${isAdmin && host.ssh?.host_key && html`<button class="btn btn-sm" disabled=${busy} onClick=${() => save({ reset_host_key: true })}>Reset</button>`}
        </div>`)}
      </div>
      ${host.ssh?.error && html`<div style=${{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>Last poll failed: ${host.ssh.error}</div>`}
    `}
    ${!isSsh && field('Kind', html`<select class="select" value=${f.kind} onChange=${e => set('kind', e.target.value)}>
      ${['agent', 'vps', 'proxmox', 'runner'].map(k => html`<option key=${k} value=${k}>${k}</option>`)}</select>`)}
    <div class="form-row" style=${{ marginTop: 12 }}>
      ${field('VPS provider', html`<input ...${text('provider')}/>`)}
      ${field('Region', html`<input ...${text('region')}/>`)}
      ${field('Plan', html`<input ...${text('plan')}/>`)}
    </div>
    ${field('Tags (comma separated)', html`<input ...${text('tags')} placeholder="edge, dns"/>`)}
    <div class="form-group" style=${{ margin: '12px 0' }}>
      <label class="form-label">Groups</label>
      ${groups.length === 0 && html`<span class="page-desc">No groups yet. Create one with Manage Groups.</span>`}
      ${groups.map(g => html`<label key=${g.id} class="checkbox-row" style=${{ display: 'inline-flex', marginRight: 14 }}>
        <input type="checkbox" checked=${f.groups.includes(g.id)} onChange=${() => toggleGroup(g.id)}/> ${g.name}
      </label>`)}
    </div>
    ${field('Runner folders (one path per line, overrides detection)', html`<textarea class="textarea" rows="3" value=${f.runner_folders}
      onInput=${e => set('runner_folders', e.target.value)}/>`)}
    <div style=${{ marginTop: 12 }}>${field('Notes', html`<textarea class="textarea" rows="3" value=${f.notes} onInput=${e => set('notes', e.target.value)}/>`)}</div>
    <div class="btn-group" style=${{ justifyContent: 'flex-end', marginTop: 16 }}>
      <button class="btn" onClick=${onClose}>Cancel</button>
      <button class="btn btn-primary" onClick=${() => save()} disabled=${busy}>Save</button>
    </div>
  <//>`;
}
