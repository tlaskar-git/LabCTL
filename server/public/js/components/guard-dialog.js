import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { html, Modal } from '../ui.js';
import { openJobDrawer } from '../job-drawer.js';

// Run dialog for one template on one host. A guarded action shows what will happen and asks for the host name.
// The server enforces the same rule (guards.js): the request carries `confirm`.
export const defaults = params => Object.fromEntries((params || []).map(p => [p.name, p.default]));

export function ParamFields({ params, values, onChange }) {
  return (params || []).map(p => {
    const set = v => onChange({ ...values, [p.name]: v });
    if (p.type === 'bool') {
      return html`<label key=${p.name} class="checkbox-row" style=${{ display: 'flex', gap: 8, margin: '6px 0' }}>
        <input type="checkbox" checked=${!!values[p.name]} onChange=${e => set(e.target.checked)}/> ${p.label}</label>`;
    }
    const input = p.type === 'enum'
      ? html`<select class="select" value=${values[p.name]} onChange=${e => set(e.target.value)}>${p.options.map(o => html`<option key=${o} value=${o}>${o}</option>`)}</select>`
      : html`<input class="input" type=${p.type === 'int' ? 'number' : 'text'} value=${values[p.name]}
        onInput=${e => set(p.type === 'int' ? Number(e.target.value) : e.target.value)}/>`;
    return html`<div key=${p.name} class="form-group" style=${{ marginBottom: 10 }}><label class="form-label">${p.label}</label>${input}</div>`;
  });
}

export function GuardDialog({ action, host, onClose, onStarted, addToast }) {
  const [values, setValues] = useState(defaults(action.params));
  const [drain, setDrain] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const word = action.confirm_word || host.hostname || host.id;
  const needTyped = !!action.guard;

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api(`/api/templates/${encodeURIComponent(action.id)}/run`, { method: 'POST',
        body: { host_ids: [host.id], params: values, drain: drain || undefined, confirm: needTyped ? typed : undefined } });
      const job = r.jobs?.[0];
      addToast?.(job ? 'Job started' : 'Nothing started');
      if (onStarted) onStarted(job);
      if (job) openJobDrawer(job.job_id);
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return html`<${Modal} title=${needTyped ? `Confirm: ${action.name}` : action.name} onClose=${busy ? () => {} : onClose}>
    <div class="card" style=${{ marginBottom: 12 }}>
      <div><strong>${action.name}</strong> <span class="mono page-desc">${action.id}</span></div>
      <div style=${{ margin: '6px 0' }}>Host: <strong>${host.hostname || host.id}</strong></div>
      <div class=${needTyped ? '' : 'page-desc'} style=${needTyped ? { color: 'var(--red)' } : {}}>${action.description}</div>
      ${action.guard_reason === 'domain_controller' && html`<div style=${{ color: 'var(--red)', marginTop: 6 }}>This host is a domain controller.</div>`}
    </div>
    <${ParamFields} params=${action.params.filter(p => drain || p.name !== 'DRAIN_TIMEOUT_MIN')} values=${values} onChange=${setValues}/>
    ${action.drain && html`<label class="checkbox-row" style=${{ display: 'flex', gap: 8, margin: '6px 0' }}><input type="checkbox" checked=${drain} onChange=${e => setDrain(e.target.checked)}/> Drain first (wait for running CI jobs to finish)</label>`}
    ${needTyped && html`<div class="form-group" style=${{ margin: '12px 0' }}>
      <label class="form-label">Type <code>${word}</code> to confirm</label>
      <input class="input" autofocus value=${typed} onInput=${e => setTyped(e.target.value)} placeholder=${word}/>
    </div>`}
    ${error && html`<div style=${{ color: 'var(--red)', margin: '8px 0' }}>${error}</div>`}
    <div class="btn-group" style=${{ justifyContent: 'flex-end' }}>
      <button class="btn" disabled=${busy} onClick=${onClose}>Cancel</button>
      <button class=${`btn ${needTyped ? 'btn-danger' : 'btn-primary'}`} disabled=${busy || (needTyped && typed !== word)} onClick=${submit}>${busy ? 'Starting' : 'Run'}</button>
    </div>
  <//>`;
}
