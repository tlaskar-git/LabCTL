import { useState, useEffect } from 'preact/hooks';
import { api, downloadBlob } from '../api.js';
import { html, Icons, StatusBadge, Modal } from '../ui.js';

// ── Jobs Page ─────────────────────────────────────────────
export default function JobsPage({ hosts, addToast }) {
  const [jobs, setJobs] = useState([]);
  const [filter, setFilter] = useState('all');
  const [viewJob, setViewJob] = useState(null);

  const loadJobs = async () => {
    const data = await api('/api/jobs?limit=200');
    setJobs(data);
  };

  useEffect(() => { loadJobs(); const i = setInterval(loadJobs, 5000); return () => clearInterval(i); }, []);

  const cancelJob = async (id) => {
    await api(`/api/jobs/${id}/cancel`, { method: 'POST' });
    addToast('Job cancelled');
    loadJobs();
  };

  const filtered = filter === 'all' ? jobs : jobs.filter(j => j.status === filter);

  return (
    html`<div>
      <div class="page-header">
        <div>
          <div class="page-title">Jobs</div>
          <div class="page-desc">${jobs.length} total jobs</div>
        </div>
        <button class="btn" onClick=${loadJobs}><${Icons.RefreshCw}/> Refresh</button>
      </div>

      <div class="tabs">
        ${['all', 'running', 'pending', 'sent', 'completed', 'failed'].map(f => (
          html`<div key=${f} class=${`tab ${filter === f ? 'active' : ''}`} onClick=${() => setFilter(f)}>
            ${f} (${f === 'all' ? jobs.length : jobs.filter(j => j.status === f).length})
          </div>`
        ))}
      </div>

      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Status</th><th>Type</th><th>Host</th><th>Created</th><th>Actions</th>
          </tr></thead>
          <tbody>
            ${filtered.map(job => (
              html`<tr key=${job.id}>
                <td><${StatusBadge} status=${job.status}/></td>
                <td style=${{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}>${job.type}</td>
                <td>${job.hostname || job.host_id?.slice(0, 8)}</td>
                <td style=${{ fontSize: 12, color: 'var(--text-dim)' }}>${job.created_at}</td>
                <td>
                  <div class="btn-group">
                    <button class="btn btn-sm" onClick=${() => setViewJob(job)}>
                      <${Icons.Eye}/> View
                    </button>
                    ${['pending', 'sent'].includes(job.status) && (
                      html`<button class="btn btn-sm btn-danger" onClick=${() => cancelJob(job.id)}>
                        <${Icons.Stop}/> Cancel
                      </button>`
                    )}
                  </div>
                </td>
              </tr>`
            ))}
            ${filtered.length === 0 && (
              html`<tr><td colSpan=${5} style=${{ textAlign: 'center', padding: 30, color: 'var(--text-dim)' }}>
                No jobs found.
              </td></tr>`
            )}
          </tbody>
        </table>
      </div>

      ${viewJob && (
        html`<${Modal} title=${`Job: ${viewJob.type}`} onClose=${() => setViewJob(null)}>
          <div style=${{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <${StatusBadge} status=${viewJob.status}/>
            <span style=${{ color: 'var(--text-dim)', fontSize: 12 }}>
              ${viewJob.hostname} · ${viewJob.created_at}
            </span>
            <div style=${{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              ${['pending','sent'].includes(viewJob.status) && (
                html`<button class="btn btn-sm" onClick=${async () => {
                  await cancelJob(viewJob.id);
                  setViewJob(v => ({ ...v, status: 'cancelled' }));
                }}>Cancel</button>`
              )}
              ${viewJob.status === 'running' && (
                html`<button class="btn btn-sm btn-danger" onClick=${async () => {
                  await api(`/api/jobs/${viewJob.id}/cancel`, { method: 'POST' });
                  addToast('Kill signal sent');
                  setViewJob(v => ({ ...v, status: 'cancelled' }));
                  loadJobs();
                }}>
                  <${Icons.Stop}/> Kill
                </button>`
              )}
              ${(viewJob.result || viewJob.error) && (
                html`<button class="btn btn-sm" onClick=${() => {
                  downloadBlob(viewJob.result || viewJob.error, `${viewJob.hostname}-${viewJob.type}-${viewJob.id.slice(0,8)}.log`);
                }}>
                  <${Icons.Download}/> Download Log
                </button>`
              )}
            </div>
          </div>
          ${viewJob.params && viewJob.params !== '{}' && (
            html`<div style=${{ marginBottom: 12 }}>
              <div class="form-label">Parameters</div>
              <div class="output-log">${JSON.stringify(JSON.parse(viewJob.params || '{}'), null, 2)}</div>
            </div>`
          )}
          ${viewJob.result && (
            html`<div style=${{ marginBottom: 12 }}>
              <div class="form-label">Output</div>
              <div class="output-log">${viewJob.result}</div>
            </div>`
          )}
          ${viewJob.error && (
            html`<div>
              <div class="form-label" style=${{ color: 'var(--red)' }}>Error</div>
              <div class="output-log" style=${{ borderColor: 'var(--red)' }}>${viewJob.error}</div>
            </div>`
          )}
        <//>`
      )}
    </div>`
  );
}
