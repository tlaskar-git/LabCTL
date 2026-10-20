import { useState, useEffect } from 'preact/hooks';
import { api, subscribe } from '../api.js';
import { html, Modal } from '../ui.js';

const TABS = [['active', 'Active'], ['ack', 'Acknowledged'], ['silenced', 'Silenced'], ['resolved', 'Resolved'], ['rules', 'Rules']];
const SEV = { critical: 'failed', warning: 'pending', info: 'cancelled' };
const when = iso => (iso ? iso.slice(0, 16).replace('T', ' ') : '');
const NEW_RULE = { name: '', severity: 'warning', enabled: true, scope: { type: 'all' }, channels: [], params: {},
  condition: { metric: 'disk_pct', op: '>=', threshold: 90, for_minutes: 10 } };

const Sev = ({ s }) => html`<span class=${`badge badge-${SEV[s] || 'cancelled'}`}>${s}</span>`;

function AlertList({ state, canWrite, addToast }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { setRows(null); return subscribe(`alerts?state=${state}&limit=200`, d => setRows(d.rows)); }, [state]);
  const act = async (id, path, body, msg) => {
    try { await api(`/api/alerts/${id}/${path}`, { method: 'POST', body }); addToast(msg); } catch (e) { addToast(e.message, 'error'); }
  };
  if (!rows) return html`<div class="card empty-state"><div class="empty-state-desc">Loading...</div></div>`;
  return html`<div class="table-wrap"><table>
    <thead><tr><th>Severity</th><th>Alert</th><th>Host</th><th>${state === 'resolved' ? 'Resolved' : 'Since'}</th><th>Notices</th>${canWrite && state !== 'resolved' && html`<th>Actions</th>`}</tr></thead>
    <tbody>
      ${rows.map(a => html`<tr key=${a.id}>
        <td><${Sev} s=${a.severity}/></td>
        <td><div style=${{ fontWeight: 600 }}>${a.rule_name}</div>
          <div style=${{ fontSize: 12, color: 'var(--text-dim)' }}>${a.message}</div>
          ${a.suppressed && html`<span class="badge badge-waiting">maintenance</span>`}
          ${a.acked_by && html`<div style=${{ fontSize: 11, color: 'var(--text-dim)' }}>Acknowledged by ${a.acked_by}</div>`}
          ${a.silenced_until && html`<div style=${{ fontSize: 11, color: 'var(--text-dim)' }}>Silenced until ${when(a.silenced_until)}</div>`}</td>
        <td>${a.hostname || ''}</td>
        <td style=${{ fontSize: 12 }}>${when(state === 'resolved' ? a.resolved_at : a.fired_at || a.created_at)}</td>
        <td>${a.notify_count}</td>
        ${canWrite && state !== 'resolved' && html`<td><div class="btn-group">
          ${!a.acked_at && html`<button class="btn btn-sm" onClick=${() => act(a.id, 'ack', {}, 'Acknowledged')}>Acknowledge</button>`}
          ${[60, 240, 1440].map(m => html`<button key=${m} class="btn btn-sm" onClick=${() => act(a.id, 'silence', { minutes: m }, `Silenced for ${m / 60} h`)}>Silence ${m / 60} h</button>`)}
          ${a.silenced_until && html`<button class="btn btn-sm" onClick=${() => act(a.id, 'silence', { minutes: 0 }, 'Silence cleared')}>Unsilence</button>`}
        </div></td>`}
      </tr>`)}
      ${rows.length === 0 && html`<tr><td colSpan=${6} style=${{ textAlign: 'center', padding: 30, color: 'var(--text-dim)' }}>No ${state === 'ack' ? 'acknowledged' : state} alerts.</td></tr>`}
    </tbody></table></div>`;
}

