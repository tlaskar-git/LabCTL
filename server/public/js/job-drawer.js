import { useState, useEffect } from 'preact/hooks';
import { api, API } from './api.js';
import { html, Icons, StatusBadge } from './ui.js';
import { useAppState } from './state.js';
import { Terminal } from './components/terminal.js';
import { JobTiles, GroupProgress, fmtDuration } from './components/job-tiles.js';

// Job drawer. openJobDrawer(id) takes a job id, or a group id ("grp-...") for a multi-host job.
// Optional second argument { search } opens the log with that text searched.
let current = null;
const listeners = new Set();

function set(id, opts = {}) {
  current = id == null ? null : { id, search: opts.search || '' };
  listeners.forEach(fn => fn(current));
}

export const openJobDrawer = (id, opts) => set(id, opts);
export const closeJobDrawer = () => set(null);

const isGroup = id => String(id).startsWith('grp-');
const OPEN = ['pending', 'sent', 'running', 'waiting'];
const bytesText = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const when = iso => (iso ? new Date(iso).toLocaleString() : '-');

function Field({ label, children }) {
  return html`<div style=${{ minWidth: 0 }}>
    <div style=${{ fontSize: 11, color: 'var(--text-dim)' }}>${label}</div>
    <div style=${{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${children}</div>
  </div>`;
}

function useTicker(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [active]);
  return now;
}

