import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../api.js';
import { html } from '../ui.js';
import { Dialog } from './template-editor.js';

const REF_KIND = { runbook: 'Runbook', patch_policy: 'Patch policy', schedule: 'Schedule', builtin_schedule: 'Built-in schedule' };

// Kebab menu on a template card (admin). items: [[label, fn], ...]. Arrow keys move, Escape closes.
export function TemplateMenu({ tpl, items }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    wrap.current?.querySelector('[role="menuitem"]')?.focus();
    const away = e => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const keys = e => {
    const list = [...wrap.current.querySelectorAll('[role="menuitem"]')];
    const i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); wrap.current.querySelector('.tpl-kebab').focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
  };
  return html`<div class="tpl-menu-wrap" ref=${wrap} onKeyDown=${open ? keys : undefined}>
    <button type="button" class="btn btn-sm btn-icon tpl-kebab" aria-haspopup="menu" aria-expanded=${open ? 'true' : 'false'}
      aria-label=${`Actions for ${tpl.name}`} onClick=${() => setOpen(!open)}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
    </button>
    ${open && html`<div class="tpl-menu" role="menu" aria-label=${`Actions for ${tpl.name}`}>
      ${items.map(([label, fn, danger]) => html`<button key=${label} type="button" role="menuitem" class=${danger ? 'tpl-danger' : ''}
        onClick=${() => { setOpen(false); fn(); }}>${label}</button>`)}
    </div>`}
  </div>`;
}

// Delete (custom, typed name) or hide (built-in). Lists runbooks, policies and schedules that use the template.
export function DeleteDialog({ tpl, onClose, onDone, addToast }) {
  const custom = tpl.source === 'custom';
  const [refs, setRefs] = useState(null);
  const [typed, setTyped] = useState('');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api(`/api/templates/${encodeURIComponent(tpl.id)}`).then(d => setRefs(d.references || [])).catch(e => setError(e.message)); }, [tpl.id]);
  const ready = refs && !busy && (!custom || typed === tpl.name) && (!refs.length || force);
  const go = async () => {
    setBusy(true); setError('');
    try {
      await api(`/api/templates/${encodeURIComponent(tpl.id)}`, { method: 'DELETE', body: { confirm: custom ? typed : undefined, force_referenced: force || undefined } });
      addToast(custom ? `${tpl.name} deleted` : `${tpl.name} hidden. Restore it from Hidden templates.`);
      onDone(); onClose();
    } catch (e) { setError(e.message); setBusy(false); }
  };
  return html`<${Dialog} title=${custom ? `Delete ${tpl.name}` : `Hide ${tpl.name}`} onClose=${onClose}>
    <p class="page-desc">${custom ? 'The custom template is removed for good.' : 'The built-in template is hidden from every list and cannot run. Its files stay on disk and you can restore it later.'}</p>
    ${refs === null && !error && html`<div aria-busy="true" class="tpl-hint">Checking where it is used...</div>`}
    ${refs && refs.length > 0 && html`<div class="tpl-warn" role="status">
      <b>In use by ${refs.length} item${refs.length === 1 ? '' : 's'}. Their steps fail until you change them.</b>
      <ul class="tpl-refs">${refs.map(r => html`<li key=${r.kind + r.id}>${REF_KIND[r.kind] || r.kind}: ${r.name}</li>`)}</ul>
      <label class="checkbox-row"><input type="checkbox" class="checkbox" checked=${force} onChange=${e => setForce(e.target.checked)}/> ${custom ? 'Delete' : 'Hide'} it anyway</label>
    </div>`}
    ${custom && html`<div class="form-group"><label class="form-label" for="tpl-del-confirm">Type <b class="tpl-word">${tpl.name}</b> to confirm.</label>
      <input id="tpl-del-confirm" class="input" autocomplete="off" value=${typed} onInput=${e => setTyped(e.target.value)}/></div>`}
    ${error && html`<div role="alert" class="tpl-error">${error}</div>`}
    <div class="tpl-actions">
      <button type="button" class="btn btn-danger" disabled=${!ready} onClick=${go}>${busy ? 'Working...' : custom ? 'Delete' : 'Hide'}</button>
      <button type="button" class="btn" onClick=${onClose}>Cancel</button>
    </div>
  <//>`;
}
