import { html } from '../ui.js';

export const EMPTY_FILTERS = { q: '', os: '', status: '', group: '', tag: '', kind: '', outdated_agent: '' };

// Search box and filters (OS, status, group, tag, kind, outdated agent). options: { os: [], groups: [], tags: [] }.
export function HostFilters({ filters, onChange, options }) {
  const set = (key, value) => onChange({ ...filters, [key]: value });
  const select = (key, label, items) => html`<select class="select" style=${{ maxWidth: 150 }} aria-label=${label}
    value=${filters[key]} onChange=${e => set(key, e.target.value)}>
    <option value="">${label}</option>
    ${items.map(i => html`<option key=${i.value} value=${i.value}>${i.label}</option>`)}
  </select>`;
  const plain = list => list.map(v => ({ value: v, label: v }));
  const active = Object.values(filters).some(Boolean);
  return html`<div style=${{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
    <input class="input" style=${{ maxWidth: 260 }} placeholder="Search name, IP, tag, notes" aria-label="Search hosts"
      value=${filters.q} onInput=${e => set('q', e.target.value)}/>
    ${select('os', 'All OS', plain(options.os))}
    ${select('status', 'Any status', plain(['online', 'offline']))}
    ${select('kind', 'Any kind', plain(['agent', 'ssh', 'vps', 'proxmox', 'runner']))}
    ${select('group', 'All groups', options.groups.map(g => ({ value: g.id, label: g.name })))}
    ${select('tag', 'All tags', options.tags.map(t => ({ value: t.id, label: t.name })))}
    <label class="checkbox-row" style=${{ fontSize: 12 }}>
      <input type="checkbox" checked=${filters.outdated_agent === 'true'} onChange=${e => set('outdated_agent', e.target.checked ? 'true' : '')}/>
      Outdated agent
    </label>
    ${active && html`<button class="btn btn-sm" onClick=${() => onChange(EMPTY_FILTERS)}>Clear</button>`}
  </div>`;
}
