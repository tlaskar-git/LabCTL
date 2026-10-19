import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons } from '../ui.js';

export default function MonitoringPage({ hosts, addToast, currentUser }) {
  const [health, setHealth] = useState([]);
  const [metrics, setMetrics] = useState([]);
  const [settings, setSettings] = useState({ retention_days: 30, poll_interval_seconds: 300 });
  const [hostId, setHostId] = useState('');

  const load = async () => {
    try {
      const [h, m, s] = await Promise.all([
        api('/api/health/hosts'),
        api(`/api/metrics?limit=300${hostId ? `&host_id=${hostId}` : ''}`),
        api('/api/settings')
      ]);
      setHealth(h); setMetrics(m); setSettings(s);
    } catch (e) { addToast(e.message, 'error'); }
  };
  useEffect(() => { load(); }, [hostId]);

  const saveSettings = async () => {
    try {
      const next = await api('/api/settings', { method: 'PUT', body: settings });
      setSettings(next);
      addToast('Monitoring settings saved');
    } catch (e) { addToast(e.message, 'error'); }
  };

  const criticalCount = health.filter(h => h.criticals?.length).length;
  const maxDisk = Math.max(0, ...metrics.flatMap(m => (m.drives || []).map(d => Number(d.percent || 0))));
  const maxRam = Math.max(0, ...metrics.map(m => Number(m.ram_used_percent || 0)));

  return (
    html`<div>
      <div class="page-header">
        <div>
          <div class="page-title">Monitoring</div>
          <div class="page-desc">Heartbeat history, disk growth, Docker state, and service warnings.</div>
        </div>
        <button class="btn" onClick=${load}><${Icons.RefreshCw}/> Refresh</button>
      </div>
      <div class="metric-grid">
        <div class="metric-card"><div class="page-desc">Hosts with warnings</div><div class="metric-value">${criticalCount}</div></div>
        <div class="metric-card"><div class="page-desc">Highest disk usage</div><div class="metric-value">${maxDisk}%</div></div>
        <div class="metric-card"><div class="page-desc">Highest RAM usage</div><div class="metric-value">${maxRam}%</div></div>
        <div class="metric-card"><div class="page-desc">Snapshots retained</div><div class="metric-value">${metrics.length}</div></div>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">Retention</div></div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Days to keep</label>
            <input class="input" type="number" min="1" value=${settings.retention_days} onInput=${e => setSettings({ ...settings, retention_days: e.target.value })}/>
          </div>
          <div class="form-group">
            <label class="form-label">Snapshot interval seconds</label>
            <input class="input" type="number" min="60" value=${settings.poll_interval_seconds} onInput=${e => setSettings({ ...settings, poll_interval_seconds: e.target.value })}/>
          </div>
          <div style=${{ alignSelf: 'end' }}>
            <button class="btn btn-primary" onClick=${saveSettings} disabled=${currentUser.role !== 'admin'}><${Icons.Settings}/> Save</button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <div class="card-title">Host health</div>
          <select class="select" style=${{ maxWidth: 260 }} value=${hostId} onChange=${e => setHostId(e.target.value)}>
            <option value="">All hosts</option>
            ${hosts.map(h => html`<option key=${h.id} value=${h.id}>${h.hostname}</option>`)}
          </select>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Host</th><th>Last seen</th><th>Disk</th><th>RAM</th><th>Docker</th><th>Warnings</th></tr></thead>
            <tbody>
              ${health.map(h => {
                const latest = h.latest || {};
                const disk = Math.max(0, ...(latest.drives || []).map(d => Number(d.percent || 0)));
                return (
                  html`<tr key=${h.host_id}>
                    <td>${h.hostname}</td>
                    <td class="mono">${h.last_seen?.slice(0, 19)}</td>
                    <td>${disk}%</td>
                    <td>${latest.ram_used_percent ?? 'N/A'}%</td>
                    <td>${latest.docker_running ?? 0}/${latest.docker_total ?? 0}</td>
                    <td>${h.criticals?.length ? h.criticals.join(', ') : 'Clear'}</td>
                  </tr>`
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>`
  );
}
