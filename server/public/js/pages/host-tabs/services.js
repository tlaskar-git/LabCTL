import { html } from '../../ui.js';
import { VpsPanel } from '../../components/vps-panel.js';
import { InventoryGate, Section, DataTable, toneBadge, fmtDate, arr } from '../../components/chart-kit.js';

// Props: host (record from the hosts list, may be undefined), hostId, addToast.
// The agent reports failed services only (systemd failed units, stopped automatic Windows services, launchd jobs
// with a non-zero exit), so this tab lists those, not every service on the host.
function Inner({ hostId }) {
  return html`<${InventoryGate} hostId=${hostId}>${inv => {
    const failed = arr(inv.services?.failed);
    return html`<div>
      <${Section} title=${`Failed services (${failed.length})`}>
        <${DataTable} empty="No failed services" rows=${failed} cols=${[{ h: 'Name', f: s => s.name }, { h: 'State', f: s => toneBadge('bad', s.state || 'failed') }, { h: 'Detail', f: s => s.detail || '-' }]}/>
        <div class="page-desc" style=${{ marginTop: 10 }}>The agent collects failed services only. It does not send a full service list.</div>
      <//>
      ${inv.darwin && html`<${Section} title=${`Failed launchd jobs (${arr(inv.darwin.launchd_failed).length})`}>
        <${DataTable} empty="No failed launchd jobs" rows=${arr(inv.darwin.launchd_failed)} cols=${[{ h: 'Label', f: s => s.label || s.name || String(s) }, { h: 'Last exit', f: s => s.status ?? s.exit ?? s.state ?? '-' }]}/>
      <//>`}
      ${inv.windows && html`<${Section} title=${`Failed scheduled tasks (${arr(inv.windows.failed_tasks).length})`}>
        <${DataTable} empty="No failed scheduled tasks" rows=${arr(inv.windows.failed_tasks)} cols=${[{ h: 'Task', f: t => t.name }, { h: 'Result', f: t => toneBadge('bad', t.result_hex || String(t.result)) }, { h: 'Last run', f: t => fmtDate(t.last_run) }]}/>
      <//>`}
    </div>`;
  }}<//>`;
}

export default function ServicesTab({ host, hostId, addToast }) {
  const h = host || { id: hostId };
  return html`<div>
    <${Inner} host=${host} hostId=${hostId}/>
    <${VpsPanel} host=${h} view="services" addToast=${addToast}/>
  </div>`;
}
