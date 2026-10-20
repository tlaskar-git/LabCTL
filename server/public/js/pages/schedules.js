import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons, Modal } from '../ui.js';
import { Chip, EmptyState, KitIcons, SectionHeader, Skeleton, absTime, relTime, hostName, nameFor } from '../components/ui-kit.js';
import { JOB_TYPES } from '../job-types.js';
import { TypedConfirm } from './patching.js';


// ── Built-in schedules: one click on, time editable, last and next run ─────
function BuiltinSchedules({ addToast }) {
  const [list, setList] = useState([]);
  const [ask, setAsk] = useState(null);
  const [draft, setDraft] = useState({}); // key -> cron being edited

  const load = () => api('/api/builtin-schedules').then(setList).catch(e => addToast(e.message, 'error'));
  useEffect(() => { load(); }, []);

  const call = async (key, action, body, method = 'POST') => {
    try {
      const r = await api(`/api/builtin-schedules/${key}${action ? `/${action}` : ''}`, { method, body });
      if (r.result) addToast(`${r.result.status}: ${r.result.detail}`, r.result.status === 'error' ? 'error' : 'success');
      setDraft(d => ({ ...d, [key]: undefined }));
      load();
    } catch (e) { addToast(e.message, 'error'); }
  };
  const toggle = s => (s.enabled ? call(s.key, 'disable', {})
    : s.guarded ? setAsk({ key: s.key, name: s.name, cron: draft[s.key] || s.cron }) : call(s.key, 'enable', { cron: draft[s.key] || s.cron }));

  return html`<section aria-labelledby="builtin-h">
    <${SectionHeader} id="builtin-h" title="Built-in schedules" count=${list.filter(s => s.enabled).length ? `${list.filter(s => s.enabled).length} on` : null}/>
    <p class="hint" style=${{ margin: '-4px 0 10px' }}>Switch one on and it runs by itself. Hosts in a maintenance window are skipped. Times use the server time zone.</p>
    ${!list.length ? html`<${Skeleton} rows=${3}/>` : html`<div class="rows">${list.map(s => html`<div class="row" key=${s.key}>
      <button type="button" role="switch" aria-checked=${s.enabled ? 'true' : 'false'} aria-label=${`Enable ${s.name}`} class=${`toggle ${s.enabled ? 'active' : ''}`}
        style=${{ border: 0 }} onClick=${() => toggle(s)}/>
      <div class="row-main">
        <div class="row-title">${s.name}</div>
        <div class="row-sub" title=${s.description}>${s.description}</div>
        ${s.key === 'cert_expiry' && !s.domains && html`<div class="row-sub" style=${{ color: 'var(--yellow)' }}>Set cert_domains under Settings first.</div>`}
        <div class="sched-meta">
          ${s.last_status && html`<${Chip} status=${s.last_status} title=${s.last_detail || ''} dot>${s.last_status}<//>`}
          <span class="row-meta" title=${absTime(s.last_run)}>Last ${relTime(s.last_run)}</span>
          ${s.enabled && s.next_run && html`<span class="row-meta" title=${absTime(s.next_run)}>Next ${relTime(s.next_run)}</span>`}
        </div>
      </div>
      <div class="row-actions">
        <input class="input mono cron-input" aria-label=${`Cron for ${s.name}`} value=${draft[s.key] ?? s.cron} onInput=${e => setDraft(d => ({ ...d, [s.key]: e.target.value }))}/>
        ${draft[s.key] !== undefined && draft[s.key] !== s.cron && html`<button class="btn btn-sm" onClick=${() => call(s.key, '', { cron: draft[s.key] }, 'PUT')}>Save</button>`}
        ${s.key !== 'patch_weekly' && html`<button class="btn btn-sm btn-icon" aria-label=${`Run ${s.name} now`} title="Run now" onClick=${() => call(s.key, 'run', {})}><${Icons.Play}/></button>`}
      </div>
    </div>`)}</div>`}
    ${ask && html`<${TypedConfirm} title="Enable weekly patching" word="patch_weekly"
      action="This creates three ring policies and enables them. They can reboot hosts. Hosts without ring tags are not touched."
      onClose=${() => setAsk(null)} onConfirm=${confirm => { call(ask.key, 'enable', { cron: ask.cron, confirm }); setAsk(null); }}/>`}
  </section>`;
}

// ── Schedules Page ────────────────────────────────────────
export default function SchedulesPage({ hosts, addToast }) {
  const [schedules, setSchedules] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
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
        <button class="btn btn-primary" onClick=${() => setShowAdd(true)}><${KitIcons.Plus}/> New schedule</button>
      </div>

      <div class="page-stack">
      <${BuiltinSchedules} addToast=${addToast}/>

      <section aria-labelledby="custom-h">
        <${SectionHeader} id="custom-h" title="Your schedules" count=${schedules ? schedules.length : null}/>
        ${!schedules ? html`<${Skeleton} rows=${2}/>` : !schedules.length
          ? html`<${EmptyState} icon="Clock" title="No schedules yet" text="Run a backup, an update or a reboot on a timetable."
              action=${html`<button class="btn btn-primary" onClick=${() => setShowAdd(true)}><${KitIcons.Plus}/> New schedule</button>`}/>`
          : html`<div class="rows">${schedules.map(s => html`<div class="row" key=${s.id}>
              <button type="button" role="switch" aria-checked=${s.enabled ? 'true' : 'false'} aria-label=${`Enable ${s.name}`}
                class=${`toggle ${s.enabled ? 'active' : ''}`} style=${{ border: 0 }} onClick=${() => toggleSchedule(s.id, s.enabled)}/>
              <div class="row-main">
                <div class="row-title">${s.name}</div>
                <div class="row-sub">${JOB_TYPES[s.type]?.label || s.type} on ${nameFor(hosts, s.host_id, s.hostname || s.host_id?.slice(0, 8))} · <code>${s.cron}</code></div>
              </div>
              <span class="row-meta" title=${absTime(s.next_run)}>${s.enabled && s.next_run ? `Next ${relTime(s.next_run)}` : 'Off'}</span>
              <div class="row-actions">
                <button class="btn btn-sm btn-icon" aria-label=${`Delete ${s.name}`} title="Delete" onClick=${() => deleteSchedule(s)}><${Icons.Trash}/></button>
              </div>
            </div>`)}</div>`}
      </section>
      </div>

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
