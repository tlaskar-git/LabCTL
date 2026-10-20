import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons, Modal } from '../ui.js';
import { openJobDrawer } from '../job-drawer.js';

const UPDATE_TYPES = [['security', 'Security updates'], ['all', 'All updates'], ['os-only', 'Operating system only'], ['apps-only', 'Applications only (Homebrew)']];
const RING_NAMES = ['Ring 0 test', 'Ring 1 general', 'Ring 2 critical'];
const STATUS_BADGE = { success: 'completed', completed: 'completed', failed: 'failed', skipped: 'pending', planned: 'waiting', dry_run: 'waiting', running: 'running', not_run: 'cancelled', missed: 'pending', pending: 'pending' };
const when = iso => (iso ? new Date(iso).toLocaleString() : '-');
const ringNumber = r => (typeof r === 'object' ? r.ring : r);

// A modal that asks for a word to be typed before an action goes ahead.
export function TypedConfirm({ title, word, action, onConfirm, onClose }) {
  const [typed, setTyped] = useState('');
  return html`<${Modal} title=${title} onClose=${onClose}>
    <div class="page-desc" style=${{ marginBottom: 12 }}>${action}</div>
    <div class="form-group">
      <label class="form-label" for="typed-confirm">Type <b>${word}</b> to confirm</label>
      <input id="typed-confirm" class="input" autocomplete="off" autofocus value=${typed} onInput=${e => setTyped(e.target.value)}
        onKeyDown=${e => e.key === 'Enter' && typed === word && onConfirm(typed)}/>
    </div>
    <div class="btn-group">
      <button class="btn btn-primary" disabled=${typed !== word} onClick=${() => onConfirm(typed)}>Confirm</button>
      <button class="btn" onClick=${onClose}>Cancel</button>
    </div>
  <//>`;
}

const blank = { name: '', cron: '', enabled: false, update_type: 'security', rings: [0, 1, 2], reboot: { mode: 'if_required', delay_min: 1 }, drain: { enabled: true, force: false },
  snapshot: { enabled: false, host_id: null, vmids: 'running' }, health: { heartbeat_minutes: 10, services: [], runner_online: true }, maintenance: { mode: 'skip', wait_max_minutes: 120 }, depends_on: null };

