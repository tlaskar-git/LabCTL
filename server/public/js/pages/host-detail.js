import { useState, useEffect } from 'preact/hooks';
import { html, StatusBadge } from '../ui.js';
import { navigate } from '../router.js';

// Route: #/host/:id?tab=<tab id>. Each tab is its own module in host-tabs/ and loads on first use.
export const tabs = [
  { id: 'overview', title: 'Overview', load: () => import('./host-tabs/overview.js') },
  { id: 'metrics', title: 'Metrics', load: () => import('./host-tabs/metrics.js') },
  { id: 'services', title: 'Services', load: () => import('./host-tabs/services.js') },
  { id: 'docker', title: 'Docker', load: () => import('./host-tabs/docker.js') },
  { id: 'ci-runners', title: 'CI Runners', load: () => import('./host-tabs/ci-runners.js') },
  { id: 'jobs', title: 'Jobs', load: () => import('./host-tabs/jobs.js') },
  { id: 'software-updates', title: 'Software and updates', load: () => import('./host-tabs/software-updates.js') },
  { id: 'security', title: 'Security', load: () => import('./host-tabs/security.js') },
  { id: 'logs', title: 'Logs', load: () => import('./host-tabs/logs.js') },
  { id: 'settings', title: 'Settings', load: () => import('./host-tabs/settings.js') },
];

export default function HostDetail({ hosts, params, query, addToast }) {
  const tab = tabs.find(t => t.id === query.tab) || tabs[0];
  const host = (hosts || []).find(h => h.id === params.id);
  const [loaded, setLoaded] = useState({ id: null, Tab: null });
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    tab.load().then(m => live && setLoaded({ id: tab.id, Tab: m.default }), e => live && setError(e.message));
    return () => { live = false; };
  }, [tab.id]);

  const Tab = loaded.id === tab.id ? loaded.Tab : null;
  const go = id => navigate(`/host/${encodeURIComponent(params.id)}?tab=${id}`);
  return html`
    <div>
      <div class="page-header">
        <div>
          <div class="page-title">${host ? host.hostname : 'Host'}</div>
          <div class="page-desc">${host ? html`<${StatusBadge} status=${host.online ? 'online' : 'offline'}/> ${[host.os, host.os_version, host.kind].filter(Boolean).join(' / ')}` : ''} <span class="mono">${params.id}</span></div>
        </div>
      </div>
      <div class="tabs">
        ${tabs.map(t => html`<div key=${t.id} class=${`tab ${t.id === tab.id ? 'active' : ''}`} onClick=${() => go(t.id)}>${t.title}</div>`)}
      </div>
      ${error && html`<div class="card">Failed to load tab: ${error}</div>`}
      ${Tab && html`<${Tab} key=${params.id} host=${host} hostId=${params.id} addToast=${addToast}/>`}
    </div>`;
}
