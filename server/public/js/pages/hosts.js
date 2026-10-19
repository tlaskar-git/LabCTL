import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons, StatusBadge, Modal } from '../ui.js';
import { HostDetailModal } from '../components/host-detail-modal.js';

// ── Hosts Overview ────────────────────────────────────────
export default function HostsPage({ hosts, onSelectHost, addToast }) {
  const online = hosts.filter(h => h.online || h.status === 'online').length;
  const [groups, setGroups] = useState([]);
  const [showManageGroups, setShowManageGroups] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupColor, setNewGroupColor] = useState('#3b82f6');
  const [assigningHost, setAssigningHost] = useState(null);
  const [selectedHost, setSelectedHost] = useState(null);

  const GROUP_COLORS = ['#3b82f6','#22c55e','#f97316','#a855f7','#ef4444','#eab308','#06b6d4','#ec4899'];

  const loadGroups = async () => {
    try { setGroups(await api('/api/groups')); } catch(e) { console.error(e); }
  };

  useEffect(() => { loadGroups(); }, []);
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
    loadGroups();
  };

  const deleteGroup = async (id) => {
    await api(`/api/groups/${id}`, { method: 'DELETE' });
    addToast('Group deleted');
    loadGroups();
  };

  const assignHost = async (hostId, groupId) => {
    await api(`/api/hosts/${hostId}/group`, { method: 'PUT', body: { group_id: groupId }});
    setAssigningHost(null);
    addToast('Host assigned');
  };

  // Group hosts
  const grouped = {};
  const ungrouped = [];
  hosts.forEach(host => {
    const gid = host.group_id;
    if (gid && groups.find(g => g.id === gid)) {
      if (!grouped[gid]) grouped[gid] = [];
      grouped[gid].push(host);
    } else {
      ungrouped.push(host);
    }
  });

  const renderHostCard = (host) => {
    const info = host.system_info || {};
    const isOnline = host.online || host.status === 'online';
    return (
      html`<div key=${host.id} class="host-card" style=${{ position: 'relative' }}
        onClick=${() => setSelectedHost(host)}>
        <div style=${{ position: 'absolute', top: 8, right: 8 }}>
          <button class="btn btn-sm" style=${{ padding: '2px 6px', fontSize: 10 }}
            onClick=${(e) => { e.stopPropagation(); setAssigningHost(host); }}
            title="Assign to group">
            <${Icons.Settings}/>
          </button>
        </div>
        <div class="host-name">
          <${StatusBadge} status=${isOnline ? 'online' : 'offline'}/>
          ${host.hostname}
        </div>
        <div class="host-os">${host.os} · ${host.ip || info.ip || '\u2014'}</div>
        <div class="host-stats">
          <div class="host-stat">CPU <strong>${info.cpus || '?'} cores</strong></div>
          <div class="host-stat">RAM <strong>${info.ram_mb ? `${Math.round(info.ram_mb/1024)}GB` : '?'}</strong></div>
          <div class="host-stat">Disk <strong>${info.disk_free_gb != null ? `${info.disk_free_gb}GB free` : '?'}</strong></div>
          <div class="host-stat">Up <strong>${info.uptime_hours ? `${info.uptime_hours}h` : '?'}</strong></div>
          ${info.docker_running != null && (
            html`<div class="host-stat">Docker <strong>${info.docker_running} running</strong></div>`
          )}
        </div>
      </div>`
    );
  };

  return (
    html`<div>
      <div class="page-header">
        <div>
          <div class="page-title">Hosts</div>
          <div class="page-desc">${hosts.length} registered, ${online} online</div>
        </div>
      </div>

      ${groups.map(group => {
        const groupHosts = grouped[group.id] || [];
        if (groupHosts.length === 0) return null;
        return (
          html`<div key=${group.id} style=${{ marginBottom: 24 }}>
            <div style=${{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
              paddingBottom: 8, borderBottom: `2px solid ${group.color}`
            }}>
              <span style=${{
                width: 12, height: 12, borderRadius: 3, background: group.color, flexShrink: 0
              }}/>
              <span style=${{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>${group.name}</span>
              <span style=${{ fontSize: 12, color: 'var(--text-dim)' }}>${groupHosts.length} host${groupHosts.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="hosts-grid">
              ${groupHosts.map(renderHostCard)}
            </div>
          </div>`
        );
      })}

      ${ungrouped.length > 0 && (
        html`<div style=${{ marginBottom: 24 }}>
          ${groups.length > 0 && (
            html`<div style=${{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
              paddingBottom: 8, borderBottom: '2px solid var(--border)'
            }}>
              <span style=${{ fontSize: 14, fontWeight: 700, color: 'var(--text-dim)' }}>Ungrouped</span>
              <span style=${{ fontSize: 12, color: 'var(--text-dim)' }}>${ungrouped.length} host${ungrouped.length !== 1 ? 's' : ''}</span>
            </div>`
          )}
          <div class="hosts-grid">
            ${ungrouped.map(renderHostCard)}
          </div>
        </div>`
      )}

      ${hosts.length === 0 && (
        html`<div class="card" style=${{ textAlign: 'center', color: 'var(--text-dim)', padding: 40 }}>
          No hosts registered. Deploy the agent on your machines to get started.
        </div>`
      )}

      
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
                      <td>${(grouped[g.id] || []).length}</td>
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
        <//>`
      )}

      
      ${assigningHost && (
        html`<${Modal} title=${`Assign: ${assigningHost.hostname}`} onClose=${() => setAssigningHost(null)}>
          <div style=${{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div
              onClick=${() => assignHost(assigningHost.id, null)}
              style=${{
                padding: '10px 14px', borderRadius: 6, cursor: 'pointer',
                background: !assigningHost.group_id ? 'rgba(59,130,246,0.1)' : 'var(--bg-input)',
                border: `1px solid ${!assigningHost.group_id ? 'var(--accent)' : 'var(--border)'}`,
                fontSize: 13
              }}>
              No group (ungrouped)
            </div>
            ${groups.map(g => (
              html`<div key=${g.id}
                onClick=${() => assignHost(assigningHost.id, g.id)}
                style=${{
                  padding: '10px 14px', borderRadius: 6, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 10,
                  background: assigningHost.group_id === g.id ? 'rgba(59,130,246,0.1)' : 'var(--bg-input)',
                  border: `1px solid ${assigningHost.group_id === g.id ? 'var(--accent)' : 'var(--border)'}`,
                  fontSize: 13
                }}>
                <span style=${{ width: 12, height: 12, borderRadius: 3, background: g.color, flexShrink: 0 }}/>
                ${g.name}
              </div>`
            ))}
          </div>
          ${groups.length === 0 && (
            html`<div style=${{ color: 'var(--text-dim)', fontSize: 13, marginTop: 12 }}>
              Create groups first via "Manage Groups" on the Hosts page.
            </div>`
          )}
        <//>`
      )}

      
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