function PolicyForm({ initial, hosts, policies, onSave, onClose }) {
  const [p, setP] = useState({ ...blank, ...initial });
  const [services, setServices] = useState((initial.health?.services || []).join(', '));
  const set = (k, v) => setP(x => ({ ...x, [k]: v }));
  const sub = (k, key, v) => setP(x => ({ ...x, [k]: { ...x[k], [key]: v } }));
  const ringOn = n => p.rings.some(r => ringNumber(r) === n);
  const toggleRing = n => set('rings', ringOn(n) ? p.rings.filter(r => ringNumber(r) !== n) : [...p.rings, n].sort((a, b) => ringNumber(a) - ringNumber(b)));
  const save = () => onSave({ ...p, health: { ...p.health, services: services.split(/[,\s]+/).filter(Boolean) } });
  return html`<${Modal} title=${initial.id ? 'Edit patch policy' : 'New patch policy'} onClose=${onClose}>
    <div class="form-row">
      <div class="form-group"><label class="form-label" for="pp-name">Name</label><input id="pp-name" class="input" value=${p.name} onInput=${e => set('name', e.target.value)}/></div>
      <div class="form-group"><label class="form-label" for="pp-cron">Schedule (cron, server time zone)</label><input id="pp-cron" class="input" placeholder="0 2 * * 2 (empty: manual only)" value=${p.cron} onInput=${e => set('cron', e.target.value)}/></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label" for="pp-type">Update type</label>
        <select id="pp-type" class="select input" value=${p.update_type} onChange=${e => set('update_type', e.target.value)}>${UPDATE_TYPES.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}</select></div>
      <div class="form-group"><label class="form-label" for="pp-dep">Runs only if this policy has not failed</label>
        <select id="pp-dep" class="select input" value=${p.depends_on || ''} onChange=${e => set('depends_on', e.target.value || null)}>
          <option value="">No dependency</option>${policies.filter(x => x.id !== p.id).map(x => html`<option key=${x.id} value=${x.id}>${x.name}</option>`)}</select></div>
    </div>
    <div class="form-group"><span class="form-label">Rings, run in order (hosts take their ring from the tags ring0, ring1, ring2)</span>
      <div style=${{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>${[0, 1, 2].map(n => html`<label key=${n} class="checkbox-row"><input type="checkbox" class="checkbox" checked=${ringOn(n)} onChange=${() => toggleRing(n)}/> ${RING_NAMES[n]}</label>`)}</div></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label" for="pp-reboot">Reboot</label>
        <select id="pp-reboot" class="select input" value=${p.reboot.mode} onChange=${e => sub('reboot', 'mode', e.target.value)}>
          <option value="never">Never</option><option value="if_required">If required</option><option value="always">Always</option></select></div>
      <div class="form-group"><label class="form-label" for="pp-delay">Reboot delay (minutes)</label>
        <input id="pp-delay" class="input" type="number" min="0" value=${p.reboot.delay_min} onInput=${e => sub('reboot', 'delay_min', Number(e.target.value))}/></div>
    </div>
    <label class="checkbox-row"><input type="checkbox" class="checkbox" checked=${p.drain.enabled} onChange=${e => sub('drain', 'enabled', e.target.checked)}/> Drain runners first (wait for running builds, never force)</label>
    <div class="form-group" style=${{ marginTop: 10 }}><span class="form-label">Pre-update snapshot (Proxmox)</span>
      <label class="checkbox-row"><input type="checkbox" class="checkbox" checked=${p.snapshot.enabled} onChange=${e => sub('snapshot', 'enabled', e.target.checked)}/> Take a snapshot before updating</label>
      ${p.snapshot.enabled && html`<div class="form-row" style=${{ marginTop: 6 }}>
        <select class="select input" aria-label="Proxmox host" value=${p.snapshot.host_id || ''} onChange=${e => sub('snapshot', 'host_id', e.target.value || null)}>
          <option value="">The host itself (kind proxmox)</option>${hosts.filter(h => h.kind === 'proxmox').map(h => html`<option key=${h.id} value=${h.id}>${h.hostname}</option>`)}</select>
        <input class="input" aria-label="VM ids" placeholder="running, all or 101,102" value=${p.snapshot.vmids} onInput=${e => sub('snapshot', 'vmids', e.target.value)}/>
      </div>`}</div>
    <div class="form-row">
      <div class="form-group"><label class="form-label" for="pp-hb">Health check: agent back within (minutes)</label>
        <input id="pp-hb" class="input" type="number" min="1" value=${p.health.heartbeat_minutes} onInput=${e => sub('health', 'heartbeat_minutes', Number(e.target.value))}/></div>
      <div class="form-group"><label class="form-label" for="pp-svc">Services that must run (comma separated)</label>
        <input id="pp-svc" class="input" value=${services} onInput=${e => setServices(e.target.value)}/></div>
    </div>
    <label class="checkbox-row"><input type="checkbox" class="checkbox" checked=${p.health.runner_online} onChange=${e => sub('health', 'runner_online', e.target.checked)}/> Runner hosts: runner must show online in GitHub</label>
    <div class="form-row" style=${{ marginTop: 10 }}>
      <div class="form-group"><label class="form-label" for="pp-maint">Host in a maintenance window</label>
        <select id="pp-maint" class="select input" value=${p.maintenance.mode} onChange=${e => sub('maintenance', 'mode', e.target.value)}>
          <option value="skip">Skip the host and record it</option><option value="wait">Wait for the window to end</option></select></div>
      <div class="form-group"><label class="form-label" for="pp-wait">Longest wait (minutes)</label>
        <input id="pp-wait" class="input" type="number" min="1" value=${p.maintenance.wait_max_minutes} onInput=${e => sub('maintenance', 'wait_max_minutes', Number(e.target.value))}/></div>
    </div>
    <div class="btn-group" style=${{ marginTop: 12 }}><button class="btn btn-primary" onClick=${save}>Save</button><button class="btn" onClick=${onClose}>Cancel</button></div>
  <//>`;
}

