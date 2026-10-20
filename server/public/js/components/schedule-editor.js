import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons } from '../ui.js';
import { KitIcons, hostName } from './ui-kit.js';
import { CronField } from './schedule-cron.js';

// The schedule editor drawer. kind decides the sections:
//   templates      name, description, schedule, hosts (scope), template steps with their parameters
//   health_report  name, description, schedule, channels and report sections
//   patching       name, description, schedule, ring policy settings (update type, reboot, drain, policy names)
//   host           name and schedule only (the per-host schedules under "Your schedules")
// onSave(body) returns a promise; a rejection shows its message in the drawer.
const OS = [['linux', 'Linux'], ['darwin', 'macOS'], ['windows', 'Windows']];
const KINDS = [['agent', 'Agent'], ['ssh', 'SSH'], ['vps', 'VPS'], ['proxmox', 'Proxmox'], ['runner', 'Runner']];
const RINGS = [[0, 'Ring 0 (tag ring0)'], [1, 'Ring 1 (tag ring1)'], [2, 'Ring 2 (tag ring2)']];
const SECTIONS = ['Fleet', 'Compliance', 'Alerts', 'Jobs'];
const UPDATE_TYPES = [['security', 'Security updates'], ['all', 'All updates'], ['os-only', 'Operating system only'], ['apps-only', 'Applications only']];
const REBOOT = [['if_required', 'When an update needs it'], ['always', 'Always'], ['never', 'Never']];

function Checks({ legend, options, value = [], onChange, hint }) {
  const toggle = v => onChange(value.includes(v) ? value.filter(x => x !== v) : [...value, v]);
  return html`<fieldset class="sched-checks">
    <legend class="form-label">${legend}</legend>
    ${hint && html`<div class="hint">${hint}</div>`}
    <div class="sched-check-list">
      ${options.length ? options.map(([v, l]) => html`<label key=${v} class="sched-check">
        <input type="checkbox" checked=${value.includes(v)} onChange=${() => toggle(v)}/> ${l}</label>`)
        : html`<span class="hint">None defined</span>`}
    </div>
  </fieldset>`;
}

function ParamInput({ p, value, onChange, id }) {
  const v = value ?? p.default ?? '';
  const label = p.label || p.name;
  if (p.type === 'bool') {
    return html`<label class="sched-check"><input type="checkbox" checked=${v === true || v === 'true' || v === 1}
      onChange=${e => onChange(e.target.checked)}/> ${label}</label>`;
  }
  return html`<div class="form-group">
    <label class="form-label" for=${id}>${label}</label>
    ${p.type === 'enum'
      ? html`<select id=${id} class="select input" value=${v} onChange=${e => onChange(e.target.value)}>
          ${(p.options || []).map(o => html`<option key=${o} value=${o}>${o}</option>`)}</select>`
      : html`<input id=${id} class="input" type=${p.type === 'int' ? 'number' : 'text'} value=${v}
          onInput=${e => onChange(p.type === 'int' && e.target.value !== '' ? Number(e.target.value) : e.target.value)}/>`}
  </div>`;
}

function Steps({ steps, onChange, templates }) {
  const byId = new Map(templates.map(t => [t.id, t]));
  const set = (i, change) => onChange(steps.map((s, n) => (n === i ? { ...s, ...change } : s)));
  return html`<div class="sched-steps">
    ${steps.map((s, i) => {
      const tpl = byId.get(s.template);
      return html`<div class="sched-step" key=${i}>
        <div class="sched-step-head">
          <div class="form-group">
            <label class="form-label" for=${`step-${i}`}>Step ${i + 1}: template</label>
            <select id=${`step-${i}`} class="select input" value=${s.template} onChange=${e => set(i, { template: e.target.value, params: {} })}>
              ${!tpl && html`<option value=${s.template}>${s.template || 'Choose a template'}${s.template ? ' (removed)' : ''}</option>`}
              ${templates.map(t => html`<option key=${t.id} value=${t.id}>${t.name}${t.guard ? ' (guarded)' : ''}</option>`)}
            </select>
          </div>
          <button type="button" class="btn btn-sm btn-icon" aria-label=${`Remove step ${i + 1}`} title="Remove step" disabled=${steps.length < 2}
            onClick=${() => onChange(steps.filter((_, n) => n !== i))}><${Icons.Trash}/></button>
        </div>
        ${!tpl && s.template && html`<div class="sched-error" role="alert">Template ${s.template} was removed. Choose another one.</div>`}
        ${tpl && tpl.params?.length > 0 && html`<div class="sched-params">
          ${tpl.params.map(p => html`<${ParamInput} key=${p.name} p=${p} id=${`step-${i}-${p.name}`} value=${s.params?.[p.name]}
            onChange=${v => set(i, { params: { ...s.params, [p.name]: v } })}/>`)}
        </div>`}
      </div>`;
    })}
    <button type="button" class="btn btn-sm" disabled=${steps.length >= 10} onClick=${() => onChange([...steps, { template: templates[0]?.id || '', params: {} }])}>
      <${KitIcons.Plus}/> Add step</button>
  </div>`;
}

