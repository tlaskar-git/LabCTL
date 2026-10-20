import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons } from '../ui.js';
import { useAppState } from '../state.js';
import { useActions } from './action-panel.js';
import { GuardDialog } from './guard-dialog.js';

// Host window Actions tab: the built-in quick jobs and the templates that fit this host, as tiles under categories.
const CATEGORIES = [['Updates', Icons.Download], ['Maintenance', Icons.Trash], ['Docker', Icons.Box], ['Services', Icons.Settings],
  ['Files', Icons.HardDrive], ['Monitoring and info', Icons.Activity], ['Danger', Icons.Power]];
// Template groups from GET /api/hosts/:id/actions to the categories above.
const FROM_GROUP = { Patch: 'Updates', Security: 'Monitoring and info', Network: 'Services', Cleanup: 'Maintenance',
  Health: 'Monitoring and info', Danger: 'Danger' };
const categoryOf = a => (/docker/.test(a.id) ? 'Docker' : FROM_GROUP[a.group] || 'Monitoring and info');

// The quick jobs the host window always had, with the same hints (job types from job-types.js, run through /api/jobs).
function quickJobs(win, linux, docker) {
  return [
    win && { key: 'wu', cat: 'Updates', name: 'Windows Update', type: 'windows_update', params: { reboot: false }, icon: Icons.Shield,
      hint: 'Runs Windows Update through PSWindowsUpdate. Installs available updates and does not reboot automatically.' },
    win && { key: 'wur', cat: 'Updates', name: 'Windows Update and reboot', type: 'windows_update', params: { reboot: true }, icon: Icons.Shield,
      hint: 'Runs Windows Update through PSWindowsUpdate, then reboots this host if Windows reports a reboot is required.' },
    linux && { key: 'lu', cat: 'Updates', name: 'Linux update', type: 'linux_update', params: { reboot: false }, icon: Icons.Download,
      hint: 'Runs apt-get update, apt-get upgrade -y, then apt-get autoremove -y on this Linux host. No reboot is requested.' },
    linux && { key: 'lur', cat: 'Updates', name: 'Linux update and reboot', type: 'linux_update', params: { reboot: true }, icon: Icons.Download,
      hint: 'Runs apt-get update, apt-get upgrade -y, apt-get autoremove -y, then schedules a reboot only if /var/run/reboot-required exists.' },
    linux && docker && { key: 'du', cat: 'Docker', name: 'Docker image update', type: 'docker_update', params: {}, icon: Icons.Box,
      hint: 'Pulls the latest image for every running Docker container on this host. It does not recreate containers unless a specific Docker update job includes restart details.' },
    { key: 'dc', cat: 'Maintenance', name: 'Disk cleanup', type: 'disk_cleanup', params: {}, icon: Icons.Trash,
      hint: win ? 'Clears temp files, Windows Update download cache, recycle bin, and event logs, then reports disk space.'
        : 'Runs apt autoremove/autoclean, vacuums journal logs to 7 days, runs docker system prune -f, clears /tmp, then reports df -h.' },
    linux && { key: 'bk', cat: 'Maintenance', name: 'Run backup', type: 'backup', params: { script: '/root/proxmox-vm-backup.sh' }, icon: Icons.HardDrive,
      hint: 'Runs the backup job with script /root/proxmox-vm-backup.sh on this Linux host. The agent executes it with bash and records the output in Jobs.' },
    win && { key: 'da', cat: 'Services', name: 'Disable auto-login', type: 'disable_autologin', params: {}, icon: Icons.Key,
      hint: 'Removes Windows auto-login registry values for this host.' },
    { key: 'lc', cat: 'Monitoring and info', name: win ? 'List scheduled tasks' : 'List crons and timers', type: 'list_crons', params: {}, icon: Icons.List,
      hint: win ? 'Fetches enabled Windows Scheduled Tasks. The result shows in the Schedules tab.' : 'Fetches root and user crontabs plus systemd timers. The result shows in the Schedules tab.' },
    { key: 'rb', cat: 'Danger', name: 'Reboot in 30 seconds', type: 'reboot', params: { delay: 30 }, icon: Icons.Power, confirm: true,
      hint: 'Queues a reboot job for this host with delay set to 30 seconds. Linux schedules shutdown -r, Windows uses shutdown /r.' }
  ].filter(Boolean);
}