function RunView({ run }) {
  return html`<div>
    ${run.error && html`<div class="page-desc" style=${{ color: 'var(--yellow)', marginBottom: 8 }}>${run.error}</div>`}
    ${run.results.map(r => html`<div key=${r.ring} class="card" style=${{ marginBottom: 10 }}>
      <div class="card-header"><div class="card-title">${RING_NAMES[r.ring]}</div><span class=${`badge badge-${STATUS_BADGE[r.status] || 'pending'}`}>${r.status}</span></div>
      ${r.hosts.length === 0 && html`<div class="page-desc">No host has the tag ring${r.ring}${r.unknown && r.unknown.length ? ' (the tag does not exist yet)' : ''}.</div>`}
      ${r.hosts.map(h => html`<div key=${h.host_id} style=${{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
        <div style=${{ display: 'flex', gap: 8, alignItems: 'center' }}><b>${h.hostname}</b><span class=${`badge badge-${STATUS_BADGE[h.status] || 'pending'}`}>${h.status}</span><span class="page-desc">${h.reason}</span></div>
        <div style=${{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          ${h.steps.map((s, i) => html`<button key=${i} class="btn btn-sm" disabled=${!s.job_id} title=${s.reason || s.template || ''} onClick=${() => s.job_id && openJobDrawer(s.job_id)}>
            ${s.name}: ${s.status}</button>`)}
        </div>
      </div>`)}
    </div>`)}
  </div>`;
}

