import { useState, useEffect, useMemo } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons } from '../ui.js';
import { openJobDrawer } from '../job-drawer.js';
import { Chart } from '../components/chart.js';
import { Chip, EmptyState, KitIcons, OsIcon, SectionHeader, Skeleton, StatCard, relTime, absTime, hostFor, nameFor } from '../components/ui-kit.js';

// Fleet overview from GET /api/fleet/summary. Every count links to the Hosts page filtered to the hosts behind it
// (pages/hosts.js reads the query). Failed jobs have no host filter, so that tile opens a list here.
const ATTENTION = [
  { key: 'offline_hosts', label: 'Offline', tone: 'bad', href: '#/hosts?status=offline', text: h => `Offline, last seen ${relTime(h.last_seen)}` },
  { key: 'disks_over_80', label: 'Disk above 80%', tone: 'bad', href: '#/hosts?disk=high', text: h => `Disk ${h.mount} is ${Math.round(h.percent)}% full` },
  { key: 'runners_offline', label: 'Runner offline', tone: 'bad', href: '#/hosts?runners=offline', text: h => `Runner ${h.runner} is ${h.service_state}` },
  { key: 'pending_reboots', label: 'Reboot pending', tone: 'warn', href: '#/hosts?reboot=1', text: h => `Reboot pending${h.days ? ` for ${h.days} d` : ''}` },
  { key: 'behind_on_patches', label: 'Behind on patches', tone: 'warn', href: '#/hosts?patches=behind', text: h => `${h.pending || 'Some'} updates pending` },
  { key: 'agents_out_of_date', label: 'Agent out of date', tone: 'warn', href: '#/hosts?outdated=1', text: h => `Agent ${h.agent_version}, latest is ${h.latest}` },
];
const SHOW = 8;
const hostHref = id => `#/host/${encodeURIComponent(id)}`;
const lastOf = a => { for (let i = (a || []).length - 1; i >= 0; i--) if (a[i] !== null && a[i] !== undefined) return a[i]; return null; };
const pct = v => (v === null ? '-' : `${Math.round(v)}%`);

function FailedJobs({ hosts }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    api('/api/jobs?status=failed&limit=100').then(r => setRows(r.filter(j => Date.now() - Date.parse(j.completed_at || j.created_at) < 86400000)), () => setRows([]));
  }, []);
  if (!rows) return html`<${Skeleton} rows=${2}/>`;
  if (!rows.length) return html`<${EmptyState} icon="Check" title="No failed jobs in the last 24 hours"/>`;
  return html`<div class="rows">${rows.map(j => html`<div class="row" key=${j.id}>
    <${Chip} tone="bad" dot>failed<//>
    <div class="row-main"><button class="row-link" onClick=${() => openJobDrawer(j.id)}><div class="row-title">${j.type}</div></button>
      <div class="row-sub"><a href=${hostHref(j.host_id)}>${j.host_name || nameFor(hosts, j.host_id, j.hostname)}</a>${j.error ? ` · ${j.error}` : ''}</div></div>
    <span class="row-meta" title=${absTime(j.completed_at || j.created_at)}>${relTime(j.completed_at || j.created_at)}</span>
  </div>`)}</div>`;
}

function Attention({ s, hosts }) {
  const [all, setAll] = useState(false);
  const items = ATTENTION.flatMap(c => (s[c.key] || []).map((h, i) => ({ c, h, k: `${c.key}-${h.host_id}-${i}` })));
  const cats = ATTENTION.filter(c => (s[c.key] || []).length);
  return html`<section aria-labelledby="attn-h">
    <${SectionHeader} id="attn-h" title="Needs attention" count=${items.length}
      right=${cats.length > 0 && html`<div class="chip-row">${cats.map(c => html`<a key=${c.key} class=${`chip chip-${c.tone}`} href=${c.href}
        aria-label=${`${c.label}: ${s[c.key].length}. Open the Hosts page filtered to them`}>${c.label} ${s[c.key].length}</a>`)}</div>`}/>
    ${!items.length ? html`<${EmptyState} icon="Check" title="All clear" text="No host is offline, short of disk, behind on patches or waiting for a reboot."/>`
      : html`<div class="rows">${(all ? items : items.slice(0, SHOW)).map(({ c, h, k }) => html`<div class="row" key=${k}>
          <span class=${`attn-dot ${c.tone}`} aria-hidden="true"/>
          <${OsIcon} host=${hostFor(hosts, h.host_id) || {}} size=${20}/>
          <div class="row-main"><a class="row-link" href=${hostHref(h.host_id)}><div class="row-title">${nameFor(hosts, h.host_id, h.hostname)}</div></a>
            <div class="row-sub">${c.text(h)}</div></div>
          <${Chip} tone=${c.tone}>${c.label}<//>
        </div>`)}</div>
        ${items.length > SHOW && html`<button class="btn btn-sm" style=${{ marginTop: 8 }} onClick=${() => setAll(a => !a)}>${all ? 'Show fewer' : `Show all ${items.length}`}</button>`}`}
  </section>`;
}

