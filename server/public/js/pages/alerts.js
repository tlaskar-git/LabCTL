import { useState, useEffect } from 'preact/hooks';
import { api, subscribe } from '../api.js';
import { html, Icons, Modal } from '../ui.js';
import { Chip, EmptyState, KitIcons, SectionHeader, Segmented, Skeleton, absTime, relTime, hostName, nameFor } from '../components/ui-kit.js';

const TABS = [['active', 'Active'], ['ack', 'Acknowledged'], ['silenced', 'Silenced'], ['resolved', 'Resolved'], ['rules', 'Rules']];
const SEV = { critical: 'bad', warning: 'warn', info: 'info' };
const NEW_RULE = { name: '', severity: 'warning', enabled: true, scope: { type: 'all' }, channels: [], params: {},
  condition: { metric: 'disk_pct', op: '>=', threshold: 90, for_minutes: 10 } };

const Sev = ({ s }) => html`<${Chip} tone=${SEV[s] || 'muted'} dot>${s}<//>`;

function AlertList({ state, canWrite, addToast, onRules, hosts }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { setRows(null); return subscribe(`alerts?state=${state}&limit=200`, d => setRows(d.rows)); }, [state]);
  const act = async (id, path, body, msg) => {
    try { await api(`/api/alerts/${id}/${path}`, { method: 'POST', body }); addToast(msg); } catch (e) { addToast(e.message, 'error'); }
  };
  if (!rows) return html`<${Skeleton} rows=${3}/>`;
  if (!rows.length) {
    const word = { active: 'active', ack: 'acknowledged', silenced: 'silenced', resolved: 'resolved' }[state];
    return html`<${EmptyState} icon="Check" title=${`No ${word} alerts`}
      text=${state === 'active' ? 'Rules watch every host all the time. A new alert shows here and goes to your channels.' : null}
      action=${state === 'active' && html`<button class="btn" onClick=${onRules}>View the rules</button>`}/>`;
  }
  const open = canWrite && state !== 'resolved';
  return html`<div class="rows">${rows.map(a => html`<div class="row" key=${a.id}>
    <${Sev} s=${a.severity}/>
    <div class="row-main">
      <div class="row-title">${a.rule_name}${a.hostname || a.host_id ? html` <span class="muted" style=${{ fontWeight: 500 }}>on ${nameFor(hosts, a.host_id, a.hostname)}</span>` : null}</div>
      <div class="row-sub wrap">${a.message}</div>
      <div class="chip-row" style=${{ marginTop: 4 }}>
        ${a.suppressed && html`<${Chip} tone="info">maintenance<//>`}
        ${a.acked_by && html`<${Chip}>Acknowledged by ${a.acked_by}<//>`}
        ${a.silenced_until && html`<${Chip} tone="warn" title=${absTime(a.silenced_until)}>Silenced ${relTime(a.silenced_until).replace(/^in /, 'for ')}<//>`}
        ${a.notify_count > 0 && html`<${Chip}>${a.notify_count} ${a.notify_count === 1 ? 'notice' : 'notices'}<//>`}
      </div>
    </div>
    <span class="row-meta" title=${absTime(state === 'resolved' ? a.resolved_at : a.fired_at || a.created_at)}>
      ${relTime(state === 'resolved' ? a.resolved_at : a.fired_at || a.created_at)}</span>
    ${open && html`<div class="row-actions">
      ${!a.acked_at && html`<button class="btn btn-sm" onClick=${() => act(a.id, 'ack', {}, 'Acknowledged')}><${KitIcons.Check}/> Acknowledge</button>`}
      ${a.silenced_until
        ? html`<button class="btn btn-sm" onClick=${() => act(a.id, 'silence', { minutes: 0 }, 'Silence cleared')}>Unsilence</button>`
        : html`<select class="select silence-select" aria-label=${`Silence ${a.rule_name}`} value=""
            onChange=${e => { const m = Number(e.target.value); if (m) act(a.id, 'silence', { minutes: m }, `Silenced for ${m / 60} h`); }}>
            <option value="">Silence</option><option value="60">for 1 h</option><option value="240">for 4 h</option><option value="1440">for 24 h</option>
          </select>`}
    </div>`}
  </div>`)}</div>`;
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
        <input type="checkbox" checked=${(scope.ids || []).includes(h.id)} onChange=${() => set('scope', { ...scope, ids: toggle(scope.ids || [], h.id) })}/> ${hostName(h)}</label>`)}</div>`}
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
  return html`<details class="disclose card" style=${{ marginTop: 16 }}>
    <summary><${KitIcons.Chevron}/>Alert settings</summary>
    <div class="form-row" style=${{ marginTop: 12, flexWrap: 'wrap' }}>
      <div class="form-group" style=${{ minWidth: 180 }}><label class="form-label" for="al-rep">Repeat every (hours, 0 = never)</label><input id="al-rep" class="input" type="number" min="0" value=${c.repeat_hours} onInput=${e => set('repeat_hours', e.target.value)}/></div>
      <div class="form-group" style=${{ minWidth: 180 }}><label class="form-label" for="al-run">Runner _work limit (GB)</label><input id="al-run" class="input" type="number" value=${c.runner_work_limit_gb} onInput=${e => set('runner_work_limit_gb', e.target.value)}/></div>
      <div class="form-group" style=${{ minWidth: 180 }}><label class="form-label" for="al-dock">Docker disk limit (GB)</label><input id="al-dock" class="input" type="number" value=${c.docker_disk_limit_gb} onInput=${e => set('docker_disk_limit_gb', e.target.value)}/></div>
    </div>
    <div class="form-group" style=${{ marginBottom: 12 }}><label class="form-label" for="al-base">LabCTL address used in notice links (start with the scheme)</label><input id="al-base" class="input" placeholder="labctl.example.test" value=${c.base_url} onInput=${e => set('base_url', e.target.value)}/></div>
    <div class="form-group" style=${{ marginBottom: 12 }}><div class="form-label">Default channels</div>
      <div class="chip-row">${channels.map(ch => html`<label key=${ch.id} class="checkbox-row"><input type="checkbox" checked=${c.default_channels.includes(ch.id)}
        onChange=${() => set('default_channels', c.default_channels.includes(ch.id) ? c.default_channels.filter(x => x !== ch.id) : [...c.default_channels, ch.id])}/> ${ch.name}</label>`)}</div></div>
    <button class="btn btn-primary" onClick=${save}>Save settings</button>
  </details>`;
}

