import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons, StatusBadge, Modal } from '../ui.js';
import { HostDetailModal } from '../components/host-detail-modal.js';
import { Chip, Chips } from '../components/host-chips.js';
import { HostFilters, EMPTY_FILTERS } from '../components/host-filters.js';
import { RemoveDialog } from '../components/host-remove-dialog.js';
import { HostSettings } from '../components/host-settings.js';
import { AddSshHost } from '../components/host-add-ssh.js';
import { DeployActions } from '../components/deploy-actions.js';
import { filtersFromQuery, fleetHostIds, FLEET_FILTERS } from '../components/host-query.js';

const seen = iso => (iso ? iso.slice(0, 19).replace('T', ' ') : '—');
const GROUP_COLORS = ['#3b82f6','#22c55e','#f97316','#a855f7','#ef4444','#eab308','#06b6d4','#ec4899'];

// ── Hosts: search, filters, bulk actions, remove ──────────
export default function HostsPage({ hosts, addToast, currentUser, query }) {
  const isAdmin = currentUser?.role === 'admin';
  const canEdit = currentUser?.role !== 'viewer';
  const online = hosts.filter(h => h.online || h.status === 'online').length;
  const [rows, setRows] = useState([]);
  const fromUrl = filtersFromQuery(query, EMPTY_FILTERS);
  const [filters, setFilters] = useState(fromUrl.filters);
  const [fleet, setFleet] = useState(fromUrl.fleet);
  const [selected, setSelected] = useState(new Set());
  const [groups, setGroups] = useState([]);
  const [tags, setTags] = useState([]);
  const [removing, setRemoving] = useState(null);
  const [settingsHost, setSettingsHost] = useState(null);
  const [addingSsh, setAddingSsh] = useState(false);
  const [selectedHost, setSelectedHost] = useState(null);
  const [showManageGroups, setShowManageGroups] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupColor, setNewGroupColor] = useState('#3b82f6');
  const [bulkTag, setBulkTag] = useState('');
  const [bulkGroup, setBulkGroup] = useState('');

  const loadRows = async () => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
    try {
      const list = await api(`/api/hosts?${params}`);
      const ids = fleet.length ? fleetHostIds(fleet, await api('/api/fleet/summary')) : null;
      setRows(ids ? list.filter(h => ids.has(h.id)) : list);
    } catch (e) { console.error(e); }
  };
  const loadMeta = async () => {
    try {
      const [g, t] = await Promise.all([api('/api/groups'), api('/api/tags')]);
      setGroups(g);
      setTags(t);
    } catch (e) { console.error(e); }
  };
  const refresh = () => { loadRows(); loadMeta(); };

  useEffect(() => { loadRows(); const t = setInterval(loadRows, 3000); return () => clearInterval(t); }, [JSON.stringify(filters), fleet.join()]);
  // A new hash query (a fleet tile, a link) replaces the filters, so the filter bar always shows what the URL says.
  useEffect(() => { const f = filtersFromQuery(query, EMPTY_FILTERS); setFilters(f.filters); setFleet(f.fleet); }, [JSON.stringify(query)]);
  useEffect(() => { loadMeta(); }, []);
  useEffect(() => {
    const openGroups = () => setShowManageGroups(true);
    window.addEventListener('labctl:manage-groups', openGroups);
    return () => window.removeEventListener('labctl:manage-groups', openGroups);
  }, []);

  const addGroup = async () => {
    if (!newGroupName.trim()) return;
    await api('/api/groups', { method: 'POST', body: { name: newGroupName, color: newGroupColor }});
    setNewGroupName('');
    addToast('Group created');
    refresh();
  };
  const deleteGroup = async (id) => {
    await api(`/api/groups/${id}`, { method: 'DELETE' });
    addToast('Group deleted');
    refresh();
  };
  const deleteTag = async (id) => {
    await api(`/api/tags/${id}`, { method: 'DELETE' });
    addToast('Tag deleted');
    refresh();
  };

  const picked = rows.filter(h => selected.has(h.id));
  const allOn = rows.length > 0 && picked.length === rows.length;
  const toggle = id => setSelected(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSelected(allOn ? new Set() : new Set(rows.map(h => h.id)));

  const bulkPatch = async (body, done) => {
    try {
      await Promise.all(picked.map(h => api(`/api/hosts/${encodeURIComponent(h.id)}`, { method: 'PATCH', body })));
      addToast(done);
      setBulkTag('');
      setBulkGroup('');
      refresh();
    } catch (e) { addToast(e.message, 'error'); }
  };

  const osOptions = [...new Set(hosts.map(h => h.os).filter(Boolean))].sort();
  const agentCell = h => (h.kind === 'ssh'
    ? html`<span class="page-desc">agentless</span>`
    : html`<span class="mono">${h.agent_version || '—'}</span>${h.agent_outdated && html` <span class="badge badge-pending" title=${`Latest known: ${h.latest_agent_version}`}>outdated</span>`}`);

  const renderRow = (h) => html`<tr key=${h.id} style=${{ cursor: 'pointer' }} onClick=${() => setSelectedHost(h)}>
    <td onClick=${e => e.stopPropagation()}>
      <input type="checkbox" checked=${selected.has(h.id)} onChange=${() => toggle(h.id)} aria-label=${`Select ${h.hostname || h.id}`}/>
    </td>
    <td><${StatusBadge} status=${h.online || h.status === 'online' ? 'online' : 'offline'}/></td>
    <td>
      <strong>${h.hostname || h.id}</strong>
      ${(h.provider || h.region || h.plan) && html`<div class="page-desc">${[h.provider, h.region, h.plan].filter(Boolean).join(' / ')}</div>`}
    </td>
    <td>${h.kind}</td>
    <td>${h.os || '—'}</td>
    <td class="mono">${h.ip || h.system_info?.ip || '—'}</td>
    <td>${agentCell(h)}</td>
    <td><${Chips} items=${h.tags}/></td>
    <td><${Chips} items=${h.groups}/></td>
    <td class="mono">${seen(h.last_seen)}</td>
    <td onClick=${e => e.stopPropagation()} style=${{ whiteSpace: 'nowrap' }}>
      ${canEdit && html`<button class="btn btn-sm" title="Host settings" aria-label="Host settings" onClick=${() => setSettingsHost(h)}><${Icons.Settings}/></button>`}
      <${DeployActions} host=${h} isAdmin=${isAdmin} addToast=${addToast} onDone=${refresh}/>
      ${isAdmin && html` <button class="btn btn-sm btn-danger" title="Remove host" aria-label="Remove host" onClick=${() => setRemoving([h])}><${Icons.Trash}/> Remove</button>`}
    </td>
  </tr>`;

  return (
    html`<div>
      <div class="page-header">
        <div>
          <div class="page-title">Hosts</div>
          <div class="page-desc">${hosts.length} registered, ${online} online</div>
        </div>
        <div class="btn-group">
          ${isAdmin && html`<a class="btn" style=${{ textDecoration: 'none' }} href="#/blocklist"><${Icons.Stop}/> Blocked hosts</a>`}
          ${canEdit && html`<a class="btn btn-primary" style=${{ textDecoration: 'none' }} href="#/add-host"><${Icons.Server}/> Add host</a>`}
          ${canEdit && html`<button class="btn" onClick=${() => setAddingSsh(true)}><${Icons.Terminal}/> Add SSH host</button>`}
        </div>
      </div>

      <${HostFilters} filters=${filters} onChange=${f => { setFilters(f); if (!Object.values(f).some(Boolean)) setFleet([]); }} options=${{ os: osOptions, groups, tags }}/>
      ${fleet.length > 0 && html`<div style=${{ marginBottom: 12 }}>${fleet.map(k => html`<span key=${k} class="badge badge-pending" style=${{ marginRight: 8 }}>${FLEET_FILTERS[k].label}</span>`)}
        <button class="btn btn-sm" onClick=${() => setFleet([])}>Clear fleet filter</button></div>`}

      ${picked.length > 0 && html`<div class="card" style=${{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', padding: '10px 14px' }}>
        <strong>${picked.length} selected</strong>
        ${canEdit && html`
          <input class="input" style=${{ maxWidth: 160 }} placeholder="Tag name" aria-label="Tag to add" value=${bulkTag} onInput=${e => setBulkTag(e.target.value)}/>
          <button class="btn btn-sm" disabled=${!bulkTag.trim()} onClick=${() => bulkPatch({ add_tags: [bulkTag.trim()] }, 'Tag added')}>Add tag</button>
          <select class="select" style=${{ maxWidth: 160 }} aria-label="Group to add" value=${bulkGroup} onChange=${e => setBulkGroup(e.target.value)}>
            <option value="">Choose group</option>
            ${groups.map(g => html`<option key=${g.id} value=${g.id}>${g.name}</option>`)}
          </select>
          <button class="btn btn-sm" disabled=${!bulkGroup} onClick=${() => bulkPatch({ add_groups: [bulkGroup] }, 'Added to group')}>Add to group</button>`}
        ${isAdmin && html`<button class="btn btn-sm btn-danger" onClick=${() => setRemoving(picked)}><${Icons.Trash}/> Remove ${picked.length}</button>`}
        <button class="btn btn-sm" onClick=${() => setSelected(new Set())}>Clear selection</button>
      </div>`}

      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th style=${{ width: 28 }}><input type="checkbox" aria-label="Select all hosts" checked=${allOn} onChange=${toggleAll}/></th>
              <th>Status</th><th>Host</th><th>Kind</th><th>OS</th><th>Address</th><th>Agent version</th><th>Tags</th><th>Groups</th><th>Last seen</th><th></th>
            </tr></thead>
            <tbody>${rows.map(renderRow)}</tbody>
          </table>
        </div>
        ${rows.length === 0 && html`<div style=${{ textAlign: 'center', color: 'var(--text-dim)', padding: 30 }}>
          ${hosts.length === 0 ? 'No hosts registered. Deploy the agent on your machines or add an SSH host.' : 'No host matches the filters.'}
        </div>`}
      </div>

      
      ${showManageGroups && (
        html`<${Modal} title="Manage Groups" onClose=${() => setShowManageGroups(false)}>
          <div style=${{ marginBottom: 16 }}>
            <div class="form-row">
              <div class="form-group" style=${{ flex: 2 }}>
                <label class="form-label">New Group Name</label>
                <input class="input" placeholder="e.g., Proxmox Hosts"
                  value=${newGroupName}
                  onInput=${e => setNewGroupName(e.target.value)}
                  onKeyDown=${e => e.key === 'Enter' && addGroup()}/>
              </div>
              <div class="form-group" style=${{ flex: 0, minWidth: 80 }}>
                <label class="form-label">Color</label>
                <div style=${{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  ${GROUP_COLORS.map(c => (
                    html`<div key=${c} onClick=${() => setNewGroupColor(c)} style=${{
                      width: 24, height: 24, borderRadius: 4, background: c, cursor: 'pointer',
                      border: newGroupColor === c ? '2px solid white' : '2px solid transparent'
                    }}/>`
                  ))}
                </div>
              </div>
              <div class="form-group" style=${{ flex: 0, alignSelf: 'flex-end' }}>
                <button class="btn btn-primary" onClick=${addGroup}>Add</button>
              </div>
            </div>
          </div>

          ${groups.length > 0 && (
            html`<div class="table-wrap">
              <table>
                <thead><tr><th>Color</th><th>Name</th><th>Hosts</th><th>Actions</th></tr></thead>
                <tbody>
                  ${groups.map(g => (
                    html`<tr key=${g.id}>
                      <td><span style=${{ display: 'inline-block', width: 16, height: 16, borderRadius: 3, background: g.color }}/></td>
                      <td style=${{ fontWeight: 600 }}>${g.name}</td>
                      <td>${hosts.filter(h => (h.groups || []).some(x => x.id === g.id)).length}</td>
                      <td>
                        <button class="btn btn-sm btn-danger" onClick=${() => deleteGroup(g.id)}>
                          <${Icons.Trash}/>
                        </button>
                      </td>
                    </tr>`
                  ))}
                </tbody>
              </table>
            </div>`
          )}

          ${groups.length === 0 && (
            html`<div style=${{ textAlign: 'center', color: 'var(--text-dim)', padding: 20, fontSize: 13 }}>
              No groups yet. Create one above.
            </div>`
          )}

          <div class="form-label" style=${{ marginTop: 16 }}>Tags</div>
          ${tags.length === 0 && html`<div class="page-desc">No tags yet. Add them from a host's settings or the bulk bar.</div>`}
          ${tags.map(t => html`<${Chip} key=${t.id} item=${t} onRemove=${() => deleteTag(t.id)}/>`)}
        <//>`
      )}


      ${removing && html`<${RemoveDialog} hosts=${removing} addToast=${addToast} onClose=${() => setRemoving(null)}
        onDone=${() => { setRemoving(null); setSelected(new Set()); refresh(); }}/>`}

      ${settingsHost && html`<${HostSettings} host=${settingsHost} groups=${groups} isAdmin=${isAdmin} addToast=${addToast}
        onClose=${() => setSettingsHost(null)} onSaved=${() => { setSettingsHost(null); refresh(); }}/>`}

      ${addingSsh && html`<${AddSshHost} isAdmin=${isAdmin} addToast=${addToast}
        onClose=${() => setAddingSsh(false)} onCreated=${() => { setAddingSsh(false); refresh(); }}/>`}

      ${selectedHost && (
        html`<${HostDetailModal} host=${selectedHost} onClose=${() => setSelectedHost(null)} addToast=${addToast}/>`
      )}
    </div>`
  );
}

// Extra button the shell shows in the top bar while this page is open.
export function Toolbar() {
  return html`<button class="btn top-manage" onClick=${() => window.dispatchEvent(new Event('labctl:manage-groups'))}>
    <${Icons.Settings}/> Manage Groups
  </button>`;
}
