import { useState, useEffect } from 'preact/hooks';
import { api, subscribe } from '../api.js';
import { html, Icons, StatusBadge } from '../ui.js';
import { openJobDrawer } from '../job-drawer.js';
import { fmtDuration } from '../components/job-tiles.js';

// ── Jobs page: history with filters, and search across job logs ──────────
const STATUSES = ['all', 'running', 'pending', 'sent', 'completed', 'failed', 'cancelled'];

function Snippet({ text, q }) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0 || !q) return text;
  return html`${text.slice(0, i)}<mark style=${{ background: 'var(--yellow)', color: '#111' }}>${text.slice(i, i + q.length)}</mark>${text.slice(i + q.length)}`;
}

export default function JobsPage({ hosts, addToast, currentUser }) {
  const [jobs, setJobs] = useState([]);
  const [status, setStatus] = useState('all');
  const [f, setF] = useState({ host_id: '', type: '', actor: '', from: '', to: '' });
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  const [searching, setSearching] = useState(false);
  const canAct = currentUser && ['operator', 'admin'].includes(currentUser.role);

  const filterQuery = () => {
    const p = new URLSearchParams();
    if (f.host_id) p.set('host_id', f.host_id);
    if (f.type) p.set('type', f.type);
    if (f.actor) p.set('actor', f.actor);
    if (f.from) p.set('from', f.from);
    if (f.to) p.set('to', `${f.to}T23:59:59.999Z`);
    return p;
  };

  // The list refreshes on change notices from /api/events (see api.js subscribe).
  useEffect(() => {
    const p = filterQuery();
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

  const rows = status === 'all' ? jobs : jobs.filter(j => j.status === status);
  // Re-render every 5 s while a job waits in 'sent', so its waiting time stays current.
  const [, tick] = useState(0);
  const waiting = jobs.some(j => j.status === 'sent');
  useEffect(() => { if (!waiting) return; const i = setInterval(() => tick(n => n + 1), 5000); return () => clearInterval(i); }, [waiting]);
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const hostName = id => (hosts.find(h => h.id === id) || {}).hostname || id;

  return html`<div>
    <div class="page-header">
      <div>
        <div class="page-title">Jobs</div>
        <div class="page-desc">${jobs.length} jobs in this view</div>
      </div>
    </div>

    <form class="card" style=${{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }} onSubmit=${search}>
      <input class="input" style=${{ flex: '1 1 260px' }} type="search" placeholder="Search the output of all jobs (matches the filters below)" value=${q}
        onInput=${e => setQ(e.target.value)} aria-label="Search job logs"/>
      <button class="btn btn-primary" type="submit" disabled=${searching}>${searching ? 'Searching...' : 'Search logs'}</button>
      ${found && html`<button class="btn" type="button" onClick=${() => setFound(null)}>Clear results</button>`}
    </form>

    ${found && html`<div class="table-wrap" style=${{ marginBottom: 12 }}>
      <div style=${{ padding: '8px 12px', fontSize: 12, color: 'var(--text-dim)' }}>
        ${found.matches.length} match(es) in ${found.scanned} job log(s)${found.truncated ? ', more exist: narrow the search' : ''}. The newest 500 jobs are searched.
      </div>
      <table><thead><tr><th>Host</th><th>Job</th><th>Line</th><th>Text</th></tr></thead><tbody>
        ${found.matches.map((m, i) => html`<tr key=${i} style=${{ cursor: 'pointer' }} onClick=${() => openJobDrawer(m.job_id, { search: q.trim() })}>
          <td>${m.hostname}</td>
          <td style=${{ fontSize: 12, color: 'var(--text-dim)' }}>${m.type} · ${m.created_at.slice(0, 16).replace('T', ' ')}</td>
          <td>${m.line}</td>
          <td style=${{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}><${Snippet} text=${m.text} q=${q.trim()}/></td>
        </tr>`)}
        ${!found.matches.length && html`<tr><td colSpan=${4} style=${{ textAlign: 'center', padding: 20, color: 'var(--text-dim)' }}>No matches.</td></tr>`}
      </tbody></table>
    </div>`}

    <div style=${{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
      <select class="select" style=${{ width: 180 }} value=${f.host_id} onChange=${set('host_id')} aria-label="Host">
        <option value="">All hosts</option>
        ${hosts.map(h => html`<option key=${h.id} value=${h.id}>${h.hostname}</option>`)}
      </select>
      <input class="input" style=${{ width: 140 }} placeholder="Type" value=${f.type} onInput=${set('type')} aria-label="Type"/>
      <input class="input" style=${{ width: 140 }} placeholder="Started by" value=${f.actor} onInput=${set('actor')} aria-label="Started by"/>
      <input class="input" style=${{ width: 150 }} type="date" value=${f.from} onInput=${set('from')} aria-label="From date"/>
      <input class="input" style=${{ width: 150 }} type="date" value=${f.to} onInput=${set('to')} aria-label="To date"/>
    </div>

    <div class="tabs">
      ${STATUSES.map(s => html`<div key=${s} class=${`tab ${status === s ? 'active' : ''}`} onClick=${() => setStatus(s)}>
        ${s} (${s === 'all' ? jobs.length : jobs.filter(j => j.status === s).length})
      </div>`)}
    </div>

    <div class="table-wrap">
      <table>
        <thead><tr><th>Status</th><th>Type</th><th>Host</th><th>Started by</th><th>Created</th><th>Duration</th><th>Actions</th></tr></thead>
        <tbody>
          ${rows.map(job => html`<tr key=${job.id}>
            <td><${StatusBadge} status=${job.status}/>
              ${job.status === 'sent' && !job.bytes_received && html`<div style=${{ fontSize: 11, color: 'var(--text-dim)' }}>
                Sent to the agent, waiting for the first output (${Math.max(0, Math.round((Date.now() - new Date(job.sent_at || job.created_at)) / 1000))} s)</div>`}
              ${['pending', 'failed'].includes(job.status) && job.error && html`<div style=${{ fontSize: 11, color: job.status === 'failed' ? 'var(--red)' : 'var(--text-dim)', maxWidth: 320 }}>${job.error}</div>`}
            </td>
            <td style=${{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}>${job.type}</td>
            <td>${job.hostname || hostName(job.host_id)}</td>
            <td style=${{ fontSize: 12 }}>${job.started_by || 'system'}</td>
            <td style=${{ fontSize: 12, color: 'var(--text-dim)' }}>${job.created_at.slice(0, 19).replace('T', ' ')}</td>
            <td style=${{ fontSize: 12 }}>${job.duration_ms !== null && job.duration_ms !== undefined ? fmtDuration(job.duration_ms) : '-'}</td>
            <td><div class="btn-group">
              <button class="btn btn-sm" onClick=${() => openJobDrawer(job.id)}><${Icons.Eye}/> View</button>
              ${job.group_id && html`<button class="btn btn-sm" onClick=${() => openJobDrawer(job.group_id)} title="All hosts of this job">Group</button>`}
              ${canAct && ['pending', 'sent', 'running'].includes(job.status) && html`<button class="btn btn-sm btn-danger" onClick=${() => cancelJob(job.id)}><${Icons.Stop}/> Cancel</button>`}
            </div></td>
          </tr>`)}
          ${rows.length === 0 && html`<tr><td colSpan=${7} style=${{ textAlign: 'center', padding: 30, color: 'var(--text-dim)' }}>No jobs found.</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>`;
}
