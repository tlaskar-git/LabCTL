import { useState, useEffect, useMemo } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons } from '../ui.js';
import { openJobDrawer } from '../job-drawer.js';
import { Chart } from '../components/chart.js';
import { Section, KV, DataTable, fmtAgo, fmtDate } from '../components/chart-kit.js';

// Fleet overview: tiles from GET /api/fleet/summary. A tile opens the list of hosts behind its number.
const hostLink = r => html`<a href=${`#/host/${encodeURIComponent(r.host_id)}`}>${r.hostname || r.host_id}</a>`;

const TILES = [
  { id: 'hosts', label: 'Hosts', value: s => s.totals.hosts, bad: false },
  { id: 'online', label: 'Online', value: s => s.totals.online, bad: false },
  { id: 'offline', label: 'Offline hosts', value: s => s.offline_hosts.length, bad: true,
    cols: [{ h: 'Host', f: hostLink }, { h: 'Last seen', f: r => (r.last_seen ? `${fmtAgo(r.last_seen)} (${fmtDate(r.last_seen)})` : 'never') }], rows: s => s.offline_hosts },
  { id: 'reboots', label: 'Pending reboots', value: s => s.pending_reboots.length, bad: true,
    cols: [{ h: 'Host', f: hostLink }, { h: 'Pending for', num: true, f: r => `${r.days} days` }], rows: s => s.pending_reboots },
  { id: 'patches', label: 'Behind on patches', value: s => s.behind_on_patches.length, bad: true,
    cols: [{ h: 'Host', f: hostLink }, { h: 'Pending', num: true, f: r => r.pending }, { h: 'Last patch', f: r => (r.last_patch ? fmtDate(r.last_patch) : 'unknown') }, { h: 'Reason', f: r => r.reason }], rows: s => s.behind_on_patches },
  { id: 'agents', label: 'Agents out of date', value: s => s.agents_out_of_date.length, bad: true,
    cols: [{ h: 'Host', f: hostLink }, { h: 'Version', f: r => r.agent_version }, { h: 'Latest', f: r => r.latest }], rows: s => s.agents_out_of_date },
  { id: 'jobs', label: 'Jobs failed in 24 h', value: s => s.jobs_failed_24h, bad: true },
  { id: 'disks', label: 'Disks above 80%', value: s => s.disks_over_80.length, bad: true,
    cols: [{ h: 'Host', f: hostLink }, { h: 'Mount', f: r => r.mount }, { h: 'Used', num: true, f: r => `${r.percent}%` }], rows: s => s.disks_over_80 },
  { id: 'runners', label: 'Runners offline', value: s => s.runners_offline.length, bad: true,
    cols: [{ h: 'Host', f: hostLink }, { h: 'Runner', f: r => r.runner }, { h: 'Service state', f: r => r.service_state }], rows: s => s.runners_offline },
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
  const [open, setOpen] = useState('offline');
  const load = () => api('/api/fleet/summary').then(r => { setS(r); setError(''); }, e => setError(e.message));
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);
  const trend = useMemo(() => s && ({ ts: s.trend.ts, series: [{ label: 'CPU', values: s.trend.cpu }, { label: 'Memory', values: s.trend.ram }] }), [s?.generated_at]);
  const tile = TILES.find(t => t.id === open);

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
          return html`<button key=${t.id} class="metric-card tile" style=${{ textAlign: 'left', cursor: 'pointer', outline: open === t.id ? '2px solid var(--accent)' : 'none' }} onClick=${() => setOpen(t.id)}>
            <div class="page-desc">${t.label}</div>
            <div class="metric-value" style=${{ color: t.bad && v > 0 ? 'var(--red)' : undefined }}>${v}</div>
          </button>`;
        })}
      </div>
      ${tile && tile.rows && html`<${Section} title=${tile.label}><${DataTable} empty="Nothing to show" rows=${tile.rows(s)} cols=${tile.cols}/><//>`}
      ${open === 'jobs' && html`<${Section} title="Jobs failed in the last 24 hours"><${FailedJobs}/><//>`}
      ${open === 'queued' && html`<${Section} title="Queued workflow runs"><div class="page-desc">The count comes from the GitHub cache. It stays at 0 until the GitHub integration is connected.</div><//>`}
      ${(open === 'hosts' || open === 'online') && html`<${Section} title="Hosts by type">
        <${KV} rows=${[...Object.entries(s.totals.by_os).map(([k, v]) => [`OS ${k}`, v]), ...Object.entries(s.totals.by_kind).map(([k, v]) => [`Kind ${k}`, v]),
          ...Object.entries(s.totals.by_status).map(([k, v]) => [`Status ${k}`, v])]}/>
      <//>`}
      <${Section} title="Fleet average, last 24 hours"><${Chart} data=${trend} unit="%" max=${100}/><//>
    </div>`}
    ${!s && !error && html`<div class="page-desc">Loading</div>`}
  </div>`;
}
