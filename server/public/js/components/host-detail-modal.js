import { useState, useEffect } from 'preact/hooks';
import { api, downloadBlob } from '../api.js';
import { html, Icons, StatusBadge } from '../ui.js';
import { CronTaskList } from './cron-task-list.js';
import { fmtAgo } from './chart-kit.js';
import { orDash, uptimeText, osText, seenText } from './host-view.js';
import { HostOverview } from './host-gauges.js';
import { HostActions } from './host-actions.js';
import { Terminal } from './terminal.js';
import { DeployActions } from './deploy-actions.js';
import { Chips } from './host-chips.js';
import { OsIcon, hostName, Pencil, RenameField } from './host-name.js';
import { iconLabel } from './os-icon.js';
import { IconPicker } from './icon-picker.js';

const TABS = [['overview', 'Overview'], ['actions', 'Actions'], ['jobs', 'Jobs'], ['schedules', 'Schedules'], ['details', 'Details']];

// Host window: header (icon, display name, hostname, status), then Overview, Actions, Jobs, Schedules and Details.
export function HostDetailModal({ host, onClose, addToast, isAdmin = false, canEdit = false, onChanged, onSettings }) {
  const [renaming, setRenaming] = useState(false);
  const [picking, setPicking] = useState(false);
  const [cronJobId, setCronJobId] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [activeTab, setActiveTab] = useState('overview');
  const [viewJob, setViewJob] = useState(null);

  const info = host.system_info || {};
  const isOnline = host.online || host.status === 'online';
  const isWindows = (host.os || '').toLowerCase().includes('windows');
  // The list record carries the light view; GET /api/hosts/:id adds containers, processes and network.
  const [full, setFull] = useState(null);
  const v = full?.view || host.view || {};

  useEffect(() => {
    setFull(null);
    api(`/api/hosts/${encodeURIComponent(host.id)}`).then(setFull).catch(() => {});
  }, [host.id]);

  const loadJobs = () => api(`/api/jobs?host_id=${encodeURIComponent(host.id)}&limit=50`).then(setJobs).catch(() => {});
  useEffect(() => {
    loadJobs();
    const i = setInterval(loadJobs, 5000);
    return () => clearInterval(i);
  }, [host.id]);

  const runJob = async (type, params = {}) => {
    try {
      const r = await api('/api/jobs', { method: 'POST', body: { host_id: host.id, type, params }});
      addToast(`${type} dispatched to ${hostName(host)}`);
      loadJobs();
      return r?.id;
    } catch (e) { addToast(e.message, 'error'); return null; }
  };
  const showJob = id => { if (id) { setViewJob(id); setActiveTab('jobs'); } loadJobs(); };
  const setIcon = async icon => {
    try {
      await api(`/api/hosts/${encodeURIComponent(host.id)}`, { method: 'PATCH', body: { icon } });
      addToast(icon ? `Icon set to ${iconLabel(icon)}` : 'Icon set to automatic');
      setPicking(false);
      onChanged?.();
    } catch (e) { addToast(e.message, 'error'); }
  };

  const lastJobOfType = (type) => jobs.find(j => j.type === type && j.status === 'completed');

  const InfoRow = ({ label, value, mono }) => (
    html`<div style=${{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
      <span style=${{ fontSize: 12, color: 'var(--text-dim)' }}>${label}</span>
      <span style=${{ fontSize: 12, color: 'var(--text-primary)', textAlign: 'right', fontFamily: mono ? 'Geist Mono, monospace' : 'inherit' }}>${orDash(value)}</span>
    </div>`
  );
  return (
    html`<div class="modal-overlay" onClick=${onClose}>
      <div class="modal host-window" role="dialog" aria-modal="true" aria-label=${hostName(host)} onClick=${e => e.stopPropagation()}>
        <div class="hw-head">
          ${canEdit ? html`<button class=${`hw-icon ${isOnline ? '' : 'is-off'}`} title="Change icon" aria-label=${`Icon: ${iconLabel(host.icon || host.icon_auto)}. Change`} onClick=${() => setPicking(true)}>
              <${OsIcon} host=${host} size=${40}/></button>`
            : html`<span class=${`hw-icon ${isOnline ? '' : 'is-off'}`}><${OsIcon} host=${host} size=${40}/></span>`}
          <div class="hw-title">
            ${renaming ? html`<${RenameField} host=${host} addToast=${addToast} size=${18} onDone=${saved => { setRenaming(false); if (saved) onChanged?.(); }}/>`
              : html`<div class="hw-name-row">
                <h2 class="hw-name">${hostName(host)}</h2>
                ${canEdit && html`<button class="icon-btn" title="Rename" aria-label=${`Rename ${hostName(host)}`} onClick=${() => setRenaming(true)}><${Pencil}/></button>`}
                <${StatusBadge} status=${isOnline ? 'online' : 'offline'}/>
              </div>`}
            <div class="hw-meta">
              ${host.display_name && html`<span class="mono" title="Hostname">${host.hostname || host.id}</span>`}
              ${[osText(v) || host.os, v.ip || host.ip || info.ip].filter(Boolean).map(x => html`<span key=${x}>${x}</span>`)}
              ${(v.agent_version || host.agent_version) && html`<span class=${host.agent_outdated ? 'hw-outdated' : ''} title=${host.agent_outdated ? `Latest known ${host.latest_agent_version}` : ''}>agent ${v.agent_version || host.agent_version}${host.agent_outdated ? ' (outdated)' : ''}</span>`}
            </div>
            <div class="hw-seen">${seenText(v, isOnline) || 'No data reported yet'}</div>
          </div>
          <button class="btn-close" aria-label="Close" onClick=${onClose}><${Icons.X}/></button>
        </div>

        <div class="tabs hw-tabs" role="tablist" aria-label="Host sections">
          ${TABS.map(([id, label]) => html`<button key=${id} type="button" role="tab" aria-selected=${activeTab === id}
            class=${`tab ${activeTab === id ? 'active' : ''}`} onClick=${() => setActiveTab(id)}>${label}</button>`)}
        </div>

        ${activeTab === 'overview' && html`<${HostOverview} v=${v} online=${isOnline}/>`}

        ${activeTab === 'actions' && html`<${HostActions} host=${host} isWindows=${isWindows} addToast=${addToast}
          docker=${(v.docker_total ?? info.docker_running) != null} onStarted=${showJob}/>`}

        ${activeTab === 'details' && html`<div>
          <div class="card" style=${{ padding: 12, marginBottom: 12 }}>
            <${InfoRow} label="Display name" value=${host.display_name}/>
            <${InfoRow} label="Hostname" value=${host.hostname} mono/>
            <${InfoRow} label="Operating system" value=${osText(v) || host.os}/>
            <${InfoRow} label="Kernel or build" value=${v.kernel}/>
            <${InfoRow} label="Platform" value=${v.platform}/>
            <${InfoRow} label="Architecture" value=${v.arch}/>
            <${InfoRow} label="CPU cores" value=${v.cpu_cores} mono/>
            ${v.cpu_model && html`<${InfoRow} label="CPU model" value=${v.cpu_model}/>`}
            <${InfoRow} label="Model" value=${v.model}/>
            <${InfoRow} label="IP address" value=${v.ip || host.ip} mono/>
            ${info.domain && html`<${InfoRow} label="Domain" value=${info.domain} mono/>`}
            <${InfoRow} label="Kind" value=${host.kind}/>
            <${InfoRow} label="Uptime" value=${uptimeText(v.uptime_s)}/>
            <${InfoRow} label=${isOnline ? 'Last seen' : 'Last reported'} value=${host.last_seen ? `${new Date(host.last_seen).toLocaleString('en-GB')} (${fmtAgo(host.last_seen)})` : null}/>
            <${InfoRow} label="Agent version" value=${v.agent_version || host.agent_version}/>
            <${InfoRow} label="Agent ID" value=${host.id} mono/>
            ${(host.provider || host.region || host.plan) && html`<${InfoRow} label="VPS" value=${[host.provider, host.region, host.plan].filter(Boolean).join(' / ')}/>`}
          </div>
          ${(host.tags?.length > 0 || host.groups?.length > 0) && html`<div style=${{ marginBottom: 12 }}><${Chips} items=${[...(host.groups || []), ...(host.tags || [])]}/></div>`}
          ${host.notes && html`<div class="card" style=${{ padding: 12, marginBottom: 12, whiteSpace: 'pre-wrap' }}>${host.notes}</div>`}
          <div class="btn-group">
            ${canEdit && onSettings && html`<button class="btn btn-sm" onClick=${onSettings}><${Icons.Settings}/> Settings</button>`}
            <${DeployActions} host=${host} isAdmin=${isAdmin} addToast=${addToast} onDone=${() => onChanged?.()}/>
          </div>
        </div>`}

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
                        <button class="btn btn-sm" aria-label=${`Show output of ${job.type}`} aria-pressed=${viewJob === job.id} onClick=${() => setViewJob(job.id)}><${Icons.Eye}/> Output</button>
                      </td>
                    </tr>`
                  ))}
                  ${jobs.length === 0 && (
                    html`<tr><td colSpan=${4} style=${{ textAlign: 'center', padding: 20, color: 'var(--text-dim)' }}>No jobs for this host.</td></tr>`
                  )}
                </tbody>
              </table>
            </div>

            ${viewJob && html`<div style=${{ marginTop: 12 }}>
              <div style=${{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                ${(() => { const j = jobs.find(x => x.id === viewJob); return j && html`<${StatusBadge} status=${j.status}/><span class="mono" style=${{ fontSize: 12 }}>${j.type}</span>`; })()}
                <button class="btn-close" aria-label="Hide output" style=${{ marginLeft: 'auto' }} onClick=${() => setViewJob(null)}><${Icons.X}/></button>
              </div>
              <${Terminal} key=${viewJob} jobId=${viewJob} name=${`${host.hostname || host.id}-${String(viewJob).slice(0, 8)}`.replace(/[^A-Za-z0-9._-]/g, '_')}/>
            </div>`}
          </div>`
        )}

        ${activeTab === 'schedules' && (
          html`<div>
            <div class="sched-head">
              <span class="sub-head" style=${{ margin: 0 }}>${isWindows ? 'Scheduled tasks' : 'Cron jobs and timers'}</span>
              <button class="btn btn-sm" onClick=${async () => setCronJobId(await runJob('list_crons'))}><${Icons.RefreshCw}/> Refresh</button>
            </div>
            ${(() => {
              const cronJob = lastJobOfType('list_crons');
              if (!cronJob) {
                return (
                  html`<div style=${{ textAlign: 'center', padding: 30 }}>
                    <div style=${{ color: 'var(--text-dim)', marginBottom: 12 }}>No cron/task data yet.</div>
                    <button class="btn btn-primary" onClick=${async () => setCronJobId(await runJob('list_crons'))}>
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
                      onRefresh=${async () => setCronJobId(await runJob('list_crons'))}
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
                    onRefresh=${async () => setCronJobId(await runJob('list_crons'))}
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
                      <button class="btn btn-sm" onClick=${async () => setCronJobId(await runJob('list_crons'))}><${Icons.RefreshCw}/> Refresh</button>
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

        
        ${activeTab === 'schedules' && (() => {
          const id = cronJobId || jobs.find(j => j.type === 'list_crons')?.id;
          return id && html`<details class="sched-out" open=${!!cronJobId}>
            <summary>Output of the latest run</summary>
            <${Terminal} key=${id} jobId=${id} name=${`${host.hostname || host.id}-crons`.replace(/[^A-Za-z0-9._-]/g, '_')}/>
          </details>`;
        })()}
      </div>
      ${picking && html`<${IconPicker} title="Host icon" current=${host.icon || null} auto=${host.icon_auto} onPick=${setIcon} onClose=${() => setPicking(false)}/>`}
    </div>`
  );
}
