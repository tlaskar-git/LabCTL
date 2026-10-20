import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons, Modal } from '../ui.js';
import { openJobDrawer } from '../job-drawer.js';

// ── Runbooks: list, editor, and run view ─────────────────────────────
const KINDS = [
  ['template', 'Template'], ['script', 'Script'], ['wait_agent', 'Wait for agent'],
  ['github_runner_online', 'GitHub runner online'], ['sleep', 'Sleep'], ['note', 'Note']
];
const SHELLS = ['bash', 'powershell', 'python'];
const STATUS_BADGE = { success: 'completed', failed: 'failed', running: 'running', pending: 'pending', skipped: 'cancelled',
  completed: 'completed', partial: 'waiting', queued: 'pending' };
const blank = kind => ({ kind, name: (KINDS.find(k => k[0] === kind) || [])[1] || kind, on_failure: 'stop', ...(kind === 'sleep' ? { seconds: 60 } : {}) });
const when = iso => (iso ? new Date(iso).toLocaleString() : '-');

// Colours come from the job badge classes, the text keeps the run's own word (skipped, partial).
function Badge({ status }) {
  return html`<span class=${`badge badge-${STATUS_BADGE[status] || status}`}><span class=${`badge-dot ${status === 'running' ? 'pulse' : ''}`}/>${status}</span>`;
}

// The typed confirmation prompt for guarded runs.
function ConfirmModal({ word, onCancel, onConfirm }) {
  const [text, setText] = useState('');
  return html`<${Modal} title="Confirm guarded runbook" onClose=${onCancel}>
    <p class="page-desc">This runbook uses a guarded template. Type <b>${word}</b> to continue.</p>
    <input class="input" value=${text} onInput=${e => setText(e.target.value)} aria-label="Confirmation"/>
    <div style=${{ marginTop: 12 }}><button class="btn btn-danger" disabled=${text !== word} onClick=${() => onConfirm(text)}>Run</button></div>
  <//>`;
}

function TemplateParams({ tpl, params = {}, onChange }) {
  if (!tpl || !tpl.params.length) return null;
  const set = (name, v) => {
    const next = { ...params };
    if (v === '' || v === undefined) delete next[name]; else next[name] = v;
    onChange(next);
  };
  return html`<div style=${{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
    ${tpl.params.map(p => html`<label key=${p.name} style=${{ fontSize: 12 }}>${p.label}
      ${p.type === 'bool' ? html`<select class="select" value=${String(params[p.name] ?? '')} onChange=${e => set(p.name, e.target.value === '' ? '' : e.target.value === 'true')}>
          <option value="">Default (${String(p.default)})</option><option value="true">Yes</option><option value="false">No</option></select>`
        : p.type === 'enum' ? html`<select class="select" value=${params[p.name] ?? ''} onChange=${e => set(p.name, e.target.value)}>
          <option value="">Default (${p.default})</option>${p.options.map(o => html`<option key=${o} value=${o}>${o}</option>`)}</select>`
        : html`<input class="input" type=${p.type === 'int' ? 'number' : 'text'} placeholder=${String(p.default)} value=${params[p.name] ?? ''}
            onInput=${e => set(p.name, p.type === 'int' && e.target.value !== '' ? Number(e.target.value) : e.target.value)}/>`}
    </label>`)}
  </div>`;
}