function JobView({ id, search }) {
  const { user } = useAppState();
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [bytes, setBytes] = useState(0);
  const load = () => api(`/api/jobs/${encodeURIComponent(id)}?log=0`).then(j => { setJob(j); setError(''); }).catch(e => setError(e.message));
  useEffect(() => { setJob(null); setBytes(0); load(); }, [id]);
  const open = !!job && OPEN.includes(job.status);
  const now = useTicker(open);
  const canAct = user && ['operator', 'admin'].includes(user.role);

  const onEvent = e => {
    if (e.type === 'bytes') setBytes(e.value);
    else if (e.type === 'status' || e.type === 'done') load();
  };
  const cancel = async () => { try { await api(`/api/jobs/${id}/cancel`, { method: 'POST' }); } catch (err) { setError(err.message); } load(); };
  const retry = async () => {
    try { const r = await api(`/api/jobs/${id}/retry`, { method: 'POST' }); openJobDrawer(r.id); } catch (err) { setError(err.message); }
  };

  if (error && !job) return html`<div class="card" style=${{ color: 'var(--red)' }}>${error}</div>`;
  if (!job) return html`<div class="page-desc">Loading...</div>`;
  const start = job.started_at || job.created_at;
  const duration = open ? now - new Date(start) : (job.duration_ms ?? (job.completed_at ? new Date(job.completed_at) - new Date(start) : null));
  return html`<div>
    <div style=${{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
      <${StatusBadge} status=${job.status}/>
      <span style=${{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}>${job.type}</span>
      <div style=${{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
        ${canAct && open && html`<button class="btn btn-sm btn-danger" onClick=${cancel}><${Icons.Stop}/> Cancel</button>`}
        ${canAct && !open && html`<button class="btn btn-sm" onClick=${retry}><${Icons.RefreshCw}/> Retry</button>`}
      </div>
    </div>
    <div style=${{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 12 }}>
      <${Field} label="Host">${job.hostname}<//>
      <${Field} label="Started by">${job.started_by || 'system'}<//>
      <${Field} label="Started">${when(job.started_at || job.created_at)}<//>
      <${Field} label="Duration">${fmtDuration(duration)}<//>
      <${Field} label="Exit code">${job.exit_code ?? '-'}<//>
      <${Field} label="Received">${bytesText(Math.max(bytes, job.bytes_received || 0))}<//>
    </div>
    ${job.error && html`<div style=${{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>${job.error}</div>`}
    ${error && html`<div style=${{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>${error}</div>`}
    <${Terminal} key=${id} jobId=${id} initialSearch=${search} onEvent=${onEvent} name=${`${job.hostname}-${job.type}-${String(id).slice(0, 8)}`.replace(/[^A-Za-z0-9._-]/g, '_')}/>
  </div>`;
}

function GroupView({ id }) {
  const { user } = useAppState();
  const [sum, setSum] = useState(null);
  const [error, setError] = useState('');
  const [pick, setPick] = useState(null);
  const now = useTicker(!!sum && !sum.finished);
  const canAct = user && ['operator', 'admin'].includes(user.role);

  useEffect(() => {
    setSum(null); setPick(null);
    const es = new EventSource(`${API}/api/job-groups/${encodeURIComponent(id)}/stream`);
    es.addEventListener('status', e => { const d = JSON.parse(e.data); setSum(d); if (d.finished) es.close(); });
    es.addEventListener('tile', e => {
      const d = JSON.parse(e.data);
      setSum(s => s && { ...s, hosts: s.hosts.map(h => (h.job_id === d.job_id ? { ...h, last_line: d.last_line, bytes_received: d.bytes_received } : h)) });
    });
    es.onerror = () => { if (es.readyState === 2) setError('Group not found'); };
    return () => es.close();
  }, [id]);

  const retryFailed = async () => {
    try { const r = await api(`/api/job-groups/${id}/retry-failed`, { method: 'POST' }); openJobDrawer(r.group_id); } catch (err) { setError(err.message); }
  };
  if (!sum) return html`<div class="page-desc">${error || 'Loading...'}</div>`;
  const failed = sum.counts.failed || 0;
  return html`<div>
    ${pick ? html`<div style=${{ marginBottom: 10 }}><button class="btn btn-sm" onClick=${() => setPick(null)}>All hosts</button></div>` : html`<div>
      <div style=${{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style=${{ fontWeight: 600 }}>${sum.label || sum.type || 'Job group'}</span>
        <span style=${{ fontSize: 12, color: 'var(--text-dim)' }}>${sum.actor || 'system'} · ${when(sum.created_at)}</span>
        ${canAct && failed > 0 && html`<button class="btn btn-sm btn-danger" style=${{ marginLeft: 'auto' }} onClick=${retryFailed}><${Icons.RefreshCw}/> Retry failed hosts (${failed})</button>`}
      </div>
      ${sum.retry_of && html`<div style=${{ fontSize: 12, marginBottom: 8 }}>Retry of <a href="#/jobs" onClick=${e => { e.preventDefault(); openJobDrawer(sum.retry_of); }}>an earlier group</a></div>`}
      ${error && html`<div style=${{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>${error}</div>`}
      <${GroupProgress} sum=${sum}/>
      <div style=${{ marginTop: 12 }}><${JobTiles} sum=${sum} now=${now} onPick=${setPick}/></div>
    </div>`}
    ${pick && html`<${JobView} id=${pick} search=""/>`}
  </div>`;
}

export function JobDrawer() {
  const [cur, setCur] = useState(current);
  useEffect(() => {
    listeners.add(setCur);
    const onKey = e => { if (e.key === 'Escape') closeJobDrawer(); };
    window.addEventListener('keydown', onKey);
    return () => { listeners.delete(setCur); window.removeEventListener('keydown', onKey); };
  }, []);
  if (!cur) return null;
  return html`<div class="drawer-overlay" onClick=${closeJobDrawer}>
    <aside class="drawer" style=${{ width: 'min(980px, 100%)' }} onClick=${e => e.stopPropagation()}>
      <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div class="modal-title">${isGroup(cur.id) ? 'Multi-host job' : 'Job'} <span style=${{ fontFamily: 'Geist Mono, monospace', fontSize: 12, color: 'var(--text-dim)' }}>${String(cur.id).slice(0, 12)}</span></div>
        <button class="btn-close" onClick=${closeJobDrawer} aria-label="Close"><${Icons.X}/></button>
      </div>
      ${isGroup(cur.id) ? html`<${GroupView} key=${cur.id} id=${cur.id}/>` : html`<${JobView} key=${cur.id} id=${cur.id} search=${cur.search}/>`}
    </aside>
  </div>`;
}
