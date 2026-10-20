import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons } from '../ui.js';

// Hosts the server refuses. A blocked agent that reconnects is closed with code 4403 until it is unblocked.
export default function BlocklistPage({ addToast }) {
  const [rows, setRows] = useState([]);
  const load = () => api('/api/blocklist').then(setRows).catch(e => addToast(e.message, 'error'));
  useEffect(() => { load(); }, []);

  const unblock = async (row) => {
    try {
      await api(`/api/blocklist/${encodeURIComponent(row.host_id)}`, { method: 'DELETE' });
      addToast(`${row.hostname || row.host_id} unblocked. Its agent can register again`);
      load();
    } catch (e) { addToast(e.message, 'error'); }
  };

  return html`<div>
    <div class="page-header">
      <div>
        <div class="page-title">Blocked hosts</div>
        <div class="page-desc">${rows.length} blocked. Removing a host adds it here so a reconnecting agent does not register again.</div>
      </div>
      <button class="btn" onClick=${load}><${Icons.RefreshCw}/> Refresh</button>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Host</th><th>Host ID</th><th>Removal mode</th><th>Blocked by</th><th>Blocked at</th><th></th></tr></thead>
          <tbody>
            ${rows.map(r => html`<tr key=${r.host_id}>
              <td><strong>${r.hostname || '—'}</strong></td>
              <td class="mono">${r.host_id}</td>
              <td>${r.reason === 'uninstall_and_remove' ? 'Uninstall and remove' : r.reason === 'remove' ? 'Remove' : (r.reason || '—')}</td>
              <td>${r.actor || '—'}</td>
              <td class="mono">${(r.created_at || '').slice(0, 19).replace('T', ' ')}</td>
              <td><button class="btn btn-sm" onClick=${() => unblock(r)}>Unblock</button></td>
            </tr>`)}
          </tbody>
        </table>
      </div>
      ${rows.length === 0 && html`<div style=${{ textAlign: 'center', color: 'var(--text-dim)', padding: 30 }}>No blocked hosts.</div>`}
    </div>
  </div>`;
}
