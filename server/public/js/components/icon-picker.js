import { useState } from 'preact/hooks';
import { html, Modal } from '../ui.js';
import { ICONS, OsIcon, iconLabel } from './os-icon.js';

// Icon picker: "Automatic" first (the icon LabCTL detects), then every built-in icon, with a search box and a preview.
// onPick(null) means automatic. auto: the detected id, or null where there is no automatic choice (groups).
export function IconPicker({ title = 'Choose an icon', current = null, auto = null, onPick, onClose }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(current);
  const [busy, setBusy] = useState(false);
  const list = ICONS.filter(i => !q || `${i.id} ${i.label}`.toLowerCase().includes(q.toLowerCase()));
  const shown = sel || auto || 'server';
  const pick = async () => { setBusy(true); try { await onPick(sel); } finally { setBusy(false); } };
  const tile = (id, label, icon) => html`<button key=${id || 'auto'} type="button" class=${`icon-tile ${sel === id ? 'on' : ''}`}
    aria-pressed=${sel === id} onClick=${() => setSel(id)}>
    <${OsIcon} id=${icon} size=${28} label=${label}/><span>${label}</span>
  </button>`;
  return html`<${Modal} title=${title} onClose=${onClose}>
    <div class="icon-picker-head">
      <span class="icon-preview"><${OsIcon} id=${shown} size=${44}/></span>
      <div style=${{ flex: 1, minWidth: 0 }}>
        <div style=${{ fontWeight: 600 }}>${sel ? iconLabel(sel) : auto ? `Automatic (${iconLabel(auto)})` : 'Automatic'}</div>
        <input class="input" placeholder="Search icons" aria-label="Search icons" value=${q} onInput=${e => setQ(e.target.value)} style=${{ marginTop: 6 }}/>
      </div>
    </div>
    <div class="icon-grid" role="group" aria-label="Icons">
      ${!q && tile(null, auto ? `Automatic` : 'None', auto || 'server')}
      ${list.map(i => tile(i.id, i.label, i.id))}
    </div>
    <div class="btn-group" style=${{ justifyContent: 'flex-end', marginTop: 14 }}>
      <button class="btn" onClick=${onClose}>Cancel</button>
      <button class="btn btn-primary" disabled=${busy || sel === current} onClick=${pick}>Use this icon</button>
    </div>
  <//>`;
}