// onStarted(jobId) after any job starts, so the window can show its output.
export function HostActions({ host, isWindows, docker, addToast, onStarted }) {
  const { user } = useAppState();
  const canRun = !!user && ['operator', 'admin'].includes(user.role);
  const data = useActions(host.id);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState('');
  const [armed, setArmed] = useState('');

  const runQuick = async q => {
    if (q.confirm && armed !== q.key) return setArmed(q.key);
    setArmed('');
    setBusy(q.key);
    try {
      const r = await api('/api/jobs', { method: 'POST', body: { host_id: host.id, type: q.type, params: q.params } });
      addToast(`${q.name} started`);
      onStarted?.(r?.id);
    } catch (e) { addToast(e.message, 'error'); }
    setBusy('');
  };
  const runTemplate = async a => {
    if (a.guard || a.params.length) return setDialog(a);
    setBusy(a.id);
    try {
      const r = await api(`/api/templates/${encodeURIComponent(a.id)}/run`, { method: 'POST', body: { host_ids: [host.id] } });
      addToast(r.jobs?.[0] ? `${a.name} started` : 'Nothing started');
      onStarted?.(r.jobs?.[0]?.job_id);
    } catch (e) { addToast(e.message, 'error'); }
    setBusy('');
  };

  const tiles = [
    ...quickJobs(isWindows, !isWindows, docker).map(q => ({ ...q, run: () => runQuick(q) })),
    ...(data?.groups || []).flatMap(g => g.actions).map(a => ({ key: a.id, cat: categoryOf(a), name: a.name, hint: a.description, guard: a.guard,
      icon: null, blocked: a.secrets.length > 0, run: () => runTemplate(a) }))
  ];
  const tile = (t, Icon, danger) => html`<div key=${t.key} class=${`atile ${danger ? 'danger' : ''}`}>
    <span class="atile-icon"><${t.icon || Icon}/></span>
    <div class="atile-body">
      <div class="atile-name">${t.name}${t.guard ? html` <span class="badge badge-pending">confirm</span>` : ''}</div>
      <div class="atile-hint" title=${t.hint}>${t.blocked ? 'Needs a stored credential. Run it from the Templates page.' : t.hint}</div>
    </div>
    <button class=${`btn btn-sm ${danger || armed === t.key ? 'btn-danger' : ''}`} disabled=${!canRun || busy === t.key || t.blocked}
      aria-label=${armed === t.key ? `Confirm ${t.name}` : `Run ${t.name}`} onClick=${t.run}>
      ${busy === t.key ? 'Starting' : armed === t.key ? 'Confirm' : 'Run'}
    </button>
  </div>`;

  return html`<div>
    ${!canRun && html`<div class="page-desc" style=${{ marginBottom: 8 }}>Viewers can see the actions but not run them.</div>`}
    ${CATEGORIES.map(([cat, Icon]) => {
      const list = tiles.filter(t => t.cat === cat);
      return list.length > 0 && html`<section key=${cat} class="acat">
        <h3 class="sub-head"><span class="acat-icon"><${Icon}/></span>${cat}</h3>
        <div class="atile-grid">${list.map(t => tile(t, Icon, cat === 'Danger'))}</div>
      </section>`;
    })}
    ${!data && html`<div class="page-desc">Loading template actions...</div>`}
    ${dialog && html`<${GuardDialog} action=${dialog} host=${host} addToast=${addToast}
      onStarted=${job => onStarted?.(job?.job_id)} onClose=${() => setDialog(null)}/>`}
  </div>`;
}
