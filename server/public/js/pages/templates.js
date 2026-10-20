import { useState, useEffect, useMemo } from 'preact/hooks';
import { api } from '../api.js';
import { html, Modal } from '../ui.js';
import { useAppState } from '../state.js';
import { Chip } from '../components/ui-kit.js';
import { TemplateEditor } from '../components/template-editor.js';
import { TemplateMenu, DeleteDialog } from '../components/template-actions.js';
import { rank } from '../components/palette-search.js';
import { ParamFields, compatible, defaultsOf, targetHosts, confirmWord, needsConfirm, launch } from '../components/palette-form.js';

const CATEGORY = { mac: 'Mac', runner: 'GitHub runner', vps: 'VPS and Linux', proxmox: 'Proxmox' };
const OS_LABEL = { linux: 'Linux', darwin: 'macOS', windows: 'Windows' };

// Run dialog: target picker, generated parameter form, drain and force options, typed confirmation.
function RunDialog({ tpl, hosts, onClose, addToast }) {
  const [values, setValues] = useState(defaultsOf(tpl));
  const [mode, setMode] = useState('hosts');
  const [ids, setIds] = useState([]);
  const [group, setGroup] = useState('');
  const [tag, setTag] = useState('');
  const [groups, setGroups] = useState([]);
  const [tags, setTags] = useState([]);
  const [creds, setCreds] = useState([]);
  const [secrets, setSecrets] = useState({});
  const [drain, setDrain] = useState(!!tpl.drain);
  const [force, setForce] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/groups').then(setGroups).catch(() => {});
    api('/api/tags').then(setTags).catch(() => {});
    if (tpl.secrets.length) api('/api/credentials').then(setCreds).catch(() => {});
  }, []);

  const target = mode === 'hosts' ? { type: 'hosts', ids } : mode === 'group' ? { type: 'group', value: group } : { type: 'tag', value: tag };
  const covered = targetHosts(hosts, target).filter(h => compatible(tpl, h));
  const guarded = needsConfirm(tpl, force);
  const word = confirmWord(tpl, covered);
  const missingSecret = tpl.secrets.some(s => s.required && !secrets[s.name]);
  const ready = covered.length > 0 && !busy && !missingSecret && (!guarded || confirm === word);
  const toggle = id => setIds(list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]));

  const run = async () => {
    setBusy(true); setError('');
    try {
      const res = await launch(tpl, target, values, { drain, force, confirm: guarded ? confirm : undefined, secrets });
      addToast(`${tpl.name}: ${res.jobs.length} job${res.jobs.length === 1 ? '' : 's'} started`);
      onClose();
    } catch (e) { setError(e.message); setBusy(false); }
  };

  return html`<${Modal} title=${tpl.name} onClose=${onClose}>
    <div class="page-desc" style=${{ marginBottom: 12 }}>${tpl.description}</div>
    <div class="form-group">
      <label class="form-label" for="tpl-mode">Target</label>
      <div class="btn-group" role="group" aria-label="Target type">
        ${['hosts', 'group', 'tag'].map(m => html`<button key=${m} class=${`btn btn-sm ${mode === m ? 'btn-primary' : ''}`} aria-pressed=${mode === m} onClick=${() => setMode(m)}>${m === 'hosts' ? 'Hosts' : m === 'group' ? 'Group' : 'Tag'}</button>`)}
      </div>
    </div>
    ${mode === 'hosts' && html`<div style=${{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 8, marginBottom: 12 }}>
      ${hosts.filter(h => compatible(tpl, h)).map(h => html`<label key=${h.id} class="checkbox-row">
        <input type="checkbox" class="checkbox" checked=${ids.includes(h.id)} onChange=${() => toggle(h.id)}/> ${h.hostname} <span style=${{ color: 'var(--text-dim)', fontSize: 11 }}>${h.os} ${h.online ? '' : 'offline'}</span>
      </label>`)}
      ${hosts.filter(h => compatible(tpl, h)).length === 0 && html`<div class="page-desc">No host runs ${tpl.os.map(o => OS_LABEL[o]).join(' or ')}.</div>`}
    </div>`}
    ${mode === 'group' && html`<select id="tpl-mode" class="select input" aria-label="Group" value=${group} onChange=${e => setGroup(e.target.value)} style=${{ marginBottom: 12 }}>
      <option value="">Choose a group</option>${groups.map(g => html`<option key=${g.id} value=${g.id}>${g.name}</option>`)}</select>`}
    ${mode === 'tag' && html`<select id="tpl-mode" class="select input" aria-label="Tag" value=${tag} onChange=${e => setTag(e.target.value)} style=${{ marginBottom: 12 }}>
      <option value="">Choose a tag</option>${tags.map(g => html`<option key=${g.id} value=${g.id}>${g.name}</option>`)}</select>`}
    <div class="page-desc" style=${{ marginBottom: 12 }}>${covered.length} compatible host${covered.length === 1 ? '' : 's'} selected</div>
    ${tpl.params.length > 0 && html`<${ParamFields} tpl=${tpl} values=${values} onChange=${setValues}/>`}
    ${tpl.secrets.map(sec => html`<div key=${sec.name} class="form-group" style=${{ marginTop: 10 }}>
      <label class="form-label" for=${`sec-${sec.name}`}>${sec.label}${sec.required ? ' (required)' : ''}</label>
      <select id=${`sec-${sec.name}`} class="select input" value=${secrets[sec.name] || ''} onChange=${e => setSecrets(s => ({ ...s, [sec.name]: e.target.value }))}>
        <option value="">Choose a stored credential</option>${creds.map(c => html`<option key=${c.id} value=${c.id}>${c.name || c.username || c.id}</option>`)}
      </select>
    </div>`)}
    ${tpl.drain && html`<div style=${{ marginTop: 10 }}>
      <label class="checkbox-row"><input type="checkbox" class="checkbox" checked=${drain} onChange=${e => setDrain(e.target.checked)}/> Wait for running builds to finish first (drain)</label>
      <label class="checkbox-row"><input type="checkbox" class="checkbox" checked=${force} onChange=${e => setForce(e.target.checked)}/> Force: continue even if a build is running</label>
    </div>`}
    ${guarded && html`<div class="form-group" style=${{ marginTop: 12 }}>
      <label class="form-label" for="tpl-confirm">${force ? 'Force needs a typed confirmation.' : 'This template is guarded.'} Type <b>${word}</b> to confirm.</label>
      <input id="tpl-confirm" class="input" autocomplete="off" value=${confirm} onInput=${e => setConfirm(e.target.value)}/>
    </div>`}
    ${error && html`<div role="alert" style=${{ color: 'var(--red)', marginTop: 10, fontSize: 13 }}>${error}</div>`}
    <div class="btn-group" style=${{ marginTop: 14 }}>
      <button class="btn btn-primary" disabled=${!ready} onClick=${run}>${busy ? 'Starting...' : 'Run'}</button>
      <button class="btn" onClick=${onClose}>Cancel</button>
    </div>
  <//>`;
}

