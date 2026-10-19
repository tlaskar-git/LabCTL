import { html } from '../../ui.js';
import { InventoryGate, Section, KV, toneBadge, fmtDate, arr } from '../../components/chart-kit.js';

// Props: host (record from the hosts list, may be undefined), hostId, addToast.
const flag = v => (v === null || v === undefined ? null : toneBadge(v ? 'ok' : 'bad', v ? 'On' : 'Off'));
const text = v => (v === null || v === undefined ? null : typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k}: ${x}`).join(', ') : String(v));
const days = v => (v === null || v === undefined ? null : `${v} days`);

export default function SecurityTab({ hostId }) {
  return html`<${InventoryGate} hostId=${hostId}>${inv => {
    const s = inv.security || {};
    const def = s.defender;
    const smartBad = arr(inv.smart).filter(x => x.health === 'failing');
    const known = ['filevault', 'firewall', 'gatekeeper', 'sip', 'defender'];
    const extra = Object.entries(s).filter(([k]) => !known.includes(k));
    return html`<div>
      ${inv.os === 'darwin' && html`<${Section} title="macOS posture">
        <${KV} rows=${[['FileVault', text(s.filevault)], ['Application firewall', text(s.firewall)], ['Gatekeeper', text(s.gatekeeper)], ['System Integrity Protection', text(s.sip)]]}/>
      <//>`}
      ${def && html`<${Section} title="Windows Defender">
        <${KV} rows=${[['Antivirus', flag(def.antivirus_enabled)], ['Real-time protection', flag(def.realtime)], ['Service', flag(def.service_enabled)], ['Tamper protection', flag(def.tamper_protected)],
          ['Signatures updated', def.signature_updated ? fmtDate(def.signature_updated) : null], ['Signature age', days(def.signature_age_days)],
          ['Last quick scan', days(def.quick_scan_age_days)], ['Last full scan', days(def.full_scan_age_days)]]}/>
      <//>`}
      ${inv.os === 'linux' && s.firewall !== undefined && html`<${Section} title="Linux firewall"><${KV} rows=${[['Firewall', text(s.firewall)]]}/><//>`}
      ${extra.length > 0 && html`<${Section} title="Other"><${KV} rows=${extra.map(([k, v]) => [k, text(v)])}/><//>`}
      <${Section} title="Exposure">
        <${KV} rows=${[['SMART failing', smartBad.length ? toneBadge('bad', smartBad.map(x => x.device).join(', ')) : arr(inv.smart).length ? toneBadge('ok', 'None') : null],
          ['Security updates pending', inv.updates?.security ?? null]]}/>
      <//>
      ${!inv.security && html`<div class="page-desc">The agent has not collected security data for this host.</div>`}
    </div>`;
  }}<//>`;
}
