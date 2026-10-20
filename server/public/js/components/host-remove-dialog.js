import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { html, Modal } from '../ui.js';
import { hostName } from './host-name.js';

// Remove one host or many. Two modes, and a typed confirmation: the name shown on screen (the real hostname is accepted
// too, the server checks either), or "REMOVE n HOSTS" for several.
export function RemoveDialog({ hosts, onClose, onDone, addToast }) {
  const bulk = hosts.length > 1;
  const expected = bulk ? `REMOVE ${hosts.length} HOSTS` : hostName(hosts[0]);
  const accepted = bulk ? [expected] : [expected, hosts[0].hostname || hosts[0].id];
  const [mode, setMode] = useState('remove');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const agentless = hosts.some(h => h.kind === 'ssh');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const results = bulk
        ? (await api('/api/hosts/bulk-remove', { method: 'POST', body: { host_ids: hosts.map(h => h.id), mode, confirm: typed } })).results
        : [{ ok: true, ...(await api(`/api/hosts/${encodeURIComponent(hosts[0].id)}`, { method: 'DELETE', body: { mode, confirm: typed } })) }];
      const failed = results.filter(r => !r.ok).length;
      const silent = results.filter(r => r.uninstall === 'timeout').length;
      addToast(`${results.length - failed} removed${failed ? `, ${failed} failed` : ''}${silent ? `. ${silent} agent(s) did not confirm the uninstall within 30 seconds` : ''}`, failed || silent ? 'error' : 'success');
      onDone();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  const option = (value, title, text) => html`<label style=${{ display: 'flex', gap: 10, padding: '10px 12px', marginBottom: 8, cursor: 'pointer',
    borderRadius: 6, border: `1px solid ${mode === value ? 'var(--accent)' : 'var(--border)'}`, background: 'var(--bg-input)' }}>
    <input type="radio" name="remove-mode" checked=${mode === value} onChange=${() => setMode(value)}/>
    <span><strong>${title}</strong><br/><span class="page-desc">${text}</span></span>
  </label>`;

  return html`<${Modal} title=${bulk ? `Remove ${hosts.length} hosts` : `Remove ${expected}`} onClose=${busy ? () => {} : onClose}>
    ${option('remove', 'Remove from LabCTL',
      'Deletes the host and adds it to the blocklist. If its agent reconnects it is refused until you unblock it.')}
    ${option('uninstall_and_remove', 'Uninstall agent and remove',
      'Tells the agent to uninstall itself first and waits up to 30 seconds, then removes the host and blocks it.')}
    ${agentless && html`<div class="page-desc" style=${{ marginBottom: 8 }}>Agentless SSH hosts have no agent to uninstall and are not blocked. They are only deleted.</div>`}
    <div class="form-group" style=${{ margin: '12px 0' }}>
      <label class="form-label">Type <code>${expected}</code> to confirm${accepted[1] && accepted[1] !== expected ? html` (or the hostname <code>${accepted[1]}</code>)` : ''}</label>
      <input class="input" autofocus value=${typed} onInput=${e => setTyped(e.target.value)} placeholder=${expected}/>
    </div>
    ${error && html`<div style=${{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>${error}</div>`}
    <div class="btn-group" style=${{ justifyContent: 'flex-end' }}>
      <button class="btn" onClick=${onClose} disabled=${busy}>Cancel</button>
      <button class="btn btn-danger" onClick=${submit} disabled=${busy || !accepted.includes(typed)}>${busy ? 'Working...' : 'Remove'}</button>
    </div>
  <//>`;
}
