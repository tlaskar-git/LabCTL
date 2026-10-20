import { useState, useEffect } from 'preact/hooks';
import { api, downloadBlob } from '../api.js';
import { html, Icons, StatusBadge, Modal } from '../ui.js';
import { CronTaskList } from './cron-task-list.js';
import { fmtBytes, fmtAgo } from './chart-kit.js';
import { NOT_REPORTED, has, Dash, orDash, Bar, usedOf, uptimeText, loadText, osText, seenText } from './host-view.js';

// ── Host Detail Modal ─────────────────────────────────────
export function HostDetailModal({ host, onClose, addToast }) {
  const [jobs, setJobs] = useState([]);
  const [activeTab, setActiveTab] = useState('overview');
  const [viewJob, setViewJob] = useState(null);

  const info = host.system_info || {};
  const isOnline = host.online || host.status === 'online';
  const isWindows = (host.os || '').toLowerCase().includes('windows');
  const isLinux = !isWindows;
  // The list record carries the light view; GET /api/hosts/:id adds containers, processes and network.
  const [full, setFull] = useState(null);
  const v = full?.view || host.view || {};

  useEffect(() => {
    setFull(null);
    api(`/api/hosts/${encodeURIComponent(host.id)}`).then(setFull).catch(() => {});
  }, [host.id]);

  useEffect(() => {
    api(`/api/jobs?host_id=${host.id}&limit=50`).then(setJobs).catch(() => {});
    const i = setInterval(() => {
      api(`/api/jobs?host_id=${host.id}&limit=50`).then(setJobs).catch(() => {});
    }, 5000);
    return () => clearInterval(i);
  }, [host.id]);

  const runJob = async (type, params = {}) => {
    await api('/api/jobs', { method: 'POST', body: { host_id: host.id, type, params }});
    addToast(`${type} dispatched to ${host.hostname}`);
  };

  const lastJobOfType = (type) => jobs.find(j => j.type === type && j.status === 'completed');

  const InfoRow = ({ label, value, mono }) => (
    html`<div style=${{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
      <span style=${{ fontSize: 12, color: 'var(--text-dim)' }}>${label}</span>
      <span style=${{ fontSize: 12, color: 'var(--text-primary)', textAlign: 'right', fontFamily: mono ? 'Geist Mono, monospace' : 'inherit' }}>${orDash(value)}</span>
    </div>`
  );
  const Meter = ({ label, percent, detail }) => (
    html`<div style=${{ marginBottom: 10 }}>
      <div style=${{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 11 }}>
        <span style=${{ color: 'var(--text-dim)' }}>${label}</span>
        <span style=${{ color: 'var(--text-secondary)' }}>${has(percent) ? `${Math.round(percent * 10) / 10}%` : html`<${Dash}/>`}${detail ? ` \u00b7 ${detail}` : ''}</span>
      </div>
      <${Bar} percent=${percent}/>
    </div>`
  );
  const cardTitle = { fontSize: 12, fontWeight: 700, marginBottom: 8, color: 'var(--text-secondary)' };
  const containers = v.containers || [];

  const quickActionStyle = { justifyContent: 'center', padding: '8px 6px', fontSize: 11 };
  const QuickActionButton = ({ tooltip, onClick, children }) => (
    html`<div class="tooltip-wrap">
      <button class="btn" onClick=${onClick} title=${tooltip} aria-label=${tooltip} style=${quickActionStyle}>
        ${children}
      </button>
      <div class="tooltip-text">${tooltip}</div>
    </div>`
  );

  return (
    html`<div class="modal-overlay" onClick=${onClose}>
      <div class="modal" onClick=${e => e.stopPropagation()} style=${{ maxWidth: 700, maxHeight: '90vh' }}>
        
        <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <div style=${{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <span style=${{ fontSize: 18, fontWeight: 700 }}>${host.hostname}</span>
              <${StatusBadge} status=${isOnline ? 'online' : 'offline'}/>
            </div>
            <div style=${{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'Geist Mono, monospace' }}>
              ${[osText(v) || host.os, v.ip || host.ip || info.ip, v.arch].filter(Boolean).join(' · ')}
            </div>
            <div style=${{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
              ${seenText(v, isOnline) || 'No data reported yet'}
            </div>
          </div>
          <button class="btn-close" onClick=${onClose}><${Icons.X}/></button>
        </div>

        
        <div class="tabs">
          ${['overview','jobs','crons/tasks','quick actions'].map(t => (
            html`<div key=${t} class=${`tab ${activeTab === t ? 'active' : ''}`} onClick=${() => setActiveTab(t)}>
              ${t.charAt(0).toUpperCase() + t.slice(1)}
            </div>`
          ))}
        </div>

        
        ${activeTab === 'overview' && (
          html`<div>
            
            <div class="card" style=${{ padding: 12, marginBottom: 12 }}>
              <div style=${cardTitle}>Usage${!isOnline && v.heartbeat_at ? ' (last reported values)' : ''}</div>
              <${Meter} label="CPU" percent=${v.cpu_percent} detail=${[loadText(v.load) && `load ${loadText(v.load)}`, has(v.cpu_cores) && `${v.cpu_cores} cores`].filter(Boolean).join(', ')}/>
              <${Meter} label="RAM" percent=${v.ram?.percent} detail=${usedOf(v.ram?.used, v.ram?.total)}/>
              ${v.swap?.total === 0 ? html`<div style=${{ fontSize: 11, color: 'var(--text-dim)' }}>Swap: none configured</div>`
                : html`<${Meter} label="Swap" percent=${v.swap?.percent} detail=${usedOf(v.swap?.used, v.swap?.total)}/>`}
            </div>

            <div class="card" style=${{ padding: 12, marginBottom: 12 }}>
              <div style=${cardTitle}>Drives</div>
              ${(v.disks || []).length ? v.disks.map((d, i) => html`<div key=${d.mount || i} style=${{ marginBottom: 10 }}>
                <div style=${{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                  <span style=${{ fontSize: 11, fontFamily: 'Geist Mono, monospace', color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
                    ${d.mount}${d.device && d.device !== d.mount ? ` (${d.device})` : ''}${d.fs ? ` ${d.fs}` : ''}
                  </span>
                  <span style=${{ fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                    ${has(d.percent) ? `${Math.round(d.percent)}% · ` : ''}${has(d.free) ? `${fmtBytes(d.free)} free of ${fmtBytes(d.total)}` : orDash(null)}
                  </span>
                </div>
                <${Bar} percent=${d.percent}/>
              </div>`) : html`<span style=${{ fontSize: 12 }} title=${NOT_REPORTED}>No drive data reported</span>`}
            </div>

            <div class="card" style=${{ padding: 12 }}>
              <div style=${cardTitle}>System Info</div>
              <${InfoRow} label="Hostname" value=${host.hostname} mono/>
              <${InfoRow} label="Operating system" value=${osText(v) || host.os}/>
              <${InfoRow} label="Kernel or build" value=${v.kernel}/>
              <${InfoRow} label="Platform" value=${v.platform}/>
              <${InfoRow} label="Architecture" value=${v.arch}/>
              <${InfoRow} label="CPU cores" value=${v.cpu_cores} mono/>
              ${has(v.cpu_model) && html`<${InfoRow} label="CPU model" value=${v.cpu_model}/>`}
              <${InfoRow} label="Model" value=${v.model}/>
              <${InfoRow} label="IP address" value=${v.ip || host.ip} mono/>
              ${info.domain && html`<${InfoRow} label="Domain" value=${info.domain} mono/>`}
              <${InfoRow} label="Uptime" value=${uptimeText(v.uptime_s)}/>
              <${InfoRow} label=${isOnline ? 'Last seen' : 'Last reported'} value=${host.last_seen ? `${new Date(host.last_seen).toLocaleString('en-GB')} (${fmtAgo(host.last_seen)})` : null}/>
              <${InfoRow} label="Agent version" value=${v.agent_version || host.agent_version}/>
              <${InfoRow} label="Agent ID" value=${host.id} mono/>
            </div>

            ${containers.length > 0 && (
              html`<div class="card" style=${{ padding: 12 }}>
                <div style=${cardTitle}>Docker Containers (${v.docker_running ?? '-'} running of ${v.docker_total ?? containers.length})</div>
                <div class="table-wrap">
                  <table style=${{ fontSize: 11 }}>
                    <thead><tr><th>Name</th><th>Image</th><th>State</th><th>Status</th></tr></thead>
                    <tbody>
                      ${containers.map((c, i) => (
                        html`<tr key=${c.name || i}>
                          <td style=${{ fontFamily: 'Geist Mono, monospace', color: c.state === 'running' ? 'var(--green)' : 'var(--red)' }}>${c.name}</td>
                          <td style=${{ fontFamily: 'Geist Mono, monospace', fontSize: 10 }}>${c.image}</td>
                          <td>${c.state}${c.health ? ` (${c.health})` : ''}</td>
                          <td style=${{ fontSize: 10 }}>${c.status || '-'}</td>
                        </tr>`
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>`
            )}

            ${(() => {
              const cronJob = lastJobOfType('list_crons');
              if (!cronJob) return null;
              return (
                html`<div class="card" style=${{ padding: 12 }}>
                  <div style=${{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: 'var(--text-secondary)' }}>
                    ${isWindows ? 'Scheduled Tasks' : 'Cron Jobs / Timers'}
                  </div>
                  <div class="output-log" style=${{ maxHeight: 200 }}>${cronJob.result}</div>
                </div>`
              );
            })()}
          </div>`
        )}

        
        ${activeTab === 'jobs' && (
          html`<div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Status</th><th>Type</th><th>Created</th><th>Actions</th></tr></thead>
                <tbody>
                  ${jobs.slice(0, 30).map(job => (
                    html`<tr key=${job.id}>
                      <td><${StatusBadge} status=${job.status}/></td>
                      <td style=${{ fontFamily: 'Geist Mono, monospace', fontSize: 11 }}>${job.type}</td>
                      <td style=${{ fontSize: 11, color: 'var(--text-dim)' }}>${job.created_at?.slice(0, 19)}</td>
                      <td>
                        <button class="btn btn-sm" onClick=${() => setViewJob(job)}><${Icons.Eye}/></button>
                      </td>
                    </tr>`
                  ))}
                  ${jobs.length === 0 && (
                    html`<tr><td colSpan=${4} style=${{ textAlign: 'center', padding: 20, color: 'var(--text-dim)' }}>No jobs for this host.</td></tr>`
                  )}
                </tbody>
              </table>
            </div>

            ${viewJob && (
              html`<div style=${{ marginTop: 12 }}>
                <div style=${{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <${StatusBadge} status=${viewJob.status}/>
                  <span class="mono" style=${{ fontSize: 12 }}>${viewJob.type}</span>
                  <span style=${{ fontSize: 11, color: 'var(--text-dim)' }}>${viewJob.created_at}</span>
                  <button class="btn-close" style=${{ marginLeft: 'auto' }} onClick=${() => setViewJob(null)}><${Icons.X}/></button>
                </div>
                ${viewJob.result && html`<div class="output-log">${viewJob.result}</div>`}
                ${viewJob.error && html`<div class="output-log" style=${{ borderColor: 'var(--red)' }}>${viewJob.error}</div>`}
              </div>`
            )}
          </div>`
        )}

        
        ${activeTab === 'crons/tasks' && (
          html`<div>
            ${(() => {
              const cronJob = lastJobOfType('list_crons');
              if (!cronJob) {
                return (
                  html`<div style=${{ textAlign: 'center', padding: 30 }}>
                    <div style=${{ color: 'var(--text-dim)', marginBottom: 12 }}>No cron/task data yet.</div>
                    <button class="btn btn-primary" onClick=${() => runJob('list_crons')}>
                      <${Icons.List}/> Fetch ${isWindows ? 'Scheduled Tasks' : 'Crons/Timers'}
                    </button>
                  </div>`
                );
              }

              // Windows tasks - clickable with details
              if (isWindows) {
                try {
                  const tasks = JSON.parse(cronJob.result);
                  const taskList = Array.isArray(tasks) ? tasks : [tasks];
                  return (
                    html`<${CronTaskList}
                      tasks=${taskList}
                      isWindows=${true}
                      onRefresh=${() => runJob('list_crons')}
                      onAction=${(taskName, action) => runJob('custom_command', {
                        command: `schtasks /Change /TN "${taskName}" /${action === 'enable' ? 'ENABLE' : 'DISABLE'}`
                      })}
                      onRunNow=${(taskName) => runJob('custom_command', {
                        command: `schtasks /Run /TN "${taskName}"`
                      })}
                      hostname=${host.hostname}
                    />`
                  );
                } catch(e) {
                  // Fall through to raw
                }
              }

              // Linux - parse crontab and systemd timers
              const lines = (cronJob.result || '').split('\n');
              const cronEntries = [];
              let section = '';
              lines.forEach(line => {
                const trimmed = line.trim();
                if (trimmed.startsWith('=== ') || trimmed.startsWith('--- ') || trimmed.startsWith('UNIT ') || trimmed === '') {
                  if (trimmed.includes('crontab') || trimmed.includes('Crontab')) section = 'crontab';
                  else if (trimmed.includes('timer') || trimmed.includes('Timer')) section = 'timer';
                  return;
                }
                if (trimmed.startsWith('#') || trimmed === '') return;
                if (section === 'timer' || trimmed.includes('.timer')) {
                  const parts = trimmed.split(/\s+/);
                  cronEntries.push({ type: 'timer', name: parts[0] || trimmed, raw: trimmed, details: parts.slice(1).join(' ') });
                } else if (/^[\d\*\/\-\,]+\s/.test(trimmed)) {
                  const parts = trimmed.split(/\s+/);
                  const schedule = parts.slice(0, 5).join(' ');
                  const command = parts.slice(5).join(' ');
                  cronEntries.push({ type: 'cron', name: command.split('/').pop() || command, raw: trimmed, schedule, command });
                } else {
                  cronEntries.push({ type: 'other', name: trimmed.slice(0, 40), raw: trimmed, details: trimmed });
                }
              });

              if (cronEntries.length > 0) {
                return (
                  html`<${CronTaskList}
                    tasks=${cronEntries}
                    isWindows=${false}
                    onRefresh=${() => runJob('list_crons')}
                    onAction=${(name, action) => {
                      if (name.includes('.timer')) {
                        runJob('custom_command', { command: `systemctl ${action} ${name}` });
                      }
                    }}
                    onRunNow=${(name) => {
                      if (name.includes('.timer')) {
                        const svcName = name.replace('.timer', '.service');
                        runJob('custom_command', { command: `systemctl start ${svcName}` });
                      }
                    }}
                    hostname=${host.hostname}
                  />`
                );
              }

              // Fallback raw
              return (
                html`<div>
                  <div style=${{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                    <span style=${{ fontSize: 13, fontWeight: 600 }}>${isWindows ? 'Scheduled Tasks' : 'Crons / Timers'}</span>
                    <div class="btn-group">
                      <button class="btn btn-sm" onClick=${() => runJob('list_crons')}><${Icons.RefreshCw}/> Refresh</button>
                      <button class="btn btn-sm" onClick=${() => {
                        downloadBlob(cronJob.result, `${host.hostname}-crons.txt`);
                      }}><${Icons.Download}/> Download</button>
                    </div>
                  </div>
                  <div class="output-log" style=${{ maxHeight: 500 }}>${cronJob.result}</div>
                </div>`
              );
            })()}
          </div>`
        )}

        
        ${activeTab === 'quick actions' && (
          html`<div>
            <div style=${{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
              ${isWindows && (
                html`
                  <${QuickActionButton} tooltip="Runs Windows Update through PSWindowsUpdate. Installs available updates and does not reboot automatically." onClick=${() => runJob('windows_update', { reboot: false })}>
                    <${Icons.Shield}/> WinUpdate
                  <//>
                  <${QuickActionButton} tooltip="Runs Windows Update through PSWindowsUpdate, then reboots this host if Windows reports a reboot is required." onClick=${() => runJob('windows_update', { reboot: true })}>
                    <${Icons.Shield}/> WinUpdate+Reboot
                  <//>
                `
              )}
              ${isLinux && (
                html`
                  <${QuickActionButton} tooltip="Runs apt-get update, apt-get upgrade -y, then apt-get autoremove -y on this Linux host. No reboot is requested." onClick=${() => runJob('linux_update', { reboot: false })}>
                    <${Icons.Download}/> Linux Update
                  <//>
                  <${QuickActionButton} tooltip="Runs apt-get update, apt-get upgrade -y, apt-get autoremove -y, then schedules a reboot only if /var/run/reboot-required exists." onClick=${() => runJob('linux_update', { reboot: true })}>
                    <${Icons.Download}/> Update+Reboot
                  <//>
                `
              )}
              ${isLinux && (v.docker_total ?? info.docker_running) != null && (
                html`<${QuickActionButton} tooltip="Pulls the latest image for every running Docker container on this host. It does not recreate containers unless a specific Docker update job includes restart details." onClick=${() => runJob('docker_update')}>
                  <${Icons.Box}/> Docker Update
                <//>`
              )}
              <${QuickActionButton} tooltip=${isWindows ? 'Fetches enabled Windows Scheduled Tasks and stores the result in the Jobs tab for this host.' : 'Fetches root/user crontabs plus systemd timers and stores the result in the Jobs tab for this host.'} onClick=${() => runJob('list_crons')}>
                <${Icons.List}/> ${isWindows ? 'Sched Tasks' : 'Crons/Timers'}
              <//>
              <${QuickActionButton} tooltip=${isWindows ? 'Clears temp files, Windows Update download cache, recycle bin, and event logs, then reports disk space.' : 'Runs apt autoremove/autoclean, vacuums journal logs to 7 days, runs docker system prune -f, clears /tmp, then reports df -h.'} onClick=${() => runJob('disk_cleanup')}>
                <${Icons.Trash}/> Disk Cleanup
              <//>
              <${QuickActionButton} tooltip="Queues a reboot job for this host with delay set to 30 seconds. Linux schedules shutdown -r, Windows uses shutdown /r." onClick=${() => runJob('reboot', { delay: 30 })}>
                <${Icons.Power}/> Reboot (30s)
              <//>
              ${isLinux && (
                html`<${QuickActionButton} tooltip="Runs the backup job with script /root/proxmox-vm-backup.sh on this Linux host. The agent executes it with bash and records the output in Jobs." onClick=${() => runJob('backup', { script: '/root/proxmox-vm-backup.sh' })}>
                  <${Icons.HardDrive}/> Run Backup
                <//>`
              )}
              ${isWindows && (
                html`<${QuickActionButton} tooltip="Removes Windows auto-login registry values for this host." onClick=${() => runJob('disable_autologin')}>
                  <${Icons.Key}/> Disable AutoLogin
                <//>`
              )}
            </div>
            <div style=${{ fontSize: 10, color: 'var(--text-dim)', marginTop: 8 }}>
              Jobs dispatched from here appear in the Jobs tab above.
            </div>
          </div>`
        )}
      </div>
    </div>`
  );
}
