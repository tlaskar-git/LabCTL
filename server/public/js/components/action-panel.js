import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html } from '../ui.js';
import { Section, toneBadge, fmtAgo } from './chart-kit.js';
import { GuardDialog } from './guard-dialog.js';
import { useAppState } from '../state.js';
import { openJobDrawer } from '../job-drawer.js';

// Host actions: GET /api/hosts/:id/actions (templates that fit the host, grouped) and the latest log per template.
export function useActions(hostId) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    setData(null);
    api(`/api/hosts/${encodeURIComponent(hostId)}/actions`).then(r => live && setData(r), () => live && setData({ groups: [], roles: [] }));
    return () => { live = false; };
  }, [hostId]);
  return data;
}

// { template id: { log, status, at, job_id } }. Reloads every 10 s and when reload() is called.
export function useResults(hostId) {
  const [results, setResults] = useState({});
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () => api(`/api/hosts/${encodeURIComponent(hostId)}/action-results`)
      .then(rows => live && setResults(Object.fromEntries(rows.map(r => [r.template, r]))), () => {});
    load();
    const t = setInterval(load, 10000);
    return () => { live = false; clearInterval(t); };
  }, [hostId, n]);
  return [results, () => setTimeout(() => setN(x => x + 1), 1500)];
}

// Groups to show: `groups` limits by group name, `categories` by template category (default vps and proxmox).
export function ActionPanel({ host, data, title = 'Actions', groups, categories = ['vps', 'proxmox'], custom, onStarted, addToast }) {
  const { user } = useAppState();
  const canRun = !!user && ['operator', 'admin'].includes(user.role);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState('');
  if (!data) return null;
  const shown = data.groups
    .filter(g => !groups || groups.includes(g.group))
    .map(g => ({ ...g, actions: g.actions.filter(a => categories.includes(a.category)) }))
    .filter(g => g.actions.length);
  if (!shown.length) return null;

  const run = async a => {
    if (custom?.[a.id]) return custom[a.id](a);
    if (a.guard || a.params.length) return setDialog(a);
    setBusy(a.id);
    try {
      const r = await api(`/api/templates/${encodeURIComponent(a.id)}/run`, { method: 'POST', body: { host_ids: [host.id] } });
      if (r.jobs?.[0]) { addToast?.('Job started'); onStarted?.(); openJobDrawer(r.jobs[0].job_id); }
    } catch (e) { addToast?.(e.message, 'error'); }
    setBusy('');
  };

  return html`<${Section} title=${title}>
    ${shown.map(g => html`<div key=${g.group} style=${{ marginBottom: 12 }}>
      <div class="form-label">${g.group}</div>
      ${g.actions.map(a => html`<div key=${a.id} style=${{ display: 'flex', gap: 12, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
        <div style=${{ flex: 1, minWidth: 0 }}>
          <strong>${a.name}</strong> ${a.guard && toneBadge('warn', 'Typed confirmation')}
          <div class="page-desc">${a.description}</div>
        </div>
        <button class=${`btn btn-sm ${g.group === 'Danger' ? 'btn-danger' : ''}`} disabled=${!canRun || busy === a.id || a.secrets.length > 0}
          title=${a.secrets.length ? 'Needs a stored credential. Run it from the Templates page.' : ''} onClick=${() => run(a)}>Run</button>
      </div>`)}
    </div>`)}
    ${dialog && html`<${GuardDialog} action=${dialog} host=${host} addToast=${addToast} onStarted=${onStarted} onClose=${() => setDialog(null)}/>`}
  <//>`;
}

// One result card: title, age and status of the latest job (opens the drawer), then children when a result exists.
export function ResultSection({ title, res, children }) {
  const right = res && html`<span class="page-desc"><a href="#/jobs" onClick=${e => { e.preventDefault(); openJobDrawer(res.job_id); }}>${fmtAgo(res.at)}</a> ${toneBadge(res.status === 'completed' ? 'ok' : 'bad', res.status)}</span>`;
  return html`<${Section} title=${title} right=${right}>${res ? children : html`<div class="page-desc">Not run yet. Use the actions below.</div>`}<//>`;
}
