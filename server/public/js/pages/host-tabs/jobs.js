import { useState, useEffect } from 'preact/hooks';
import { api } from '../../api.js';
import { html } from '../../ui.js';
import { openJobDrawer } from '../../job-drawer.js';
import { Section, DataTable, fmtDate, fmtDuration } from '../../components/chart-kit.js';

const dur = ms => (ms === null || ms === undefined ? '-' : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : fmtDuration(Math.round(ms / 1000)));

// Props: host (record from the hosts list, may be undefined), hostId, addToast.
export default function JobsTab({ hostId }) {
  const [jobs, setJobs] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const load = () => api(`/api/jobs?host_id=${encodeURIComponent(hostId)}&limit=100`).then(r => { if (live) { setJobs(r); setError(''); } }, e => live && setError(e.message));
    load();
    const t = setInterval(load, 5000);
    return () => { live = false; clearInterval(t); };
  }, [hostId]);
  if (error) return html`<div class="card">${error}</div>`;
  if (!jobs) return html`<div class="page-desc">Loading</div>`;
  return html`<${Section} title=${`Jobs on this host (${jobs.length})`}>
    <${DataTable} empty="No jobs have run on this host" rows=${jobs} cols=${[
      { h: 'Job', f: j => html`<a href=${`#/host/${encodeURIComponent(hostId)}?tab=jobs`} onClick=${e => { e.preventDefault(); openJobDrawer(j.id); }}>${j.type}</a>` },
      { h: 'Status', f: j => html`<span class=${`badge badge-${j.status}`}>${j.status}</span>` },
      { h: 'Started by', f: j => j.actor || '-' }, { h: 'Created', f: j => fmtDate(j.created_at) },
      { h: 'Duration', num: true, f: j => dur(j.duration_ms) },
      { h: 'Exit', num: true, f: j => j.exit_code ?? '-' }]}/>
  <//>`;
}
