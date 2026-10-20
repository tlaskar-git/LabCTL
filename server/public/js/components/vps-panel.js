import { html } from '../ui.js';
import { KV, DataTable, toneBadge, fmtDuration } from './chart-kit.js';
import { ActionPanel, ResultSection, useActions, useResults } from './action-panel.js';
import { parseResults, heldBack, jails, ports, certs, wgPeers, postReboot, unattended, lastLines } from './result-parse.js';

// VPS and domain controller panel for the host detail tabs. view: 'overview' | 'updates' | 'security' | 'services'.
// Cards read the latest job per template (GET /api/hosts/:id/action-results); the action list sits under them.
const VIEWS = {
  overview: { title: 'VPS actions', groups: ['Health', 'Danger'] },
  updates: { title: 'VPS patching and cleanup', groups: ['Patch', 'Cleanup'] },
  security: { title: 'VPS security checks', groups: ['Security'] },
  services: { title: 'Network service actions', groups: ['Network'] }
};
const yes = v => (v === undefined ? null : toneBadge(v === 'yes' ? 'warn' : 'ok', v === 'yes' ? 'Yes' : 'No'));
const count = v => (v === undefined ? null : toneBadge(Number(v) > 0 ? 'bad' : 'ok', String(v)));
const tail = (res, n = 15) => html`<pre class="mono" style=${{ whiteSpace: 'pre-wrap', fontSize: 12, margin: '8px 0 0' }}>${lastLines(res.log, n)}</pre>`;
const certTone = c => (c.days === null || c.days < 0 ? 'bad' : c.days < 21 ? 'warn' : 'ok');