export default function PatchingPage({ hosts = [], addToast }) {
  const [policies, setPolicies] = useState([]);
  const [runs, setRuns] = useState([]);
  const [tab, setTab] = useState('policies');
  const [edit, setEdit] = useState(null);
  const [ask, setAsk] = useState(null); // { title, word, action, then(confirm) }
  const [view, setView] = useState(null);

  const load = async () => {
    try { setPolicies(await api('/api/patch-policies')); setRuns(await api('/api/patch-runs?limit=30')); } catch (e) { addToast(e.message, 'error'); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { // follow a run that is in progress
    if (!runs.some(r => r.status === 'running') && !(view && view.status === 'running')) return;
    const t = setInterval(async () => { await load(); if (view) setView(await api(`/api/patch-runs/${view.id}`).catch(() => view)); }, 3000);
    return () => clearInterval(t);
  }, [runs, view]);

  const call = async (fn, ok) => { try { const r = await fn(); if (ok) addToast(ok); load(); return r; } catch (e) { addToast(e.message, 'error'); } };
  // Sends the request. A 400 asking for confirmation opens the typed prompt and retries with the word.
  const withConfirm = (title, action, send) => async () => {
    try { await send(); } catch (e) {
      const word = e.confirm_word;
      if (!word) return addToast(e.message, 'error');
      setAsk({ title, word, action, then: confirm => send(confirm).catch(err => addToast(err.message, 'error')) });
    }
  };
  const request = (method, path, body) => async confirm => {
    const token = localStorage.getItem('labctl_token');
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, credentials: 'same-origin', body: JSON.stringify({ ...body, ...(confirm ? { confirm } : {}) }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { confirm_word: data.confirm_required ? data.confirm_word : null });
    addToast(method === 'POST' && path.endsWith('/run') ? (body.dry_run ? 'Dry run started' : 'Run started') : 'Saved');
    setAsk(null); setEdit(null); load();
    return data;
  };

  const save = p => withConfirm('Enable policy', `${p.name || 'This policy'} can reboot hosts. Enabling it needs its name typed.`,
    request(p.id ? 'PUT' : 'POST', p.id ? `/api/patch-policies/${p.id}` : '/api/patch-policies', p))();
  const runIt = (p, dry) => withConfirm('Run policy', `${p.name} can reboot hosts in Ring ${p.rings.map(ringNumber).join(', ')}.`,
    request('POST', `/api/patch-policies/${p.id}/run`, { dry_run: dry }))();
  const toggle = p => save({ ...p, enabled: !p.enabled });
  const remove = p => call(() => api(`/api/patch-policies/${p.id}`, { method: 'DELETE' }), 'Policy deleted');
  const open = async run => setView(await api(`/api/patch-runs/${run.id}`));

  return html`<div>
    <div class="page-header">
      <div><div class="page-title">Patching</div>
        <div class="page-desc">Patch policies walk Ring 0, then Ring 1, then Ring 2. If a ring fails, the next ring does not run. Tag hosts ring0, ring1 or ring2.</div></div>
      <button class="btn btn-primary" onClick=${() => setEdit({})}>+ New policy</button>
    </div>
    <div class="tabs" role="tablist">
      ${[['policies', 'Policies'], ['runs', 'Run history']].map(([k, l]) => html`<button key=${k} role="tab" aria-selected=${tab === k} class=${`tab ${tab === k ? 'active' : ''}`} onClick=${() => setTab(k)}>${l}</button>`)}
    </div>
    ${tab === 'policies' && html`<div class="table-wrap"><table>
      <thead><tr><th>On</th><th>Name</th><th>Rings</th><th>Update</th><th>Reboot</th><th>Schedule</th><th>Next run</th><th>Last run</th><th>Actions</th></tr></thead>
      <tbody>
        ${policies.map(p => html`<tr key=${p.id}>
          <td><div role="switch" aria-checked=${p.enabled} aria-label=${`Enable ${p.name}`} tabindex="0" class=${`toggle ${p.enabled ? 'active' : ''}`} onClick=${() => toggle(p)} onKeyDown=${e => e.key === 'Enter' && toggle(p)}/></td>
          <td style=${{ fontWeight: 600 }}>${p.name}${p.builtin ? html` <span class="badge badge-pending">built in</span>` : ''}</td>
          <td>${p.rings.map(ringNumber).join(', ')}</td><td>${p.update_type}</td><td>${p.reboot.mode}</td>
          <td><code style=${{ fontSize: 12, color: 'var(--accent)' }}>${p.cron || 'manual'}</code></td>
          <td style=${{ fontSize: 12 }}>${p.enabled ? when(p.next_run) : '-'}</td>
          <td>${p.last_run_info ? html`<span class=${`badge badge-${STATUS_BADGE[p.last_run_info.status] || 'pending'}`}>${p.last_run_info.status}</span>` : '-'}</td>
          <td><div class="btn-group">
            <button class="btn btn-sm" onClick=${() => runIt(p, true)} title="Plan only, no jobs">Dry run</button>
            <button class="btn btn-sm btn-primary" onClick=${() => runIt(p, false)}><${Icons.Play}/> Run</button>
            <button class="btn btn-sm" onClick=${() => setEdit(p)}>Edit</button>
            <button class="btn btn-sm btn-danger" aria-label=${`Delete ${p.name}`} onClick=${() => remove(p)}><${Icons.Trash}/></button>
          </div></td>
        </tr>`)}
        ${policies.length === 0 && html`<tr><td colSpan="9" style=${{ textAlign: 'center', padding: 30, color: 'var(--text-dim)' }}>No policies. Create one, or switch on weekly patching under Schedules.</td></tr>`}
      </tbody></table></div>`}
    ${tab === 'runs' && html`<div class="table-wrap"><table>
      <thead><tr><th>Started</th><th>Policy</th><th>Trigger</th><th>Status</th><th>Hosts</th><th>Stopped at ring</th><th></th></tr></thead>
      <tbody>
        ${runs.map(r => html`<tr key=${r.id}>
          <td style=${{ fontSize: 12 }}>${when(r.started_at)}</td><td>${r.policy_name}${r.dry_run ? ' (dry run)' : ''}</td><td>${r.trigger}</td>
          <td><span class=${`badge badge-${STATUS_BADGE[r.status] || 'pending'}`}>${r.status}</span></td>
          <td style=${{ fontSize: 12 }}>${r.summary.success} done, ${r.summary.failed} failed, ${r.summary.skipped} skipped</td>
          <td>${r.stopped_at_ring === null || r.stopped_at_ring === undefined ? '-' : r.stopped_at_ring}</td>
          <td><button class="btn btn-sm" onClick=${() => open(r)}>Details</button></td>
        </tr>`)}
        ${runs.length === 0 && html`<tr><td colSpan="7" style=${{ textAlign: 'center', padding: 30, color: 'var(--text-dim)' }}>No runs yet.</td></tr>`}
      </tbody></table></div>`}
    ${edit && html`<${PolicyForm} initial=${edit} hosts=${hosts} policies=${policies} onSave=${save} onClose=${() => setEdit(null)}/>`}
    ${ask && html`<${TypedConfirm} title=${ask.title} word=${ask.word} action=${ask.action} onConfirm=${ask.then} onClose=${() => setAsk(null)}/>`}
    ${view && html`<${Modal} title=${`${view.policy_name}${view.dry_run ? ' (dry run)' : ''}: ${view.status}`} onClose=${() => setView(null)}><${RunView} run=${view}/><//>`}
  </div>`;
}
