import { useState, useEffect, useRef } from 'preact/hooks';
import { api, API, downloadBlob } from '../api.js';
import { html, Icons, StatusBadge, Modal } from '../ui.js';
import { JOB_TYPES } from '../job-types.js';
import { openJobDrawer } from '../job-drawer.js';
import { fmtDuration } from '../components/job-tiles.js';

const OPEN = ['pending', 'sent', 'running', 'waiting'];
const TAIL = 16384;
const TRACKED_KEY = 'labctl.actions.tracked';
const bytesText = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const logUrl = (id, from) => `${API}/api/jobs/${encodeURIComponent(id)}/log${from === undefined ? '' : `?from=${from}`}`;

// Output of one job read from the server log (the last 16 KB), refreshed every 1.5 s while the job is open.
// shortcut: plain text without stdout/stderr colours, the drawer has the full terminal.
function LogTail({ job }) {
  const [text, setText] = useState(null);
  const total = useRef(job.bytes_received || 0); // log size from the last read (X-Log-Total)
  const open = OPEN.includes(job.status);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const from = Math.max(0, total.current - TAIL);
        const res = await fetch(logUrl(job.id, from), { credentials: 'same-origin' });
        if (!res.ok || stop) return;
        const size = Number(res.headers.get('X-Log-Total')) || 0;
        const body = await res.text();
        if (!body && size > 0 && from >= size) { total.current = size; return load(); } // the guess was past the end
        total.current = size;
        setText(body);
      } catch { /* next tick */ }
    };
    load();
    if (!open) return () => { stop = true; };
    const i = setInterval(load, 1500);
    return () => { stop = true; clearInterval(i); };
  }, [job.id, open]);
  if (text === null) return html`<div style=${{ fontSize: 11, color: 'var(--text-dim)' }}>Loading output...</div>`;
  if (!text) {
    if (open) return null;
    return html`<div style=${{ fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic' }}>No output</div>`;
  }
  return html`<div class="output-log" style=${{ maxHeight: 220, fontSize: 11 }}
    ref=${el => { if (el && open) el.scrollTop = el.scrollHeight; }}>${text}</div>`;
}