// Each card gets the parsed job (or undefined). `with(id, fn)` runs fn only when that template has a result.
const CARDS = (r, roles) => {
  const on = (id, fn) => (r[id] ? fn(r[id]) : null);
  const dc = roles.includes('domain_controller');
  const wg = r.vps_wireguard_status || r.win_wireguard_state;
  return {
    updates: () => html`<div>
      <${ResultSection} title="Held-back packages" res=${r.vps_apt_upgrade}>
        ${on('vps_apt_upgrade', j => html`<div>
          <${KV} rows=${[['Held back', toneBadge(heldBack(j.log).length ? 'warn' : 'ok', String(heldBack(j.log).length))], ['Reboot required', yes(parseResults(j.log).reboot_required)]]}/>
          ${heldBack(j.log).length > 0 && html`<div class="mono" style=${{ marginTop: 6 }}>${heldBack(j.log).join(', ')}</div>`}</div>`)}
      <//>
      <${ResultSection} title="Reboot required check" res=${r.vps_reboot_required}>
        ${on('vps_reboot_required', j => html`<${KV} rows=${[['Reboot required', yes(parseResults(j.log).reboot_required)]]}/>`)}
      <//>
      <${ResultSection} title="Unattended upgrades" res=${r.vps_unattended_status}>
        ${on('vps_unattended_status', j => html`<${KV} rows=${[['Enabled', unattended(j.log).enabled], ['Active', unattended(j.log).active]]}/>`)}
      <//>
      ${r.win_update && html`<${ResultSection} title="Windows Update" res=${r.win_update}>${tail(r.win_update)}<//>`}
    </div>`,
    security: () => html`<div>
      <${ResultSection} title="fail2ban" res=${r.vps_fail2ban_status}>
        ${on('vps_fail2ban_status', j => html`<div><${KV} rows=${[['Currently banned', parseResults(j.log).fail2ban_banned ?? null]]}/>
          <${DataTable} empty="No jails reported" rows=${jails(j.log)}
            cols=${[{ h: 'Jail', f: x => x.jail }, { h: 'Banned now', num: true, f: x => x.now }, { h: 'Banned in total', num: true, f: x => x.total }]}/></div>`)}
      <//>
      <${ResultSection} title="Listening ports" res=${r.vps_listening_ports}>
        ${on('vps_listening_ports', j => html`<div>
          <${KV} rows=${[['Reachable from outside', ports(j.log).open.join(', ') || 'None'], ['Not in allowed list', count(parseResults(j.log).unexpected_ports)]]}/>
          <${DataTable} empty="No sockets" rows=${ports(j.log).sockets}
            cols=${[{ h: 'Protocol', f: x => x.proto }, { h: 'Address', f: x => x.local }, { h: 'Process', f: x => x.process || '-' }]}/></div>`)}
      <//>
      <${ResultSection} title="Certificate expiry" res=${r.vps_cert_expiry}>
        ${on('vps_cert_expiry', j => html`<${DataTable} empty="No certificates reported" rows=${certs(j.log)}
          cols=${[{ h: 'Domain', f: c => c.domain }, { h: 'Expires', f: c => c.until || 'no certificate' },
            { h: 'Days left', num: true, f: c => toneBadge(certTone(c), c.days === null ? '-' : String(c.days)) }]}/>`)}
      <//>
    </div>`,
    services: () => html`<div>
      <${ResultSection} title="WireGuard" res=${wg}>
        ${wg && html`<div><${KV} rows=${[['Stale peers', count(parseResults(wg.log).wireguard_stale_peers)]]}/>
          <${DataTable} empty="No peers reported" rows=${wgPeers(wg.log)}
            cols=${[{ h: 'Interface', f: p => p.iface }, { h: 'Peer', f: p => p.peer }, { h: 'Last handshake', f: p => (p.age_s === null ? toneBadge('bad', 'never') : `${p.age_s < 60 ? `${p.age_s} s` : fmtDuration(p.age_s)} ago`) }]}/>
          ${wgPeers(wg.log).length === 0 && tail(wg, 10)}</div>`}
      <//>
      ${(dc || r.win_dns_check) && html`<${ResultSection} title="DNS service check" res=${r.win_dns_check}>
        ${on('win_dns_check', j => html`<div><${KV} rows=${[['Problems', count(parseResults(j.log).dns_problems)]]}/>${tail(j, 20)}</div>`)}<//>`}
    </div>`,
    overview: () => html`<div>
      <${ResultSection} title="Post-reboot check" res=${r.vps_post_reboot_check}>
        ${on('vps_post_reboot_check', j => {
          const p = postReboot(j.log);
          return html`<div><${KV} rows=${[['Failures', count(p.failures ?? undefined)], ['WireGuard handshake', p.handshake === null ? null : toneBadge(p.handshake ? 'ok' : 'bad', p.handshake ? 'Yes' : 'No')]]}/>
            <${DataTable} empty="No services checked" rows=${p.services}
              cols=${[{ h: 'Service', f: s => s.service }, { h: 'State', f: s => toneBadge(s.active ? 'ok' : 'bad', s.active ? 'active' : 'not active') }]}/></div>`;
        })}
      <//>
      ${r.win_service_health && html`<${ResultSection} title="Windows service health" res=${r.win_service_health}>${tail(r.win_service_health)}<//>`}
      ${(dc || r.win_dc_health) && html`<${ResultSection} title="Domain controller: dcdiag and repadmin /replsummary" res=${r.win_dc_health}>
        ${on('win_dc_health', j => html`<div><${KV} rows=${[['Problems', count(parseResults(j.log).dc_problems)]]}/>${tail(j, 30)}</div>`)}<//>`}
    </div>`
  };
};

export function VpsPanel({ host, view = 'overview', addToast }) {
  const data = useActions(host.id);
  const [results, reload] = useResults(host.id);
  if (!data) return null;
  if (!(data.roles.includes('vps') || data.roles.includes('domain_controller') || host.kind === 'ssh')) return null;
  const v = VIEWS[view];
  return html`<div>
    ${CARDS(results, data.roles)[view]()}
    <${ActionPanel} host=${host} data=${data} title=${v.title} groups=${v.groups} categories=${['vps']} onStarted=${reload} addToast=${addToast}/>
  </div>`;
}
