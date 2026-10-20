import { useState, useEffect, useMemo } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons } from '../ui.js';
import { openJobDrawer } from '../job-drawer.js';
import { Chart } from '../components/chart.js';
import { Section, KV, DataTable, fmtDate } from '../components/chart-kit.js';

// Fleet overview: tiles from GET /api/fleet/summary. A tile with an href opens the Hosts page filtered to the hosts behind
// its number (pages/hosts.js reads the query). Failed jobs and queued runs have no host list, so they open a section here.
const TILES = [
  { id: 'hosts', label: 'Hosts', value: s => s.totals.hosts, bad: false, href: '#/hosts' },
  { id: 'online', label: 'Online', value: s => s.totals.online, bad: false, href: '#/hosts?status=online' },
  { id: 'offline', label: 'Offline hosts', value: s => s.offline_hosts.length, bad: true, href: '#/hosts?status=offline' },
  { id: 'reboots', label: 'Pending reboots', value: s => s.pending_reboots.length, bad: true, href: '#/hosts?reboot=1' },
  { id: 'patches', label: 'Behind on patches', value: s => s.behind_on_patches.length, bad: true, href: '#/hosts?patches=behind' },
  { id: 'agents', label: 'Agents out of date', value: s => s.agents_out_of_date.length, bad: true, href: '#/hosts?outdated=1' },
  { id: 'jobs', label: 'Jobs failed in 24 h', value: s => s.jobs_failed_24h, bad: true },
  { id: 'disks', label: 'Disks above 80%', value: s => s.disks_over_80.length, bad: true, href: '#/hosts?disk=high' },
  { id: 'runners', label: 'Runners offline', value: s => s.runners_offline.length, bad: true, href: '#/hosts?runners=offline' },
  { id: 'queued', label: 'Queued workflow runs', value: s => s.queued_runs, bad: false },
];

function FailedJobs() {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    api('/api/jobs?status=failed&limit=100').then(r => setRows(r.filter(j => Date.now() - Date.parse(j.completed_at || j.created_at) < 86400000)), () => setRows([]));
  }, []);
  if (!rows) return html`<div class="page-desc">Loading</div>`;
  return html`<${DataTable} empty="No failed jobs in the last 24 hours" rows=${rows} cols=${[
    { h: 'Job', f: j => html`<a href="#/jobs" onClick=${e => { e.preventDefault(); openJobDrawer(j.id); }}>${j.type}</a>` },
    { h: 'Host', f: j => html`<a href=${`#/host/${encodeURIComponent(j.host_id)}`}>${j.host_id}</a>` }, { h: 'When', f: j => fmtDate(j.completed_at || j.created_at) }]}/>`;
}

export default function FleetPage() {
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState('jobs');
  const load = () => api('/api/fleet/summary').then(r => { setS(r); setError(''); }, e => setError(e.message));
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);
  const trend = useMemo(() => s && ({ ts: s.trend.ts, series: [{ label: 'CPU', values: s.trend.cpu }, { label: 'Memory', values: s.trend.ram }] }), [s?.generated_at]);

  return html`<div>
    <div class="page-header">
      <div><div class="page-title">Fleet overview</div><div class="page-desc">Every host at a glance. A host counts as online when it was seen in the last ${s?.online_window_s ?? 90} seconds.</div></div>
      <button class="btn" onClick=${load}><${Icons.RefreshCw}/> Refresh</button>
    </div>
    ${error && html`<div class="card">${error}</div>`}
    ${s && html`<div>
      <div class="metric-grid">
        ${TILES.map(t => {
          const v = t.value(s);
          const Tag = t.href ? 'a' : 'button';
          return html`<${Tag} key=${t.id} href=${t.href} class="metric-card tile" style=${{ textAlign: 'left', cursor: 'pointer', color: 'inherit', textDecoration: 'none', outline: open === t.id && !t.href ? '2px solid var(--accent)' : 'none' }} onClick=${t.href ? undefined : () => setOpen(t.id)}>
            <div class="page-desc">${t.label}</div>
            <div class="metric-value" style=${{ color: t.bad && v > 0 ? 'var(--red)' : undefined }}>${v}</div>
          <//>`;
        })}
      </div>
      ${open === 'jobs' && html`<${Section} title="Jobs failed in the last 24 hours"><${FailedJobs}/><//>`}
      ${open === 'queued' && html`<${Section} title="Queued workflow runs"><div class="page-desc">The count comes from the GitHub cache. It stays at 0 until the GitHub integration is connected.</div><//>`}
      <${Section} title="Hosts by type">
        <${KV} rows=${[...Object.entries(s.totals.by_os).map(([k, v]) => [`OS ${k}`, v]), ...Object.entries(s.totals.by_kind).map(([k, v]) => [`Kind ${k}`, v]),
          ...Object.entries(s.totals.by_status).map(([k, v]) => [`Status ${k}`, v])]}/>
      <//>
      <${Section} title="Fleet average, last 24 hours"><${Chart} data=${trend} unit="%" max=${100}/><//>
    </div>`}
    ${!s && !error && html`<div class="page-desc">Loading</div>`}
  </div>`;
}
