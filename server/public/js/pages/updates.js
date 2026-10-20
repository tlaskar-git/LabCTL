import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons, Modal } from '../ui.js';
import { Chip, KitIcons, SectionHeader, Skeleton, relTime, absTime, clockTime, nameFor } from '../components/ui-kit.js';

const DONE = ['succeeded', 'rolled_back', 'failed'];
// Same rules as the server (routes/updates.js), so the operator sees a problem before pressing the button.
const GIT_REPO_RE = /^https:\/\/github\.com\/[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const GIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const repoOk = v => GIT_REPO_RE.test(v);
const refOk = v => GIT_REF_RE.test(v) && !v.includes('..');
const STEP_NAMES = { inspect: 'Read the running container', pull: 'Pull the release image', build: 'Build the image from source', backup: 'Back up the database',
  recreate: 'Restart LabCTL on the new image', health: 'Wait for a healthy start', rollback: 'Roll back to the previous image', rollback_health: 'Check the rolled back version' };
const RESULT = { succeeded: ['ok', 'Update finished'], rolled_back: ['warn', 'Update rolled back'], failed: ['bad', 'Update failed'], running: ['info', 'Updating'] };
const RING_RESULT = { updated: 'ok', pending: 'warn', skipped_offline: 'muted', timeout: 'bad', send_failed: 'bad' };

function StepIcon({ s }) {
  if (s === 'ok') return html`<span class="step-icon ok"><${KitIcons.Check}/></span>`;
  if (s === 'failed') return html`<span class="step-icon bad"><${Icons.X}/></span>`;
  return html`<span class="step-icon info"><span class="spin" style=${{ display: 'inline-flex' }}><${KitIcons.Loader}/></span></span>`;
}

// Live progress from the updater sidecar: the step list, the real error text and the restart notice.
function Progress({ status, reconnecting }) {
  if (!status?.steps?.length && !reconnecting) return null;
  const [tone, title] = RESULT[status?.state] || ['muted', status?.state || ''];
  return html`<div class="update-progress" aria-live="polite">
    <div class="section-head"><h2>${title} ${status?.target ? html`<span class="section-count">${status.target}</span>` : null}</h2>
      ${status?.finished ? html`<span class="row-meta" title=${absTime(status.finished)}>${relTime(status.finished)}</span>` : null}</div>
    ${reconnecting && html`<div class="callout" style=${{ marginBottom: 10 }}><${KitIcons.Loader}/><div>LabCTL is restarting. This page reconnects by itself.</div></div>`}
    ${status?.error && html`<div class=${`callout ${tone === 'warn' ? 'warn' : 'bad'}`} style=${{ marginBottom: 10 }}><${KitIcons.Alert}/>
      <div><b>${tone === 'warn' ? 'The new version did not start, so the previous version was put back.' : 'The update stopped.'}</b><p class="mono">${status.error}</p></div></div>`}
    <ol class="steps">${(status?.steps || []).map(s => html`<li key=${s.name} class=${`step step-${s.status}`}>
      <${StepIcon} s=${s.status}/>
      <div class="row-main"><div class="row-title">${STEP_NAMES[s.name] || s.name}</div>
        ${s.detail && html`<div class=${s.status === 'failed' ? 'row-err mono' : 'row-sub wrap'}>${s.detail}</div>`}</div>
      <span class="row-meta">${s.at ? clockTime(s.at) : ''}</span>
    </li>`)}</ol>
  </div>`;
}

// What the release check said, in one line plus the next step.
function ReleaseState({ info, onRetry }) {
  if (info.state === 'ok') {
    return info.newer
      ? html`<div class="callout"><${Icons.Download}/><div><b>Version ${info.latest} is available.</b>
          ${info.release?.published_at && html`<p>Published ${relTime(info.release.published_at)}.</p>`}</div></div>`
      : html`<div class="callout ok"><${KitIcons.Check}/><div><b>LabCTL is up to date.</b><p>The latest release is ${info.latest}.</p></div></div>`;
  }
  if (info.state === 'no_release') {
    return html`<div class="callout"><${KitIcons.Package}/><div><b>No release has been published yet</b><p>${info.message.replace(/^No release has been published yet\.\s*/, '')}</p></div></div>`;
  }
  const retry = html`<button class="btn btn-sm" onClick=${onRetry}><${Icons.RefreshCw}/> Retry</button>`;
  if (info.state === 'rate_limited') {
    return html`<div class="callout warn"><${KitIcons.Alert}/><div style=${{ flex: 1 }}><b>GitHub rate limit reached</b>
      <p>${info.retry_after ? `It resets at ${clockTime(info.retry_after)} (${relTime(info.retry_after)}).` : 'Try again later.'} Build from source still works.</p></div>${retry}</div>`;
  }
  return html`<div class="callout warn"><${KitIcons.Alert}/><div style=${{ flex: 1 }}><b>The release check failed</b><p>${info.message} Build from source still works if the Docker host can reach GitHub.</p></div>${retry}</div>`;
}

function ModeOption({ id, mode, setMode, icon, title, text, disabledReason }) {
  const Icon = icon;
  return html`<label class=${`mode-option${mode === id ? ' selected' : ''}`}>
    <input type="radio" name="update-mode" value=${id} aria-label=${title} checked=${mode === id} onChange=${() => setMode(id)}/>
    <span class="stat-icon"><${Icon}/></span>
    <span class="row-main"><span class="row-title">${title}</span><span class="row-sub wrap">${text}</span>
      ${disabledReason && html`<span class="chip chip-warn" style=${{ marginTop: 6 }}>${disabledReason}</span>`}</span>
  </label>`;
}

// The Updates card. It is also the body of the Updates page.
export function UpdatesCard({ addToast = () => {}, hosts = [] }) {
  const [info, setInfo] = useState(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [mode, setModeState] = useState('image');
  const [repo, setRepo] = useState('');
  const [ref, setRef] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [agents, setAgents] = useState(null);
  const [ring, setRing] = useState('all');
  const [run, setRun] = useState(null);
  const timer = useRef(null);
  const runTimer = useRef(null);
  const confirmRef = useRef(null);
  // Modal does not move focus by itself: put it in the confirmation field.
  useEffect(() => { if (confirmOpen) setTimeout(() => confirmRef.current?.focus(), 0); }, [confirmOpen]);

  const readStatus = async () => {
    try { const st = await api('/api/updates/status'); setStatus(st); setStatusError(''); return st; } catch (e) { setStatusError(e.message); return null; }
  };
  const load = async (refresh = false) => {
    setChecking(true);
    try {
      const i = await api(`/api/updates/check${refresh ? '?refresh=1' : ''}`);
      setInfo(i); setError(''); setModeState(i.update_mode); setRepo(i.git_repo || ''); setRef(i.git_ref || '');
    } catch (e) { setError(e.message); } finally { setChecking(false); }
    api('/api/updates/agents').then(setAgents, () => setAgents(null));
    const st = await readStatus();
    if (st?.state === 'running') poll();
    try { const r = await api('/api/updates/agents/run'); setRun(r); if (r.status === 'running') pollRun(); } catch { /* none yet */ }
  };
  useEffect(() => { load(); return () => { clearInterval(timer.current); clearInterval(runTimer.current); }; }, []);

  // Poll the sidecar every 2 s. While LabCTL restarts the API does not answer: show the notice and keep trying.
  const poll = () => {
    clearInterval(timer.current);
    timer.current = setInterval(async () => {
      try {
        const st = await api('/api/updates/status');
        setReconnecting(false); setStatus(st); setStatusError('');
        if (DONE.includes(st.state)) { clearInterval(timer.current); load(); }
      } catch { setReconnecting(true); }
    }, 2000);
  };

  const setMode = async m => {
    setModeState(m);
    try { await api('/api/updates/mode', { method: 'PUT', body: { mode: m } }); } catch (e) { addToast(e.message, 'error'); }
  };

  const apply = async () => {
    try {
      if (mode === 'git') await api('/api/updates/mode', { method: 'PUT', body: { mode: 'git', git_repo: repo.trim(), git_ref: ref.trim() } });
      const st = await api('/api/updates/apply', { method: 'POST', body: { confirm: typed } });
      setConfirmOpen(false); setTyped(''); setStatus({ configured: true, ...st });
      poll();
    } catch (e) { setConfirmOpen(false); setTyped(''); addToast(e.message, 'error'); }
  };

  const pollRun = () => {
    clearInterval(runTimer.current);
    runTimer.current = setInterval(async () => {
      try {
        const r = await api('/api/updates/agents/run'); setRun(r);
        if (r.status !== 'running') { clearInterval(runTimer.current); setAgents(await api('/api/updates/agents')); }
      } catch { clearInterval(runTimer.current); }
    }, 2000);
  };
  const updateAgents = async () => {
    try { setRun(await api('/api/updates/agents/run', { method: 'POST', body: { ring } })); pollRun(); } catch (e) { addToast(e.message, 'error'); }
  };

  if (!info && !error) return html`<${Skeleton} rows=${3}/>`;
  const running = status?.state === 'running';
  const gitValid = repoOk(repo.trim()) && refOk(ref.trim());
  const blocked = !info?.updater_configured ? 'The updater sidecar is not configured. Set LABCTL_UPDATER_SECRET and start the labctl-updater service.'
    : running ? 'An update is running.'
    : mode === 'image' && info?.state !== 'ok' ? 'Release image needs a published release. Choose Build from source, or publish a release first.'
    : mode === 'image' && !info?.newer ? 'Already on the latest release.'
    : mode === 'git' && !gitValid ? 'Fix the repository or branch first.'
    : '';
  const target = mode === 'git' ? `${ref.trim()} from ${repo.trim().replace(/^https:\/\//, '')}` : `release ${info?.latest}`;

  return html`<div class="page-stack">
    ${error && html`<div class="callout bad"><${KitIcons.Alert}/><div style=${{ flex: 1 }}><b>The update check failed</b><p>${error}</p></div>
      <button class="btn btn-sm" onClick=${() => load(true)}>Retry</button></div>`}
    ${info && html`<section class="card" aria-labelledby="server-h">
      <div class="version-hero">
        <div>
          <div class="stat-head" id="server-h">LabCTL server</div>
          <div class="version-now">v${info.current}</div>
          <div class="stat-hint">Checked ${relTime(info.checked_at)}</div>
        </div>
        <button class="btn" onClick=${() => load(true)} disabled=${checking}>
          <span class=${checking ? 'spin' : ''} style=${{ display: 'inline-flex' }}><${Icons.RefreshCw}/></span> ${checking ? 'Checking' : 'Check now'}</button>
      </div>
      <${ReleaseState} info=${info} onRetry=${() => load(true)}/>
      ${info.release?.notes && html`<details class="disclose" style=${{ marginTop: 12 }}><summary><${KitIcons.Chevron}/>Release notes for ${info.latest}</summary>
        <pre class="notes">${info.release.notes}</pre></details>`}
    </section>`}

    ${info && html`<section class="card" aria-labelledby="method-h">
      <${SectionHeader} id="method-h" title="Update method"/>
      <div class="mode-grid" role="radiogroup" aria-labelledby="method-h">
        <${ModeOption} id="image" mode=${mode} setMode=${setMode} icon=${KitIcons.Package} title="Release image"
          text="Pulls the published image of the latest release. The safest choice." disabledReason=${info.state !== 'ok' ? 'Needs a published release' : ''}/>
        <${ModeOption} id="git" mode=${mode} setMode=${setMode} icon=${KitIcons.Branch} title="Build from source (git)"
          text="The Docker host builds the image from a branch or tag on GitHub. Use it before a release exists or to test a branch."/>
      </div>
      ${mode === 'git' && html`<div class="form-row git-fields">
        <div class="form-group"><label class="form-label" for="git-repo">Repository</label>
          <input id="git-repo" class="input mono" value=${repo} onInput=${e => setRepo(e.target.value)} aria-invalid=${!repoOk(repo.trim())} spellcheck="false"/>
          ${!repoOk(repo.trim()) && html`<div class="row-err">Use a GitHub repository address over HTTPS, in the form github.com/owner/name</div>`}</div>
        <div class="form-group"><label class="form-label" for="git-ref">Branch or tag</label>
          <input id="git-ref" class="input mono" value=${ref} placeholder="main" onInput=${e => setRef(e.target.value)} aria-invalid=${!refOk(ref.trim())} spellcheck="false"/>
          ${!refOk(ref.trim()) && html`<div class="row-err">Letters, digits, dot, dash, underscore and slash only, for example feature/labctl-v2</div>`}</div>
      </div>`}
      <div class="update-action">
        <button class="btn btn-primary" disabled=${!!blocked} onClick=${() => setConfirmOpen(true)} aria-describedby="update-why">
          <${Icons.RefreshCw}/> Update now</button>
        <span id="update-why" class="hint" style=${{ margin: 0 }}>${blocked || `Updates to ${target}. Backup first, automatic roll back if it fails.`}</span>
      </div>
      ${statusError && html`<div class="row-err" style=${{ marginTop: 8 }}>${statusError}</div>`}
      <${Progress} status=${status} reconnecting=${reconnecting}/>
    </section>`}

    ${agents && html`<section class="card" aria-labelledby="agents-h">
      <${SectionHeader} id="agents-h" title="Agents" right=${html`<${Chip} tone="muted">Latest ${agents.bundled}<//>`}/>
      ${agents.outdated > 0
        ? html`<div class="callout warn"><${KitIcons.Alert}/><div style=${{ flex: 1 }}><b>${agents.outdated} ${agents.outdated === 1 ? 'agent is' : 'agents are'} out of date</b>
            <p>${agents.online_outdated} online. Offline agents are skipped. The run stops at the first ring with a failure.</p>
            <div class="filter-bar" style=${{ margin: '10px 0 0' }}>
              <select class="select" aria-label="Rings to update" value=${ring} onChange=${e => setRing(e.target.value)}>
                <option value="all">All rings, one at a time</option><option value="ring0">ring0</option><option value="ring1">ring1</option><option value="ring2">ring2 and untagged</option>
              </select>
              <button class="btn btn-primary" disabled=${run?.status === 'running'} onClick=${updateAgents}>Update all agents</button>
            </div></div></div>`
        : html`<div class="callout ok"><${KitIcons.Check}/><div>Every agent runs ${agents.bundled} or newer.</div></div>`}
      ${run?.rings?.length > 0 && html`<div style=${{ marginTop: 14 }}>
        <div class="section-head"><h2>Last agent run <${Chip} status=${run.status}/></h2>${run.stopped_at ? html`<span class="row-meta">Stopped at ${run.stopped_at}</span>` : null}</div>
        ${run.rings.map(r => html`<div key=${r.ring} style=${{ marginBottom: 8 }}>
          <div class="day-head" style=${{ margin: '6px 0' }}>${r.ring} <${Chip} status=${r.status}/></div>
          <div class="chip-row">${r.hosts.map(h => html`<${Chip} key=${h.id} tone=${RING_RESULT[h.result] || 'muted'} title=${h.result.replace(/_/g, ' ')} dot>${nameFor(hosts, h.id, h.hostname)}<//>`)}</div>
        </div>`)}
      </div>`}
    </section>`}

    ${confirmOpen && html`<${Modal} title="Update LabCTL" onClose=${() => { setConfirmOpen(false); setTyped(''); }}>
      <p class="hint" style=${{ marginTop: 0 }}>LabCTL updates to <b>${target}</b>. It backs up the database, restarts, and rolls back by itself if the new version is not healthy within 90 seconds.</p>
      <label class="form-label" for="update-confirm" style=${{ marginTop: 12 }}>Type UPDATE to continue</label>
      <input id="update-confirm" ref=${confirmRef} class="input" value=${typed} onInput=${e => setTyped(e.target.value)} autocomplete="off"/>
      <div class="btn-group" style=${{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button class="btn" onClick=${() => { setConfirmOpen(false); setTyped(''); }}>Cancel</button>
        <button class="btn btn-danger" disabled=${typed !== 'UPDATE'} onClick=${apply}>Update now</button>
      </div>
    <//>`}
  </div>`;
}

export default function UpdatesPage({ addToast, hosts }) {
  return html`<div>
    <div class="page-header"><div><div class="page-title">Updates</div><div class="page-desc">Keep the LabCTL server and its agents current.</div></div></div>
    <${UpdatesCard} addToast=${addToast} hosts=${hosts}/>
  </div>`;
}
