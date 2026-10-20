import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../api.js';
import { html } from '../ui.js';
import { toneBadge, fmtDuration, arr } from './chart-kit.js';
import { RunnerActions } from './runner-actions.js';

// GitHub state for runners. useHostRunners feeds the CI runners tab, useFleetRunners feeds the GitHub page.
// Entries come from GET /api/hosts/:id/runners and GET /api/runners (the merged view built by the server).
export function useHostRunners(hostId) {
  const [s, setS] = useState({ byName: {}, github: null, latest: null, error: '' });
  const load = useCallback(() => api(`/api/hosts/${encodeURIComponent(hostId)}/runners`)
    .then(r => setS({ byName: Object.fromEntries(arr(r.runners).map(x => [x.name, x])), github: r.github, latest: r.latest, error: '' }),
      e => setS(p => ({ ...p, error: e.message }))), [hostId]);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  return { ...s, reload: load };
}

export function useFleetRunners() {
  const [s, setS] = useState({ runners: [], github: null, queued: { total: 0, repos: {} }, latest: null, loading: true, error: '' });
  const load = useCallback(() => api('/api/runners').then(r => setS({ ...r, loading: false, error: '' }), e => setS(p => ({ ...p, loading: false, error: e.message }))), []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  return { ...s, reload: load };
}

const flag = (tone, text, title) => html`<span class=${`badge badge-${{ bad: 'failed', warn: 'pending', ok: 'completed' }[tone]}`} title=${title || ''} style=${{ marginRight: 4, display: 'inline-block' }}>${text}</span>`;

// Warning badges for one merged entry.
export function RunnerFlags({ entry }) {
  const f = entry.flags;
  return html`<span>
    ${f.mismatch && flag('bad', 'Mismatch', f.mismatch)}
    ${f.public_repo && html`<a href=${entry.settings_url} target="_blank" rel="noopener noreferrer" style=${{ textDecoration: 'none' }}
      title="Fork pull requests can run code on a self-hosted runner. Open the repository setting that controls this.">${flag('warn', 'Public repository: review fork pull request settings')}</a>`}
    ${f.behind_latest && flag('warn', `Behind ${entry.latest_version}`, `Installed ${entry.local.version}`)}
    ${f.busy_too_long && flag('warn', 'Busy for a long time')}
    ${f.missing_in_github && flag('warn', 'Not found in GitHub', 'No runner with this name is registered in the repository or organisation')}
    ${arr(f.size_warnings).map(w => flag('warn', w))}
    ${entry.github_error && flag('bad', 'GitHub poll failed', entry.github_error)}
  </span>`;
}

const ghCell = (entry, github) => {
  if (!github || !github.configured) return html`<span class="page-desc" data-slot="github-status">Not connected</span>`;
  if (!entry || !entry.github) return html`<span class="page-desc">${entry && entry.scope ? 'Not found in GitHub' : 'Unknown scope'}</span>`;
  return toneBadge(entry.github.status === 'online' ? 'ok' : 'bad', `${entry.github.status}${entry.github.stale ? ' (stale)' : ''}`);
};

// Columns for the CI runners tab. getEntry(row) maps an inventory row to its merged entry (or undefined).
// ctl: { hostId, hostName, github, onChange, addToast }.
export function githubColumns(getEntry, ctl) {
  return [
    { h: 'GitHub status', f: r => ghCell(getEntry(r), ctl.github) },
    { h: 'GitHub busy', f: r => { const e = getEntry(r); return e && e.github ? (e.github.busy ? toneBadge('warn', 'Busy') : 'Idle') : '-'; } },
    { h: 'GitHub labels', f: r => { const e = getEntry(r); return e && e.github ? arr(e.github.labels).join(', ') || '-' : '-'; } },
    { h: 'Queued', f: r => { const e = getEntry(r); return e && e.queued && e.queued.count ? `${e.queued.count}${e.queued.oldest_age_s ? `, oldest ${fmtDuration(e.queued.oldest_age_s)}` : ''}` : '-'; } },
    { h: 'Warnings', f: r => { const e = getEntry(r); return e ? html`<${RunnerFlags} entry=${e}/>` : '-'; } },
    { h: 'Actions', f: r => html`<${RunnerActions} hostId=${ctl.hostId} hostName=${ctl.hostName} runner=${r.name} disableUpdate=${(getEntry(r) || {}).disable_update}
      onDone=${ctl.onChange} addToast=${ctl.addToast}/>` }
  ];
}
