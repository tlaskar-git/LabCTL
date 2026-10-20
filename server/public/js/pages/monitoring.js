import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons } from '../ui.js';
import { orDash, has, usedOf, uptimeText, loadText, seenText } from '../components/host-view.js';
import { Chip, EmptyState, Gauge, KitIcons, OsIcon, SectionHeader, Segmented, Skeleton, StatCard, hostFor, hostName, nameFor } from '../components/ui-kit.js';

export default function MonitoringPage({ hosts, addToast, currentUser }) {
  const [health, setHealth] = useState(null);
  const [settings, setSettings] = useState({ retention_days: 30, poll_interval_seconds: 300 });
  const [hostId, setHostId] = useState('');
  const [only, setOnly] = useState('all');

  const load = async () => {
    try {
      const [h, s] = await Promise.all([api('/api/health/hosts'), api('/api/settings')]);
      setHealth(h); setSettings(s);
    } catch (e) { setHealth(x => x || []); addToast(e.message, 'error'); }
  };
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);

  const saveSettings = async () => {
    try {
      const next = await api('/api/settings', { method: 'PUT', body: settings });
      setSettings(next);
      addToast('Monitoring settings saved');
    } catch (e) { addToast(e.message, 'error'); }
  };

  const all = health || [];
  const criticalCount = all.filter(h => h.criticals?.length).length;
  const rows = all.filter(h => (!hostId || h.host_id === hostId) && (only === 'all' || h.criticals?.length));
  // Highest value across hosts, with the host it belongs to; null when no host reported it.
  const top = f => all.reduce((a, h) => (has(f(h.view || {})) && (!a || f(h.view) > a.v) ? { v: f(h.view), name: nameFor(hosts, h.host_id, h.hostname) } : a), null);
  const topTile = (icon, label, t) => html`<${StatCard} icon=${icon} label=${label} value=${t ? `${Math.round(t.v)}%` : '-'}
    tone=${t && t.v >= 90 ? 'bad' : t && t.v >= 75 ? 'warn' : ''} hint=${t ? t.name : 'Not reported'}/>`;

  return html`<div>
    <div class="page-header">
      <div><div class="page-title">Monitoring</div><div class="page-desc">Latest health per host. Offline hosts show their last values.</div></div>
      <button class="btn" onClick=${load}><${Icons.RefreshCw}/> Refresh</button>
    </div>
    ${!health ? html`<${Skeleton} tiles=${4} rows=${3}/>` : html`<div class="page-stack">
      <div class="stat-grid">
        <${StatCard} icon="Alert" label="Hosts with warnings" value=${criticalCount} tone=${criticalCount ? 'bad' : 'ok'} hint=${`of ${all.length} hosts`}
          onClick=${() => setOnly(o => (o === 'warn' ? 'all' : 'warn'))} pressed=${only === 'warn'}/>
        ${topTile('Activity', 'Highest CPU', top(v => v.cpu_percent))}
        ${topTile('Server', 'Highest memory', top(v => v.ram?.percent))}
        ${topTile('HardDrive', 'Highest disk', top(v => v.disk_max_percent))}
      </div>
      <section aria-labelledby="mon-h">
        <${SectionHeader} id="mon-h" title="Hosts" count=${rows.length} right=${html`<div class="filter-bar" style=${{ margin: 0 }}>
          <${Segmented} label="Show" value=${only} onChange=${setOnly} options=${[['all', 'All'], ['warn', 'With warnings', criticalCount]]}/>
          <select class="select" aria-label="Host" value=${hostId} onChange=${e => setHostId(e.target.value)}>
            <option value="">All hosts</option>
            ${hosts.map(h => html`<option key=${h.id} value=${h.id}>${hostName(h)}</option>`)}
          </select></div>`}/>
        ${!rows.length ? html`<${EmptyState} icon="Activity" title=${all.length ? 'Nothing matches' : 'No host reports health yet'}
            text=${all.length ? 'Every host in this view is clear.' : 'Install an agent and its first snapshot shows here within a minute.'}
            action=${!all.length && html`<a class="btn btn-primary" href="#/agents">Install an agent</a>`}/>`
          : html`<div class="mon-grid">${rows.map(h => {
            const v = h.view || {};
            const disks = (v.disks || []).map(d => `${d.mount} ${has(d.percent) ? Math.round(d.percent) : '-'}%`).join(', ');
            return html`<article key=${h.host_id} class=${`mon-tile${h.online ? '' : ' is-offline'}`} aria-label=${nameFor(hosts, h.host_id, h.hostname)}>
              <div class="mon-head">
                <${OsIcon} host=${hostFor(hosts, h.host_id) || { os: h.os }} size=${22}/>
                <a class="row-link" href=${`#/host/${encodeURIComponent(h.host_id)}`}><div class="row-title">${nameFor(hosts, h.host_id, h.hostname)}</div></a>
                <${Chip} status=${h.online ? 'online' : 'offline'} dot>${h.online ? 'online' : 'offline'}<//>
              </div>
              <div class="row-sub">${[h.os, v.arch].filter(Boolean).join(' / ')}${seenText(v, h.online) ? ` · ${seenText(v, h.online)}` : ''}</div>
              <div class="mon-gauges">
                <${Gauge} label="CPU" value=${v.cpu_percent}/>
                <span title=${usedOf(v.ram?.used, v.ram?.total) || ''}><${Gauge} label="Memory" value=${v.ram?.percent}/></span>
                <span title=${disks}><${Gauge} label="Disk" value=${v.disk_max_percent}/></span>
              </div>
              <dl class="mon-meta">
                <div><dt>Load</dt><dd class="mono" title=${loadText(v.load) || ""}>${orDash(loadText(v.load))}</dd></div>
                <div><dt>Uptime</dt><dd>${orDash(uptimeText(v.uptime_s))}</dd></div>
                <div><dt>Docker</dt><dd>${has(v.docker_total) ? `${v.docker_running ?? 0} of ${v.docker_total}` : orDash(null)}</dd></div>
              </dl>
              <div class="chip-row">${h.criticals?.length ? h.criticals.map(c => html`<${Chip} key=${c} tone="bad">${c}<//>`) : html`<${Chip} tone="ok">Clear<//>`}</div>
            </article>`;
          })}</div>`}
      </section>
      <details class="disclose card">
        <summary><${KitIcons.Chevron}/>Retention and snapshot interval</summary>
        <div class="form-row" style=${{ marginTop: 12, flexWrap: 'wrap' }}>
          <div class="form-group" style=${{ minWidth: 180 }}>
            <label class="form-label" for="mon-ret">Days to keep</label>
            <input id="mon-ret" class="input" type="number" min="1" value=${settings.retention_days} onInput=${e => setSettings({ ...settings, retention_days: e.target.value })}/>
          </div>
          <div class="form-group" style=${{ minWidth: 180 }}>
            <label class="form-label" for="mon-int">Snapshot interval (seconds)</label>
            <input id="mon-int" class="input" type="number" min="60" value=${settings.poll_interval_seconds} onInput=${e => setSettings({ ...settings, poll_interval_seconds: e.target.value })}/>
          </div>
          <div style=${{ alignSelf: 'end' }}>
            <button class="btn btn-primary" onClick=${saveSettings} disabled=${currentUser.role !== 'admin'}
              title=${currentUser.role !== 'admin' ? 'Only administrators can change this' : undefined}>Save</button>
          </div>
        </div>
      </details>
    </div>`}
  </div>`;
}
