import { useState } from 'preact/hooks';
import { html } from '../ui.js';

export const EMPTY_FILTERS = { q: '', os: '', status: '', group: '', tag: '', kind: '', outdated_agent: '' };

const Funnel = () => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18l-7 8.5V19l-4 2v-7.5z"/></svg>`;

// Slim toolbar: search, a Filters button that opens the selects (OS, status, kind, group, tag, outdated agent),
// and `children` on the right (view toggle and the like). options: { os: [], groups: [], tags: [] }.
export function HostFilters({ filters, onChange, options, children }) {
  const set = (key, value) => onChange({ ...filters, [key]: value });
  const count = Object.entries(filters).filter(([k, v]) => k !== 'q' && v).length;
  const [open, setOpen] = useState(count > 0);
  const select = (key, label, items) => html`<select class="select" aria-label=${label}
    value=${filters[key]} onChange=${e => set(key, e.target.value)}>
    <option value="">${label}</option>
    ${items.map(i => html`<option key=${i.value} value=${i.value}>${i.label}</option>`)}
  </select>`;
  const plain = list => list.map(v => ({ value: v, label: v }));
  const active = Object.values(filters).some(Boolean);
  return html`<div class="host-toolbar-wrap">
    <div class="host-toolbar">
      <input class="input host-search" type="search" placeholder="Search name, hostname, IP, tag, notes" aria-label="Search hosts"
        value=${filters.q} onInput=${e => set('q', e.target.value)}/>
      <button class=${`btn ${open ? 'is-on' : ''}`} aria-expanded=${open} aria-controls="host-filter-row" onClick=${() => setOpen(!open)}>
        <${Funnel}/> Filters${count ? html` <span class="count-pill">${count}</span>` : ''}
      </button>
      ${active && html`<button class="btn btn-sm" onClick=${() => onChange(EMPTY_FILTERS)}>Clear</button>`}
      <div class="host-toolbar-right">${children}</div>
    </div>
    ${open && html`<div class="host-filter-row" id="host-filter-row">
      ${select('os', 'All OS', plain(options.os))}
      ${select('status', 'Any status', plain(['online', 'offline']))}
      ${select('kind', 'Any kind', plain(['agent', 'ssh', 'vps', 'proxmox', 'runner']))}
      ${select('group', 'All groups', options.groups.map(g => ({ value: g.id, label: g.name })))}
      ${select('tag', 'All tags', options.tags.map(t => ({ value: t.id, label: t.name })))}
      <label class="checkbox-row" style=${{ fontSize: 13 }}>
        <input type="checkbox" checked=${filters.outdated_agent === 'true'} onChange=${e => set('outdated_agent', e.target.checked ? 'true' : '')}/>
        Outdated agent
      </label>
    </div>`}
  </div>`;
}
