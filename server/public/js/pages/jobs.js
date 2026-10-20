import { useState, useEffect } from 'preact/hooks';
import { api, subscribe } from '../api.js';
import { html, Icons } from '../ui.js';
import { openJobDrawer } from '../job-drawer.js';
import { JOB_TYPES } from '../job-types.js';
import { fmtDuration } from '../components/job-tiles.js';
import { Chip, EmptyState, KitIcons, SectionHeader, Segmented, Skeleton, absTime, clockTime, groupByDay, relTime, hostName as displayName, nameFor } from '../components/ui-kit.js';

// ── Jobs page: a day-by-day list with status chips, filters in one slim bar, and search across job logs ──────────
const STATUSES = ['all', 'running', 'pending', 'sent', 'completed', 'failed', 'cancelled'];
const OPEN = ['pending', 'sent', 'running'];
const label = type => JOB_TYPES[type]?.label || type;

function Snippet({ text, q }) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0 || !q) return text;
  return html`${text.slice(0, i)}<mark class="hit">${text.slice(i, i + q.length)}</mark>${text.slice(i + q.length)}`;
}

function JobRow({ job, hostName, canAct, onCancel }) {
  const when = job.created_at;
  return html`<div class="row">
    <${Chip} status=${job.status} dot>${job.status}<//>
    <div class="row-main">
      <button class="row-link" onClick=${() => openJobDrawer(job.id)} aria-label=${`Open ${label(job.type)} on ${job.host_name || hostName(job.host_id, job.hostname)}`}>
        <div class="row-title">${label(job.type)} <span class="muted" style=${{ fontWeight: 500 }}>on ${job.host_name || hostName(job.host_id, job.hostname)}</span></div>
      </button>
      <div class="row-sub">${job.started_by || 'system'}${job.duration_ms !== null && job.duration_ms !== undefined ? ` · ${fmtDuration(job.duration_ms)}` : ''}</div>
      ${job.status === 'sent' && !job.bytes_received && html`<div class="row-sub">
        Waiting for the first output, ${Math.max(0, Math.round((Date.now() - new Date(job.sent_at || job.created_at)) / 1000))} s</div>`}
      ${['pending', 'failed'].includes(job.status) && job.error && html`<div class=${job.status === 'failed' ? 'row-err' : 'row-sub wrap'}>${job.error}</div>`}
    </div>
    <span class="row-meta" title=${absTime(when)}>${clockTime(when)}</span>
    <div class="row-actions">
      ${job.group_id && html`<button class="btn btn-sm" onClick=${() => openJobDrawer(job.group_id)} title="All hosts of this job">Group</button>`}
      ${canAct && OPEN.includes(job.status) && html`<button class="btn btn-sm btn-icon" onClick=${() => onCancel(job.id)} aria-label="Cancel job" title="Cancel job"><${Icons.Stop}/></button>`}
    </div>
  </div>`;
}

