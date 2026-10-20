import { api } from '../api.js';
import { html } from '../ui.js';
import { openJobDrawer } from '../job-drawer.js';

// Shared by the templates page and the command palette: parameter fields, target selection, typed confirmation, launch.

export const compatible = (tpl, host) => !host.os || tpl.os.includes(host.os);

export const defaultsOf = tpl => Object.fromEntries(tpl.params.map(p => [p.name, p.default]));

// target: { type: 'hosts', ids: [] } | { type: 'group', value } | { type: 'tag', value }. Returns the hosts it covers.
export function targetHosts(hosts, target) {
  if (!target) return [];
  if (target.type === 'hosts') return hosts.filter(h => target.ids.includes(h.id));
  const key = target.type === 'group' ? 'groups' : 'tags';
  return hosts.filter(h => (h[key] || []).some(x => x.id === target.value || String(x.name).toLowerCase() === String(target.value).toLowerCase()));
}

// What the server expects in body.confirm: the host name for one host, else the template id (see src/guards.js).
export function confirmWord(tpl, hosts) {
  const usable = hosts.filter(h => compatible(tpl, h));
  return usable.length === 1 ? (usable[0].hostname || usable[0].id) : tpl.id;
}

export const needsConfirm = (tpl, force) => !!(tpl.guard || force);

// Request body for POST /api/templates/:id/run. Only values that differ from the default are sent.
export function runBody(tpl, target, values, { drain, force, confirm, secrets } = {}) {
  const params = {};
  for (const p of tpl.params) if (values[p.name] !== undefined && values[p.name] !== p.default && values[p.name] !== '') params[p.name] = values[p.name];
  const body = { params };
  if (target.type === 'hosts') body.host_ids = target.ids; else body[target.type] = target.value;
  if (tpl.drain && drain) body.drain = true;
  if (tpl.drain && force) body.force = true;
  if (secrets && Object.keys(secrets).length) body.secrets = secrets;
  if (confirm) body.confirm = confirm;
  return body;
}

// Starts the run, opens the job drawer on the first job. Returns the API reply.
export async function launch(tpl, target, values, opts) {
  const res = await api(`/api/templates/${tpl.id}/run`, { method: 'POST', body: runBody(tpl, target, values, opts) });
  if (res.jobs && res.jobs.length) openJobDrawer(res.jobs[0].job_id);
  return res;
}

// One input per manifest parameter. compact puts them in a tight row for the palette.
export function ParamFields({ tpl, values, onChange, compact = false }) {
  const set = (name, v) => onChange({ ...values, [name]: v });
  return html`<div style=${{ display: 'grid', gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
    ${tpl.params.map(p => {
      const id = `param-${tpl.id}-${p.name}`;
      const v = values[p.name] ?? p.default;
      if (p.type === 'bool') {
        return html`<label key=${p.name} class="checkbox-row" for=${id}>
          <input id=${id} type="checkbox" class="checkbox" checked=${!!v} onChange=${e => set(p.name, e.target.checked)}/> ${p.label}
        </label>`;
      }
      return html`<div key=${p.name} class="form-group" style=${{ marginBottom: 0 }}>
        <label class="form-label" for=${id}>${p.label}</label>
        ${p.type === 'enum'
          ? html`<select id=${id} class="select input" value=${v} onChange=${e => set(p.name, e.target.value)}>${p.options.map(o => html`<option key=${o} value=${o}>${o}</option>`)}</select>`
          : p.type === 'int'
            ? html`<input id=${id} class="input" type="number" min="0" value=${v} onInput=${e => set(p.name, e.target.value === '' ? '' : Number(e.target.value))}/>`
            : html`<input id=${id} class="input" value=${v} onInput=${e => set(p.name, e.target.value)}/>`}
      </div>`;
    })}
  </div>`;
}