function Scope({ scope, onChange, hosts, groups, tags }) {
  const sc = scope || {};
  const set = (k, v) => { const next = { ...sc, [k]: v }; if (Array.isArray(v) && !v.length) delete next[k]; onChange(next); };
  return html`<div>
    <label class="sched-check"><input type="checkbox" checked=${!!sc.all} onChange=${e => set('all', e.target.checked || undefined)}/> All hosts</label>
    ${!sc.all && html`<div class="hint">A host is chosen when it matches any of the choices below.</div>
      <label class="sched-check"><input type="checkbox" checked=${!!sc.runners} onChange=${e => set('runners', e.target.checked || undefined)}/>
        Hosts with a runner (tag runner, kind runner, or a runner in the inventory)</label>
      <${Checks} legend="Operating system" options=${OS} value=${sc.os} onChange=${v => set('os', v)}/>
      <${Checks} legend="Ring tag" options=${RINGS} value=${sc.rings} onChange=${v => set('rings', v)}/>
      <${Checks} legend="Host kind" options=${KINDS} value=${sc.kinds} onChange=${v => set('kinds', v)}/>
      <${Checks} legend="Groups" options=${groups.map(g => [g.id, g.name])} value=${sc.groups} onChange=${v => set('groups', v)}/>
      <${Checks} legend="Tags" options=${tags.map(t => [t.name, t.name])} value=${sc.tags} onChange=${v => set('tags', v)}/>
      <${Checks} legend="Specific hosts" options=${(hosts || []).map(h => [h.id, hostName(h)])} value=${sc.hosts} onChange=${v => set('hosts', v)}/>`}
  </div>`;
}

function Patch({ patch, onChange }) {
  const p = patch || {};
  const set = change => onChange({ ...p, ...change });
  const names = p.names || ['', '', ''];
  return html`<div>
    <div class="sched-grid">
      <div class="form-group"><label class="form-label" for="patch-type">Update type</label>
        <select id="patch-type" class="select input" value=${p.update_type} onChange=${e => set({ update_type: e.target.value })}>
          ${UPDATE_TYPES.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}</select></div>
      <div class="form-group"><label class="form-label" for="patch-reboot">Reboot</label>
        <select id="patch-reboot" class="select input" value=${p.reboot?.mode} onChange=${e => set({ reboot: { ...p.reboot, mode: e.target.value } })}>
          ${REBOOT.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}</select></div>
      <div class="form-group"><label class="form-label" for="patch-delay">Reboot delay (minutes)</label>
        <input id="patch-delay" class="input" type="number" min="0" max="1440" value=${p.reboot?.delay_min ?? 1}
          onInput=${e => set({ reboot: { ...p.reboot, delay_min: Number(e.target.value) } })}/></div>
    </div>
    <label class="sched-check"><input type="checkbox" checked=${!!p.drain?.enabled} onChange=${e => set({ drain: { enabled: e.target.checked } })}/>
      Drain runner builds first</label>
    <div class="sched-grid">
      ${[0, 1, 2].map(n => html`<div class="form-group" key=${n}><label class="form-label" for=${`patch-name-${n}`}>Ring ${n} policy name</label>
        <input id=${`patch-name-${n}`} class="input" value=${names[n]} onInput=${e => set({ names: names.map((x, i) => (i === n ? e.target.value : x)) })}/></div>`)}
    </div>
    <div class="hint">These settings change the three ring policies this schedule created. A failed ring still stops the next.</div>
  </div>`;
}