const SOURCE = { builtin: ['Built-in', 'muted'], edited: ['Edited', 'warn'], custom: ['Custom', 'info'] };
const catLabel = c => CATEGORY[c] || (c ? c[0].toUpperCase() + c.slice(1) : 'Other');
// The command palette keeps its own copy of the list: tell it to fetch again.
const changed = () => window.dispatchEvent(new Event('labctl:templates-changed'));

// ── Templates page: the library of job action templates ────────────────
export default function TemplatesPage({ hosts = [], addToast }) {
  const { user } = useAppState();
  const isAdmin = user?.role === 'admin';
  const [all, setAll] = useState([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [os, setOs] = useState('');
  const [open, setOpen] = useState(null);
  const [editing, setEditing] = useState(undefined); // undefined: closed, null: new, id: edit
  const [removing, setRemoving] = useState(null);

  const load = () => api('/api/templates?hidden=1').then(setAll).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);
  const refresh = () => { load(); changed(); };

  const templates = all.filter(t => !t.hidden);
  const hidden = all.filter(t => t.hidden);
  const shown = useMemo(() => rank(templates.filter(t => !os || t.os.includes(os)), query, t => `${t.name} ${t.id} ${t.description} ${t.category} ${t.os.join(' ')} ${t.kinds.join(' ')}`, 200), [all, query, os]);
  const cats = [...Object.keys(CATEGORY), ...[...new Set(templates.map(t => t.category))].filter(c => !CATEGORY[c]).sort()];
  const groups = cats.map(c => ({ key: c, items: shown.filter(t => t.category === c) })).filter(g => g.items.length);

  const act = async (fn, msg) => { try { await fn(); addToast(msg); refresh(); } catch (e) { addToast(e.message, 'error'); } };
  const clone = t => act(() => api(`/api/templates/${encodeURIComponent(t.id)}/clone`, { method: 'POST' }), `${t.name} cloned`);
  const restore = t => act(() => api(`/api/templates/${encodeURIComponent(t.id)}/restore`, { method: 'POST' }), `${t.name} restored`);
  const menu = t => [['Run', () => setOpen(t)], ['Edit', () => setEditing(t.id)], ['Clone', () => clone(t)],
    ...(t.source === 'edited' ? [['Restore default', () => restore(t)]] : []),
    [t.source === 'custom' ? 'Delete' : 'Hide', () => setRemoving(t), true]];

  return html`<div>
    <div class="page-header">
      <div>
        <div class="page-title">Template library</div>
        <div class="page-desc">${templates.length} job action templates. Pick one, choose hosts, group or tag, and run it. Ctrl+K does the same from anywhere.</div>
      </div>
      ${isAdmin && html`<button type="button" class="btn btn-primary" onClick=${() => setEditing(null)}>New template</button>`}
    </div>
    <div class="form-row tpl-filters">
      <input class="input" type="search" aria-label="Search templates" placeholder="Search by name, id, kind or OS" value=${query} onInput=${e => setQuery(e.target.value)}/>
      <select class="select input" aria-label="Filter by OS" value=${os} onChange=${e => setOs(e.target.value)} style=${{ maxWidth: 180 }}>
        <option value="">All systems</option>${Object.entries(OS_LABEL).map(([k, v]) => html`<option key=${k} value=${k}>${v}</option>`)}
      </select>
    </div>
    ${error && html`<div class="card" role="alert">${error}</div>`}
    ${groups.map(g => html`<section key=${g.key} style=${{ marginBottom: 20 }} aria-label=${catLabel(g.key)}>
      <div class="nav-section" style=${{ padding: '0 0 8px' }}>${catLabel(g.key)} (${g.items.length})</div>
      <div class="actions-grid">
        ${g.items.map(t => html`<div key=${t.id} class="tpl-card">
          <button class="action-tile" onClick=${() => setOpen(t)} aria-label=${`Run ${t.name}`}>
            <div class="action-tile-label">${t.name}</div>
            <div class="action-tile-desc">${t.description}</div>
            <div style=${{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, justifyContent: 'center' }}>
              ${SOURCE[t.source] && html`<${Chip} tone=${SOURCE[t.source][1]}>${SOURCE[t.source][0]}<//>`}
              ${t.os.map(o => html`<span key=${o} class="badge badge-pending">${OS_LABEL[o]}</span>`)}
              ${t.guard && html`<span class="badge badge-failed">guarded</span>`}
              ${t.drain && html`<span class="badge badge-running">drain</span>`}
            </div>
          </button>
          ${isAdmin && html`<${TemplateMenu} tpl=${t} items=${menu(t)}/>`}
        </div>`)}
      </div>
    </section>`)}
    ${templates.length > 0 && shown.length === 0 && html`<div class="card empty-state"><div class="empty-state-title">No template matches</div></div>`}
    ${isAdmin && hidden.length > 0 && html`<section class="tpl-hidden" aria-labelledby="tpl-hidden-h">
      <h2 id="tpl-hidden-h" class="nav-section" style=${{ padding: '0 0 8px' }}>Hidden templates (${hidden.length})</h2>
      ${hidden.map(t => html`<div key=${t.id} class="tpl-hidden-row">
        <span><b>${t.name}</b> <span class="tpl-hint">${t.id}</span></span>
        <button type="button" class="btn btn-sm" aria-label=${`Restore ${t.name}`} onClick=${() => restore(t)}>Restore</button>
      </div>`)}
    </section>`}
    ${open && html`<${RunDialog} tpl=${open} hosts=${hosts} addToast=${addToast} onClose=${() => setOpen(null)}/>`}
    ${editing !== undefined && html`<${TemplateEditor} id=${editing} categories=${cats} addToast=${addToast} onSaved=${refresh}
      onClose=${() => setEditing(undefined)}
      onTestRun=${async id => { const list = await api('/api/templates'); const t = list.find(x => x.id === id); setEditing(undefined); if (t) setOpen(t); }}/>`}
    ${removing && html`<${DeleteDialog} tpl=${removing} addToast=${addToast} onDone=${refresh} onClose=${() => setRemoving(null)}/>`}
  </div>`;
}

