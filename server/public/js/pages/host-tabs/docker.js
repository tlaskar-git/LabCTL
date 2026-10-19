import { html } from '../../ui.js';
import { InventoryGate, Section, DataTable, toneBadge, fmtBytes, fmtPct, arr } from '../../components/chart-kit.js';

// Props: host (record from the hosts list, may be undefined), hostId, addToast.
const stateTone = c => (c.state === 'running' ? 'ok' : 'bad');
const healthTone = h => (h === 'healthy' ? 'ok' : h === 'unhealthy' ? 'bad' : 'warn');

export default function DockerTab({ hostId }) {
  return html`<${InventoryGate} hostId=${hostId}>${inv => {
    const d = inv.docker;
    if (!d) return html`<div class="card empty-state"><div class="empty-state-title">No Docker data</div><div class="empty-state-desc">Docker is not installed on this host or the agent cannot reach it.</div></div>`;
    return html`<${Section} title=${`Containers (${d.running} running of ${d.total})`}>
      <${DataTable} empty="No containers" rows=${arr(d.containers)} cols=${[
        { h: 'Name', f: c => c.name }, { h: 'Image', f: c => c.image },
        { h: 'State', f: c => toneBadge(stateTone(c), c.state) }, { h: 'Health', f: c => (c.health ? toneBadge(healthTone(c.health), c.health) : '-') },
        { h: 'Restarts', num: true, f: c => (c.restart_count > 2 ? toneBadge('warn', String(c.restart_count)) : c.restart_count ?? '-') },
        { h: 'CPU', num: true, f: c => fmtPct(c.cpu_percent) }, { h: 'Memory', num: true, f: c => (c.mem_bytes === null || c.mem_bytes === undefined ? '-' : `${fmtBytes(c.mem_bytes)} (${fmtPct(c.mem_percent)})`) },
        { h: 'Image age', num: true, f: c => (c.image_age_days === null || c.image_age_days === undefined ? '-' : `${c.image_age_days} days`) },
        { h: 'Newer image', f: c => (c.newer_image === true ? toneBadge('warn', 'Yes') : c.newer_image === false ? 'No' : 'Not checked') }]}/>
    <//>`;
  }}<//>`;
}
