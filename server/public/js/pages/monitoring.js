import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons } from '../ui.js';
import { MiniBar, Dash, orDash, has, usedOf, uptimeText, loadText, seenText } from '../components/host-view.js';

export default function MonitoringPage({ hosts, addToast, currentUser }) {
  const [health, setHealth] = useState([]);
  const [settings, setSettings] = useState({ retention_days: 30, poll_interval_seconds: 300 });
  const [hostId, setHostId] = useState('');

  const load = async () => {
    try {
      const [h, s] = await Promise.all([api('/api/health/hosts'), api('/api/settings')]);
      setHealth(h); setSettings(s);
    } catch (e) { addToast(e.message, 'error'); }
  };
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);

  const saveSettings = async () => {
    try {
      const next = await api('/api/settings', { method: 'PUT', body: settings });
      setSettings(next);
      addToast('Monitoring settings saved');
    } catch (e) { addToast(e.message, 'error'); }
  };

  const criticalCount = health.filter(h => h.criticals?.length).length;
  const rows = hostId ? health.filter(h => h.host_id === hostId) : health;
  // Highest value across hosts, with the host it belongs to; null when no host reported it.
  const top = f => rows.reduce((a, h) => (has(f(h.view || {})) && (!a || f(h.view) > a.v) ? { v: f(h.view), name: h.hostname } : a), null);
  const tile = (label, t) => html`<div class="metric-card"><div class="page-desc">${label}</div>
    <div class="metric-value">${t ? `${Math.round(t.v)}%` : html`<${Dash}/>`}</div><div class="page-desc">${t ? t.name : ''}</div></div>`;

  return (
    html`<div>
      <div class="page-header">
        <div>
          <div class="page-title">Monitoring</div>
          <div class="page-desc">Latest CPU, memory, disk, Docker state and service warnings per host. Offline hosts show their last reported values.</div>
        </div>
        <button class="btn" onClick=${load}><${Icons.RefreshCw}/> Refresh</button>
      </div>
      <div class="metric-grid">
        <div class="metric-card"><div class="page-desc">Hosts with warnings</div><div class="metric-value">${criticalCount}</div></div>
        ${tile('Highest CPU usage', top(v => v.cpu_percent))}
        ${tile('Highest RAM usage', top(v => v.ram?.percent))}
        ${tile('Highest disk usage', top(v => v.disk_max_percent))}
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
            <thead><tr><th>Host</th><th>Reported</th><th>CPU</th><th>Load</th><th>RAM</th><th>Disk</th><th>Uptime</th><th>Docker</th><th>Warnings</th></tr></thead>
            <tbody>
              ${rows.map(h => {
                const v = h.view || {};
                return (
                  html`<tr key=${h.host_id} style=${{ opacity: h.online ? 1 : 0.7 }}>
                    <td><a href=${`#/host/${encodeURIComponent(h.host_id)}`}>${h.hostname}</a><div class="page-desc">${[h.os, v.arch].filter(Boolean).join(' / ')}</div></td>
                    <td style=${{ whiteSpace: 'nowrap' }}>${orDash(seenText(v, h.online))}</td>
                    <td><${MiniBar} percent=${v.cpu_percent} title=${has(v.cpu_cores) ? `${v.cpu_cores} cores` : ''}/></td>
                    <td class="mono">${orDash(loadText(v.load))}</td>
                    <td><${MiniBar} percent=${v.ram?.percent} title=${usedOf(v.ram?.used, v.ram?.total) || ''}/></td>
                    <td><${MiniBar} percent=${v.disk_max_percent} title=${(v.disks || []).map(d => `${d.mount} ${has(d.percent) ? Math.round(d.percent) : '-'}%`).join(', ')}/></td>
                    <td class="mono" style=${{ whiteSpace: 'nowrap' }}>${orDash(uptimeText(v.uptime_s))}</td>
                    <td>${has(v.docker_total) ? `${v.docker_running ?? 0}/${v.docker_total}` : orDash(null)}</td>
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
