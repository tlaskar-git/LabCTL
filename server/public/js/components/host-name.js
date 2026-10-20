import { useState, useRef } from 'preact/hooks';
import { api } from '../api.js';
import { html } from '../ui.js';
export { OsIcon, iconOf } from './os-icon.js';

// The name every screen shows: the operator's display name, else the real hostname. The API sends it as `name`.
// The real hostname (h.hostname) stays the key for matching, deploys and typed confirmations.
export const hostName = h => (h ? h.name || h.display_name || h.hostname || h.host_id || h.id || '' : '');

export const Pencil = () => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;

// Inline rename: Enter saves, Escape cancels, an empty value goes back to the real hostname.
export function RenameField({ host, onDone, addToast, size }) {
  const [v, setV] = useState(host.display_name || host.hostname || '');
  const busy = useRef(false); // a ref: the blur handler must see a save in flight
  const save = async () => {
    const value = v.trim();
    if (value === (host.display_name || host.hostname || '')) return onDone(false);
    busy.current = true;
    try {
      await api(`/api/hosts/${encodeURIComponent(host.id)}`, { method: 'PATCH', body: { display_name: value === host.hostname ? null : value } });
      addToast?.(value && value !== host.hostname ? `Shown as ${value}` : 'Display name cleared');
      onDone(true);
    } catch (e) { addToast?.(e.message, 'error'); busy.current = false; }
  };
  return html`<span class="rename-field" onClick=${e => e.stopPropagation()}>
    <input class="input" style=${size ? { fontSize: size } : null} value=${v} maxLength="64" aria-label=${`Display name for ${host.hostname || host.id}`}
      ref=${el => el && !el.dataset.f && (el.dataset.f = '1', el.focus(), el.select())}
      onInput=${e => setV(e.target.value)} onBlur=${() => !busy.current && onDone(false)}
      onKeyDown=${e => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDone(false); } }}/>
    <span class="rename-hint">Enter saves, Escape cancels. Empty shows the hostname.</span>
  </span>`;
}