export default function JobsPage({ hosts, addToast, currentUser }) {
  const [jobs, setJobs] = useState(null);
  const [status, setStatus] = useState('all');
  const [f, setF] = useState({ host_id: '', type: '', actor: '', from: '', to: '' });
  const [more, setMore] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  const [searching, setSearching] = useState(false);
  const canAct = currentUser && ['operator', 'admin'].includes(currentUser.role);

  // The list refreshes on change notices from /api/events (see api.js subscribe).
  useEffect(() => {
    const p = new URLSearchParams();
    if (f.host_id) p.set('host_id', f.host_id);
    if (f.type) p.set('type', f.type);
    if (f.actor) p.set('actor', f.actor);
    if (f.from) p.set('from', f.from);
    if (f.to) p.set('to', `${f.to}T23:59:59.999Z`);
    p.set('limit', '500');
    return subscribe(`jobs?${p}`, setJobs);
  }, [f.host_id, f.type, f.actor, f.from, f.to]);

  const search = async e => {
    e && e.preventDefault();
    if (q.trim().length < 2) { addToast('Type at least 2 characters to search.', 'error'); return; }
    setSearching(true);
    try {
      const p = new URLSearchParams();
      p.set('q', q.trim());
      if (f.host_id) p.set('host', f.host_id);
      if (status !== 'all') p.set('status', status);
      if (f.from) p.set('from', f.from);
      if (f.to) p.set('to', `${f.to}T23:59:59.999Z`);
      setFound(await api(`/api/logs/search?${p}`));
    } catch (err) { addToast(err.message, 'error'); } finally { setSearching(false); }
  };

  const cancelJob = async id => {
    try { await api(`/api/jobs/${id}/cancel`, { method: 'POST' }); addToast('Job cancelled'); } catch (err) { addToast(err.message, 'error'); }
  };

  const list = jobs || [];
  const rows = status === 'all' ? list : list.filter(j => j.status === status);
  // Re-render every 5 s while a job waits in 'sent', so its waiting time stays current.
  const [, tick] = useState(0);
  const waiting = list.some(j => j.status === 'sent');
  useEffect(() => { if (!waiting) return; const i = setInterval(() => tick(n => n + 1), 5000); return () => clearInterval(i); }, [waiting]);
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const hostName = (id, fallback) => nameFor(hosts, id, fallback);
  const extra = ['type', 'actor', 'from', 'to'].filter(k => f[k]).length;
  const count = s => (s === 'all' ? list.length : list.filter(j => j.status === s).length);

  return html`<div>
    <div class="page-header">
      <div><div class="page-title">Jobs</div><div class="page-desc">${jobs ? `${list.length} jobs in this view` : 'Loading'}</div></div>
    </div>

    <form class="filter-bar" onSubmit=${search} role="search">
      <input class="input grow" type="search" placeholder="Search job output" value=${q} onInput=${e => setQ(e.target.value)} aria-label="Search the output of all jobs"/>
      <select class="select" value=${f.host_id} onChange=${set('host_id')} aria-label="Host">
        <option value="">All hosts</option>
        ${hosts.map(h => html`<option key=${h.id} value=${h.id}>${displayName(h)}</option>`)}
      </select>
      <button class="btn" type="button" aria-expanded=${more} onClick=${() => setMore(m => !m)}><${KitIcons.Filter}/> Filters${extra ? ` (${extra})` : ''}</button>
      <button class="btn btn-primary" type="submit" disabled=${searching}>${searching ? 'Searching' : 'Search'}</button>
      ${found && html`<button class="btn" type="button" onClick=${() => setFound(null)}>Clear results</button>`}
    </form>
    ${more && html`<div class="filter-bar">
      <input class="input" placeholder="Type" value=${f.type} onInput=${set('type')} aria-label="Job type"/>
      <input class="input" placeholder="Started by" value=${f.actor} onInput=${set('actor')} aria-label="Started by"/>
      <input class="input" type="date" value=${f.from} onInput=${set('from')} aria-label="From date"/>
      <input class="input" type="date" value=${f.to} onInput=${set('to')} aria-label="To date"/>
      ${extra > 0 && html`<button class="btn btn-sm" type="button" onClick=${() => setF({ ...f, type: '', actor: '', from: '', to: '' })}>Reset</button>`}
    </div>`}

    ${found && html`<section style=${{ marginBottom: 24 }} aria-labelledby="found-h">
      <${SectionHeader} id="found-h" title="Log matches" count=${found.matches.length}
        right=${html`<span class="row-meta">${found.scanned} logs searched${found.truncated ? ', more exist: narrow the search' : ''}</span>`}/>
      ${found.matches.length ? html`<div class="rows">${found.matches.map((m, i) => html`<div class="row" key=${i}>
        <div class="row-main"><button class="row-link" onClick=${() => openJobDrawer(m.job_id, { search: q.trim() })}>
          <div class="row-title">${nameFor(hosts, m.host_id, m.hostname)} <span class="muted" style=${{ fontWeight: 500 }}>${label(m.type)}, line ${m.line}</span></div></button>
          <div class="row-sub mono"><${Snippet} text=${m.text} q=${q.trim()}/></div></div>
        <span class="row-meta" title=${absTime(m.created_at)}>${relTime(m.created_at)}</span>
      </div>`)}</div>` : html`<${EmptyState} icon="Eye" title="No matches" text="The newest 500 jobs that fit the filters were searched."/>`}
    </section>`}

    <div style=${{ marginBottom: 14 }}>
      <${Segmented} label="Job status" value=${status} onChange=${setStatus}
        options=${STATUSES.filter(s => s === 'all' || s === status || count(s) > 0).map(s => [s, s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1), count(s)])}/>
    </div>

    ${!jobs ? html`<${Skeleton} rows=${6}/>`
      : !rows.length ? html`<${EmptyState} icon="Activity" title="No jobs here" text=${list.length ? 'No job in this view has that status.' : 'Run an action on a host and it shows up here.'}
          action=${!list.length && html`<a class="btn btn-primary" href="#/actions"><${Icons.Play}/> Go to Actions</a>`}/>`
      : groupByDay(rows, 'created_at').map(([day, items]) => html`<div key=${day}>
          <div class="day-head">${day}</div>
          <div class="rows">${items.map(job => html`<${JobRow} key=${job.id} job=${job} hostName=${hostName} canAct=${canAct} onCancel=${cancelJob}/>`)}</div>
        </div>`)}
  </div>`;
}