function RuleEditor({ initial, meta, hosts, channels, onClose, onSaved, addToast }) {
  const [r, setR] = useState(initial);
  const [dry, setDry] = useState(null);
  const set = (k, v) => setR(x => ({ ...x, [k]: v }));
  const cond = (k, v) => setR(x => ({ ...x, condition: { ...x.condition, [k]: v } }));
  const scope = r.scope || { type: 'all' };
  const toggle = (list, id) => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  const body = () => ({ ...r, condition: { ...r.condition, threshold: r.condition.threshold === '' ? '' : Number(r.condition.threshold), for_minutes: Number(r.condition.for_minutes) || 0 } });
  const metric = meta.metrics.find(m => m.id === r.condition.metric);
  const dryRun = async () => { try { setDry(await api('/api/alert-rules/test', { method: 'POST', body: body() })); } catch (e) { addToast(e.message, 'error'); } };
  const save = async () => {
    try {
      await api(r.id ? `/api/alert-rules/${r.id}` : '/api/alert-rules', { method: r.id ? 'PUT' : 'POST', body: body() });
      addToast('Rule saved'); onSaved();
    } catch (e) { addToast(e.message, 'error'); }
  };
  return html`<${Modal} title=${r.id ? 'Edit rule' : 'New rule'} onClose=${onClose}>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Name</label><input class="input" value=${r.name} onInput=${e => set('name', e.target.value)}/></div>
      <div class="form-group"><label class="form-label">Severity</label>
        <select class="select input" value=${r.severity} onChange=${e => set('severity', e.target.value)}>${meta.severities.map(s => html`<option key=${s} value=${s}>${s}</option>`)}</select></div>
    </div>
    <div class="form-group"><label class="form-label">Metric</label>
      <select class="select input" value=${r.condition.metric} onChange=${e => cond('metric', e.target.value)}>${meta.metrics.map(m => html`<option key=${m.id} value=${m.id}>${m.label}</option>`)}</select></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Operator</label>
        <select class="select input" value=${r.condition.op} onChange=${e => cond('op', e.target.value)}>${meta.ops.map(o => html`<option key=${o} value=${o}>${o}</option>`)}</select></div>
      <div class="form-group"><label class="form-label">Threshold${metric?.unit ? ` (${metric.unit})` : ''}</label>
        <input class="input" type="number" value=${r.condition.threshold} onInput=${e => cond('threshold', e.target.value)}/></div>
      <div class="form-group"><label class="form-label">For (minutes)</label>
        <input class="input" type="number" min="0" value=${r.condition.for_minutes} onInput=${e => cond('for_minutes', e.target.value)}/></div>
    </div>
    ${metric?.scope === 'host' ? html`<div class="form-group"><label class="form-label">Scope</label>
      <select class="select input" value=${scope.type} onChange=${e => set('scope', { type: e.target.value, ids: [], value: '' })}>
        <option value="all">All hosts</option><option value="hosts">Chosen hosts</option><option value="group">Group</option><option value="tag">Tag</option></select>
      ${scope.type === 'hosts' && html`<div style=${{ marginTop: 6, maxHeight: 130, overflow: 'auto' }}>${hosts.map(h => html`<label key=${h.id} class="checkbox-row">
        <input type="checkbox" checked=${(scope.ids || []).includes(h.id)} onChange=${() => set('scope', { ...scope, ids: toggle(scope.ids || [], h.id) })}/> ${h.hostname}</label>`)}</div>`}
      ${(scope.type === 'group' || scope.type === 'tag') && html`<input class="input" style=${{ marginTop: 6 }} placeholder=${`${scope.type} name`} value=${scope.value || ''} onInput=${e => set('scope', { ...scope, value: e.target.value })}/>`}
    </div>` : html`<div class="page-desc" style=${{ marginBottom: 10 }}>This rule reads GitHub data and applies to all runners.</div>`}
    <div class="form-group"><label class="form-label">Send to (empty uses the default channels)</label>
      ${channels.map(c => html`<label key=${c.id} class="checkbox-row"><input type="checkbox" checked=${r.channels.includes(c.id)} onChange=${() => set('channels', toggle(r.channels, c.id))}/> ${c.name} (${c.kind})</label>`)}
      ${channels.length === 0 && html`<div class="page-desc">No channels yet. Add one under Channels.</div>`}</div>
    ${dry && html`<div class="card" style=${{ marginBottom: 10 }}>
      <div style=${{ fontSize: 12 }}>${dry.evaluated} evaluated, ${dry.matches.length} match${dry.skipped_offline_hosts ? `, ${dry.skipped_offline_hosts} offline host(s) skipped` : ''}</div>
      ${dry.matches.slice(0, 10).map(m => html`<div key=${m.subject} class="mono" style=${{ fontSize: 12 }}>${m.hostname || ''} ${m.key} = ${m.value}${m.detail ? ` (${m.detail})` : ''}</div>`)}</div>`}
    <div class="btn-group"><button class="btn" onClick=${dryRun}>Dry run</button><button class="btn btn-primary" onClick=${save}>Save</button></div>
  <//>`;
}

function Settings({ channels, addToast }) {
  const [c, setC] = useState(null);
  useEffect(() => { api('/api/alert-config').then(setC).catch(() => {}); }, []);
  if (!c) return null;
  const set = (k, v) => setC(x => ({ ...x, [k]: v }));
  const save = async () => { try { setC(await api('/api/alert-config', { method: 'PUT', body: c })); addToast('Alert settings saved'); } catch (e) { addToast(e.message, 'error'); } };
  return html`<div class="card" style=${{ marginTop: 16 }}>
    <div class="card-header"><div class="card-title">Alert settings</div></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Repeat every (hours, 0 = never)</label><input class="input" type="number" min="0" value=${c.repeat_hours} onInput=${e => set('repeat_hours', e.target.value)}/></div>
      <div class="form-group"><label class="form-label">Runner _work limit (GB)</label><input class="input" type="number" value=${c.runner_work_limit_gb} onInput=${e => set('runner_work_limit_gb', e.target.value)}/></div>
      <div class="form-group"><label class="form-label">Docker disk limit (GB)</label><input class="input" type="number" value=${c.docker_disk_limit_gb} onInput=${e => set('docker_disk_limit_gb', e.target.value)}/></div>
    </div>
    <div class="form-group"><label class="form-label">LabCTL address used in notice links (start with the scheme)</label><input class="input" placeholder="labctl.example.test" value=${c.base_url} onInput=${e => set('base_url', e.target.value)}/></div>
    <div class="form-group"><label class="form-label">Default channels</label>
      ${channels.map(ch => html`<label key=${ch.id} class="checkbox-row"><input type="checkbox" checked=${c.default_channels.includes(ch.id)}
        onChange=${() => set('default_channels', c.default_channels.includes(ch.id) ? c.default_channels.filter(x => x !== ch.id) : [...c.default_channels, ch.id])}/> ${ch.name}</label>`)}</div>
    <button class="btn btn-primary" onClick=${save}>Save settings</button>
  </div>`;
}

