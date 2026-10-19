import { html } from '../../ui.js';
import { InventoryGate, Section, LogBox, arr } from '../../components/chart-kit.js';

// Props: host (record from the hosts list, may be undefined), hostId, addToast.
// Runner log tails from the inventory, plus the agent's own collector errors and agent_log lines when present.
// Lines with error or failed are highlighted.
export default function LogsTab({ hostId }) {
  return html`<${InventoryGate} hostId=${hostId}>${inv => {
    const runners = arr(inv.runners);
    const errors = Object.entries(inv.errors || {}).map(([k, v]) => `collector error: ${k}: ${v}`);
    return html`<div>
      <${Section} title="Agent"><${LogBox} lines=${[...errors, ...arr(inv.agent_log)]}/><//>
      ${runners.length === 0 && html`<div class="page-desc">No runners on this host, so there are no runner logs.</div>`}
      ${runners.map(r => html`<${Section} key=${r.path} title=${`Runner ${r.name || r.path}`}><${LogBox} lines=${arr(r.log_tail)}/><//>`)}
    </div>`;
  }}<//>`;
}
