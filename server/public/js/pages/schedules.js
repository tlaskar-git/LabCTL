import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons, Modal } from '../ui.js';
import { Chip, EmptyState, KitIcons, SectionHeader, Skeleton, absTime, relTime, hostName, nameFor } from '../components/ui-kit.js';
import { JOB_TYPES } from '../job-types.js';
import { TypedConfirm } from './patching.js';
import { ScheduleEditor } from '../components/schedule-editor.js';


// ── Built-in schedules: switch on, edit, remove, restore; custom entries live in the same list ─────
function RowMenu({ label, items }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const focusItem = d => {
    const list = [...wrap.current.querySelectorAll('[role="menuitem"]')];
    const i = list.indexOf(document.activeElement);
    list[(i + d + list.length) % list.length]?.focus();
  };
  useEffect(() => { if (open) wrap.current?.querySelector('[role="menuitem"]')?.focus(); }, [open]);
  const keys = e => {
    if (e.key === 'Escape') { setOpen(false); wrap.current.querySelector('button')?.focus(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(-1); }
  };
  if (!items.length) return null;
  return html`<div class="sched-menu-wrap" ref=${wrap} onKeyDown=${keys} onFocusOut=${e => !wrap.current.contains(e.relatedTarget) && setOpen(false)}>
    <button type="button" class="btn btn-sm btn-icon sched-kebab" aria-haspopup="menu" aria-expanded=${open ? 'true' : 'false'} aria-label=${label}
      onClick=${() => setOpen(o => !o)}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg></button>
    ${open && html`<div class="sched-menu" role="menu" aria-label=${label}>
      ${items.map(([text, fn, danger]) => html`<button key=${text} type="button" role="menuitem" class=${danger ? 'sched-danger' : ''}
        onClick=${() => { setOpen(false); fn(); }}>${text}</button>`)}
    </div>`}
  </div>`;
}

function ConfirmRemove({ s, onClose, onConfirm }) {
  return html`<${Modal} title=${`Remove ${s.name}`} onClose=${onClose}>
    <div class="page-desc" style=${{ marginBottom: 12 }}>It is switched off and hidden from this list. Restore it later from Removed built-in schedules.</div>
    <div class="btn-group">
      <button class="btn btn-danger" autofocus onClick=${onConfirm}>Remove</button>
      <button class="btn" onClick=${onClose}>Cancel</button>
    </div>
  <//>`;
}

function BuiltinSchedules({ addToast, isAdmin, canRun, onEdit, reloadKey }) {
  const [list, setList] = useState(null);
  const [removed, setRemoved] = useState([]);
  const [ask, setAsk] = useState(null); // { kind: 'enable' | 'remove', s }

  const load = () => {
    api('/api/builtin-schedules').then(setList).catch(e => { setList(l => l || []); addToast(e.message, 'error'); });
    api('/api/builtin-schedules?removed=1').then(setRemoved).catch(() => {});
  };
  useEffect(() => { load(); }, [reloadKey]);
  // autofocus does not fire for a dialog added after page load: move focus into the confirm dialog.
  useEffect(() => { if (ask) document.querySelector('.modal input, .modal .btn-danger')?.focus(); }, [ask]);

  const call = async (key, action, body, method = 'POST') => {
    try {
      const r = await api(`/api/builtin-schedules/${key}${action ? `/${action}` : ''}`, { method, body });
      if (r.result) addToast(`${r.result.status}: ${r.result.detail}`, r.result.status === 'error' ? 'error' : 'success');
      load();
      return r;
    } catch (e) { addToast(e.message, 'error'); return null; }
  };
  const toggle = s => (s.enabled ? call(s.key, 'disable', {}) : s.guarded ? setAsk({ kind: 'enable', s }) : call(s.key, 'enable', {}));
  const doRemove = async (s, confirm) => {
    setAsk(null);
    if (await call(s.key, '', confirm ? { confirm } : {}, 'DELETE')) addToast(s.custom ? `${s.name} deleted` : `${s.name} removed`);
  };
  const menu = s => [
    ...(isAdmin ? [['Edit', () => onEdit(s)]] : []),
    ...(canRun && s.key !== 'patch_weekly' ? [['Run now', () => call(s.key, 'run', {})]] : []),
    ...(isAdmin && s.builtin && s.edited ? [['Reset to defaults', () => call(s.key, 'reset', {})]] : []),
    ...(isAdmin ? [[s.custom ? 'Delete' : 'Remove', () => setAsk({ kind: 'remove', s }), true]] : [])
  ];
  const on = (list || []).filter(s => s.enabled).length;

  return html`<section aria-labelledby="builtin-h">
    <${SectionHeader} id="builtin-h" title="Built-in schedules" count=${on ? `${on} on` : null}/>
    <p class="hint" style=${{ margin: '-4px 0 10px' }}>Switch one on and it runs by itself. Hosts in a maintenance window are skipped. Times use the server time zone.</p>
    ${!list ? html`<${Skeleton} rows=${3}/>` : !list.length
      ? html`<${EmptyState} icon="Clock" title="No built-in schedules" text="Restore one below, or add one with New schedule."/>`
      : html`<div class="rows">${list.map(s => html`<div class="row sched-row" key=${s.key}>
      <button type="button" role="switch" aria-checked=${s.enabled ? 'true' : 'false'} aria-label=${`Enable ${s.name}`} class=${`toggle ${s.enabled ? 'active' : ''}`}
        style=${{ border: 0 }} disabled=${!canRun} onClick=${() => toggle(s)}/>
      <div class="row-main">
        <div class="row-title sched-title">${s.name}
          <${Chip} tone="muted">${s.custom ? 'Custom' : 'Built-in'}<//>
          ${s.edited && html`<${Chip} tone="info">Edited<//>`}
          ${s.guarded && html`<${Chip} tone="muted" title="Switching it on needs a typed confirmation">Guarded<//>`}
          ${s.missing_templates?.length > 0 && html`<${Chip} tone="warn" title=${s.missing_templates.map(t => `Template ${t} was removed`).join('. ')}>Missing template<//>`}
        </div>
        <div class="row-sub" title=${s.description}>${s.description}</div>
        ${s.missing_templates?.length > 0 && html`<div class="row-sub sched-warn">${s.missing_templates.map(t => `Template ${t} was removed.`).join(' ')} Edit the schedule to choose another.</div>`}
        ${s.key === 'cert_expiry' && !s.domains && html`<div class="row-sub sched-warn">Set cert_domains under Settings first.</div>`}
        <div class="sched-meta">
          ${s.last_status && html`<${Chip} status=${s.last_status} title=${s.last_detail || ''} dot>${s.last_status}<//>`}
          <span class="row-meta" title=${absTime(s.last_run)}>Last ${relTime(s.last_run)}</span>
          <span class="row-meta" title=${absTime(s.next_run)}>${s.enabled && s.next_run ? `Next ${relTime(s.next_run)}` : 'Off'}</span>
          <code class="row-meta">${s.cron}</code>
        </div>
      </div>
      <div class="row-actions">
        ${canRun && s.key !== 'patch_weekly' && html`<button class="btn btn-sm btn-icon" aria-label=${`Run ${s.name} now`} title="Run now" onClick=${() => call(s.key, 'run', {})}><${Icons.Play}/></button>`}
        <${RowMenu} label=${`Actions for ${s.name}`} items=${menu(s)}/>
      </div>
    </div>`)}</div>`}

    ${removed.length > 0 && html`<div class="sched-removed">
      <h3 id="removed-h" class="sched-sub-h">Removed built-in schedules</h3>
      <div class="rows" aria-labelledby="removed-h">${removed.map(s => html`<div class="row" key=${s.key}>
        <div class="row-main"><div class="row-title">${s.name}</div><div class="row-sub">${s.description}</div></div>
        ${isAdmin && html`<div class="row-actions"><button class="btn btn-sm" aria-label=${`Restore ${s.name}`} onClick=${() => call(s.key, 'restore', {})}>Restore</button></div>`}
      </div>`)}</div>
    </div>`}

    ${ask?.kind === 'enable' && html`<${TypedConfirm} title=${`Switch on ${ask.s.name}`} word=${ask.s.confirm_word}
      action=${ask.s.key === 'patch_weekly' ? 'This creates three ring policies and enables them. They can reboot hosts. Hosts without ring tags are not touched.'
        : 'This schedule runs a guarded template on its hosts.'}
      onClose=${() => setAsk(null)} onConfirm=${confirm => { call(ask.s.key, 'enable', { confirm }); setAsk(null); }}/>`}
    ${ask?.kind === 'remove' && (ask.s.custom
      ? html`<${TypedConfirm} title=${`Delete ${ask.s.name}`} word=${ask.s.name} action="This deletes the schedule for good. Jobs it started stay in the job history."
          onClose=${() => setAsk(null)} onConfirm=${c => doRemove(ask.s, c)}/>`
      : ask.s.key === 'patch_weekly' && ask.s.policies?.length
        ? html`<${TypedConfirm} title=${`Remove ${ask.s.name}`} word="DELETE"
            action="This switches weekly patching off, hides it, and deletes the three ring policies it created, including any changes made to them on the Patching page. Restore brings back the defaults, not those changes."
            onClose=${() => setAsk(null)} onConfirm=${c => doRemove(ask.s, c)}/>`
        : html`<${ConfirmRemove} s=${ask.s} onClose=${() => setAsk(null)} onConfirm=${() => doRemove(ask.s)}/>`)}
  </section>`;
}

// ── Schedules Page ────────────────────────────────────────
export default function SchedulesPage({ hosts, addToast, currentUser }) {
  const [schedules, setSchedules] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null); // { mode: 'new' | 'builtin' | 'host', entry }
  const [reloadKey, setReloadKey] = useState(0);
  const role = currentUser?.role === 'readonly' ? 'viewer' : currentUser?.role;
  const isAdmin = role === 'admin';
  const canRun = role === 'admin' || role === 'operator';
  const [form, setForm] = useState({ name: '', host_id: '', type: 'backup', cron: '0 1 * * 0', params: {} });

  const load = () => api('/api/schedules').then(setSchedules, e => { setSchedules(x => x || []); addToast(e.message, 'error'); });
  useEffect(() => { load(); }, []);

  const addSchedule = async () => {
    if (!form.name || !form.host_id || !form.cron) {
      addToast('Fill in all required fields.', 'error');
      return;
    }
    await api('/api/schedules', { method: 'POST', body: form });
    addToast(`Schedule "${form.name}" created`);
    setShowAdd(false);
    setForm({ name: '', host_id: '', type: 'backup', cron: '0 1 * * 0', params: {} });
    load();
  };

  const toggleSchedule = async (id, enabled) => {
    await api(`/api/schedules/${id}`, { method: 'PUT', body: { enabled: !enabled } });
    load();
  };

  // The editor drawer saves a new catalogue entry, an edit of one, or the name and time of a host schedule.
  const saveEdit = async body => {
    const { mode, entry } = editing;
    if (mode === 'new') await api('/api/builtin-schedules', { method: 'POST', body });
    else if (mode === 'host') await api(`/api/schedules/${entry.id}`, { method: 'PUT', body: { name: body.name, cron: body.cron } });
    else await api(`/api/builtin-schedules/${entry.key}`, { method: 'PUT', body });
    addToast(mode === 'new' ? `Schedule "${body.name}" created` : 'Schedule saved', 'success');
    setEditing(null);
    if (mode === 'host') load(); else setReloadKey(k => k + 1);
  };
  const resetEdit = async () => {
    try { await api(`/api/builtin-schedules/${editing.entry.key}/reset`, { method: 'POST', body: {} }); addToast('Defaults restored', 'success'); } catch (e) { addToast(e.message, 'error'); }
    setEditing(null);
    setReloadKey(k => k + 1);
  };

  const deleteSchedule = async (s) => {
    if (!window.confirm(`Delete the schedule ${s.name}?`)) return;
    await api(`/api/schedules/${s.id}`, { method: 'DELETE' });
    addToast('Schedule deleted');
    load();
  };

  return (
    html`<div>
      <div class="page-header">
        <div>
          <div class="page-title">Schedules</div>
          <div class="page-desc">Jobs that run by themselves on a cron timetable.</div>
        </div>
        ${isAdmin && html`<button class="btn btn-primary" onClick=${() => setEditing({ mode: 'new' })}><${KitIcons.Plus}/> New schedule</button>`}
      </div>

      <div class="page-stack">
      <${BuiltinSchedules} addToast=${addToast} isAdmin=${isAdmin} canRun=${canRun} reloadKey=${reloadKey}
        onEdit=${entry => setEditing({ mode: 'builtin', entry })}/>

      <section aria-labelledby="custom-h">
        <${SectionHeader} id="custom-h" title="Your schedules" count=${schedules ? schedules.length : null}
          right=${canRun && html`<button class="btn btn-sm" onClick=${() => setShowAdd(true)}><${KitIcons.Plus}/> Host job</button>`}/>
        ${!schedules ? html`<${Skeleton} rows=${2}/>` : !schedules.length
          ? html`<${EmptyState} icon="Clock" title="No schedules yet" text="Run a backup, an update or a reboot on a timetable."
              action=${canRun && html`<button class="btn btn-primary" onClick=${() => setShowAdd(true)}><${KitIcons.Plus}/> Host job</button>`}/>`
          : html`<div class="rows">${schedules.map(s => html`<div class="row" key=${s.id}>
              <button type="button" role="switch" aria-checked=${s.enabled ? 'true' : 'false'} aria-label=${`Enable ${s.name}`}
                class=${`toggle ${s.enabled ? 'active' : ''}`} style=${{ border: 0 }} onClick=${() => toggleSchedule(s.id, s.enabled)}/>
              <div class="row-main">
                <div class="row-title">${s.name}</div>
                <div class="row-sub">${JOB_TYPES[s.type]?.label || s.type} on ${nameFor(hosts, s.host_id, s.hostname || s.host_id?.slice(0, 8))} · <code>${s.cron}</code></div>
              </div>
              <span class="row-meta" title=${absTime(s.next_run)}>${s.enabled && s.next_run ? `Next ${relTime(s.next_run)}` : 'Off'}</span>
              <div class="row-actions">
                ${canRun && html`<button class="btn btn-sm" aria-label=${`Edit ${s.name}`} onClick=${() => setEditing({ mode: 'host', entry: s })}>Edit</button>`}
                <button class="btn btn-sm btn-icon" aria-label=${`Delete ${s.name}`} title="Delete" onClick=${() => deleteSchedule(s)}><${Icons.Trash}/></button>
              </div>
            </div>`)}</div>`}
      </section>
      </div>

      ${editing && html`<${ScheduleEditor} key=${editing.entry?.key || editing.entry?.id || 'new'} hosts=${hosts}
        title=${editing.mode === 'new' ? 'New schedule' : `Edit ${editing.entry.name}`}
        kind=${editing.mode === 'host' ? 'host' : editing.mode === 'new' ? 'templates' : editing.entry.kind} entry=${editing.entry}
        onSave=${saveEdit} onClose=${() => setEditing(null)}
        onReset=${editing.mode === 'builtin' && editing.entry.builtin && editing.entry.edited ? resetEdit : null}/>`}

      ${showAdd && (
        html`<${Modal} title="New Schedule" onClose=${() => setShowAdd(false)}>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Schedule Name</label>
              <input class="input" placeholder="Weekly LAB01 Backup"
                value=${form.name} onInput=${e => setForm(f => ({ ...f, name: e.target.value }))}/>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Host</label>
              <select class="select input" value=${form.host_id}
                onChange=${e => setForm(f => ({ ...f, host_id: e.target.value }))}>
                <option value="">Select host...</option>
                ${hosts.map(h => html`<option key=${h.id} value=${h.id}>${hostName(h)}</option>`)}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Job Type</label>
              <select class="select input" value=${form.type}
                onChange=${e => setForm(f => ({ ...f, type: e.target.value }))}>
                ${Object.entries(JOB_TYPES).map(([k, v]) => (
                  html`<option key=${k} value=${k}>${v.label}</option>`
                ))}
              </select>
            </div>
          </div>
          <div class="form-group" style=${{ marginBottom: 12 }}>
            <label class="form-label">Schedule</label>

            
            <div style=${{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
              ${['daily','weekly','monthly','interval','custom'].map(freq => (
                html`<div key=${freq} onClick=${() => {
                  const defaults = { daily: '0 1 * * *', weekly: '0 1 * * 0', monthly: '0 1 1 * *', interval: '0 */6 * * *' };
                  setForm(f => ({ ...f, _freq: freq, cron: defaults[freq] || f.cron, _cronPreset: freq === 'custom' ? 'custom' : freq }));
                }} style=${{
                  padding: '5px 12px', borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  background: (form._freq || 'custom') === freq ? 'var(--accent)' : 'var(--bg-input)',
                  color: (form._freq || 'custom') === freq ? 'white' : 'var(--text-secondary)',
                  border: `1px solid ${(form._freq || 'custom') === freq ? 'var(--accent)' : 'var(--border)'}`
                }}>${freq.charAt(0).toUpperCase() + freq.slice(1)}</div>`
              ))}
            </div>

            
            ${['daily','weekly','monthly'].includes(form._freq) && (
              html`<div class="form-row" style=${{ marginBottom: 10 }}>
                <div class="form-group">
                  <label class="form-label" style=${{ fontSize: 10 }}>Hour</label>
                  <select class="select input" style=${{ fontSize: 12 }} value=${(() => {
                    const parts = (form.cron || '').split(' ');
                    return parts[1] || '1';
                  })()} onChange=${e => {
                    const parts = (form.cron || '0 1 * * *').split(' ');
                    parts[1] = e.target.value;
                    setForm(f => ({ ...f, cron: parts.join(' ') }));
                  }}>
                    ${Array.from({length: 24}, (_, i) => (
                      html`<option key=${i} value=${String(i)}>${i === 0 ? '12 AM' : i < 12 ? `${i} AM` : i === 12 ? '12 PM' : `${i-12} PM`}</option>`
                    ))}
                  </select>
                </div>
                <div class="form-group">
                  <label class="form-label" style=${{ fontSize: 10 }}>Minute</label>
                  <select class="select input" style=${{ fontSize: 12 }} value=${(() => {
                    const parts = (form.cron || '').split(' ');
                    return parts[0] || '0';
                  })()} onChange=${e => {
                    const parts = (form.cron || '0 1 * * *').split(' ');
                    parts[0] = e.target.value;
                    setForm(f => ({ ...f, cron: parts.join(' ') }));
                  }}>
                    ${[0,5,10,15,20,25,30,35,40,45,50,55].map(m => (
                      html`<option key=${m} value=${String(m)}>${String(m).padStart(2,'0')}</option>`
                    ))}
                  </select>
                </div>
              </div>`
            )}

            
            ${form._freq === 'weekly' && (
              html`<div style=${{ marginBottom: 10 }}>
                <label class="form-label" style=${{ fontSize: 10, marginBottom: 4 }}>Day of Week</label>
                <div style=${{ display: 'flex', gap: 4 }}>
                  ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d, i) => {
                    const parts = (form.cron || '0 1 * * 0').split(' ');
                    const selected = (parts[4] || '0').split(',').includes(String(i));
                    return (
                      html`<div key=${i} onClick=${() => {
                        const parts = (form.cron || '0 1 * * 0').split(' ');
                        let days = (parts[4] || '0').split(',').filter(x => x !== '*' && x !== '');
                        if (selected) days = days.filter(x => x !== String(i));
                        else days.push(String(i));
                        if (days.length === 0) days = ['0'];
                        parts[4] = days.join(',');
                        setForm(f => ({ ...f, cron: parts.join(' ') }));
                      }} style=${{
                        width: 36, height: 32, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 11, fontWeight: 600, cursor: 'pointer',
                        background: selected ? 'var(--accent)' : 'var(--bg-input)',
                        color: selected ? 'white' : 'var(--text-secondary)',
                        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`
                      }}>${d}</div>`
                    );
                  })}
                </div>
              </div>`
            )}

            
            ${form._freq === 'monthly' && (
              html`<div style=${{ marginBottom: 10 }}>
                <label class="form-label" style=${{ fontSize: 10, marginBottom: 4 }}>Day of Month</label>
                <div style=${{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                  ${Array.from({length: 28}, (_, i) => i + 1).map(d => {
                    const parts = (form.cron || '0 1 1 * *').split(' ');
                    const selected = parts[2] === String(d);
                    return (
                      html`<div key=${d} onClick=${() => {
                        const parts = (form.cron || '0 1 1 * *').split(' ');
                        parts[2] = String(d);
                        setForm(f => ({ ...f, cron: parts.join(' ') }));
                      }} style=${{
                        width: 28, height: 28, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, fontWeight: 600, cursor: 'pointer',
                        background: selected ? 'var(--accent)' : 'var(--bg-input)',
                        color: selected ? 'white' : 'var(--text-secondary)',
                        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`
                      }}>${d}</div>`
                    );
                  })}
                </div>
              </div>`
            )}

            
            ${form._freq === 'interval' && (
              html`<div class="form-row" style=${{ marginBottom: 10 }}>
                <div class="form-group">
                  <label class="form-label" style=${{ fontSize: 10 }}>Every</label>
                  <select class="select input" style=${{ fontSize: 12 }} value=${form._interval || '6h'} onChange=${e => {
                    const map = { '15m': '*/15 * * * *', '30m': '*/30 * * * *', '1h': '0 * * * *', '2h': '0 */2 * * *', '4h': '0 */4 * * *', '6h': '0 */6 * * *', '8h': '0 */8 * * *', '12h': '0 */12 * * *' };
                    setForm(f => ({ ...f, _interval: e.target.value, cron: map[e.target.value] || f.cron }));
                  }}>
                    <option value="15m">15 minutes</option>
                    <option value="30m">30 minutes</option>
                    <option value="1h">1 hour</option>
                    <option value="2h">2 hours</option>
                    <option value="4h">4 hours</option>
                    <option value="6h">6 hours</option>
                    <option value="8h">8 hours</option>
                    <option value="12h">12 hours</option>
                  </select>
                </div>
              </div>`
            )}

            
            <div style=${{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <code style=${{ fontSize: 12, color: 'var(--accent)', background: 'var(--bg-input)', padding: '4px 10px', borderRadius: 4, border: '1px solid var(--border)', flex: 1, fontFamily: 'Geist Mono, monospace' }}>
                ${form.cron || '0 1 * * 0'}
              </code>
              ${form._freq !== 'custom' && html`<span style=${{ fontSize: 10, color: 'var(--text-dim)' }}>auto-generated</span>`}
            </div>
            ${form._freq === 'custom' && (
              html`<input class="input mono" placeholder="0 1 * * 0" style=${{ fontSize: 12, marginTop: 6 }}
                value=${form.cron} onInput=${e => setForm(f => ({ ...f, cron: e.target.value }))}/>`
            )}
            <div style=${{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
              Works for both Linux cron and Windows Task Scheduler. Format: min hour day month weekday
            </div>
          </div>

          ${form.type === 'backup' && (
            html`<div class="form-group" style=${{ marginBottom: 12 }}>
              <label class="form-label">Script Path</label>
              <div style=${{ display: 'flex', gap: 6 }}>
                <input class="input" placeholder="/root/proxmox-vm-backup.sh"
                  value=${form.params.script || ''}
                  onInput=${e => setForm(f => ({ ...f, params: { ...f.params, script: e.target.value } }))}/>
                <button class="btn btn-sm" title="Browse remote path" onClick=${() => {
                  if (form.host_id) {
                    api('/api/jobs', { method: 'POST', body: { host_id: form.host_id, type: 'file_browse', params: { path: form.params.script ? form.params.script.replace(/[^\/\\]*$/, '') : '/' } }});
                    addToast('Browse job sent. Check Jobs tab for result.');
                  } else { addToast('Select a host first.', 'error'); }
                }}>Browse</button>
              </div>
              <div style=${{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>Path to the backup script on the remote host.</div>
            </div>`
          )}

          ${form.type === 'custom_command' && (
            html`<div class="form-group" style=${{ marginBottom: 12 }}>
              <label class="form-label">Command or Script Path</label>
              <textarea class="textarea"
                value=${form.params.command || ''}
                onInput=${e => setForm(f => ({ ...f, params: { ...f.params, command: e.target.value } }))}/>
              <div style=${{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>Enter a command, script path, or paste a multi-line script.</div>
            </div>`
          )}

          ${['autologin', 'backup'].includes(form.type) && (
            html`<div class="form-group" style=${{ marginBottom: 12 }}>
              <label class="form-label">Run As (saved credential)</label>
              <select class="select input" style=${{ fontSize: 12 }}
                value=${form.params._credId || ''}
                onChange=${e => setForm(f => ({ ...f, params: { ...f.params, _credId: e.target.value } }))}>
                <option value="">Default (no credential override)</option>
                ${hosts.filter(h => h.id === form.host_id).map(h => (
                  html`<option key=${h.id} value=${h.id}>${h.hostname} saved credentials</option>`
                ))}
              </select>
            </div>`
          )}

          <div class="btn-group" style=${{ justifyContent: 'flex-end' }}>
            <button class="btn" onClick=${() => setShowAdd(false)}>Cancel</button>
            <button class="btn btn-primary" onClick=${addSchedule}>Create Schedule</button>
          </div>
        <//>`
      )}
    </div>`
  );
}