function Rules({ hosts, canWrite, isAdmin, addToast }) {
  const [rules, setRules] = useState(null);
  const [meta, setMeta] = useState(null);
  const [channels, setChannels] = useState([]);
  const [edit, setEdit] = useState(null);
  const load = () => api('/api/alert-rules').then(setRules).catch(e => { setRules(r => r || []); addToast(e.message, 'error'); });
  useEffect(() => {
    load();
    api('/api/alert-metrics').then(setMeta).catch(() => {});
    api('/api/channels').then(setChannels).catch(() => {});
  }, []);
  const toggle = async r => { await api(`/api/alert-rules/${r.id}/${r.enabled ? 'disable' : 'enable'}`, { method: 'POST' }).catch(e => addToast(e.message, 'error')); load(); };
  const remove = async r => {
    if (!window.confirm(`Delete the rule ${r.name}?`)) return;
    await api(`/api/alert-rules/${r.id}`, { method: 'DELETE' }).then(() => addToast('Rule deleted'), e => addToast(e.message, 'error')); load();
  };
  const scopeText = s => (s.type === 'all' ? 'All hosts' : s.type === 'hosts' ? `${(s.ids || []).length} host(s)` : `${s.type}: ${s.value}`);
  const cond = r => `${r.condition.metric} ${r.condition.op} ${r.params?.threshold_setting ? `(${r.params.threshold_setting})` : r.condition.threshold}${r.condition.for_minutes ? ` for ${r.condition.for_minutes} min` : ''}`;
  return html`<div>
    <${SectionHeader} title="Rules" count=${rules ? rules.length : null}
      right=${canWrite && meta && html`<button class="btn btn-primary" onClick=${() => setEdit(NEW_RULE)}><${KitIcons.Plus}/> New rule</button>`}/>
    ${!rules ? html`<${Skeleton} rows=${3}/>` : !rules.length ? html`<${EmptyState} icon="Eye" title="No rules yet" text="A rule raises an alert when a metric crosses a threshold."/>`
      : html`<div class="rows">${rules.map(r => html`<div class="row" key=${r.id}>
        <button type="button" role="switch" aria-checked=${r.enabled ? 'true' : 'false'} aria-label=${`Rule ${r.name} enabled`} disabled=${!canWrite}
          class=${`toggle ${r.enabled ? 'active' : ''}`} style=${{ border: 0 }} onClick=${() => toggle(r)}/>
        <div class="row-main">
          <div class="row-title">${r.name}${r.silenced_until ? html` <${Chip} tone="warn">silenced<//>` : null}</div>
          <div class="row-sub"><code>${cond(r)}</code> · ${scopeText(r.scope)}</div>
        </div>
        <${Sev} s=${r.severity}/>
        ${canWrite && html`<div class="row-actions">
          <button class="btn btn-sm" onClick=${() => setEdit(r)}>Edit</button>
          <button class="btn btn-sm" onClick=${() => api(`/api/alert-rules/${r.id}/silence`, { method: 'POST', body: { minutes: r.silenced_until ? 0 : 240 } }).then(load, e => addToast(e.message, 'error'))}>${r.silenced_until ? 'Unsilence' : 'Silence 4 h'}</button>
          <button class="btn btn-sm btn-icon" aria-label=${`Delete ${r.name}`} title="Delete" onClick=${() => remove(r)}><${Icons.Trash}/></button></div>`}
      </div>`)}</div>`}
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
    <div class="page-header"><div><div class="page-title">Alerts</div><div class="page-desc">What needs a look now, and the rules behind it.</div></div></div>
    <div style=${{ marginBottom: 16 }}><${Segmented} label="Alert view" value=${tab} onChange=${setTab} options=${TABS}/></div>
    ${tab === 'rules' ? html`<${Rules} hosts=${hosts} canWrite=${canWrite} isAdmin=${role === 'admin'} addToast=${addToast}/>`
      : html`<${AlertList} state=${tab} canWrite=${canWrite} addToast=${addToast} hosts=${hosts} onRules=${() => setTab('rules')}/>`}
  </div>`;
}
