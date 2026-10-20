import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons } from '../ui.js';
import { KitIcons } from './ui-kit.js';

// Template editor (admin): create a custom template, or edit a built-in or custom one. Built-in edits are stored as
// an override in the database; the files on disk never change. Params reach the script only as LABCTL_P_<NAME>.
export const OS_LABEL = { linux: 'Linux', darwin: 'macOS', windows: 'Windows' };
export const KIND_LABEL = { agent: 'Agent', ssh: 'SSH', vps: 'VPS', proxmox: 'Proxmox', runner: 'Runner' };
const TYPES = [['string', 'Text'], ['int', 'Number'], ['bool', 'Yes or no'], ['enum', 'Select']];
const SHELLS = [['bash', 'Bash'], ['powershell', 'PowerShell'], ['python', 'Python']];
const MAX = 200 * 1024;
const NAME_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const FOCUSABLE = 'input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])';

// Dialog shell: role dialog, Escape closes, focus moves in on open and back on close, Tab stays inside.
export function Dialog({ title, onClose, wide = false, children }) {
  const box = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    box.current?.querySelector(FOCUSABLE)?.focus();
    return () => opener && opener.focus && opener.focus();
  }, []);
  const keys = e => {
    if (e.key === 'Escape' && !e.defaultPrevented) { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const items = [...box.current.querySelectorAll(FOCUSABLE)].filter(x => !x.disabled && x.offsetParent !== null);
    if (!items.length) return;
    const [first, last] = [items[0], items[items.length - 1]];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const titleId = useRef(`dlg-${Math.random().toString(36).slice(2)}`).current;
  return html`<div class="modal-overlay" onClick=${onClose}>
    <div ref=${box} class=${`modal${wide ? ' tpl-editor' : ''}`} role="dialog" aria-modal="true" aria-labelledby=${titleId}
      onClick=${e => e.stopPropagation()} onKeyDown=${keys}>
      <div class="tpl-dialog-head">
        <h2 class="modal-title" id=${titleId}>${title}</h2>
        <button type="button" class="btn-close" aria-label="Close" onClick=${onClose}><${Icons.X}/></button>
      </div>
      ${children}
    </div>
  </div>`;
}

const blank = () => ({ name: '', description: '', category: 'custom', os: ['linux'], kinds: ['agent'], shell: 'bash', script: '',
  params: [], guard: false, drain: false, source: 'custom' });
const toggle = (list, v) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v]);

function ParamRow({ p, i, onChange, onRemove }) {
  const set = patch => onChange(i, { ...p, ...patch });
  const id = k => `tp-${i}-${k}`;
  const nameBad = p.name && !NAME_RE.test(p.name);
  return html`<fieldset class="tpl-param">
    <legend class="sr-only">Parameter ${i + 1}</legend>
    <div class="form-group"><label class="form-label" for=${id('n')}>Name</label>
      <input id=${id('n')} class="input mono" value=${p.name} aria-invalid=${nameBad ? 'true' : 'false'} placeholder="PATH"
        onInput=${e => set({ name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })}/></div>
    <div class="form-group"><label class="form-label" for=${id('l')}>Label</label>
      <input id=${id('l')} class="input" value=${p.label} onInput=${e => set({ label: e.target.value })}/></div>
    <div class="form-group"><label class="form-label" for=${id('t')}>Type</label>
      <select id=${id('t')} class="select input" value=${p.type}
        onChange=${e => { const type = e.target.value; set({ type, default: type === 'bool' ? false : type === 'int' ? 0 : type === 'enum' ? (p.options || [])[0] || '' : '' }); }}>
        ${TYPES.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}
      </select></div>
    ${p.type === 'enum' && html`<div class="form-group"><label class="form-label" for=${id('o')}>Options (comma separated)</label>
      <input id=${id('o')} class="input" value=${(p.options || []).join(', ')}
        onInput=${e => { const options = e.target.value.split(',').map(s => s.trim()).filter(Boolean); set({ options, default: options.includes(p.default) ? p.default : options[0] || '' }); }}/></div>`}
    <div class="form-group"><label class="form-label" for=${id('d')}>Default</label>
      ${p.type === 'bool'
        ? html`<label class="checkbox-row"><input id=${id('d')} type="checkbox" class="checkbox" checked=${!!p.default} onChange=${e => set({ default: e.target.checked })}/> ${p.default ? 'Yes' : 'No'}</label>`
        : p.type === 'enum'
          ? html`<select id=${id('d')} class="select input" value=${p.default} onChange=${e => set({ default: e.target.value })}>${(p.options || []).map(o => html`<option key=${o} value=${o}>${o}</option>`)}</select>`
          : html`<input id=${id('d')} class="input" type=${p.type === 'int' ? 'number' : 'text'} min="0" value=${p.default}
              onInput=${e => set({ default: p.type === 'int' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value })}/>`}</div>
    <div class="tpl-param-end">
      <label class="checkbox-row"><input type="checkbox" class="checkbox" checked=${!!p.required} onChange=${e => set({ required: e.target.checked })}/> Required</label>
      <button type="button" class="btn btn-sm" aria-label=${`Remove parameter ${p.name || i + 1}`} onClick=${() => onRemove(i)}>Remove</button>
    </div>
  </fieldset>`;
}