// One job on the Actions page: status line, why it waits, live output, and links to the drawer and the full log.
function JobCard({ job, onCancel }) {
  const open = OPEN.includes(job.status);
  const start = job.started_at || job.created_at;
  const elapsed = start ? (open ? Date.now() - new Date(start) : (job.duration_ms ?? (job.completed_at ? new Date(job.completed_at) - new Date(start) : null))) : null;
  const download = async () => {
    const res = await fetch(logUrl(job.id), { credentials: 'same-origin' });
    if (res.ok) downloadBlob(await res.text(), `${job.hostname}-${job.type}-${job.id.slice(0, 8)}.log`);
  };
  const sentFor = job.status === 'sent' && job.sent_at ? Math.round((Date.now() - new Date(job.sent_at)) / 1000) : null;
  return html`<div style=${{
    background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, borderLeftWidth: 3,
    borderLeftColor: job.status === 'completed' ? 'var(--green)' : job.status === 'failed' ? 'var(--red)' : job.status === 'running' ? 'var(--accent)' : 'var(--yellow)'
  }}>
    <div style=${{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
      <${StatusBadge} status=${job.status}/>
      <span style=${{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}>${job.type}</span>
      <span style=${{ fontSize: 11, color: 'var(--text-secondary)' }}>${job.hostname}</span>
      <span style=${{ fontSize: 11, color: 'var(--text-dim)' }}>
        ${fmtDuration(elapsed)} · ${bytesText(job.bytes_received || 0)} · exit ${job.exit_code ?? '-'}
      </span>
      <div style=${{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
        ${open && html`<button class="btn btn-sm ${job.status === 'running' ? 'btn-danger' : ''}" style=${{ padding: '1px 8px' }} onClick=${() => onCancel(job)}>${job.status === 'running' ? 'Stop' : 'Cancel'}</button>`}
        <button class="btn btn-sm" style=${{ padding: '1px 8px' }} onClick=${() => openJobDrawer(job.id)}><${Icons.Eye}/> Open in the drawer</button>
        <button class="btn btn-sm" style=${{ padding: '1px 8px' }} onClick=${download}><${Icons.Download}/> Download</button>
      </div>
    </div>
    ${job.error && html`<div style=${{ color: 'var(--red)', fontSize: 12, marginBottom: 6 }}>${job.error}</div>`}
    ${sentFor !== null && !job.bytes_received && html`<div style=${{ fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic', marginBottom: 6 }}>Sent to the agent, waiting for the first output (${sentFor} s)</div>`}
    ${job.status === 'pending' && !job.error && html`<div style=${{ fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic', marginBottom: 6 }}>Queued, waiting for the agent</div>`}
    <${LogTail} key=${job.id} job=${job}/>
  </div>`;
}

function JobCards({ jobs, setJobs }) {
  const cancel = async job => {
    await api(`/api/jobs/${job.id}/cancel`, { method: 'POST' });
    setJobs(prev => prev.map(j => (j.id === job.id ? { ...j, status: 'cancelled' } : j)));
  };
  return html`<div style=${{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    ${jobs.map(job => html`<${JobCard} key=${job.id} job=${job} onCancel=${cancel}/>`)}
  </div>`;
}

// ── Actions Page ──────────────────────────────────────────
export default function ActionsPage({ hosts, addToast }) {
  const [selectedHosts, setSelectedHosts] = useState([]);
  const [showJobModal, setShowJobModal] = useState(null);
  const [jobParams, setJobParams] = useState({});
  const [groups, setGroups] = useState([]);
  const [trackedJobs, setTrackedJobs] = useState([]);
  const [modalJobs, setModalJobs] = useState([]);
  const outputRef = useRef(null);

  useEffect(() => { api('/api/groups').then(setGroups).catch(() => {}); }, []);

  // The background panel survives a page refresh: its job ids are kept for this browser tab.
  useEffect(() => {
    let ids = [];
    try { ids = JSON.parse(sessionStorage.getItem(TRACKED_KEY) || '[]'); } catch { /* storage blocked */ }
    if (ids.length) Promise.all(ids.map(id => api(`/api/jobs/${id}?log=0`).catch(() => null))).then(js => setTrackedJobs(js.filter(Boolean)));
  }, []);
  useEffect(() => {
    try { sessionStorage.setItem(TRACKED_KEY, JSON.stringify(trackedJobs.map(j => j.id).slice(0, 50))); } catch { /* storage blocked */ }
  }, [trackedJobs.map(j => j.id).join()]);

  // Poll job status (output comes from the log, see LogTail). ?log=0: result carries only the parsed result.
  const poll = (list, setList) => () => {
    if (!list.some(j => OPEN.includes(j.status))) return;
    const i = setInterval(async () => {
      const fresh = await Promise.all(list.map(j => api(`/api/jobs/${j.id}?log=0`).catch(() => j)));
      setList(prev => prev.map(j => fresh.find(f => f.id === j.id) || j)); // merge: jobs added meanwhile stay
    }, 2000);
    return () => clearInterval(i);
  };
  useEffect(poll(trackedJobs, setTrackedJobs), [trackedJobs]);
  useEffect(poll(modalJobs, setModalJobs), [modalJobs]);

  // When closing modal, move modal jobs to background panel
  const closeModal = () => {
    if (modalJobs.length > 0) {
      setTrackedJobs(prev => [...modalJobs, ...prev]);
    }
    setModalJobs([]);
    setShowJobModal(null);
    setJobParams({});
  };

  const toggleHost = (id) => {
    setSelectedHosts(prev =>
      prev.includes(id) ? prev.filter(h => h !== id) : [...prev, id]
    );
  };

  const selectAll = () => setSelectedHosts(hosts.map(h => h.id));
  const selectNone = () => setSelectedHosts([]);
  const selectGroup = (groupId) => {
    const groupHostIds = hosts.filter(h => h.group_id === groupId).map(h => h.id);
    setSelectedHosts(prev => {
      const allSelected = groupHostIds.every(id => prev.includes(id));
      if (allSelected) return prev.filter(id => !groupHostIds.includes(id));
      return [...new Set([...prev, ...groupHostIds])];
    });
  };

  // Group hosts for display
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

  const renderHostChip = (host) => (
    html`<div key=${host.id}
      class="checkbox-row"
      onClick=${() => toggleHost(host.id)}
      style=${{
        background: selectedHosts.includes(host.id) ? 'rgba(59,130,246,0.1)' : 'var(--bg-input)',
        border: `1px solid ${selectedHosts.includes(host.id) ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 6, padding: '6px 10px', fontSize: 12
      }}>
      <div class=${`checkbox ${selectedHosts.includes(host.id) ? 'checked' : ''}`}>
        ${selectedHosts.includes(host.id) && html`<span style=${{ color: 'white', fontSize: 10 }}>✓</span>`}
      </div>
      <span>${host.hostname}</span>
      <${StatusBadge} status=${host.online ? 'online' : 'offline'}/>
    </div>`
  );

  const submitJob = async (jobType) => {
    if (selectedHosts.length === 0) {
      addToast('Select at least one host.', 'error');
      return;
    }

    const meta = JOB_TYPES[jobType];
    let targetIds = [...selectedHosts];

    // Filter hosts by OS compatibility
    if (meta && meta.os !== 'all') {
      const compatible = [];
      const skipped = [];
      for (const hid of selectedHosts) {
        const h = hosts.find(x => x.id === hid);
        const isWin = (h?.os || '').toLowerCase().includes('windows');
        if (meta.os === 'windows' && !isWin) { skipped.push(h?.hostname || hid); }
        else if (meta.os === 'linux' && isWin) { skipped.push(h?.hostname || hid); }
        else { compatible.push(hid); }
      }
      if (skipped.length > 0) {
        addToast(`Skipped ${skipped.join(', ')} (not ${meta.os}). Running on ${compatible.length} compatible host(s).`, 'error');
      }
      if (compatible.length === 0) {
        addToast(`No ${meta.os} hosts selected. ${meta.label} requires ${meta.os}.`, 'error');
        return;
      }
      targetIds = compatible;
    }

    const res = await api('/api/jobs/batch', {
      method: 'POST',
      body: {
        host_ids: targetIds,
        type: jobType,
        params: jobParams
      }
    });

    // Add to modal jobs (shown inside the modal)
    const newJobs = res.map(j => ({ ...j, type: jobType, status: 'pending', result: '', error: '', hostname: hosts.find(h => h.id === j.host_id)?.hostname || j.host_id }));
    setModalJobs(prev => [...newJobs, ...prev]);
    setJobParams({});
    if (res.length) openJobDrawer(res.length === 1 ? res[0].id : res[0].group_id); // live output, or the host grid for several hosts
  };

  const submitChain = async () => {
    const newJobs = [];
    for (const hid of selectedHosts) {
      const res = await api('/api/chains/proxmox-backup-all', {
        method: 'POST',
        body: {
          host_ids: [hid],
          script: jobParams.script || '/root/proxmox-vm-backup.sh',
          reboot_after: jobParams.reboot_after || false
        }
      });
      res.forEach(j => newJobs.push({ ...j, type: 'backup', status: 'pending', result: '', error: '', hostname: hosts.find(h => h.id === j.host_id)?.hostname || j.host_id }));
    }
    setModalJobs(prev => [...newJobs, ...prev]);
    setJobParams({});
    if (newJobs.length === 1) openJobDrawer(newJobs[0].id);
  };

  return (
    html`<div>
      <div class="page-header">
        <div>
          <div class="page-title">Actions</div>
          <div class="page-desc">Run tasks across your hosts</div>
        </div>
      </div>

      
      <div class="card">
        <div class="card-header">
          <span class="card-title">Select Hosts (${selectedHosts.length}/${hosts.length})</span>
          <div class="btn-group">
            <button class="btn btn-sm" onClick=${selectAll}>All</button>
            <button class="btn btn-sm" onClick=${selectNone}>None</button>
          </div>
        </div>

        ${groups.map(group => {
          const groupHosts = grouped[group.id] || [];
          if (groupHosts.length === 0) return null;
          const allSelected = groupHosts.every(h => selectedHosts.includes(h.id));
          return (
            html`<div key=${group.id} style=${{ marginBottom: 12 }}>
              <div style=${{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer' }}
                onClick=${() => selectGroup(group.id)}>
                <span style=${{ width: 10, height: 10, borderRadius: 2, background: group.color, flexShrink: 0 }}/>
                <span style=${{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  ${group.name}
                </span>
                <span style=${{ fontSize: 10, color: allSelected ? 'var(--accent)' : 'var(--text-dim)' }}>
                  ${allSelected ? '(all selected)' : `(click to ${allSelected ? 'deselect' : 'select'} all)`}
                </span>
              </div>
              <div style=${{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingLeft: 18 }}>
                ${groupHosts.map(renderHostChip)}
              </div>
            </div>`
          );
        })}

        ${ungrouped.length > 0 && (
          html`<div style=${{ marginBottom: 8 }}>
            ${groups.length > 0 && (
              html`<div style=${{ marginBottom: 6 }}>
                <span style=${{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Ungrouped
                </span>
              </div>`
            )}
            <div style=${{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingLeft: groups.length > 0 ? 18 : 0 }}>
              ${ungrouped.map(renderHostChip)}
            </div>
          </div>`
        )}
      </div>

      
      ${(() => {
        const selHosts = hosts.filter(h => selectedHosts.includes(h.id));
        const hasWindows = selHosts.some(h => (h.os || '').toLowerCase().includes('windows'));
        const hasLinux = selHosts.some(h => !(h.os || '').toLowerCase().includes('windows'));
        const noSelection = selHosts.length === 0;
        return (
          html`<div class="actions-grid">
            ${Object.entries(JOB_TYPES).map(([key, meta]) => {
              const show = noSelection || meta.os === 'all' ||
                (meta.os === 'windows' && hasWindows) ||
                (meta.os === 'linux' && hasLinux);
              if (!show) return null;
              const Icon = meta.icon;
              return (
                html`<div key=${key} class="action-tile" onClick=${() => {
                  if (selectedHosts.length === 0) { addToast('Select at least one host.', 'error'); return; }
                  if (meta.os === 'windows' && !hasWindows) { addToast('No Windows hosts selected.', 'error'); return; }
                  if (meta.os === 'linux' && !hasLinux) { addToast('No Linux hosts selected.', 'error'); return; }
                  setShowJobModal(key);
                }}>
                  <${Icon}/>
                  <div class="action-tile-label">${meta.label}</div>
                  <div class="action-tile-desc">${meta.os === 'all' ? 'All OS' : meta.os}</div>
                </div>`
              );
            })}
            <div class="action-tile" onClick=${() => setShowJobModal('_backup_chain')}>
              <${Icons.HardDrive}/>
              <div class="action-tile-label">Backup + Reboot Chain</div>
              <div class="action-tile-desc">Proxmox backup, reboot, autologin</div>
            </div>
          </div>`
        );
      })()}

      
      ${showJobModal && showJobModal !== '_backup_chain' && (
        html`<${Modal} title=${`Run: ${JOB_TYPES[showJobModal]?.label}`} onClose=${closeModal}>
          <div style=${{ marginBottom: 16, color: 'var(--text-dim)', fontSize: 13 }}>
            Targets: ${selectedHosts.length} host(s) selected
          </div>

          ${showJobModal === 'windows_update' && (
            html`<div class="form-group" style=${{ marginBottom: 16 }}>
              <div class="checkbox-row" onClick=${() => setJobParams(p => ({ ...p, reboot: !p.reboot }))}>
                <div class=${`checkbox ${jobParams.reboot ? 'checked' : ''}`}>
                  ${jobParams.reboot && html`<span style=${{ color: 'white', fontSize: 10 }}>✓</span>`}
                </div>
                Reboot after update
              </div>
            </div>`
          )}

          ${showJobModal === 'linux_update' && (
            html`<div class="form-group" style=${{ marginBottom: 16 }}>
              <div class="checkbox-row" onClick=${() => setJobParams(p => ({ ...p, reboot: !p.reboot }))}>
                <div class=${`checkbox ${jobParams.reboot ? 'checked' : ''}`}>
                  ${jobParams.reboot && html`<span style=${{ color: 'white', fontSize: 10 }}>✓</span>`}
                </div>
                Reboot if required
              </div>
            </div>`
          )}

          ${showJobModal === 'docker_update' && (() => {
            const selHosts = hosts.filter(h => selectedHosts.includes(h.id));
            const allContainers = selHosts.flatMap(h => (h.system_info?.docker_containers || []).map(c => ({ host: h.hostname, name: c })));
            const selectedContainers = jobParams.containers || [];
            const toggleContainer = (name) => {
              const cur = jobParams.containers || [];
              setJobParams(p => ({ ...p, containers: cur.includes(name) ? cur.filter(c => c !== name) : [...cur, name] }));
            };
            return (
              html`<div style=${{ marginBottom: 16 }}>
                <div class="form-group" style=${{ marginBottom: 12 }}>
                  <label class="form-label">Containers</label>
                  <div style=${{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 6 }}>Select specific containers or leave all unchecked to update everything.</div>
                  <div style=${{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 8, background: 'var(--bg-input)' }}>
                    ${allContainers.length > 0 ? allContainers.map((c, i) => (
                      html`<div key=${i} class="checkbox-row" onClick=${() => toggleContainer(c.name)} style=${{ marginBottom: 4 }}>
                        <div class=${`checkbox ${selectedContainers.includes(c.name) ? 'checked' : ''}`}>
                          ${selectedContainers.includes(c.name) && html`<span style=${{ color: 'white', fontSize: 10 }}>✓</span>`}
                        </div>
                        <span style=${{ fontSize: 12, fontFamily: 'Geist Mono, monospace' }}>${c.name}</span>
                        <span style=${{ fontSize: 10, color: 'var(--text-dim)' }}>(${c.host})</span>
                      </div>`
                    )) : html`<div style=${{ fontSize: 12, color: 'var(--text-dim)' }}>No containers detected on selected hosts.</div>`}
                  </div>
                </div>
                <div class="form-group">
                  <label class="form-label">Compose Directory (optional)</label>
                  <input class="input" placeholder="/opt/stacks/myapp"
                    value=${jobParams.compose_dir || ''}
                    onInput=${e => setJobParams(p => ({ ...p, compose_dir: e.target.value }))}/>
                </div>
                <div class="checkbox-row" onClick=${() => setJobParams(p => ({ ...p, restart: p.restart === false ? true : (p.restart === true ? false : false) }))}
                  style=${{ marginTop: 10 }}>
                  <div class=${`checkbox ${jobParams.restart !== false ? 'checked' : ''}`}>
                    ${jobParams.restart !== false && html`<span style=${{ color: 'white', fontSize: 10 }}>✓</span>`}
                  </div>
                  <span style=${{ fontSize: 12 }}>Restart containers after pull (auto-detects compose project)</span>
                </div>
              </div>`
            );
          })()}

          ${showJobModal === 'backup' && (
            html`<div class="form-group" style=${{ marginBottom: 16 }}>
              <label class="form-label">Backup Script Path</label>
              <input class="input" placeholder="/root/proxmox-vm-backup.sh"
                value=${jobParams.script || ''}
                onInput=${e => setJobParams(p => ({ ...p, script: e.target.value }))}/>
            </div>`
          )}

          ${showJobModal === 'autologin' && (() => {
            const selHost = hosts.find(h => selectedHosts.includes(h.id));
            const detectedDomain = selHost?.system_info?.domain || '';
            if (!jobParams._domainInit && detectedDomain) {
              setTimeout(() => setJobParams(p => ({ ...p, domain: detectedDomain, _domainInit: true })), 0);
            }
            return (
              html`
                <div class="form-row">
                  <div class="form-group">
                    <label class="form-label">Username</label>
                    <input class="input" placeholder="User Name"
                      value=${jobParams.username || ''}
                      onInput=${e => setJobParams(p => ({ ...p, username: e.target.value }))}/>
                  </div>
                  <div class="form-group">
                    <label class="form-label">Password</label>
                    <input class="input" type="password"
                      value=${jobParams.password || ''}
                      onInput=${e => setJobParams(p => ({ ...p, password: e.target.value }))}/>
                  </div>
                </div>
                <div class="form-group" style=${{ marginBottom: 16 }}>
                  <label class="form-label">Domain ${detectedDomain && html`<span style=${{ color: 'var(--green)', fontSize: 10 }}>(auto-detected)</span>`}</label>
                  <input class="input"
                    value=${jobParams.domain || ''}
                    onInput=${e => setJobParams(p => ({ ...p, domain: e.target.value }))}/>
                </div>
              `
            );
          })()}

          ${showJobModal === 'custom_command' && (
            html`<div class="form-group" style=${{ marginBottom: 16 }}>
              <label class="form-label">Command</label>
              <textarea class="textarea" rows=${3}
                placeholder="e.g., systemctl status nginx"
                value=${jobParams.command || ''}
                onInput=${e => setJobParams(p => ({ ...p, command: e.target.value }))}/>
            </div>`
          )}

          ${showJobModal === 'service_control' && (() => {
            const selHosts = hosts.filter(h => selectedHosts.includes(h.id));
            const allServices = [...new Set(selHosts.flatMap(h => h.system_info?.services || []))].sort();
            const selectedServices = jobParams.services || [];
            const toggleService = (name) => {
              const cur = jobParams.services || [];
              setJobParams(p => ({ ...p, services: cur.includes(name) ? cur.filter(s => s !== name) : [...cur, name] }));
            };
            return (
              html`<div style=${{ marginBottom: 16 }}>
                <div class="form-group" style=${{ marginBottom: 12 }}>
                  <label class="form-label">Services</label>
                  ${allServices.length > 0 ? (
                    html`<div style=${{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 8, background: 'var(--bg-input)' }}>
                      ${allServices.map(s => (
                        html`<div key=${s} class="checkbox-row" onClick=${() => toggleService(s)} style=${{ marginBottom: 3 }}>
                          <div class=${`checkbox ${selectedServices.includes(s) ? 'checked' : ''}`}>
                            ${selectedServices.includes(s) && html`<span style=${{ color: 'white', fontSize: 10 }}>✓</span>`}
                          </div>
                          <span style=${{ fontSize: 12, fontFamily: 'Geist Mono, monospace' }}>${s}</span>
                        </div>`
                      ))}
                    </div>`
                  ) : (
                    html`<input class="input" placeholder="Service name (comma-separated for multiple)"
                      value=${jobParams.service || ''}
                      onInput=${e => setJobParams(p => ({ ...p, service: e.target.value }))}/>`
                  )}
                </div>
                <div class="form-group">
                  <label class="form-label">Action</label>
                  <select class="select input"
                    value=${jobParams.action || 'status'}
                    onChange=${e => setJobParams(p => ({ ...p, action: e.target.value }))}>
                    <option value="status">Status</option>
                    <option value="start">Start</option>
                    <option value="stop">Stop</option>
                    <option value="restart">Restart</option>
                  </select>
                </div>
              </div>`
            );
          })()}

          ${showJobModal === 'reboot' && (
            html`<div class="form-group" style=${{ marginBottom: 16 }}>
              <label class="form-label">Delay (seconds)</label>
              <input class="input" type="number" placeholder="30"
                value=${jobParams.delay || 30}
                onInput=${e => setJobParams(p => ({ ...p, delay: parseInt(e.target.value) || 30 }))}/>
            </div>`
          )}

          ${showJobModal === 'disk_cleanup' && (() => {
            const selHosts = hosts.filter(h => selectedHosts.includes(h.id));
            const hasWindows = selHosts.some(h => (h.os || '').toLowerCase().includes('windows'));
            const hasLinux = selHosts.some(h => !(h.os || '').toLowerCase().includes('windows'));
            const opts = jobParams.options || [];
            const toggleOpt = (opt) => {
              const cur = jobParams.options || [];
              setJobParams(p => ({ ...p, options: cur.includes(opt) ? cur.filter(o => o !== opt) : [...cur, opt] }));
            };
            return (
              html`<div style=${{ marginBottom: 16 }}>
                ${hasWindows && (
                  html`<div style=${{ marginBottom: 12 }}>
                    <div style=${{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>Windows Cleanup</div>
                    ${[
                      ['temp','Temp Files (User + System)'],
                      ['windows_update_cache','Windows Update Cache'],
                      ['recycle_bin','Recycle Bin'],
                      ['event_logs','Event Logs'],
                      ['prefetch','Prefetch Files'],
                      ['thumbnails','Thumbnail Cache'],
                      ['delivery_optimization','Delivery Optimization Cache'],
                      ['cbs_logs','CBS Logs (Component Store)'],
                      ['font_cache','Font Cache'],
                      ['error_reports','Windows Error Reports'],
                      ['installer_cache','Old Installer Cache ($WINDOWS.~BT)'],
                      ['memory_dumps','Memory Dump Files'],
                    ].map(([k,v]) => (
                      html`<div key=${k} class="checkbox-row" onClick=${() => toggleOpt(k)} style=${{ marginBottom: 4 }}>
                        <div class=${`checkbox ${opts.includes(k) ? 'checked' : ''}`}>
                          ${opts.includes(k) && html`<span style=${{ color: 'white', fontSize: 10 }}>✓</span>`}
                        </div>
                        <span style=${{ fontSize: 12 }}>${v}</span>
                      </div>`
                    ))}
                  </div>`
                )}
                ${hasLinux && (
                  html`<div>
                    <div style=${{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>Linux Cleanup</div>
                    ${[
                      ['apt_cache','APT Cache + Autoremove'],
                      ['journal','Journal Logs (older than 7d)'],
                      ['docker_prune','Docker Prune (images, volumes, networks)'],
                      ['tmp','Temp Files (/tmp)'],
                      ['old_kernels','Old Kernels'],
                      ['snap_cache','Snap Cache (old revisions)'],
                      ['pip_cache','Pip Cache'],
                      ['log_rotate','Force Log Rotation + Compress'],
                      ['coredumps','Core Dumps'],
                      ['thumbnail_cache','Thumbnail Cache (~/.cache/thumbnails)'],
                      ['trash','User Trash (~/.local/share/Trash)'],
                    ].map(([k,v]) => (
                      html`<div key=${k} class="checkbox-row" onClick=${() => toggleOpt(k)} style=${{ marginBottom: 4 }}>
                        <div class=${`checkbox ${opts.includes(k) ? 'checked' : ''}`}>
                          ${opts.includes(k) && html`<span style=${{ color: 'white', fontSize: 10 }}>✓</span>`}
                        </div>
                        <span style=${{ fontSize: 12 }}>${v}</span>
                      </div>`
                    ))}
                  </div>`
                )}
                <div style=${{ fontSize: 10, color: 'var(--text-dim)', marginTop: 8 }}>Leave all unchecked to run everything.</div>
              </div>`
            );
          })()}

          ${showJobModal === 'file_browse' && (() => {
            const selHost = hosts.find(h => selectedHosts.includes(h.id));
            const isWin = (selHost?.os || '').toLowerCase().includes('windows');
            const defaultPath = isWin ? 'C:\\' : '/';
            const currentPath = jobParams.path || defaultPath;

            // Parse previous browse results for clickable navigation
            const lastBrowse = modalJobs.find(j => j.type === 'file_browse' && j.status === 'completed' && j.result);
            let entries = [];
            if (lastBrowse && lastBrowse.result) {
              try {
                entries = JSON.parse(lastBrowse.result);
                if (!Array.isArray(entries)) entries = [];
              } catch(e) {
                // Try to parse line-by-line listing
                entries = lastBrowse.result.split('\n').filter(l => l.trim()).map(l => {
                  const parts = l.trim().split(/\s+/);
                  const name = parts[parts.length - 1] || l.trim();
                  const isDir = l.startsWith('d') || l.includes('<DIR>') || name.endsWith('/') || name.endsWith('\\');
                  return { name: name.replace(/[\/\\]$/, ''), is_dir: isDir, size: '' };
                });
              }
            }

            const navigateTo = (dir) => {
              const sep = isWin ? '\\' : '/';
              let newPath;
              if (dir === '..') {
                const parts = currentPath.replace(/[\/\\]+$/, '').split(/[\/\\]/);
                parts.pop();
                newPath = parts.join(sep) || (isWin ? 'C:\\' : '/');
                if (isWin && !newPath.includes('\\')) newPath += '\\';
              } else {
                newPath = currentPath.replace(/[\/\\]+$/, '') + sep + dir;
              }
              setJobParams(p => ({ ...p, path: newPath }));
              // Auto-browse
              setTimeout(() => submitJob('file_browse'), 100);
            };

            return (
              html`<div style=${{ marginBottom: 16 }}>
                <div class="form-group" style=${{ marginBottom: 8 }}>
                  <label class="form-label">Path</label>
                  <div style=${{ display: 'flex', gap: 6 }}>
                    <input class="input mono" placeholder=${defaultPath} style=${{ flex: 1 }}
                      value=${currentPath}
                      onInput=${e => setJobParams(p => ({ ...p, path: e.target.value }))}
                      onKeyDown=${e => { if (e.key === 'Enter') submitJob('file_browse'); }}/>
                    <button class="btn btn-sm" onClick=${() => navigateTo('..')} style=${{ padding: '6px 10px' }}>Up</button>
                  </div>
                </div>

                
                ${entries.length > 0 && (
                  html`<div style=${{ border: '1px solid var(--border)', borderRadius: 6, maxHeight: 250, overflowY: 'auto', background: 'var(--bg-input)' }}>
                    ${entries.map((entry, i) => (
                      html`<div key=${i} onClick=${() => entry.is_dir && navigateTo(entry.name)} style=${{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
                        borderBottom: '1px solid var(--border)', cursor: entry.is_dir ? 'pointer' : 'default',
                        fontSize: 12, fontFamily: 'Geist Mono, monospace',
                      }}>
                        <span style=${{ color: entry.is_dir ? 'var(--accent)' : 'var(--text-dim)', fontSize: 14 }}>
                          ${entry.is_dir ? '\uD83D\uDCC1' : '\uD83D\uDCC4'}
                        </span>
                        <span style=${{ flex: 1, color: entry.is_dir ? 'var(--accent)' : 'var(--text-secondary)' }}>${entry.name}</span>
                        ${entry.size && html`<span style=${{ fontSize: 10, color: 'var(--text-dim)' }}>${entry.size}</span>`}
                      </div>`
                    ))}
                  </div>`
                )}

                <div style=${{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button class="btn btn-sm" onClick=${() => {
                    setJobParams(p => ({ ...p, action: 'download', path: currentPath }));
                  }}><${Icons.Download}/> Download File</button>
                  <label class="btn btn-sm" style=${{ cursor: 'pointer' }}>
                    <${Icons.Download} style=${{ transform: 'rotate(180deg)' }}/> Upload File
                    <input type="file" style=${{ display: 'none' }} onChange=${e => {
                      if (e.target.files[0]) {
                        setJobParams(p => ({ ...p, upload_file: e.target.files[0].name, action: 'upload' }));
                        addToast('Upload queued. File transfers require agent v2+ support.', 'success');
                      }
                    }}/>
                  </label>
                </div>
                <div style=${{ fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>
                  Click folders to navigate. Press Enter or Execute to browse the current path.
                </div>
              </div>`
            );
          })()}

          <div class="btn-group" style=${{ justifyContent: 'flex-end', marginBottom: modalJobs.length > 0 ? 16 : 0 }}>
            <button class="btn" onClick=${closeModal}>Close</button>
            <button class="btn btn-primary" onClick=${() => submitJob(showJobModal)}>
              <${Icons.Play}/> Execute
            </button>
          </div>

          
          ${modalJobs.length > 0 && (
            html`<div style=${{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div style=${{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
                Output (${modalJobs.filter(j => OPEN.includes(j.status)).length} active)
              </div>
              <div style=${{ maxHeight: 520, overflowY: 'auto' }}><${JobCards} jobs=${modalJobs} setJobs=${setModalJobs}/></div>
            </div>`
          )}
        <//>`
      )}

      ${showJobModal === '_backup_chain' && (
        html`<${Modal} title="Backup + Reboot + Autologin Chain" onClose=${closeModal}>
          <div style=${{ marginBottom: 16, color: 'var(--text-dim)', fontSize: 13 }}>
            Runs backup script, then reboots, then configures autologin on Windows hosts.
          </div>
          <div class="form-group" style=${{ marginBottom: 12 }}>
            <label class="form-label">Backup Script Path</label>
            <div style=${{ display: 'flex', gap: 6 }}>
              <input class="input" placeholder="/root/proxmox-vm-backup.sh"
                value=${jobParams.script || ''}
                onInput=${e => setJobParams(p => ({ ...p, script: e.target.value }))}/>
              <button class="btn btn-sm" title="Browse remote filesystem" onClick=${() => {
                if (selectedHosts.length > 0) {
                  setJobParams(p => ({ ...p, _browsing: true }));
                  submitJob('file_browse');
                }
              }}>Browse</button>
            </div>
          </div>
          <div class="form-group" style=${{ marginBottom: 12 }}>
            <label class="form-label">Credentials (optional)</label>
            <select class="select input" style=${{ fontSize: 12 }}
              value=${jobParams._credId || ''}
              onChange=${async e => {
                setJobParams(p => ({ ...p, _credId: e.target.value }));
              }}>
              <option value="">Use saved autologin credentials</option>
              ${hosts.filter(h => selectedHosts.includes(h.id)).map(h => (
                html`<option key=${h.id} value=${h.id}>${h.hostname} credentials</option>`
              ))}
            </select>
          </div>
          <div class="checkbox-row" onClick=${() => setJobParams(p => ({ ...p, reboot_after: !p.reboot_after }))}
            style=${{ marginBottom: 16 }}>
            <div class=${`checkbox ${jobParams.reboot_after ? 'checked' : ''}`}>
              ${jobParams.reboot_after && html`<span style=${{ color: 'white', fontSize: 10 }}>✓</span>`}
            </div>
            Reboot hosts after backup
          </div>
          <div class="btn-group" style=${{ justifyContent: 'flex-end', marginBottom: modalJobs.length > 0 ? 16 : 0 }}>
            <button class="btn" onClick=${closeModal}>Close</button>
            <button class="btn btn-primary" onClick=${submitChain}><${Icons.Play}/> Run Chain</button>
          </div>

          
          ${modalJobs.length > 0 && (
            html`<div style=${{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div style=${{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
                Output (${modalJobs.filter(j => OPEN.includes(j.status)).length} active)
              </div>
              <div style=${{ maxHeight: 520, overflowY: 'auto' }}><${JobCards} jobs=${modalJobs} setJobs=${setModalJobs}/></div>
            </div>`
          )}
        <//>`
      )}

      
      ${trackedJobs.length > 0 && (
        html`<div ref=${outputRef} class="card" style=${{ marginTop: 8 }}>
          <div class="card-header">
            <span class="card-title">Job Output (${trackedJobs.filter(j => OPEN.includes(j.status)).length} active)</span>
            <div class="btn-group">
              <button class="btn btn-sm" onClick=${() => setTrackedJobs([])}>Clear All</button>
            </div>
          </div>
          <${JobCards} jobs=${trackedJobs} setJobs=${setTrackedJobs}/>
        </div>`
      )}
    </div>`
  );
}
