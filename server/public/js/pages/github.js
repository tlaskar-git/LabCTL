import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../api.js';
import { html } from '../ui.js';
import { Section, DataTable, KV, toneBadge, fmtAgo, fmtDuration, arr } from '../components/chart-kit.js';
import { useFleetRunners, RunnerFlags } from '../components/runner-status.js';
import { RunnerActions, AddRunnerButton } from '../components/runner-actions.js';

const SECRET_NAME = 'LABCTL_GITHUB_TOKEN';
const Check = ({ checked, onChange, children }) => html`<label style=${{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
  <input type="checkbox" checked=${checked} onChange=${e => onChange(e.target.checked)}/><span>${children}</span></label>`;

// Settings card: the one fine-grained token (write-only), a permission check, poll status and the optional extra repositories.
export function GithubCard({ addToast }) {
  const [status, setStatus] = useState(null);
  const [token, setToken] = useState('');
  const [writeCheck, setWriteCheck] = useState(false);
  const [result, setResult] = useState(null);
  const [pollS, setPollS] = useState('60');
  const [repos, setRepos] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(() => api('/api/github/status').then(s => { setStatus(s); setPollS(String(s.poll_s)); setRepos(arr(s.repos).join('\n')); }).catch(e => addToast(e.message, 'error')), []);
  useEffect(() => { load(); const t = setInterval(() => api('/api/github/status').then(setStatus).catch(() => {}), 15000); return () => clearInterval(t); }, [load]);

  const run = (name, fn, okText) => async () => {
    setBusy(name);
    try { await fn(); if (okText) addToast(okText); } catch (e) { addToast(e.message, 'error'); }
    setBusy('');
  };
  const save = run('save', async () => { await api('/api/github/token', { method: 'PUT', body: token ? { token } : {} }); setToken(''); await load(); }, 'Token saved');
  const clear = run('clear', async () => { await api('/api/github/token', { method: 'DELETE' }); setResult(null); await load(); }, 'Token removed');
  const check = run('check', async () => setResult(await api('/api/github/check-permissions', { method: 'POST', body: { write_check: writeCheck } })));
  const poll = run('poll', async () => { setStatus(await api('/api/github/poll', { method: 'POST', body: {} })); }, 'Poll finished');
  const saveSettings = run('settings', async () => {
    await api('/api/github/settings', { method: 'PUT', body: { poll_s: Number(pollS), repos: repos.split('\n').map(x => x.trim()).filter(Boolean) } });
    await load();
  }, 'Saved');

  if (!status) return html`<div class="page-desc">Loading</div>`;
  const rate = status.rate_limit;
  return html`<${Section} title="GitHub" right=${toneBadge(status.configured ? 'ok' : 'warn', status.configured ? 'Token set' : 'No token')}>
    <p class="page-desc" style=${{ marginBottom: 10 }}>
      Store the token as ${SECRET_NAME} in your secret store and start LabCTL through a launcher that injects it as an environment variable. On the first save with the field empty, LabCTL reads ${SECRET_NAME} from its environment.
      The token is encrypted at rest and is never shown again. One fine-grained token covers every runner: Administration (read and write) on the repositories,
      or Self-hosted runners (read and write) at organisation level. Queued runs also need Actions (read), and public repository detection needs Metadata (read).
    </p>
    <div class="form-row">
      <div class="form-group"><label class="form-label">${status.configured ? 'Replace token' : 'Token'}</label>
        <input class="input" type="password" autocomplete="new-password" value=${token} onInput=${e => setToken(e.target.value)} placeholder=${status.configured ? 'Enter a new token to replace the current one' : `Paste a token, or leave empty to read ${SECRET_NAME}`}/></div>
    </div>
    <div class="btn-group" style=${{ marginBottom: 14 }}>
      <button class="btn btn-primary" disabled=${!!busy || (status.configured && !token)} onClick=${save}>${status.configured ? 'Replace token' : 'Save token'}</button>
      ${status.configured && html`<button class="btn btn-danger" disabled=${!!busy} onClick=${clear}>Clear token</button>`}
    </div>
    ${status.configured && html`<div>
      <div class="btn-group" style=${{ alignItems: 'center', marginBottom: 10 }}>
        <button class="btn" disabled=${!!busy} onClick=${check}>${busy === 'check' ? 'Checking' : 'Check permissions'}</button>
        <${Check} checked=${writeCheck} onChange=${setWriteCheck}>Also test write access (creates a registration token and discards it)<//>
        <button class="btn" disabled=${!!busy} onClick=${poll}>Poll now</button>
      </div>
      ${result && html`<${DataTable} rows=${result.checks} cols=${[
        { h: 'Scope', f: c => c.scope }, { h: 'Check', f: c => c.name },
        { h: 'Result', f: c => (c.ok === null ? toneBadge('warn', 'Not tested') : toneBadge(c.ok ? 'ok' : 'bad', c.ok ? 'Pass' : 'Fail')) },
        { h: 'Missing permission', f: c => arr(c.missing).join(', ') || '-' }, { h: 'Detail', f: c => c.detail || '-' }]}/>`}
      <div style=${{ height: 12 }}/>
      <${KV} rows=${[['Last poll', status.last_poll_at ? fmtAgo(status.last_poll_at) : 'not yet'], ['Last poll result', status.last_poll_at ? (status.last_poll_ok ? 'OK' : 'Errors') : null],
        ['Poll interval', `${status.poll_s} s`], ['Repositories and organisations', status.scopes],
        ['Rate limit', rate ? `${rate.remaining} of ${rate.limit} left` : null], ['Backing off until', status.backoff_until || undefined]]}/>
      ${arr(status.errors).length ? html`<div style=${{ color: 'var(--red)', margin: '8px 0', fontSize: 12 }}>${status.errors.map((e, i) => html`<div key=${i}>${e}</div>`)}</div>` : null}
      <div class="form-row" style=${{ marginTop: 14 }}>
        <div class="form-group" style=${{ maxWidth: 160 }}><label class="form-label">Poll every (seconds, 30 or more)</label>
          <input class="input" type="number" min="30" value=${pollS} onInput=${e => setPollS(e.target.value)}/></div>
        <div class="form-group"><label class="form-label">Extra repositories for organisation runners (owner/repo, one per line)</label>
          <textarea class="textarea" rows="3" value=${repos} onInput=${e => setRepos(e.target.value)}/></div>
      </div>
      <button class="btn" disabled=${!!busy} onClick=${saveSettings}>Save poll settings</button>
    </div>`}
  <//>`;
}

