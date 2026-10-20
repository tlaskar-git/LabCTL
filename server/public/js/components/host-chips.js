import { html } from '../ui.js';

// Small coloured label for a tag or group. item is { name, color }.
export function Chip({ item, onRemove }) {
  const color = item.color || 'var(--text-dim)';
  return html`<span style=${{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', marginRight: 4,
    borderRadius: 10, fontSize: 11, border: `1px solid ${color}`, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
    <span style=${{ width: 6, height: 6, borderRadius: '50%', background: color }}/>${item.name}
    ${onRemove && html`<span style=${{ cursor: 'pointer', marginLeft: 2 }} onClick=${onRemove} title="Remove">x</span>`}
  </span>`;
}

export function Chips({ items = [] }) {
  return items.map(i => html`<${Chip} key=${i.id} item=${i}/>`);
}
