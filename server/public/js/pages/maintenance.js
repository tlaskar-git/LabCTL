import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons, Modal } from '../ui.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const BLANK = { name: '', kind: 'one-off', scopeType: 'all', ids: [], value: '', starts_at: '', ends_at: '', days: [1], time: '02:00', duration_min: 120 };
const when = iso => (iso ? iso.slice(0, 16).replace('T', ' ') : '');
const scopeText = s => (s.type === 'all' ? 'All hosts' : s.type === 'hosts' ? `${(s.ids || []).length} host(s)` : `${s.type}: ${s.value}`);

export default function MaintenancePage({ hosts, addToast, currentUser }) {
  const [list, setList] = useState([]);
  const [form, setForm] = useState(null);
  const canWrite = currentUser?.role === 'admin' || currentUser?.role === 'operator';
  const load = () => api('/api/maintenance').then(setList).catch(e => addToast(e.message, 'error'));
  useEffect(() => { load(); }, []);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const toggle = (arr, v) => (arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v]);

  const save = async () => {
    const scope = form.scopeType === 'all' ? { type: 'all' } : form.scopeType === 'hosts' ? { type: 'hosts', ids: form.ids } : { type: form.scopeType, value: form.value };
    const body = { name: form.name, scope, ...(form.kind === 'recurring'
      ? { recurrence: { days: form.days, time: form.time, duration_min: Number(form.duration_min) } }
      : { starts_at: form.starts_at && new Date(form.starts_at).toISOString(), ends_at: form.ends_at && new Date(form.ends_at).toISOString() }) };
    try {
      await api(form.id ? `/api/maintenance/${form.id}` : '/api/maintenance', { method: form.id ? 'PUT' : 'POST', body });
      addToast('Maintenance window saved'); setForm(null); load();
    } catch (e) { addToast(e.message, 'error'); }
  };
  const edit = w => setForm({ ...BLANK, id: w.id, name: w.name, kind: w.kind, scopeType: w.scope.type, ids: w.scope.ids || [], value: w.scope.value || '',
    starts_at: w.starts_at ? new Date(w.starts_at).toISOString().slice(0, 16) : '', ends_at: w.ends_at ? new Date(w.ends_at).toISOString().slice(0, 16) : '',
    ...(w.recurrence || {}) });
  const remove = async w => { await api(`/api/maintenance/${w.id}`, { method: 'DELETE' }).catch(e => addToast(e.message, 'error')); addToast('Window deleted'); load(); };

  return html`<div>
    <div class="page-header"><div><div class="page-title">Maintenance</div><div class="page-desc">Windows that pause alert notices and automations for chosen hosts</div></div>
      ${canWrite && html`<button class="btn btn-primary" onClick=${() => setForm(BLANK)}>+ New window</button>`}</div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Type</th><th>When</th><th>Scope</th>${canWrite && html`<th>Actions</th>`}</tr></thead>
      <tbody>
        ${list.map(w => html`<tr key=${w.id}>
          <td style=${{ fontWeight: 600 }}>${w.name}</td><td>${w.kind}</td>
          <td style=${{ fontSize: 12 }}>${w.recurrence ? `${w.recurrence.days.map(d => DAYS[d]).join(', ')} at ${w.recurrence.time} for ${w.recurrence.duration_min} min` : `${when(w.starts_at)} to ${when(w.ends_at)} (UTC)`}</td>
          <td>${scopeText(w.scope)}</td>
          ${canWrite && html`<td><div class="btn-group"><button class="btn btn-sm" onClick=${() => edit(w)}>Edit</button>
            <button class="btn btn-sm btn-danger" onClick=${() => remove(w)}><${Icons.Trash}/></button></div></td>`}
        </tr>`)}
        ${list.length === 0 && html`<tr><td colSpan=${5} style=${{ textAlign: 'center', padding: 30, color: 'var(--text-dim)' }}>No maintenance windows.</td></tr>`}
      </tbody></table></div>
    ${form && html`<${Modal} title=${form.id ? 'Edit window' : 'New window'} onClose=${() => setForm(null)}>
      <div class="form-group"><label class="form-label">Name</label><input class="input" value=${form.name} onInput=${e => set('name', e.target.value)}/></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Type</label>
          <select class="select input" value=${form.kind} onChange=${e => set('kind', e.target.value)}><option value="one-off">One-off</option><option value="recurring">Weekly</option></select></div>
        <div class="form-group"><label class="form-label">Scope</label>
          <select class="select input" value=${form.scopeType} onChange=${e => set('scopeType', e.target.value)}>
            <option value="all">All hosts</option><option value="hosts">Chosen hosts</option><option value="group">Group</option><option value="tag">Tag</option></select></div>
      </div>
      ${form.scopeType === 'hosts' && html`<div style=${{ maxHeight: 120, overflow: 'auto', marginBottom: 10 }}>${(hosts || []).map(h => html`<label key=${h.id} class="checkbox-row">
        <input type="checkbox" checked=${form.ids.includes(h.id)} onChange=${() => set('ids', toggle(form.ids, h.id))}/> ${h.hostname}</label>`)}</div>`}
      ${(form.scopeType === 'group' || form.scopeType === 'tag') && html`<div class="form-group"><input class="input" placeholder=${`${form.scopeType} name`} value=${form.value} onInput=${e => set('value', e.target.value)}/></div>`}
      ${form.kind === 'one-off' ? html`<div class="form-row">
        <div class="form-group"><label class="form-label">Starts</label><input class="input" type="datetime-local" value=${form.starts_at} onInput=${e => set('starts_at', e.target.value)}/></div>
        <div class="form-group"><label class="form-label">Ends</label><input class="input" type="datetime-local" value=${form.ends_at} onInput=${e => set('ends_at', e.target.value)}/></div></div>`
      : html`<div class="form-group"><label class="form-label">Days (server time zone)</label>
          <div class="btn-group">${DAYS.map((d, i) => html`<button key=${d} class=${`btn btn-sm ${form.days.includes(i) ? 'btn-primary' : ''}`} onClick=${() => set('days', toggle(form.days, i))}>${d}</button>`)}</div>
          <div class="form-row" style=${{ marginTop: 8 }}>
            <div class="form-group"><label class="form-label">Start time</label><input class="input" type="time" value=${form.time} onInput=${e => set('time', e.target.value)}/></div>
            <div class="form-group"><label class="form-label">Duration (minutes)</label><input class="input" type="number" min="1" value=${form.duration_min} onInput=${e => set('duration_min', e.target.value)}/></div></div></div>`}
      <button class="btn btn-primary" onClick=${save}>Save</button>
    <//>`}
  </div>`;
}