export default function GitHubPage({ addToast }) {
  const fleet = useFleetRunners();
  const [picked, setPicked] = useState('');
  const hosts = [...new Map(fleet.runners.map(r => [r.host_id, r.hostname])).entries()];
  const hostId = picked || (hosts[0] && hosts[0][0]) || '';
  const flagged = key => fleet.runners.filter(r => r.flags[key]);
  const repos = Object.entries(fleet.queued.repos || {});
  const cols = [
    { h: 'Host', f: r => r.hostname }, { h: 'Runner', f: r => r.name }, { h: 'Scope', f: r => r.scope || '-' },
    { h: 'Local service', f: r => toneBadge(r.local.service_ok ? 'ok' : 'bad', r.local.service_state || 'not installed') },
    { h: 'GitHub', f: r => (r.github ? toneBadge(r.github.status === 'online' ? 'ok' : 'bad', r.github.status) : html`<span class="page-desc">${fleet.github && fleet.github.configured ? 'Not found' : 'Not connected'}</span>`) },
    { h: 'Busy', f: r => ((r.github ? r.github.busy : r.local.busy) ? toneBadge('warn', 'Busy') : 'Idle') },
    { h: 'Labels', f: r => arr(r.github ? r.github.labels : r.local.labels).join(', ') || '-' },
    { h: 'Version', f: r => r.local.version || '-' },
    { h: 'Warnings', f: r => html`<${RunnerFlags} entry=${r}/>` },
    { h: 'Actions', f: r => html`<${RunnerActions} hostId=${r.host_id} hostName=${r.hostname} runner=${r.name} disableUpdate=${r.disable_update} onDone=${fleet.reload} addToast=${addToast}/>` }
  ];
  const addControl = hosts.length ? html`<span class="btn-group" style=${{ alignItems: 'center' }}>
    <select class="select" value=${hostId} onChange=${e => setPicked(e.target.value)}>${hosts.map(([id, name]) => html`<option key=${id} value=${id}>${name}</option>`)}</select>
    <${AddRunnerButton} hostId=${hostId} hostName=${(hosts.find(h => h[0] === hostId) || [])[1]} onDone=${fleet.reload} addToast=${addToast}/></span>` : null;
  return html`<div>
    <div class="page-header"><div><div class="page-title">GitHub</div><div class="page-desc">GitHub access and self-hosted Actions runners across all hosts.</div></div></div>
    <${GithubCard} addToast=${addToast}/>
    <${Section} title="Overview">
      <${KV} rows=${[['Runners', fleet.runners.length], ['Mismatches', flagged('mismatch').length], ['On public repositories', flagged('public_repo').length],
        ['Behind latest', flagged('behind_latest').length], ['Latest runner release', fleet.latest ? fleet.latest.version : null], ['Queued runs', fleet.queued.total]]}/>
    <//>
    <${Section} title="Queued runs by repository">
      <${DataTable} empty="No queued runs" rows=${repos} cols=${[{ h: 'Repository', f: ([k]) => k }, { h: 'Queued', num: true, f: ([, v]) => v.count },
        { h: 'Oldest waiting', f: ([, v]) => (v.oldest_age_s === null ? '-' : fmtDuration(v.oldest_age_s)) }]}/>
    <//>
    <${Section} title=${`Runners (${fleet.runners.length})`} right=${addControl}>
      ${fleet.error ? html`<div style=${{ color: 'var(--red)' }}>${fleet.error}</div>` : null}
      <${DataTable} empty=${fleet.loading ? 'Loading' : 'No runners reported by any host yet'} rows=${fleet.runners} cols=${cols}/>
    <//>
  </div>`;
}
