import { useState } from 'preact/hooks';
import { html, Icons } from '../ui.js';
import { Chip } from './host-chips.js';
import { MiniBar, osText, uptimeText } from './host-view.js';
import { fmtAgo } from './chart-kit.js';
import { OsIcon, hostName, Pencil, RenameField } from './host-name.js';

export const isOnline = h => !!(h.online || h.status === 'online');

// One host as a card. The name button opens the host window and covers the whole card (stretched), so the card is
// one keyboard stop; the checkbox and the quick actions sit above it. Quick actions show on hover and focus.
export function HostCard({ host: h, selected, onToggle, onOpen, canEdit, isAdmin, onSettings, onRedeploy, onRemove, onChanged, addToast }) {
  const [editing, setEditing] = useState(false);
  const v = h.view || {};
  const live = isOnline(h);
  const name = hostName(h);
  const sub = [h.display_name && h.hostname, osText(v) || h.os].filter(Boolean).join(' · ');
  const btn = (label, icon, onClick, cls = '') => html`<button class=${`icon-btn ${cls}`} title=${label} aria-label=${`${label}: ${name}`}
    onClick=${e => { e.stopPropagation(); onClick(); }}><${icon}/></button>`;
  return html`<article class=${`hcard ${live ? '' : 'is-off'} ${selected ? 'is-sel' : ''}`}>
    <div class="hcard-top">
      <input type="checkbox" class="hcard-check" checked=${selected} onChange=${onToggle} aria-label=${`Select ${name}`}/>
      <span class="hcard-icon">
        <${OsIcon} host=${h} size=${30}/>
        <span class=${`status-dot ${live ? 'on' : 'off'}`} title=${live ? 'Online' : 'Offline'}/>
      </span>
      <div class="hcard-title">
        ${editing ? html`<${RenameField} host=${h} addToast=${addToast} onDone=${saved => { setEditing(false); if (saved) onChanged(); }}/>`
          : html`<button class="hcard-name" onClick=${onOpen} title=${name} aria-label=${`${name}, ${live ? 'online' : 'offline'}`}>${name}</button>`}
        <div class="hcard-sub" title=${sub}>${sub || ' '}</div>
      </div>
    </div>
    <div class="hcard-metrics">
      <div><span class="metric-label">CPU</span><${MiniBar} percent=${v.cpu_percent}/></div>
      <div><span class="metric-label">RAM</span><${MiniBar} percent=${v.ram?.percent}/></div>
      <div><span class="metric-label">Disk</span><${MiniBar} percent=${v.disk_max_percent}/></div>
      <div><span class="metric-label">${live ? 'Uptime' : 'Offline'}</span>
        <span class="metric-value">${live ? uptimeText(v.uptime_s) || '-' : h.last_seen ? `seen ${fmtAgo(h.last_seen)}` : 'never seen'}</span></div>
    </div>
    <div class="hcard-foot">
      <div class="hcard-chips">
        ${h.kind !== 'agent' && html`<span class="kind-chip">${h.kind === 'ssh' ? 'agentless' : h.kind}</span>`}
        ${h.agent_outdated && html`<span class="badge badge-pending" title=${`Agent ${h.agent_version}, latest known ${h.latest_agent_version}`}>agent outdated</span>`}
        ${(h.tags || []).map(t => html`<${Chip} key=${t.id} item=${t}/>`)}
      </div>
      <div class="hcard-actions">
        ${canEdit && btn('Rename', Pencil, () => setEditing(true))}
        ${canEdit && btn('Settings', Icons.Settings, onSettings)}
        ${isAdmin && h.kind !== 'ssh' && btn('Redeploy agent', Icons.RefreshCw, onRedeploy)}
        ${isAdmin && btn('Remove host', Icons.Trash, onRemove, 'danger')}
      </div>
    </div>
  </article>`;
}
