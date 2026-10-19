import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons, Modal } from '../ui.js';

const DONE = ['succeeded', 'rolled_back', 'failed'];
const wait = ms => new Promise(r => setTimeout(r, ms));
const stepBadge = s => (s === 'ok' ? 'completed' : s === 'failed' ? 'failed' : 'running');

// The Updates card. The Settings page can embed it: import { UpdatesCard } from './updates.js'.
export function UpdatesCard({ addToast = () => {} }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [agents, setAgents] = useState(null);
  const [ring, setRing] = useState('all');
  const [run, setRun] = useState(null);
  const timer = useRef(null);
  const target = useRef('');

  const load = async (refresh = false) => {
    try { setInfo(await api(`/api/updates/check${refresh ? '?refresh=1' : ''}`)); setError(''); } catch (e) { setError(e.message); }
    try { setAgents(await api('/api/updates/agents')); } catch { /* agent list is optional */ }
    try { setStatus(await api('/api/updates/status')); } catch { /* sidecar may be absent */ }
    try { const r = await api('/api/updates/agents/run'); setRun(r); if (r.status === 'running') pollRun(); } catch { /* none yet */ }
  };
  useEffect(() => { load(); return () => clearInterval(timer.current); }, []);

  // Poll the sidecar. When the server is down, poll /api/health until the target version answers, then read the final status.
  const poll = () => {
    clearInterval(timer.current);
    timer.current = setInterval(async () => {
      try {
        const st = await api('/api/updates/status');
        setReconnecting(false);
        setStatus(st);
        if (DONE.includes(st.state)) { clearInterval(timer.current); load(); }
      } catch {
        setReconnecting(true);
        try {
          const h = await api('/api/health', { allowUnauthorized: true });
          if (h.version && (h.version === target.current || target.current === '')) setReconnecting(false);
        } catch { /* still restarting */ }
      }
    }, 2000);
  };

  const apply = async () => {
    try {
      target.current = info?.latest || '';
      const st = await api('/api/updates/apply', { method: 'POST', body: { confirm: typed } });
      setConfirmOpen(false); setTyped(''); setStatus({ configured: true, ...st });
      poll();
    } catch (e) { addToast(e.message, 'error'); }
  };

  const setMode = async (mode) => {
    try { await api('/api/updates/mode', { method: 'PUT', body: { mode } }); setInfo({ ...info, update_mode: mode }); } catch (e) { addToast(e.message, 'error'); }
  };

  const pollRun = () => {
    const t = setInterval(async () => {
      try { const r = await api('/api/updates/agents/run'); setRun(r); if (r.status !== 'running') { clearInterval(t); setAgents(await api('/api/updates/agents')); } } catch { clearInterval(t); }
    }, 2000);
  };
  const updateAgents = async () => {
    try { setRun(await api('/api/updates/agents/run', { method: 'POST', body: { ring } })); pollRun(); } catch (e) { addToast(e.message, 'error'); }
  };

  const running = status?.state === 'running';
  return html`<div>
    <div class="card">
      <div class="card-header"><div class="card-title">LabCTL server</div>
        <button class="btn btn-sm" onClick=${() => load(true)}><${Icons.RefreshCw}/> Check now</button></div>
      ${error && html`<div class="form-label" style=${{ color: 'var(--red)' }}>${error}</div>`}
      ${info && html`<div class="form-row">
        <div class="form-group"><div class="form-label">Current version</div><div>${info.current}</div></div>
        <div class="form-group"><div class="form-label">Latest version</div><div>${info.latest}${info.newer ? ' (update available)' : ' (up to date)'}</div></div>
        <div class="form-group"><div class="form-label">Update mode</div>
          <select class="select" value=${info.update_mode} onChange=${e => setMode(e.target.value)}>
            <option value="image">Pull release image</option>
            <option value="git">Git pull and rebuild</option>
          </select></div>
      </div>`}
      ${info?.notes && html`<div class="form-label">Release notes</div>
        <pre style=${{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto', margin: '4px 0 12px' }}>${info.notes}</pre>`}
      ${info && !info.updater_configured && html`<div class="form-label">The updater sidecar is not configured. Set LABCTL_UPDATER_SECRET and start the labctl-updater service.</div>`}
      <button class="btn btn-primary" disabled=${!info?.updater_configured || running || (!info?.newer && info?.update_mode === 'image')}
        onClick=${() => setConfirmOpen(true)}><${Icons.RefreshCw}/> Update now</button>

      ${reconnecting && html`<div class="form-label" style=${{ marginTop: 12 }}>LabCTL is restarting. Reconnecting...</div>`}
      ${status?.steps?.length > 0 && html`<div style=${{ marginTop: 12 }}>
        <div class="form-label">Update ${status.state}${status.target ? ` (${status.target})` : ''}${status.error ? `: ${status.error}` : ''}</div>
        ${status.steps.map(s => html`<div key=${s.name}><span class=${`badge badge-${stepBadge(s.status)}`}>${s.status}</span> ${s.name}
          <span class="form-label"> ${s.at}${s.detail ? ` ${s.detail}` : ''}</span></div>`)}
      </div>`}
    </div>

    ${agents?.outdated > 0 && html`<div class="card">
      <div class="card-header"><div class="card-title">${agents.outdated} agents out of date (bundled ${agents.bundled})</div></div>
      <div class="form-row">
        <select class="select" value=${ring} onChange=${e => setRing(e.target.value)}>
          <option value="all">All rings, one at a time</option><option value="ring0">ring0</option><option value="ring1">ring1</option><option value="ring2">ring2 and untagged</option>
        </select>
        <button class="btn btn-primary" disabled=${run?.status === 'running'} onClick=${updateAgents}>Update all agents</button>
      </div>
      <div class="form-label">${agents.online_outdated} online. Offline agents are skipped. The run stops at the first ring with a failure.</div>
    </div>`}
    ${run?.rings?.length > 0 && html`<div class="card">
      <div class="card-title">Agent update ${run.status}${run.stopped_at ? ` (stopped at ${run.stopped_at})` : ''}</div>
      ${run.rings.map(r => html`<div key=${r.ring}><div class="form-label">${r.ring}: ${r.status}</div>
        ${r.hosts.map(h => html`<div key=${h.id}><span class=${`badge badge-${h.result === 'updated' ? 'completed' : h.result.startsWith('skipped') || h.result === 'pending' ? 'pending' : 'failed'}`}>${h.result}</span> ${h.hostname}</div>`)}</div>`)}
    </div>`}

    ${confirmOpen && html`<${Modal} title="Update LabCTL" onClose=${() => setConfirmOpen(false)}>
      <p>LabCTL takes a database backup, restarts, and rolls back on its own if the new version is not healthy within 90 seconds.</p>
      <div class="form-label">Type UPDATE to continue</div>
      <input class="input" value=${typed} onInput=${e => setTyped(e.target.value)} autofocus/>
      <div style=${{ marginTop: 12 }}><button class="btn btn-danger" disabled=${typed !== 'UPDATE'} onClick=${apply}>Update now</button></div>
    <//>`}
  </div>`;
}

export default function UpdatesPage({ addToast }) {
  return html`<div>
    <div class="page-header"><div><div class="page-title">Updates</div><div class="page-desc">LabCTL server and agent updates.</div></div></div>
    <${UpdatesCard} addToast=${addToast}/>
  </div>`;
}
