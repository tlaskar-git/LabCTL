import { useState, useEffect } from 'preact/hooks';
import { api, downloadBlob } from '../api.js';
import { html, Icons, StatusBadge, Modal } from '../ui.js';
import { CronTaskList } from './cron-task-list.js';

// ── Host Detail Modal ─────────────────────────────────────
export function HostDetailModal({ host, onClose, addToast }) {
  const [jobs, setJobs] = useState([]);
  const [activeTab, setActiveTab] = useState('overview');
  const [viewJob, setViewJob] = useState(null);

  const info = host.system_info || {};
  const isOnline = host.online || host.status === 'online';
  const isWindows = (host.os || '').toLowerCase().includes('windows');
  const isLinux = !isWindows;

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
  const ramPercent = info.ram_mb != null && info.ram_available_mb != null && info.ram_mb > 0 ? Math.round(((info.ram_mb - info.ram_available_mb) / info.ram_mb) * 100) : null;
  const diskPercent = info.disk_total_gb && info.disk_free_gb ? Math.round(((info.disk_total_gb - info.disk_free_gb) / info.disk_total_gb) * 100) : null;

  const ProgressBar = ({ percent, color }) => (
    html`<div style=${{ background: 'var(--bg-primary)', borderRadius: 4, height: 6, width: '100%', overflow: 'hidden' }}>
      <div style=${{ width: `${percent}%`, height: '100%', borderRadius: 4, background: percent > 85 ? 'var(--red)' : percent > 65 ? 'var(--yellow)' : color || 'var(--accent)', transition: 'width 0.3s' }}/>
    </div>`
  );

  const InfoRow = ({ label, value, mono }) => (
    html`<div style=${{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
      <span style=${{ fontSize: 12, color: 'var(--text-dim)' }}>${label}</span>
      <span style=${{ fontSize: 12, color: 'var(--text-primary)', fontFamily: mono ? 'Geist Mono, monospace' : 'inherit' }}>${value || '\u2014'}</span>
    </div>`
  );

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
              ${host.os} · ${host.ip || info.ip} · ${info.platform || ''}
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
              <div style=${{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>RAM Usage</div>
              ${ramPercent !== null ? (
                html`
                  <${ProgressBar} percent=${ramPercent}/>
                  <div style=${{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                    ${Math.round((info.ram_mb - info.ram_available_mb) / 1024 * 10) / 10}GB / ${Math.round(info.ram_mb / 1024 * 10) / 10}GB (${ramPercent}%)
                  </div>
                `
              ) : html`<span style=${{ fontSize: 12, color: 'var(--text-dim)' }}>N/A</span>`}
            </div>

            
            <div class="card" style=${{ padding: 12, marginBottom: 12 }}>
              <div style=${{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: 'var(--text-secondary)' }}>Drives</div>
              ${(info.drives && info.drives.length > 0) ? info.drives.map((drv, i) => (
                html`<div key=${i} style=${{ marginBottom: i < info.drives.length - 1 ? 10 : 0 }}>
                  <div style=${{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style=${{ fontSize: 11, fontFamily: 'Geist Mono, monospace', color: 'var(--text-primary)' }}>
                      ${drv.device} (${drv.mount})
                    </span>
                    <span style=${{ fontSize: 11, color: 'var(--text-dim)' }}>
                      ${drv.free_gb}GB free / ${drv.total_gb}GB
                    </span>
                  </div>
                  <${ProgressBar} percent=${drv.percent || 0}/>
                </div>`
              )) : (
                diskPercent !== null ? (
                  html`<div>
                    <${ProgressBar} percent=${diskPercent}/>
                    <div style=${{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                      ${Math.round((info.disk_total_gb - info.disk_free_gb) * 10) / 10}GB / ${info.disk_total_gb}GB (${diskPercent}%)
                    </div>
                  </div>`
                ) : html`<span style=${{ fontSize: 12, color: 'var(--text-dim)' }}>N/A</span>`
              )}
            </div>

            
            <div class="card" style=${{ padding: 12 }}>
              <div style=${{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: 'var(--text-secondary)' }}>System Info</div>
              <${InfoRow} label="Hostname" value=${info.hostname || host.hostname} mono/>
              <${InfoRow} label="OS" value=${host.os}/>
              <${InfoRow} label="Platform" value=${info.platform}/>
              <${InfoRow} label="Architecture" value=${info.arch}/>
              <${InfoRow} label="CPU Cores" value=${info.cpus} mono/>
              <${InfoRow} label="IP Address" value=${host.ip || info.ip} mono/>
              ${info.domain && html`<${InfoRow} label="Domain" value=${info.domain} mono/>`}
              <${InfoRow} label="Uptime" value=${info.uptime_hours ? `${info.uptime_hours} hours (${Math.round(info.uptime_hours / 24)} days)` : null}/>
              <${InfoRow} label="Last Seen" value=${host.last_seen ? new Date(host.last_seen).toLocaleString() : null}/>
              <${InfoRow} label="Agent ID" value=${host.id} mono/>
            </div>

            
            ${info.docker_details && info.docker_details.length > 0 && (
              html`<div class="card" style=${{ padding: 12 }}>
                <div style=${{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: 'var(--text-secondary)' }}>
                  Docker Containers (${info.docker_running} running)
                </div>
                <div class="table-wrap">
                  <table style=${{ fontSize: 11 }}>
                    <thead><tr><th>Name</th><th>Image</th><th>Status</th><th>Ports</th></tr></thead>
                    <tbody>
                      ${info.docker_details.map((c, i) => (
                        html`<tr key=${i}>
                          <td style=${{ fontFamily: 'Geist Mono, monospace', color: 'var(--green)' }}>${c.name}</td>
                          <td style=${{ fontFamily: 'Geist Mono, monospace', fontSize: 10 }}>${c.image}</td>
                          <td>${c.status}</td>
                          <td style=${{ fontSize: 10 }}>${c.ports || '\u2014'}</td>
                        </tr>`
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>`
            )}
            ${info.docker_containers && info.docker_containers.length > 0 && !info.docker_details && (
              html`<div class="card" style=${{ padding: 12 }}>
                <div style=${{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: 'var(--text-secondary)' }}>
                  Docker Containers (${info.docker_running} running)
                </div>
                <div style=${{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  ${info.docker_containers.map(c => (
                    html`<span key=${c} style=${{
                      background: 'var(--bg-primary)', border: '1px solid var(--border)',
                      borderRadius: 4, padding: '3px 8px', fontSize: 11,
                      fontFamily: 'Geist Mono, monospace', color: 'var(--green)'
                    }}>${c}</span>`
                  ))}
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
              ${isLinux && info.docker_running != null && (
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