function StepEditor({ step, index, count, templates, hosts, onChange, onMove, onRemove }) {
  const up = patch => onChange({ ...step, ...patch });
  const tpl = typeof step.template === 'string' ? templates.find(t => t.id === step.template) : null;
  const sel = step.hosts || {};
  const setSel = patch => {
    const next = { ...sel, ...patch };
    for (const k of Object.keys(next)) if (!next[k] || (Array.isArray(next[k]) && !next[k].length)) delete next[k];
    up({ hosts: Object.keys(next).length ? next : undefined });
  };
  return html`<div class="card" style=${{ marginBottom: 8, padding: 12 }}>
    <div style=${{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <b style=${{ minWidth: 22 }}>${index + 1}</b>
      <select class="select" style=${{ width: 190 }} value=${step.kind} aria-label="Step kind"
        onChange=${e => onChange({ ...blank(e.target.value), name: step.name, on_failure: step.on_failure })}>
        ${KINDS.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}
      </select>
      <input class="input" style=${{ flex: '1 1 160px' }} value=${step.name} onInput=${e => up({ name: e.target.value })} placeholder="Step name" aria-label="Step name"/>
      <select class="select" style=${{ width: 150 }} value=${step.on_failure || 'stop'} onChange=${e => up({ on_failure: e.target.value })} aria-label="On failure">
        <option value="stop">Stop on failure</option><option value="continue">Continue on failure</option>
      </select>
      <button class="btn btn-sm" disabled=${index === 0} onClick=${() => onMove(-1)} aria-label="Move up">Up</button>
      <button class="btn btn-sm" disabled=${index === count - 1} onClick=${() => onMove(1)} aria-label="Move down">Down</button>
      <button class="btn btn-sm btn-danger" onClick=${onRemove} aria-label="Remove step"><${Icons.Trash}/></button>
    </div>
    <div style=${{ marginTop: 8, display: 'grid', gap: 8 }}>
      ${step.kind === 'template' && html`<div style=${{ display: 'grid', gap: 8 }}>
        ${typeof step.template === 'object' && step.template
          ? html`<label style=${{ fontSize: 12 }}>Template per operating system (JSON)
              <input class="input" defaultValue=${JSON.stringify(step.template)} onChange=${e => { try { up({ template: JSON.parse(e.target.value) }); } catch { /* keep the old value */ } }}/></label>`
          : html`<select class="select" value=${step.template || ''} onChange=${e => up({ template: e.target.value, params: {} })} aria-label="Template">
              <option value="">Choose a template</option>
              ${templates.map(t => html`<option key=${t.id} value=${t.id}>${t.name}${t.guard ? ' (guarded)' : ''}</option>`)}</select>`}
        <${TemplateParams} tpl=${tpl} params=${step.params} onChange=${params => up({ params })}/>
      </div>`}
      ${step.kind === 'script' && step.template && html`<div class="page-desc">Template step: ${JSON.stringify(step.template)}</div>`}
      ${step.kind === 'script' && !step.template && html`<div style=${{ display: 'grid', gap: 8 }}>
        <div style=${{ display: 'flex', gap: 8 }}>
          <select class="select" style=${{ width: 150 }} value=${step.shell || ''} onChange=${e => up({ shell: e.target.value || undefined })} aria-label="Shell">
            <option value="">Shell by host OS</option>${SHELLS.map(s => html`<option key=${s} value=${s}>${s}</option>`)}</select>
          <input class="input" style=${{ width: 150 }} type="number" min="1" placeholder="Timeout (s)" value=${step.timeout_s || ''} onInput=${e => up({ timeout_s: e.target.value ? Number(e.target.value) : undefined })}/>
        </div>
        <textarea class="textarea" rows="5" style=${{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }} placeholder="Script" value=${step.script || ''} onInput=${e => up({ script: e.target.value })}></textarea>
      </div>`}
      ${step.kind === 'wait_agent' && html`<label style=${{ fontSize: 12 }}>Wait up to (minutes)
        <input class="input" type="number" min="1" style=${{ width: 120 }} value=${Math.round((step.timeout_s || 600) / 60)} onInput=${e => up({ timeout_s: Math.max(1, Number(e.target.value) || 10) * 60 })}/></label>`}
      ${step.kind === 'github_runner_online' && html`<div style=${{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input class="input" style=${{ flex: '1 1 200px' }} placeholder="Runner name (use {{NAME}} for a runbook parameter)" value=${step.runner || ''} onInput=${e => up({ runner: e.target.value })}/>
        <input class="input" style=${{ flex: '1 1 200px' }} placeholder="Repository or organisation" value=${step.scope || ''} onInput=${e => up({ scope: e.target.value })}/>
      </div>`}
      ${step.kind === 'sleep' && html`<label style=${{ fontSize: 12 }}>Seconds
        <input class="input" type="number" min="0" style=${{ width: 120 }} value=${step.seconds ?? 60} onInput=${e => up({ seconds: Number(e.target.value) || 0 })}/></label>`}
      ${step.kind === 'note' && html`<textarea class="textarea" rows="2" placeholder="Note" value=${step.text || ''} onInput=${e => up({ text: e.target.value })}></textarea>`}
      ${NEEDS_HOSTS.includes(step.kind) && html`<details>
        <summary style=${{ fontSize: 12, cursor: 'pointer', color: 'var(--text-secondary)' }}>Hosts for this step ${step.hosts ? '(own selection)' : '(the hosts chosen when the runbook runs)'}</summary>
        <div style=${{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          <select class="select" multiple size="4" style=${{ minWidth: 200 }} aria-label="Hosts" value=${sel.host_ids || []}
            onChange=${e => setSel({ host_ids: [...e.target.selectedOptions].map(o => o.value) })}>
            ${hosts.map(h => html`<option key=${h.id} value=${h.id} selected=${(sel.host_ids || []).includes(h.id)}>${h.hostname}</option>`)}</select>
          <input class="input" style=${{ width: 160 }} placeholder="Group" value=${sel.group || ''} onInput=${e => setSel({ group: e.target.value })}/>
          <input class="input" style=${{ width: 160 }} placeholder="Tag" value=${sel.tag || ''} onInput=${e => setSel({ tag: e.target.value })}/>
        </div>
      </details>`}
    </div>
  </div>`;
}
const NEEDS_HOSTS = ['template', 'script', 'wait_agent', 'github_runner_online'];

function Editor({ runbook, templates, hosts, onSaved, onCancel, addToast }) {
  const [rb, setRb] = useState(() => ({ name: '', description: '', steps: [blank('script')], params: [], ...runbook }));
  const patchStep = (i, s) => setRb({ ...rb, steps: rb.steps.map((x, j) => (j === i ? s : x)) });
  const move = (i, d) => { const s = [...rb.steps]; [s[i], s[i + d]] = [s[i + d], s[i]]; setRb({ ...rb, steps: s }); };
  const save = async () => {
    try {
      const body = { name: rb.name, description: rb.description, steps: rb.steps, params: rb.params };
      const saved = await api(rb.id ? `/api/runbooks/${rb.id}` : '/api/runbooks', { method: rb.id ? 'PUT' : 'POST', body });
      addToast('Runbook saved');
      onSaved(saved);
    } catch (err) { addToast(err.message, 'error'); }
  };
  return html`<div>
    <div class="page-header"><div><div class="page-title">${rb.id ? 'Edit runbook' : 'New runbook'}</div></div>
      <div class="btn-group"><button class="btn" onClick=${onCancel}>Cancel</button><button class="btn btn-primary" onClick=${save}>Save</button></div></div>
    <div class="card" style=${{ display: 'grid', gap: 8, marginBottom: 12 }}>
      <input class="input" placeholder="Name" value=${rb.name} onInput=${e => setRb({ ...rb, name: e.target.value })} aria-label="Runbook name"/>
      <textarea class="textarea" rows="2" placeholder="Description" value=${rb.description} onInput=${e => setRb({ ...rb, description: e.target.value })}></textarea>
      <div>
        <div class="form-label">Parameters (used as {{NAME}} in step values)</div>
        ${rb.params.map((p, i) => html`<div key=${i} style=${{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <input class="input" style=${{ width: 160 }} placeholder="NAME" value=${p.name} onInput=${e => setRb({ ...rb, params: rb.params.map((x, j) => (j === i ? { ...x, name: e.target.value.toUpperCase() } : x)) })}/>
          <input class="input" style=${{ flex: 1 }} placeholder="Label" value=${p.label || ''} onInput=${e => setRb({ ...rb, params: rb.params.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}/>
          <input class="input" style=${{ width: 160 }} placeholder="Default" value=${p.default ?? ''} onInput=${e => setRb({ ...rb, params: rb.params.map((x, j) => (j === i ? { ...x, default: e.target.value } : x)) })}/>
          <button class="btn btn-sm btn-danger" onClick=${() => setRb({ ...rb, params: rb.params.filter((x, j) => j !== i) })} aria-label="Remove parameter"><${Icons.Trash}/></button>
        </div>`)}
        <button class="btn btn-sm" onClick=${() => setRb({ ...rb, params: [...rb.params, { name: '', label: '', default: '' }] })}>Add parameter</button>
      </div>
    </div>
    ${rb.steps.map((s, i) => html`<${StepEditor} key=${i} step=${s} index=${i} count=${rb.steps.length} templates=${templates} hosts=${hosts}
      onChange=${n => patchStep(i, n)} onMove=${d => move(i, d)} onRemove=${() => setRb({ ...rb, steps: rb.steps.filter((x, j) => j !== i) })}/>`)}
    <div class="btn-group">${KINDS.map(([k, l]) => html`<button key=${k} class="btn btn-sm" onClick=${() => setRb({ ...rb, steps: [...rb.steps, blank(k)] })}>Add ${l.toLowerCase()}</button>`)}</div>
  </div>`;
}

function RunDialog({ runbook, hosts, onClose, onStarted, addToast }) {
  const [picked, setPicked] = useState([]);
  const [params, setParams] = useState(() => Object.fromEntries(runbook.params.map(p => [p.name, p.default ?? ''])));
  const [word, setWord] = useState(null);
  const go = async confirm => {
    try {
      const r = await api(`/api/runbooks/${runbook.id}/run`, { method: 'POST', body: { host_ids: picked, params, confirm } });
      onStarted(r.id);
    } catch (err) {
      if (/confirmation/i.test(err.message)) setWord(runbook.name); else addToast(err.message, 'error');
    }
  };
  if (word) return html`<${ConfirmModal} word=${word} onCancel=${onClose} onConfirm=${go}/>`;
  return html`<${Modal} title=${`Run: ${runbook.name}`} onClose=${onClose}>
    <div class="form-label">Hosts</div>
    <div style=${{ maxHeight: 200, overflow: 'auto', marginBottom: 10 }}>
      ${hosts.map(h => html`<label key=${h.id} style=${{ display: 'flex', gap: 6, fontSize: 13, padding: '2px 0' }}>
        <input type="checkbox" checked=${picked.includes(h.id)} onChange=${() => setPicked(picked.includes(h.id) ? picked.filter(x => x !== h.id) : [...picked, h.id])}/> ${h.hostname}</label>`)}
    </div>
    ${runbook.params.map(p => html`<label key=${p.name} style=${{ display: 'block', fontSize: 12, marginBottom: 8 }}>${p.label || p.name}
      <input class="input" value=${params[p.name] ?? ''} onInput=${e => setParams({ ...params, [p.name]: e.target.value })}/></label>`)}
    <button class="btn btn-primary" onClick=${() => go(undefined)}><${Icons.Play}/> Run</button>
  <//>`;
}

function RunView({ id, onBack, addToast, onOpenRun }) {
  const [run, setRun] = useState(null);
  const [ask, setAsk] = useState(null);
  const load = () => api(`/api/runbook-runs/${id}`).then(setRun).catch(e => addToast(e.message, 'error'));
  useEffect(() => {
    load();
    const i = setInterval(load, 2000);
    return () => clearInterval(i);
  }, [id]);
  if (!run) return html`<div class="page-desc">Loading...</div>`;
  const rerun = async (from, confirm) => {
    try { const r = await api(`/api/runbook-runs/${id}/rerun`, { method: 'POST', body: { from_step: from, confirm } }); onOpenRun(r.id); }
    catch (err) { if (/confirmation/i.test(err.message)) setAsk({ from, word: run.name }); else addToast(err.message, 'error'); }
  };
  return html`<div>
    <div class="page-header">
      <div><div class="page-title">${run.name}</div>
        <div class="page-desc">Started by ${run.actor || 'system'} · ${when(run.started_at || run.created_at)} · ${run.ended_at ? `ended ${when(run.ended_at)}` : 'in progress'}</div></div>
      <div class="btn-group"><${Badge} status=${run.status}/><button class="btn" onClick=${onBack}>Back</button></div>
    </div>
    ${run.parent_run_id && html`<div class="page-desc" style=${{ marginBottom: 8 }}>Re-run from step ${run.from_step + 1} of <a href="#/runbooks" onClick=${e => { e.preventDefault(); onOpenRun(run.parent_run_id); }}>an earlier run</a>.</div>`}
    ${run.results.map(r => html`<div key=${r.index} class="card" style=${{ marginBottom: 8, padding: 12 }}>
      <div style=${{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>${r.index + 1}. ${r.name}</b><span style=${{ fontSize: 11, color: 'var(--text-dim)' }}>${r.kind}${r.carried ? ' · kept from the earlier run' : ''}</span>
        <${Badge} status=${r.status}/>
        <div style=${{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          ${r.group_id && html`<button class="btn btn-sm" onClick=${() => openJobDrawer(r.group_id)}>Open step output</button>`}
          ${(r.status === 'failed') && !['running', 'queued'].includes(run.status) && html`<button class="btn btn-sm" onClick=${() => rerun(r.index)}><${Icons.RefreshCw}/> Re-run from here</button>`}
        </div>
      </div>
      ${r.error && html`<div style=${{ color: 'var(--red)', fontSize: 12, marginTop: 4 }}>${r.error}</div>`}
      ${r.note && html`<div style=${{ fontSize: 12, marginTop: 4 }}>${r.note}</div>`}
      ${r.hosts && r.hosts.length > 0 && html`<div style=${{ marginTop: 6 }}>${r.hosts.map(h => html`<div key=${h.host_id} style=${{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, padding: '2px 0' }}>
        <span style=${{ minWidth: 160 }}>${h.hostname}</span><${Badge} status=${h.status}/>
        ${h.error && html`<span style=${{ color: 'var(--text-dim)' }}>${h.error}</span>`}
        ${h.job_id && html`<button class="btn btn-sm" style=${{ marginLeft: 'auto' }} onClick=${() => openJobDrawer(h.job_id)}><${Icons.Terminal}/> Output</button>`}
      </div>`)}</div>`}
    </div>`)}
    ${ask && html`<${ConfirmModal} word=${ask.word} onCancel=${() => setAsk(null)} onConfirm=${c => { const f = ask.from; setAsk(null); rerun(f, c); }}/>`}
  </div>`;
}

export default function RunbooksPage({ hosts, addToast, currentUser }) {
  const [list, setList] = useState([]);
  const [runs, setRuns] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [view, setView] = useState({ mode: 'list' });
  const canAct = currentUser && ['operator', 'admin'].includes(currentUser.role);

  const load = () => {
    api('/api/runbooks').then(setList).catch(e => addToast(e.message, 'error'));
    api('/api/runbook-runs?limit=20').then(setRuns).catch(() => {});
  };
  useEffect(() => { load(); api('/api/templates').then(setTemplates).catch(() => {}); }, []);

  if (view.mode === 'edit') return html`<${Editor} runbook=${view.runbook} templates=${templates} hosts=${hosts} addToast=${addToast}
    onCancel=${() => setView({ mode: 'list' })} onSaved=${() => { load(); setView({ mode: 'list' }); }}/>`;
  if (view.mode === 'run') return html`<${RunView} key=${view.id} id=${view.id} addToast=${addToast} onBack=${() => { load(); setView({ mode: 'list' }); }}
    onOpenRun=${id => setView({ mode: 'run', id })}/>`;

  const remove = async rb => {
    if (!window.confirm(`Delete runbook ${rb.name}?`)) return;
    try { await api(`/api/runbooks/${rb.id}`, { method: 'DELETE' }); load(); } catch (err) { addToast(err.message, 'error'); }
  };

  return html`<div>
    <div class="page-header">
      <div><div class="page-title">Runbooks</div><div class="page-desc">Ordered steps that run across hosts, with output for each step.</div></div>
      ${canAct && html`<button class="btn btn-primary" onClick=${() => setView({ mode: 'edit', runbook: null })}>New runbook</button>`}
    </div>
    <div class="table-wrap">
      <table><thead><tr><th>Name</th><th>Steps</th><th>Description</th><th>Actions</th></tr></thead><tbody>
        ${list.map(rb => html`<tr key=${rb.id}>
          <td>${rb.name}</td><td>${rb.steps.length}</td>
          <td style=${{ fontSize: 12, color: 'var(--text-dim)', maxWidth: 420 }}>${rb.description}</td>
          <td><div class="btn-group">
            ${canAct && html`<button class="btn btn-sm btn-primary" onClick=${() => setView({ mode: 'runDialog', runbook: rb })}><${Icons.Play}/> Run</button>`}
            ${canAct && html`<button class="btn btn-sm" onClick=${() => setView({ mode: 'edit', runbook: rb })}>Edit</button>`}
            ${canAct && html`<button class="btn btn-sm btn-danger" onClick=${() => remove(rb)} aria-label="Delete runbook"><${Icons.Trash}/></button>`}
          </div></td>
        </tr>`)}
        ${!list.length && html`<tr><td colSpan=${4} style=${{ textAlign: 'center', padding: 30, color: 'var(--text-dim)' }}>No runbooks yet.</td></tr>`}
      </tbody></table>
    </div>
    <h3 style=${{ margin: '20px 0 8px' }}>Recent runs</h3>
    <div class="table-wrap">
      <table><thead><tr><th>Runbook</th><th>Status</th><th>Started by</th><th>Started</th><th></th></tr></thead><tbody>
        ${runs.map(r => html`<tr key=${r.id}>
          <td>${r.name}</td><td><${Badge} status=${r.status}/></td><td>${r.actor || 'system'}</td>
          <td style=${{ fontSize: 12 }}>${when(r.created_at)}</td>
          <td><button class="btn btn-sm" onClick=${() => setView({ mode: 'run', id: r.id })}>Open</button></td>
        </tr>`)}
        ${!runs.length && html`<tr><td colSpan=${5} style=${{ textAlign: 'center', padding: 20, color: 'var(--text-dim)' }}>No runs yet.</td></tr>`}
      </tbody></table>
    </div>
    ${view.mode === 'runDialog' && html`<${RunDialog} runbook=${view.runbook} hosts=${hosts} addToast=${addToast} onClose=${() => setView({ mode: 'list' })}
      onStarted=${id => setView({ mode: 'run', id })}/>`}
  </div>`;
}