export default function FleetPage({ hosts = [] }) {
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  const [failedOpen, setFailedOpen] = useState(false);
  const load = () => api('/api/fleet/summary').then(r => { setS(r); setError(''); }, e => setError(e.message));
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);
  const trend = useMemo(() => s && ({ ts: s.trend.ts, series: [{ label: 'CPU', values: s.trend.cpu }, { label: 'Memory', values: s.trend.ram }] }), [s?.generated_at]);

  const t = s?.totals;
  const cpu = s && lastOf(s.trend.cpu), ram = s && lastOf(s.trend.ram);
  return html`<div>
    <div class="page-header">
      <div><div class="page-title">Overview</div><div class="page-desc">Online means seen in the last ${s?.online_window_s ?? 90} seconds.</div></div>
      <button class="btn" onClick=${load}><${Icons.RefreshCw}/> Refresh</button>
    </div>
    ${error && html`<div class="callout bad" style=${{ marginBottom: 16 }}><${KitIcons.Alert}/><div>${error}</div></div>`}
    ${!s && !error && html`<${Skeleton} tiles=${6} rows=${4}/>`}
    ${s && html`<div class="page-stack">
      <div class="stat-grid">
        <${StatCard} icon="Server" label="Hosts" value=${t.hosts} href="#/hosts" hint=${Object.entries(t.by_kind).map(([k, v]) => `${k} ${v}`).join(', ') || 'None yet'}/>
        <${StatCard} icon="Activity" label="Online" value=${t.online} tone=${t.hosts && t.online === t.hosts ? 'ok' : ''} href="#/hosts?status=online"
          hint=${t.hosts ? `${Math.round((100 * t.online) / t.hosts)}% of hosts` : ''}/>
        <${StatCard} icon="Power" label="Offline" value=${t.offline} tone=${t.offline ? 'bad' : ''} href="#/hosts?status=offline"/>
        <${StatCard} icon="Stop" label="Failed jobs, 24 h" value=${s.jobs_failed_24h} tone=${s.jobs_failed_24h ? 'bad' : ''}
          pressed=${failedOpen} onClick=${() => setFailedOpen(o => !o)} hint=${failedOpen ? 'Hide the list' : 'Show the list'}/>
        <${StatCard} icon="Activity" label="Average CPU" value=${pct(cpu)} spark=${s.trend.cpu}/>
        <${StatCard} icon="HardDrive" label="Average memory" value=${pct(ram)} spark=${s.trend.ram}/>
        ${s.queued_runs > 0 && html`<${StatCard} icon="Clock" label="Queued workflow runs" value=${s.queued_runs}/>`}
      </div>
      ${failedOpen && html`<section aria-labelledby="failed-h"><${SectionHeader} id="failed-h" title="Jobs failed in the last 24 hours"/><${FailedJobs} hosts=${hosts}/></section>`}
      <${Attention} s=${s} hosts=${hosts}/>
      <section class="card" aria-labelledby="mix-h">
        <${SectionHeader} id="mix-h" title="Fleet mix"/>
        <div class="mix">
          <div><div class="form-label">Operating system</div><div class="chip-row">${Object.entries(t.by_os).map(([k, v]) => html`<${Chip} key=${k}>${k} ${v}<//>`)}</div></div>
          <div><div class="form-label">Connection</div><div class="chip-row">${Object.entries(t.by_kind).map(([k, v]) => html`<${Chip} key=${k}>${k} ${v}<//>`)}</div></div>
        </div>
      </section>
      <section class="card" aria-labelledby="trend-h"><${SectionHeader} id="trend-h" title="Fleet average, last 24 hours"/><${Chart} data=${trend} unit="%" max=${100}/></section>
    </div>`}
  </div>`;
}
