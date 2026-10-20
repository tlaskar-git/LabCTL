import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { api } from './api.js';
import { html } from './ui.js';
import { useAppState } from './state.js';
import { navigate } from './router.js';
import { pages } from './pages/index.js';
import { rank } from './components/palette-search.js';
import { ParamFields, compatible, defaultsOf, targetHosts, confirmWord, needsConfirm, launch } from './components/palette-form.js';

// Command palette. Ctrl+K (Cmd+K on macOS) opens it. Type to search actions (templates), hosts, groups and pages.
// An action asks for a target (host or group), then its parameters, then runs and opens the job drawer.
// A host or group asks for the action. Keyboard only: arrows move, Enter picks, Backspace on an empty box goes back,
// Escape closes, Tab stays inside the dialog.
const INIT = { step: 'search', query: '', idx: 0, action: null, target: null, label: '', values: {}, drain: false, confirm: '', busy: false, error: '' };
const MAX_INLINE = 6;
const cache = { templates: null };
window.addEventListener('labctl:templates-changed', () => { cache.templates = null; }); // the Templates page edited the list
const FOCUSABLE = 'input, select, button, textarea';

export function Palette() {
  const { user, hosts } = useAppState();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({ templates: [], groups: [] });
  const [s, setS] = useState(INIT);
  const box = useRef(null);
  const opener = useRef(null);
  const canRun = !!user && ['admin', 'operator'].includes(user.role);
  const patch = p => setS(x => ({ ...x, ...p }));
  const close = () => setOpen(false);

  useEffect(() => {
    const onKey = e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (!open) opener.current = document.activeElement;
        setOpen(!open);
      } else if (e.key === 'Escape' && open) { e.preventDefault(); close(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) { if (opener.current && opener.current.focus) opener.current.focus(); return; }
    setS(INIT);
    let live = true;
    (async () => {
      if (!cache.templates) cache.templates = await api('/api/templates').catch(() => []);
      const groups = await api('/api/groups').catch(() => []);
      if (live) setData({ templates: Array.isArray(cache.templates) ? cache.templates : [], groups: Array.isArray(groups) ? groups : [] });
    })();
    return () => { live = false; };
  }, [open]);

  // Put the focus on the first field of each step.
  useEffect(() => {
    if (!open || !box.current) return;
    const first = box.current.querySelector(FOCUSABLE);
    if (first) first.focus();
  }, [open, s.step]);

  const role = user ? user.role : 'viewer';
  const items = useMemo(() => {
    const act = t => ({ kind: 'action', id: `a-${t.id}`, label: t.name, hint: `${t.id} ${t.category} ${t.os.join(' ')}`, tpl: t });
    const text = i => `${i.label} ${i.hint || ''}`;
    const hostItem = h => ({ kind: 'host', id: `h-${h.id}`, label: h.hostname, hint: `${h.os || ''} ${h.online ? 'online' : 'offline'}`, host: h });
    const groupItem = g => ({ kind: 'group', id: `g-${g.id}`, label: g.name, hint: 'group', group: g });
    if (s.step === 'search') {
      const all = [
        ...pages.filter(p => (p.nav !== false || p.modal) && p.route !== false && p.roles.includes(role)).map(p => ({ kind: 'page', id: `p-${p.id}`, label: p.title, hint: p.group || 'Page', page: p })),
        ...(canRun ? data.templates.map(act) : []),
        ...hosts.map(hostItem), ...data.groups.map(groupItem)];
      return rank(all, s.query, text);
    }
    if (s.step === 'target') return rank([...hosts.filter(h => compatible(s.action, h)).map(hostItem), ...data.groups.map(groupItem)], s.query, text);
    if (s.step === 'action') {
      const h = s.target && s.target.type === 'hosts' ? hosts.find(x => x.id === s.target.ids[0]) : null;
      const list = canRun ? data.templates.filter(t => !h || compatible(t, h)).map(act) : [];
      return rank([...(h ? [{ kind: 'open', id: 'open', label: 'Open host page', hint: h.hostname }] : []), ...list], s.query, text);
    }
    return [];
  }, [s.step, s.query, s.action, s.target, data, hosts, role, canRun]);

  const idx = Math.min(s.idx, Math.max(0, items.length - 1));

  const toParams = (action, target) => patch({ step: 'params', action, target, query: '', idx: 0, values: defaultsOf(action), drain: !!action.drain, confirm: '', error: '' });
  const choose = item => {
    if (!item) return;
    if (item.kind === 'page') { navigate(`/${item.page.id}`); return close(); }
    if (item.kind === 'open') { navigate(`/host/${encodeURIComponent(s.target.ids[0])}`); return close(); }
    if (s.step === 'search' && item.kind === 'action') return patch({ step: 'target', action: item.tpl, query: '', idx: 0 });
    if (s.step === 'action' && item.kind === 'action') return toParams(item.tpl, s.target);
    const target = item.kind === 'host' ? { type: 'hosts', ids: [item.host.id] } : { type: 'group', value: item.group.id };
    if (s.step === 'search') return patch({ step: 'action', target, query: '', idx: 0, label: item.label });
    if (s.step === 'target') return toParams(s.action, target);
  };

  const covered = s.step === 'params' ? targetHosts(hosts, s.target).filter(h => compatible(s.action, h)) : [];
  const word = s.step === 'params' ? confirmWord(s.action, covered) : '';
  const guarded = s.step === 'params' && needsConfirm(s.action, false);
  const canGo = s.step === 'params' && covered.length > 0 && !s.busy && (!guarded || s.confirm === word);
  const run = async () => {
    if (!canGo) return;
    patch({ busy: true, error: '' });
    try { await launch(s.action, s.target, s.values, { drain: s.drain, confirm: guarded ? s.confirm : undefined }); close(); } catch (e) { patch({ busy: false, error: e.message }); }
  };
  const back = () => {
    if (s.step === 'params') patch({ step: s.label ? 'action' : 'target', query: '', idx: 0 });
    else if (s.step === 'target') patch({ step: 'search', action: null, query: '', idx: 0 });
    else if (s.step === 'action') patch({ step: 'search', target: null, label: '', query: '', idx: 0 });
  };

  const onKeyDown = e => {
    if (e.key === 'Tab' && box.current) { // focus trap
      const els = [...box.current.querySelectorAll(FOCUSABLE)].filter(el => !el.disabled);
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      return;
    }
    if (s.step !== 'params') {
      if (e.key === 'ArrowDown') { e.preventDefault(); patch({ idx: Math.min(items.length - 1, idx + 1) }); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); patch({ idx: Math.max(0, idx - 1) }); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(items[idx]); }
      else if (e.key === 'Backspace' && !s.query) { e.preventDefault(); back(); }
    } else if (e.key === 'Enter' && !/^(BUTTON|SELECT|TEXTAREA)$/.test(e.target.tagName)) { e.preventDefault(); run(); }
  };

  if (!open) return null;
  const crumbs = [s.action && s.action.name, s.step === 'action' && s.label].filter(Boolean);
  const names = covered.slice(0, 3).map(h => h.hostname).join(', ');
  return html`<div class="modal-overlay" style=${{ alignItems: 'flex-start', paddingTop: '12vh' }} onClick=${close}>
    <div class="modal" ref=${box} role="dialog" aria-modal="true" aria-label="Command palette" style=${{ maxWidth: 640 }} onClick=${e => e.stopPropagation()} onKeyDown=${onKeyDown}>
      ${s.step !== 'params' ? html`
        <div style=${{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8, fontSize: 12, color: 'var(--text-dim)' }}>
          ${crumbs.map(c => html`<span key=${c} class="badge badge-running">${c}</span>`)}
          <span>${s.step === 'search' ? 'Search actions, hosts, groups and pages' : s.step === 'target' ? 'Choose a host or group' : 'Choose an action'}</span>
        </div>
        <input class="input" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" aria-label="Search"
          aria-activedescendant=${items.length ? `pal-opt-${idx}` : undefined} placeholder="Type to search" value=${s.query}
          onInput=${e => patch({ query: e.target.value, idx: 0 })}/>
        <ul id="palette-list" role="listbox" aria-label="Results" style=${{ listStyle: 'none', margin: '8px 0 0', padding: 0, maxHeight: '45vh', overflowY: 'auto' }}>
          ${items.map((it, i) => html`<li key=${it.id} id=${`pal-opt-${i}`} role="option" aria-selected=${i === idx}
            style=${{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 10px', borderRadius: 6, cursor: 'pointer', background: i === idx ? 'var(--bg-card-hover)' : 'transparent', borderLeft: i === idx ? '2px solid var(--accent)' : '2px solid transparent' }}
            onMouseMove=${() => i !== idx && patch({ idx: i })} onClick=${() => choose(it)}>
            <span>${it.label}</span>
            <span style=${{ fontSize: 11, color: 'var(--text-dim)' }}>${it.kind}${it.kind === 'host' || it.kind === 'page' ? ` · ${it.hint.split(' ').slice(0, 2).join(' ')}` : ''}</span>
          </li>`)}
          ${items.length === 0 && html`<li role="option" aria-selected="false" aria-disabled="true" style=${{ padding: 10, color: 'var(--text-dim)' }}>No match</li>`}
        </ul>` : html`
        <div class="modal-title" style=${{ marginBottom: 4 }}>${s.action.name}</div>
        <div class="page-desc" style=${{ marginBottom: 10 }}>${covered.length ? `${covered.length} host${covered.length === 1 ? '' : 's'}: ${names}${covered.length > 3 ? ' and more' : ''}` : 'No compatible host in this target'}</div>
        <${ParamFields} compact tpl=${{ ...s.action, params: s.action.params.slice(0, MAX_INLINE) }} values=${s.values} onChange=${v => patch({ values: v })}/>
        ${s.action.params.length > MAX_INLINE && html`<div class="page-desc" style=${{ marginTop: 6 }}>${s.action.params.length - MAX_INLINE} more options are on the Templates page.</div>`}
        ${s.action.drain && html`<label class="checkbox-row" style=${{ marginTop: 8 }}><input type="checkbox" class="checkbox" checked=${s.drain} onChange=${e => patch({ drain: e.target.checked })}/> Wait for running builds first (drain)</label>`}
        ${guarded && html`<div class="form-group" style=${{ marginTop: 10 }}>
          <label class="form-label" for="palette-confirm">This action is guarded. Type <b>${word}</b> to confirm.</label>
          <input id="palette-confirm" class="input" value=${s.confirm} autocomplete="off" onInput=${e => patch({ confirm: e.target.value })}/>
        </div>`}
        ${s.error && html`<div role="alert" style=${{ color: 'var(--red)', marginTop: 8, fontSize: 13 }}>${s.error}</div>`}
        <div class="btn-group" style=${{ marginTop: 12 }}>
          <button class="btn btn-primary" disabled=${!canGo} onClick=${run}>${s.busy ? 'Starting...' : 'Run'}</button>
          <button class="btn" onClick=${back}>Back</button>
        </div>`}
      <div style=${{ marginTop: 10, fontSize: 11, color: 'var(--text-dim)' }}>Enter to choose, arrows to move, Backspace to go back, Esc to close</div>
    </div>
  </div>`;
}
