import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons, StatusBadge, Modal } from '../ui.js';
import { HostDetailModal } from '../components/host-detail-modal.js';
import { Chip, Chips } from '../components/host-chips.js';
import { HostFilters, EMPTY_FILTERS } from '../components/host-filters.js';
import { RemoveDialog } from '../components/host-remove-dialog.js';
import { HostSettings } from '../components/host-settings.js';
import { AddSshHost } from '../components/host-add-ssh.js';
import { DeployActions, RedeployDialog } from '../components/deploy-actions.js';
import { filtersFromQuery, fleetHostIds, FLEET_FILTERS } from '../components/host-query.js';
import { MiniBar, has, orDash, usedOf, uptimeText } from '../components/host-view.js';
import { HostCard, isOnline } from '../components/host-card.js';
import { OsIcon, hostName } from '../components/host-name.js';
import { IconPicker } from '../components/icon-picker.js';

const seen = iso => (iso ? iso.slice(0, 19).replace('T', ' ') : '—');
// Per-viewer view choices. Storage can be missing or blocked (private window): the page works without it.
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } }
};
const VIEW_KEY = 'labctl.hosts.view';
const COLLAPSED_KEY = 'labctl.hosts.collapsed';
const UNGROUPED = '_ungrouped';
const Chevron = () => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
const Grid = () => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/></svg>`;

// Sections in group order, then Ungrouped. A host in several groups sits under its first one (groups come in group order).
function sectionsOf(rows, groups) {
  const by = new Map(groups.map(g => [g.id, []]));
  const loose = [];
  for (const h of rows) {
    const g = (h.groups || []).find(x => by.has(x.id));
    if (g) by.get(g.id).push(h); else loose.push(h);
  }
  return [...groups.map(g => ({ id: g.id, name: g.name, color: g.color, icon: g.icon, hosts: by.get(g.id) })),
    { id: UNGROUPED, name: 'Ungrouped', color: null, icon: null, hosts: loose }].filter(s => s.hosts.length);
}
// CPU, RAM, fullest disk and uptime from host.view. Offline hosts show their last reported values, dimmed.
function usageCells(h) {
  const v = h.view || {};
  const live = h.online || h.status === 'online';
  const hint = live ? '' : 'Last reported value, the host is offline';
  const fullest = (v.disks || []).reduce((a, d) => (d.percent !== null && (!a || d.percent > a.percent) ? d : a), null);
  return html`
    <td style=${{ opacity: live ? 1 : 0.6 }}><${MiniBar} percent=${v.cpu_percent} title=${hint || (has(v.cpu_cores) ? `${v.cpu_cores} cores` : '')}/></td>
    <td style=${{ opacity: live ? 1 : 0.6 }}><${MiniBar} percent=${v.ram?.percent} title=${hint || usedOf(v.ram?.used, v.ram?.total) || ''}/></td>
    <td style=${{ opacity: live ? 1 : 0.6 }}><${MiniBar} percent=${fullest?.percent} title=${hint || (fullest ? `Fullest: ${fullest.mount}` : '')}/></td>
    <td class="mono" style=${{ whiteSpace: 'nowrap', opacity: live ? 1 : 0.6 }} title=${hint}>${orDash(uptimeText(v.uptime_s))}</td>`;
}
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
  const [newGroupIcon, setNewGroupIcon] = useState(null);
  const [iconFor, setIconFor] = useState(null); // 'new' or a group id while the group icon picker is open
  const [redeploying, setRedeploying] = useState(null);
  const [view, setView] = useState(() => (store.get(VIEW_KEY, 'cards') === 'table' ? 'table' : 'cards'));
  const [collapsed, setCollapsed] = useState(() => new Set(store.get(COLLAPSED_KEY, [])));
  const pickView = v => { setView(v); store.set(VIEW_KEY, v); };
  const saveCollapsed = s => { setCollapsed(s); store.set(COLLAPSED_KEY, [...s]); };
  const toggleSection = id => { const n = new Set(collapsed); if (n.has(id)) n.delete(id); else n.add(id); saveCollapsed(n); };

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
    await api('/api/groups', { method: 'POST', body: { name: newGroupName, color: newGroupColor, icon: newGroupIcon }});
    setNewGroupName('');
    setNewGroupIcon(null);
    addToast('Group created');
    refresh();
  };
  const deleteGroup = async (id) => {
    await api(`/api/groups/${id}`, { method: 'DELETE' });
    addToast('Group deleted');
    refresh();
  };
  const setGroupIcon = async (id, icon) => {
    if (id === 'new') { setNewGroupIcon(icon); setIconFor(null); return; }
    try {
      await api(`/api/groups/${encodeURIComponent(id)}`, { method: 'PATCH', body: { icon } });
      addToast('Group icon saved');
      setIconFor(null);
      refresh();
    } catch (e) { addToast(e.message, 'error'); }
  };
  const deleteTag = async (id) => {
    await api(`/api/tags/${id}`, { method: 'DELETE' });
    addToast('Tag deleted');
    refresh();
  };

  const sections = sectionsOf(rows, groups);
  // The window reads the latest row, so a rename or icon change shows at once.
  const openHost = selectedHost && (rows.find(r => r.id === selectedHost.id) || selectedHost);
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

  const renderRow = (h) => html`<tr key=${h.id} class="host-row" tabIndex="0" aria-label=${`Open ${hostName(h)}`} onClick=${() => setSelectedHost(h)}
    onKeyDown=${e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setSelectedHost(h); } }}>
    <td onClick=${e => e.stopPropagation()}>
      <input type="checkbox" checked=${selected.has(h.id)} onChange=${() => toggle(h.id)} aria-label=${`Select ${hostName(h)}`}/>
    </td>
    <td><${StatusBadge} status=${h.online || h.status === 'online' ? 'online' : 'offline'}/></td>
    <td>
      <div style=${{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span class=${`row-icon ${isOnline(h) ? '' : 'is-off'}`}><${OsIcon} host=${h} size=${20}/></span>
        <div style=${{ minWidth: 0 }}>
          <strong>${hostName(h)}</strong>
          ${h.display_name && html`<div class="page-desc mono">${h.hostname}</div>`}
          ${(h.provider || h.region || h.plan) && html`<div class="page-desc">${[h.provider, h.region, h.plan].filter(Boolean).join(' / ')}</div>`}
        </div>
      </div>
    </td>
    <td>${h.kind}</td>
    <td>${h.os || '—'}</td>
    <td class="mono">${h.ip || h.view?.ip || '—'}</td>
    ${usageCells(h)}
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

      <${HostFilters} filters=${filters} onChange=${f => { setFilters(f); if (!Object.values(f).some(Boolean)) setFleet([]); }} options=${{ os: osOptions, groups, tags }}>
        <label class="checkbox-row select-all" title="Select every host shown">
          <input type="checkbox" aria-label="Select all hosts shown" checked=${allOn} onChange=${toggleAll}/> All
        </label>
        ${sections.length > 1 && html`<button class="btn btn-sm" onClick=${() => saveCollapsed(collapsed.size ? new Set() : new Set(sections.map(s => s.id)))}>
          ${collapsed.size ? 'Expand all' : 'Collapse all'}</button>`}
        <div class="view-seg" role="group" aria-label="View">
          <button class=${view === 'cards' ? 'on' : ''} aria-pressed=${view === 'cards'} title="Cards" aria-label="Card view" onClick=${() => pickView('cards')}><${Grid}/></button>
          <button class=${view === 'table' ? 'on' : ''} aria-pressed=${view === 'table'} title="Table" aria-label="Table view" onClick=${() => pickView('table')}><${Icons.List}/></button>
        </div>
      <//>
      ${fleet.length > 0 && html`<div style=${{ marginBottom: 12 }}>${fleet.map(k => html`<span key=${k} class="badge badge-pending" style=${{ marginRight: 8 }}>${FLEET_FILTERS[k].label}</span>`)}
        <button class="btn btn-sm" onClick=${() => setFleet([])}>Clear fleet filter</button></div>`}

      ${picked.length > 0 && html`<div class="card bulk-bar">
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

      ${sections.map(s => {
        const on = s.hosts.filter(isOnline).length;
        const open = !collapsed.has(s.id);
        const allSel = s.hosts.every(h => selected.has(h.id));
        const selSection = () => setSelected(prev => { const n = new Set(prev); s.hosts.forEach(h => (allSel ? n.delete(h.id) : n.add(h.id))); return n; });
        return html`<section key=${s.id} class="hsec">
          <div class="hsec-head">
            <button class="hsec-toggle" aria-expanded=${open} aria-controls=${`hsec-${s.id}`} onClick=${() => toggleSection(s.id)}>
              <span class=${`hsec-chev ${open ? '' : 'shut'}`}><${Chevron}/></span>
              <span class="hsec-icon" style=${{ color: s.color || 'var(--text-dim)' }}>
                ${s.icon ? html`<${OsIcon} id=${s.icon} size=${18}/>` : html`<span class="hsec-swatch" style=${{ background: s.color || 'var(--border)' }}/>`}
              </span>
              <span class="hsec-name">${s.name}</span>
              <span class="hsec-count">${s.hosts.length}</span>
            </button>
            <span class="hsec-summary">
              <span><span class="status-dot on"/> ${on} online</span>
              ${s.hosts.length - on > 0 && html`<span><span class="status-dot off"/> ${s.hosts.length - on} offline</span>`}
            </span>
            <label class="checkbox-row hsec-select"><input type="checkbox" checked=${allSel} onChange=${selSection} aria-label=${`Select all in ${s.name}`}/></label>
          </div>
          ${open && (view === 'cards'
            ? html`<div class="hgrid" id=${`hsec-${s.id}`}>${s.hosts.map(h => html`<${HostCard} key=${h.id} host=${h} selected=${selected.has(h.id)}
                onToggle=${() => toggle(h.id)} onOpen=${() => setSelectedHost(h)} canEdit=${canEdit} isAdmin=${isAdmin} addToast=${addToast}
                onSettings=${() => setSettingsHost(h)} onRedeploy=${() => setRedeploying(h)} onRemove=${() => setRemoving([h])} onChanged=${refresh}/>`)}</div>`
            : html`<div class="card hsec-table" id=${`hsec-${s.id}`}><div class="table-wrap"><table>
                <thead><tr>
                  <th style=${{ width: 28 }}><span class="sr-only">Select</span></th>
                  <th>Status</th><th>Host</th><th>Kind</th><th>OS</th><th>Address</th><th>CPU</th><th>RAM</th><th>Disk</th><th>Uptime</th><th>Agent version</th><th>Tags</th><th>Groups</th><th>Last seen</th><th><span class="sr-only">Actions</span></th>
                </tr></thead>
                <tbody>${s.hosts.map(renderRow)}</tbody>
              </table></div></div>`)}
        </section>`;
      })}
      ${rows.length === 0 && html`<div class="card empty-state">
        <${Icons.Server}/>
        <div class="empty-state-title">${hosts.length === 0 ? 'No hosts yet' : 'No host matches the filters'}</div>
        <div class="empty-state-desc">${hosts.length === 0 ? 'Deploy the agent on your machines or add an SSH host.' : 'Change the search or clear the filters.'}</div>
      </div>`}

      
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
                    html`<button key=${c} type="button" aria-label=${`Colour ${c}`} aria-pressed=${newGroupColor === c} onClick=${() => setNewGroupColor(c)} style=${{
                      width: 24, height: 24, borderRadius: 4, background: c, cursor: 'pointer', padding: 0,
                      border: newGroupColor === c ? '2px solid var(--text-primary)' : '2px solid transparent'
                    }}/>`
                  ))}
                </div>
              </div>
              <div class="form-group" style=${{ flex: 0 }}>
                <label class="form-label">Icon</label>
                <button class="btn icon-pick-btn" aria-label="Choose an icon for the new group" onClick=${() => setIconFor('new')}>
                  ${newGroupIcon ? html`<${OsIcon} id=${newGroupIcon} size=${18}/>` : 'None'}
                </button>
              </div>
              <div class="form-group" style=${{ flex: 0, alignSelf: 'flex-end' }}>
                <button class="btn btn-primary" onClick=${addGroup}>Add</button>
              </div>
            </div>
          </div>

          ${groups.length > 0 && (
            html`<div class="table-wrap">
              <table>
                <thead><tr><th>Color</th><th>Icon</th><th>Name</th><th>Hosts</th><th>Actions</th></tr></thead>
                <tbody>
                  ${groups.map(g => (
                    html`<tr key=${g.id}>
                      <td><span style=${{ display: 'inline-block', width: 16, height: 16, borderRadius: 3, background: g.color }}/></td>
                      <td><button class="btn btn-sm icon-pick-btn" style=${{ color: g.color }} aria-label=${`Change the icon of ${g.name}`} onClick=${() => setIconFor(g.id)}>
                        ${g.icon ? html`<${OsIcon} id=${g.icon} size=${18}/>` : html`<span style=${{ color: 'var(--text-dim)' }}>None</span>`}
                      </button></td>
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

      ${openHost && (
        html`<${HostDetailModal} host=${openHost} onClose=${() => setSelectedHost(null)} addToast=${addToast}
          isAdmin=${isAdmin} canEdit=${canEdit} onChanged=${refresh} onSettings=${() => setSettingsHost(openHost)}/>`
      )}

      ${redeploying && html`<${RedeployDialog} host=${redeploying} isAdmin=${isAdmin} addToast=${addToast}
        onClose=${() => setRedeploying(null)} onDone=${refresh}/>`}

      ${iconFor && html`<${IconPicker} title=${iconFor === 'new' ? 'Icon for the new group' : `Icon for ${groups.find(g => g.id === iconFor)?.name || 'group'}`}
        current=${iconFor === 'new' ? newGroupIcon : groups.find(g => g.id === iconFor)?.icon || null}
        onPick=${icon => setGroupIcon(iconFor, icon)} onClose=${() => setIconFor(null)}/>`}
    </div>`
  );
}

// Extra button the shell shows in the top bar while this page is open.
export function Toolbar() {
  return html`<button class="btn top-manage" onClick=${() => window.dispatchEvent(new Event('labctl:manage-groups'))}>
    <${Icons.Settings}/> Manage Groups
  </button>`;
}
