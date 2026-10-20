import { html } from '../ui.js';
import { fmtBytes } from './chart-kit.js';
import { NOT_REPORTED, has, Bar, usedOf, uptimeText, loadText } from './host-view.js';

const tone = p => (p > 85 ? 'var(--red)' : p > 65 ? 'var(--yellow)' : 'var(--accent)');
const R = 26;
const C = 2 * Math.PI * R;

// Ring gauge for one percent value. No value: an empty ring and a dash, never a guess.
export function Ring({ label, percent, detail }) {
  const p = has(percent) ? Math.max(0, Math.min(100, percent)) : null;
  return html`<div class="gauge" role="meter" aria-label=${label} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${p ?? undefined}
    aria-valuetext=${p === null ? NOT_REPORTED : `${Math.round(p)}%${detail ? `, ${detail}` : ''}`}>
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r=${R} class="gauge-track"/>
      ${p !== null && html`<circle cx="32" cy="32" r=${R} class="gauge-fill" style=${{ stroke: tone(p), strokeDasharray: `${(p / 100) * C} ${C}` }}/>`}
      <text x="32" y="36" text-anchor="middle" class="gauge-num">${p === null ? '-' : `${Math.round(p)}%`}</text>
    </svg>
    <div class="gauge-label">${label}</div>
    <div class="gauge-detail">${detail || ' '}</div>
  </div>`;
}

const Stat = ({ label, value, hint }) => html`<div class="stat-tile" title=${hint || ''}>
  <div class="gauge-label">${label}</div>
  <div class="stat-value">${has(value) && value !== '' ? value : html`<span title=${NOT_REPORTED}>-</span>`}</div>
</div>`;

// Overview tab: usage rings, load, uptime, temperatures, drives as bars, and Docker containers when the agent sends them.
export function HostOverview({ v, online }) {
  const temps = (v.temps || []).filter(t => has(t.celsius));
  const hottest = temps.reduce((a, t) => (!a || t.celsius > a.celsius ? t : a), null);
  const containers = v.containers || [];
  return html`<div class="overview">
    ${!online && v.heartbeat_at && html`<div class="page-desc" style=${{ marginBottom: 8 }}>The host is offline. These are its last reported values.</div>`}
    <div class="gauge-row">
      <${Ring} label="CPU" percent=${v.cpu_percent} detail=${has(v.cpu_cores) ? `${v.cpu_cores} cores` : ''}/>
      <${Ring} label="RAM" percent=${v.ram?.percent} detail=${usedOf(v.ram?.used, v.ram?.total)}/>
      ${v.swap?.total === 0 ? html`<${Stat} label="Swap" value="None"/>` : html`<${Ring} label="Swap" percent=${v.swap?.percent} detail=${usedOf(v.swap?.used, v.swap?.total)}/>`}
      <${Stat} label="Load (1, 5, 15 min)" value=${loadText(v.load)}/>
      <${Stat} label="Uptime" value=${uptimeText(v.uptime_s)}/>
      ${hottest && html`<${Stat} label="Hottest sensor" value=${`${Math.round(hottest.celsius)} °C`}
        hint=${temps.map(t => `${t.sensor}: ${Math.round(t.celsius)} °C`).join('\n')}/>`}
    </div>

    <h3 class="sub-head">Drives</h3>
    ${(v.disks || []).length ? html`<div class="disk-list">${v.disks.map((d, i) => html`<div key=${d.mount || i} class="disk">
      <div class="disk-top">
        <span class="mono disk-mount">${d.mount}${d.device && d.device !== d.mount ? ` (${d.device})` : ''}</span>
        <span class="disk-free">${has(d.percent) ? `${Math.round(d.percent)}%` : ''}${has(d.free) ? ` · ${fmtBytes(d.free)} free of ${fmtBytes(d.total)}` : ''}</span>
      </div>
      <${Bar} percent=${d.percent} height=${8}/>
    </div>`)}</div>` : html`<div class="page-desc" title=${NOT_REPORTED}>No drive data reported.</div>`}

    ${containers.length > 0 && html`<h3 class="sub-head">Docker containers <span class="page-desc">${v.docker_running ?? '-'} running of ${v.docker_total ?? containers.length}</span></h3>
      <div class="table-wrap"><table style=${{ fontSize: 12 }}>
        <thead><tr><th>Name</th><th>Image</th><th>State</th><th>Status</th></tr></thead>
        <tbody>${containers.map((c, i) => html`<tr key=${c.name || i}>
          <td class="mono"><span class=${`status-dot ${c.state === 'running' ? 'on' : 'off'}`}/> ${c.name}</td>
          <td class="mono" style=${{ fontSize: 11 }}>${c.image}</td>
          <td>${c.state}${c.health ? ` (${c.health})` : ''}</td>
          <td style=${{ fontSize: 11 }}>${c.status || '-'}</td>
        </tr>`)}</tbody>
      </table></div>`}
  </div>`;
}