// id: template id to edit, or null for a new one. onTestRun(id) opens the run dialog on the saved template.
export function TemplateEditor({ id, categories, onClose, onSaved, onTestRun, addToast }) {
  const [form, setForm] = useState(id ? null : blank());
  const [savedId, setSavedId] = useState(id);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState([]);
  const release = useRef(false);

  useEffect(() => {
    if (id) api(`/api/templates/${encodeURIComponent(id)}`).then(d => setForm({ ...d, params: (d.params || []).filter(p => p.name !== 'DRAIN_TIMEOUT_MIN') })).catch(e => setError(e.message));
  }, [id]);
  if (!form) return html`<${Dialog} title="Edit template" onClose=${onClose} wide>${error ? html`<div role="alert" class="tpl-error">${error}</div>` : html`<div aria-busy="true">Loading...</div>`}<//>`;

  const builtin = form.source === 'builtin' || form.source === 'edited';
  const set = patch => { setForm(f => ({ ...f, ...patch })); setDirty(true); };
  const setParam = (i, p) => set({ params: form.params.map((x, n) => (n === i ? p : x)) });
  const bytes = new TextEncoder().encode(form.script || '').length;
  const vars = [...form.params.filter(p => p.name).map(p => `LABCTL_P_${p.name}`),
    ...(form.drain ? ['LABCTL_P_DRAIN', 'LABCTL_P_FORCE', 'LABCTL_P_DRAIN_TIMEOUT_MIN'] : []), ...(form.secrets || []).map(s => `LABCTL_SECRET_${s.name}`)];
  const cats = [...new Set([...categories, form.category].filter(Boolean))];

  // Tab indents. Escape then Tab leaves the editor, so keyboard users are never trapped.
  const scriptKeys = e => {
    if (e.key === 'Escape') { release.current = true; e.preventDefault(); return; }
    if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (release.current) { release.current = false; return; }
    e.preventDefault();
    const t = e.target, s = t.selectionStart, end = t.selectionEnd;
    const next = `${t.value.slice(0, s)}  ${t.value.slice(end)}`;
    set({ script: next });
    requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = s + 2; });
  };

  const save = async () => {
    setBusy(true); setError(''); setWarnings([]);
    const body = { name: form.name, description: form.description || '', category: form.category, os: form.os, kinds: form.kinds, shell: form.shell,
      script: form.script, params: form.params, guard: !!form.guard, drain: !!form.drain };
    try {
      const r = savedId
        ? await api(`/api/templates/${encodeURIComponent(savedId)}`, { method: 'PUT', body })
        : await api('/api/templates', { method: 'POST', body });
      setSavedId(r.template.id); setDirty(false);
      setForm(f => ({ ...f, source: r.template.source }));
      onSaved(r.template);
      if (r.warnings && r.warnings.length) { setWarnings(r.warnings); addToast('Saved with syntax warnings', 'error'); }
      else { addToast(`${r.template.name} saved`); onClose(); }
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const restore = async () => {
    setBusy(true); setError('');
    try { const r = await api(`/api/templates/${encodeURIComponent(savedId)}/restore`, { method: 'POST' }); onSaved(r.template); addToast(`${r.template.name} restored to the default`); onClose(); }
    catch (e) { setError(e.message); setBusy(false); }
  };

  return html`<${Dialog} title=${savedId ? `Edit ${form.name || 'template'}` : 'New template'} onClose=${onClose} wide>
    <div class="tpl-form">
      <div class="tpl-grid">
        <div class="form-group"><label class="form-label" for="te-name">Name</label>
          <input id="te-name" class="input" maxLength="120" value=${form.name} onInput=${e => set({ name: e.target.value })}/></div>
        <div class="form-group"><label class="form-label" for="te-cat">Category</label>
          <input id="te-cat" class="input" list="te-cats" maxLength="40" value=${form.category} onInput=${e => set({ category: e.target.value })}/>
          <datalist id="te-cats">${cats.map(c => html`<option key=${c} value=${c}/>`)}</datalist></div>
      </div>
      <div class="form-group"><label class="form-label" for="te-desc">Description</label>
        <textarea id="te-desc" class="input textarea" rows="2" maxLength="1000" value=${form.description} onInput=${e => set({ description: e.target.value })}/></div>
      <div class="tpl-grid">
        <fieldset class="tpl-set"><legend class="form-label">Systems</legend>
          ${Object.entries(OS_LABEL).map(([k, v]) => html`<label key=${k} class="checkbox-row"><input type="checkbox" class="checkbox" checked=${form.os.includes(k)} onChange=${() => set({ os: toggle(form.os, k) })}/> ${v}</label>`)}
        </fieldset>
        <fieldset class="tpl-set"><legend class="form-label">Host kinds</legend>
          ${Object.entries(KIND_LABEL).map(([k, v]) => html`<label key=${k} class="checkbox-row"><input type="checkbox" class="checkbox" checked=${form.kinds.includes(k)} onChange=${() => set({ kinds: toggle(form.kinds, k) })}/> ${v}</label>`)}
        </fieldset>
        <div>
          <div class="form-group"><label class="form-label" for="te-shell">Shell</label>
            <select id="te-shell" class="select input" value=${form.shell} disabled=${builtin} aria-describedby=${builtin ? 'te-shell-note' : undefined} onChange=${e => set({ shell: e.target.value })}>
              ${SHELLS.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}
            </select>
            ${builtin && html`<div id="te-shell-note" class="tpl-hint">A built-in template keeps its shell.</div>`}</div>
          <label class="checkbox-row"><input type="checkbox" class="checkbox" checked=${!!form.drain} onChange=${e => set({ drain: e.target.checked })}/> Drain option (wait for running builds)</label>
          <label class="checkbox-row"><input type="checkbox" class="checkbox" checked=${!!form.guard} disabled=${form.locked_guard}
            aria-describedby=${form.locked_guard ? 'te-guard-note' : undefined} onChange=${e => set({ guard: e.target.checked })}/> Guarded (typed confirmation to run)</label>
          ${form.locked_guard && html`<div id="te-guard-note" class="tpl-hint">This built-in template is guarded. The typed confirmation cannot be removed.</div>`}
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="te-script">Script</label>
        <textarea id="te-script" class="input textarea tpl-script" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off"
          aria-describedby="te-script-hint" value=${form.script} onInput=${e => set({ script: e.target.value })} onKeyDown=${scriptKeys}/>
        <div id="te-script-hint" class="tpl-hint tpl-script-foot">
          <span>Tab indents. Press Esc, then Tab, to leave the editor.${form.shell !== 'python' ? ' The LabCTL prelude runs before this script.' : ''}</span>
          <span class=${bytes > MAX ? 'tpl-over' : ''}>${bytes.toLocaleString('en-GB')} / ${MAX.toLocaleString('en-GB')} bytes</span>
        </div>
      </div>

      <div class="form-group">
        <div class="tpl-section-head"><span class="form-label">Parameters</span>
          <button type="button" class="btn btn-sm" onClick=${() => set({ params: [...form.params, { name: '', label: '', type: 'string', default: '' }] })}><${KitIcons.Plus}/> Add parameter</button></div>
        <div class="tpl-hint">Values reach the script only as environment variables named LABCTL_P_ and the parameter name. Read them with quoted expansion. Never put a value into eval or a command string.</div>
        ${form.params.map((p, i) => html`<${ParamRow} key=${i} p=${p} i=${i} onChange=${setParam} onRemove=${n => set({ params: form.params.filter((_, k) => k !== n) })}/>`)}
        ${!form.params.length && html`<div class="tpl-hint">No parameters.</div>`}
      </div>

      <div class="form-group">
        <span class="form-label">Variables the script can read</span>
        <div class="chip-row" aria-label="Available variables">${vars.length ? vars.map(v => html`<code key=${v} class="tpl-var">${v}</code>`) : html`<span class="tpl-hint">None yet. Add a parameter.</span>`}</div>
      </div>

      ${warnings.length > 0 && html`<div class="tpl-warn" role="status"><b>Syntax check (bash -n). The template is saved.</b>${warnings.map(w => html`<div key=${w} class="mono">${w}</div>`)}</div>`}
      ${error && html`<div role="alert" class="tpl-error">${error}</div>`}
      <div class="tpl-actions">
        <button type="button" class="btn btn-primary" disabled=${busy || !form.name.trim() || !form.script.trim() || bytes > MAX} onClick=${save}>${busy ? 'Saving...' : 'Save'}</button>
        <button type="button" class="btn" onClick=${onClose}>Cancel</button>
        <button type="button" class="btn" disabled=${!savedId || dirty || busy} title=${dirty ? 'Save first' : ''} onClick=${() => onTestRun(savedId)}>Test run</button>
        ${form.source === 'edited' && html`<button type="button" class="btn tpl-push" disabled=${busy} onClick=${restore}>Restore default</button>`}
      </div>
    </div>
  <//>`;
}
