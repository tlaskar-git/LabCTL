import { html } from '../../ui.js';
import { VpsPanel } from '../../components/vps-panel.js';
import { ProxmoxPanel } from '../../components/proxmox-panel.js';
import { InventoryGate, Section, KV, DataTable, toneBadge, fmtBytes, fmtDate, daysSince, arr } from '../../components/chart-kit.js';

// Props: host (record from the hosts list, may be undefined), hostId, addToast.
const name = i => (typeof i === 'string' ? i : i?.name || i?.label || JSON.stringify(i));
const gap = html`<div style=${{ height: 10 }}/>`;

function Inner({ hostId }) {
  return html`<${InventoryGate} hostId=${hostId}>${inv => {
    const up = inv.updates || {};
    const d = inv.darwin || {};
    const w = inv.windows || {};
    const reboot = up.reboot_required || up.restart_required || w.pending_reboot?.any;
    return html`<div>
      <${Section} title="Updates">
        <${KV} rows=${[
          ['Pending updates', up.pending ?? null], ['Security updates', up.security ?? undefined],
          ['Reboot required', reboot === undefined ? null : toneBadge(reboot ? 'warn' : 'ok', reboot ? 'Yes' : 'No')],
          ['Reboot pending for', reboot ? `${up.reboot_pending_days ?? 0} days` : undefined],
          ['Last patch', up.last_patch ? `${fmtDate(up.last_patch)} (${daysSince(up.last_patch)} days ago)` : null]]}/>
        ${gap}
        <${DataTable} empty="No pending updates" rows=${arr(up.items)} cols=${[{ h: 'Package or update', f: name }]}/>
      <//>
      ${inv.windows && html`<${Section} title="Windows Update">
        <${KV} rows=${[['Last result', w.last_update ? toneBadge(w.last_update.result === 'succeeded' ? 'ok' : 'bad', w.last_update.result) : null],
          ['Last update date', w.last_update ? fmtDate(w.last_update.date) : null], ['Last update', w.last_update?.title ?? null],
          ['Hotfixes installed', w.hotfixes?.count ?? null], ['Latest hotfix', w.hotfixes?.last_id ? `${w.hotfixes.last_id} (${fmtDate(w.hotfixes.last_patch)})` : null],
          ['Pending reboot sources', w.pending_reboot ? ['cbs', 'wu', 'file_rename'].filter(k => w.pending_reboot[k]).join(', ') || 'None' : null]]}/>
      <//>`}
      ${inv.darwin && html`<div>
        <${Section} title=${`macOS software updates (${d.softwareupdate?.pending ?? 0})`}>
          <${DataTable} empty="No macOS updates pending" rows=${arr(d.softwareupdate?.items)} cols=${[{ h: 'Update', f: i => i.title || i.label }, { h: 'Version', f: i => i.version || '-' },
            { h: 'Size', num: true, f: i => (i.size_kb ? fmtBytes(i.size_kb * 1024) : '-') }, { h: 'Restart', f: i => (i.restart ? toneBadge('warn', 'Yes') : 'No') }]}/>
        <//>
        <${Section} title=${`Homebrew outdated (${(d.brew?.formulae ?? 0) + (d.brew?.casks ?? 0)})`}>
          <${DataTable} empty=${d.brew?.note || 'Nothing outdated'} rows=${arr(d.brew?.items)} cols=${[{ h: 'Name', f: i => i.name }, { h: 'Kind', f: i => i.kind },
            { h: 'Installed', f: i => i.installed || '-' }, { h: 'Current', f: i => i.current || '-' }, { h: 'Pinned', f: i => (i.pinned ? 'Yes' : 'No') }]}/>
        <//>
        ${d.xcode && html`<${Section} title="Xcode">
          <${KV} rows=${[['Command line tools', d.xcode.clt?.installed ? d.xcode.clt.version || 'Installed' : 'Not installed'],
            ['Xcode apps', arr(d.xcode.apps).map(a => (typeof a === 'string' ? a : `${a.name || a.path} ${a.version || ''}`.trim())).join(', ') || 'None'],
            ['DerivedData', d.xcode.derived_data_bytes === null || d.xcode.derived_data_bytes === undefined ? null : fmtBytes(d.xcode.derived_data_bytes)],
            ['Simulators', d.xcode.simulators ? `${d.xcode.simulators.count} (${d.xcode.simulators.unavailable} unavailable${d.xcode.simulators.bytes ? `, ${fmtBytes(d.xcode.simulators.bytes)}` : ''})` : null]]}/>
        <//>`}
        ${d.time_machine && html`<${Section} title="Time Machine">
          <${KV} rows=${[['Latest backup', d.time_machine.latest ?? null], ['Age', d.time_machine.age_days === null || d.time_machine.age_days === undefined ? null : `${d.time_machine.age_days} days`]]}/>
        <//>`}
      </div>`}
      ${inv.proxmox && html`<${Section} title="Proxmox"><${KV} rows=${[['Version', inv.proxmox.version ?? null]]}/><//>`}
    </div>`;
  }}<//>`;
}

export default function SoftwareUpdatesTab({ host, hostId, addToast }) {
  const h = host || { id: hostId };
  return html`<div>
    <${Inner} host=${host} hostId=${hostId}/>
    <${VpsPanel} host=${h} view="updates" addToast=${addToast}/>
    <${ProxmoxPanel} host=${h} view="updates" addToast=${addToast}/>
  </div>`;
}