export function ScheduleEditor({ title, kind, entry, hosts, onSave, onClose, onReset }) {
  const [f, setF] = useState(() => ({ name: entry?.name || '', description: entry?.description || '', cron: entry?.cron || '0 2 * * *',
    steps: entry?.steps?.length ? entry.steps : [{ template: '', params: {} }], scope: entry?.scope || { all: true },
    health: entry?.health || { channels: [], sections: SECTIONS }, patch: entry?.patch }));
  const [lists, setLists] = useState({ templates: [], groups: [], tags: [], channels: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const box = useRef(null);
  const set = change => setF(x => ({ ...x, ...change }));

  useEffect(() => {
    box.current?.querySelector('input, select, textarea')?.focus();
    const get = (path, k) => api(path).then(v => setLists(l => ({ ...l, [k]: v })), () => {});
    if (kind === 'templates') {
      get('/api/templates', 'templates').then(() => setLists(l => ({ ...l, templates: l.templates.filter(t => !t.hidden).sort((a, b) => a.name.localeCompare(b.name)) })));
      get('/api/groups', 'groups');
      get('/api/tags', 'tags');
    }
    if (kind === 'health_report') get('/api/channels', 'channels');
  }, []);
  useEffect(() => { // the first step of a new entry takes the first template once the list arrives
    if (kind === 'templates' && lists.templates.length && f.steps.length === 1 && !f.steps[0].template) set({ steps: [{ template: lists.templates[0].id, params: {} }] });
  }, [lists.templates]);

  const save = async () => {
    const body = { name: f.name, cron: f.cron };
    if (kind !== 'host') body.description = f.description;
    if (kind === 'templates') Object.assign(body, { steps: f.steps, scope: f.scope });
    if (kind === 'health_report') body.health = f.health;
    if (kind === 'patching') body.patch = f.patch;
    setBusy(true); setError('');
    try { await onSave(body); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const guarded = kind === 'templates' && f.steps.some(s => lists.templates.find(t => t.id === s.template)?.guard);

  return html`<div class="drawer-overlay" onClick=${onClose}>
    <div class="drawer sched-drawer" role="dialog" aria-modal="true" aria-labelledby="sched-ed-title" ref=${box}
      onClick=${e => e.stopPropagation()} onKeyDown=${e => e.key === 'Escape' && onClose()}>
      <div class="sched-drawer-head">
        <h2 id="sched-ed-title" class="modal-title">${title}</h2>
        <button type="button" class="btn-close" aria-label="Close" onClick=${onClose}><${Icons.X}/></button>
      </div>

      <section class="sched-sec" aria-labelledby="sec-basics">
        <h3 id="sec-basics">Basics</h3>
        <div class="form-group"><label class="form-label" for="sched-name">Name</label>
          <input id="sched-name" class="input" maxlength="120" value=${f.name} onInput=${e => set({ name: e.target.value })}/></div>
        ${kind !== 'host' && html`<div class="form-group"><label class="form-label" for="sched-desc">Description</label>
          <textarea id="sched-desc" class="textarea" rows="2" maxlength="500" value=${f.description} onInput=${e => set({ description: e.target.value })}/></div>`}
      </section>

      <section class="sched-sec" aria-labelledby="sec-when">
        <h3 id="sec-when">Schedule</h3>
        <${CronField} value=${f.cron} onChange=${cron => set({ cron })}/>
        ${kind === 'patching' && html`<div class="hint">Ring 0 runs at this time. Ring 1 and Ring 2 follow on the next days when one weekday is set.</div>`}
      </section>

      ${kind === 'templates' && html`<section class="sched-sec" aria-labelledby="sec-hosts">
        <h3 id="sec-hosts">Hosts</h3>
        <${Scope} scope=${f.scope} onChange=${scope => set({ scope })} hosts=${hosts} groups=${lists.groups} tags=${lists.tags}/>
      </section>
      <section class="sched-sec" aria-labelledby="sec-steps">
        <h3 id="sec-steps">Templates to run</h3>
        <div class="hint">Each step runs on the chosen hosts whose operating system the template supports. Hosts in a maintenance window are skipped.</div>
        <${Steps} steps=${f.steps} templates=${lists.templates} onChange=${steps => set({ steps })}/>
        ${guarded && html`<div class="hint sched-warn">A guarded template is chosen: switching this schedule on needs its name typed.</div>`}
      </section>`}

      ${kind === 'health_report' && html`<section class="sched-sec" aria-labelledby="sec-report">
        <h3 id="sec-report">Report</h3>
        <${Checks} legend="Channels" options=${lists.channels.map(c => [c.id, c.name])} value=${f.health.channels}
          hint="None chosen: the health_report_channels setting, else the default alert channels."
          onChange=${channels => set({ health: { ...f.health, channels } })}/>
        <${Checks} legend="Sections" options=${SECTIONS.map(s => [s, s])} value=${f.health.sections}
          onChange=${sections => set({ health: { ...f.health, sections } })}/>
      </section>`}

      ${kind === 'patching' && html`<section class="sched-sec" aria-labelledby="sec-patch">
        <h3 id="sec-patch">Ring policies</h3>
        <${Patch} patch=${f.patch} onChange=${patch => set({ patch })}/>
      </section>`}

      ${error && html`<div class="sched-error" role="alert">${error}</div>`}
      <div class="btn-group sched-foot">
        <button type="button" class="btn btn-primary" disabled=${busy || !f.name.trim()} onClick=${save}>${busy ? 'Saving' : 'Save'}</button>
        <button type="button" class="btn" onClick=${onClose}>Cancel</button>
        ${onReset && html`<button type="button" class="btn sched-reset" onClick=${onReset}>Reset to defaults</button>`}
      </div>
    </div>
  </div>`;
}