function Rules({ hosts, canWrite, isAdmin, addToast }) {
  const [rules, setRules] = useState([]);
  const [meta, setMeta] = useState(null);
  const [channels, setChannels] = useState([]);
  const [edit, setEdit] = useState(null);
  const load = () => api('/api/alert-rules').then(setRules).catch(e => addToast(e.message, 'error'));
  useEffect(() => {
    load();
    api('/api/alert-metrics').then(setMeta).catch(() => {});
    api('/api/channels').then(setChannels).catch(() => {});
  }, []);
  const toggle = async r => { await api(`/api/alert-rules/${r.id}/${r.enabled ? 'disable' : 'enable'}`, { method: 'POST' }).catch(e => addToast(e.message, 'error')); load(); };
  const remove = async r => { await api(`/api/alert-rules/${r.id}`, { method: 'DELETE' }).catch(e => addToast(e.message, 'error')); addToast('Rule deleted'); load(); };
  const scopeText = s => (s.type === 'all' ? 'All hosts' : s.type === 'hosts' ? `${(s.ids || []).length} host(s)` : `${s.type}: ${s.value}`);
  return html`<div>
    ${canWrite && meta && html`<div style=${{ marginBottom: 12 }}><button class="btn btn-primary" onClick=${() => setEdit(NEW_RULE)}>+ New rule</button></div>`}
    <div class="table-wrap"><table>
      <thead><tr><th>Enabled</th><th>Name</th><th>Severity</th><th>Condition</th><th>Scope</th>${canWrite && html`<th>Actions</th>`}</tr></thead>
      <tbody>${rules.map(r => html`<tr key=${r.id}>
        <td><div class=${`toggle ${r.enabled ? 'active' : ''}`} onClick=${() => canWrite && toggle(r)}/></td>
        <td style=${{ fontWeight: 600 }}>${r.name}${r.silenced_until && html` <span class="badge badge-waiting">silenced</span>`}</td>
        <td><${Sev} s=${r.severity}/></td>
        <td><code style=${{ fontSize: 12 }}>${r.condition.metric} ${r.condition.op} ${r.params?.threshold_setting ? `(${r.params.threshold_setting})` : r.condition.threshold}${r.condition.for_minutes ? ` for ${r.condition.for_minutes} min` : ''}</code></td>
        <td>${scopeText(r.scope)}</td>
        ${canWrite && html`<td><div class="btn-group">
          <button class="btn btn-sm" onClick=${() => setEdit(r)}>Edit</button>
          <button class="btn btn-sm" onClick=${() => api(`/api/alert-rules/${r.id}/silence`, { method: 'POST', body: { minutes: r.silenced_until ? 0 : 240 } }).then(load)}>${r.silenced_until ? 'Unsilence' : 'Silence 4 h'}</button>
          <button class="btn btn-sm btn-danger" onClick=${() => remove(r)}>Delete</button></div></td>`}
      </tr>`)}</tbody></table></div>
    ${isAdmin && html`<${Settings} channels=${channels} addToast=${addToast}/>`}
    ${edit && meta && html`<${RuleEditor} initial=${edit} meta=${meta} hosts=${hosts || []} channels=${channels} addToast=${addToast}
      onClose=${() => setEdit(null)} onSaved=${() => { setEdit(null); load(); }}/>`}
  </div>`;
}

export default function AlertsPage({ hosts, addToast, currentUser }) {
  const [tab, setTab] = useState('active');
  const role = currentUser?.role;
  const canWrite = role === 'admin' || role === 'operator';
  return html`<div>
    <div class="page-header"><div><div class="page-title">Alerts</div><div class="page-desc">Active alerts, history and alert rules</div></div></div>
    <div class="tabs">${TABS.map(([id, label]) => html`<div key=${id} class=${`tab ${tab === id ? 'active' : ''}`} onClick=${() => setTab(id)}>${label}</div>`)}</div>
    ${tab === 'rules' ? html`<${Rules} hosts=${hosts} canWrite=${canWrite} isAdmin=${role === 'admin'} addToast=${addToast}/>`
      : html`<${AlertList} state=${tab} canWrite=${canWrite} addToast=${addToast}/>`}
  </div>`;
}
