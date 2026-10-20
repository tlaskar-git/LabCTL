import { html, StatusBadge } from '../../ui.js';
import { VpsPanel } from '../../components/vps-panel.js';
import { ProxmoxPanel } from '../../components/proxmox-panel.js';
import { InventoryGate, Gauge, Section, KV, DataTable, toneBadge, fmtBytes, fmtDate, fmtDuration, fmtAgo, daysSince, arr } from '../../components/chart-kit.js';

// Props: host (record from the hosts list, may be undefined), hostId, addToast.
const yesNo = v => (v === null || v === undefined ? null : v ? 'Yes' : 'No');

function Proxmox({ p }) {
  return html`<${Section} title="Proxmox">
    <${KV} rows=${[['Version', p.version ?? null], ['ZFS pools', p.zpool_healthy === null || p.zpool_healthy === undefined ? null : toneBadge(p.zpool_healthy ? 'ok' : 'bad', p.zpool_healthy ? 'All healthy' : 'Degraded')],
      ['ZFS ARC', p.arc_bytes ? `${fmtBytes(p.arc_bytes)} of ${fmtBytes(p.arc_max_bytes)}` : null]]}/>
    <div style=${{ height: 12 }}/>
    <${DataTable} empty="No ZFS pools" rows=${arr(p.zpools)} cols=${[{ h: 'Pool', f: z => z.name }, { h: 'Health', f: z => toneBadge(z.health === 'ONLINE' ? 'ok' : 'bad', z.health) },
      { h: 'Size', num: true, f: z => fmtBytes(z.size) }, { h: 'Used', num: true, f: z => fmtBytes(z.alloc) }, { h: 'Free', num: true, f: z => fmtBytes(z.free) }]}/>
    <div style=${{ height: 12 }}/>
    <${DataTable} empty="No virtual machines" rows=${arr(p.vms)} cols=${[{ h: 'VM', f: v => v.vmid }, { h: 'Name', f: v => v.name },
      { h: 'State', f: v => toneBadge(v.status === 'running' ? 'ok' : 'warn', v.status) }, { h: 'Memory', num: true, f: v => (v.mem_mb ? `${v.mem_mb} MB` : '-') }]}/>
    <div style=${{ height: 12 }}/>
    <${DataTable} empty="No containers" rows=${arr(p.containers)} cols=${[{ h: 'CT', f: v => v.vmid }, { h: 'Name', f: v => v.name },
      { h: 'State', f: v => toneBadge(v.status === 'running' ? 'ok' : 'warn', v.status) }, { h: 'Lock', f: v => v.lock || '-' }]}/>
  <//>`;
}

function Windows({ w }) {
  const pr = w.pending_reboot || {};
  const failed = arr(w.failed_tasks);
  return html`<${Section} title="Windows">
    <${KV} rows=${[['Pending reboot', pr.any === undefined ? null : toneBadge(pr.any ? 'warn' : 'ok', pr.any ? 'Yes' : 'No')],
      ['Reboot sources', pr.any ? ['cbs', 'wu', 'file_rename'].filter(k => pr[k]).join(', ') : null],
      ['Last Windows Update', w.last_update ? `${w.last_update.result} on ${fmtDate(w.last_update.date)}` : null],
      ['Last update title', w.last_update?.title ?? null],
      ['Hotfixes installed', w.hotfixes?.count ?? null],
      ['Failed scheduled tasks', toneBadge(failed.length ? 'bad' : 'ok', String(failed.length))]]}/>
  <//>`;
}

function Mac({ d }) {
  return html`<${Section} title="macOS">
    <${KV} rows=${[['Software updates pending', d.softwareupdate?.pending ?? null], ['Update needs restart', yesNo(d.softwareupdate?.restart_required)],
      ['Homebrew outdated', d.brew ? `${d.brew.formulae ?? '-'} formulae, ${d.brew.casks ?? '-'} casks` : null],
      ['Last Time Machine backup', d.time_machine?.latest ? `${d.time_machine.latest} (${d.time_machine.age_days ?? '-'} days ago)` : null]]}/>
  <//>`;
}

function Inner({ host, hostId }) {
  return html`<${InventoryGate} hostId=${hostId}>${(inv, at) => {
    const hb = host?.heartbeat || {};
    const mem = inv.memory || {};
    const disks = arr(inv.disks);
    const worst = disks.reduce((a, d) => (!a || d.percent > a.percent ? d : a), null);
    const up = inv.updates || {};
    const rebootNeeded = up.reboot_required || up.restart_required || inv.windows?.pending_reboot?.any;
    const patchDays = daysSince(up.last_patch);
    const failedSvc = arr(inv.services?.failed).length;
    const smartBad = arr(inv.smart).filter(s => s.health === 'failing').length;
    const drift = inv.time?.drift_s;
    const outdated = host?.agent_outdated;
    return html`<div>
      <div class="metric-grid">
        <${Gauge} label="CPU" percent=${hb.cpu ?? inv.cpu?.percent} detail=${inv.cpu?.load ? `Load ${inv.cpu.load.map(x => x.toFixed(2)).join(' ')} on ${inv.cpu.count} cores` : `${inv.cpu?.count ?? '-'} cores`}/>
        <${Gauge} label="Memory" percent=${hb.ram ?? mem.percent} detail=${mem.total ? `${fmtBytes(mem.used)} of ${fmtBytes(mem.total)}` : ''}/>
        <${Gauge} label="Swap" percent=${mem.swap_percent} detail=${mem.swap_total ? `${fmtBytes(mem.swap_used)} of ${fmtBytes(mem.swap_total)}` : 'No swap'}/>
        <${Gauge} label="Fullest disk" percent=${worst?.percent} detail=${worst ? `${worst.mount} (${fmtBytes(worst.free)} free)` : ''}/>
      </div>
      <${Section} title="Host">
        <${KV} rows=${[
          ['Status', host ? html`<${StatusBadge} status=${host.online ? 'online' : 'offline'}/>` : null],
          ['Kind', host?.kind ?? null],
          ['Operating system', [inv.os_info?.name, inv.os_info?.version].filter(Boolean).join(' ') || host?.os || null],
          ['Kernel or build', inv.os_info?.kernel || inv.os_info?.build || null],
          ['Architecture', inv.os_info?.arch ?? null],
          ['Model', inv.os_info?.model ?? undefined],
          ['Address', inv.os_info?.ip ?? host?.ip ?? null],
          ['Agent version', host ? html`${host.agent_version || inv.agent_version || '-'} ${outdated ? toneBadge('warn', `Latest is ${host.latest_agent_version}`) : ''}` : inv.agent_version],
          ['Uptime', fmtDuration(hb.uptime ?? inv.os_info?.uptime_s)],
          ['Last seen', host?.last_seen ? `${fmtAgo(host.last_seen)} (${fmtDate(host.last_seen)})` : null],
          ['Inventory taken', at ? fmtAgo(at) : null]]}/>
      <//>
      <${Section} title="Health">
        <${KV} rows=${[
          ['Reboot required', rebootNeeded === undefined ? null : toneBadge(rebootNeeded ? 'warn' : 'ok', rebootNeeded ? 'Yes' : 'No')],
          ['Reboot pending for', rebootNeeded ? `${up.reboot_pending_days ?? 0} days` : '-'],
          ['Pending updates', up.pending === null || up.pending === undefined ? null : `${up.pending}${up.security ? ` (${up.security} security)` : ''}`],
          ['Last patch', up.last_patch ? `${fmtDate(up.last_patch)} (${patchDays} days ago)` : null],
          ['Time drift', drift === null || drift === undefined ? null : toneBadge(Math.abs(drift) > 5 ? 'bad' : Math.abs(drift) > 1 ? 'warn' : 'ok', `${drift > 0 ? '+' : ''}${drift.toFixed(2)} s${inv.time?.source ? ` (${inv.time.source})` : ''}`)],
          ['Failed services', toneBadge(failedSvc ? 'bad' : 'ok', String(failedSvc))],
          ['SMART', arr(inv.smart).length ? toneBadge(smartBad ? 'bad' : 'ok', smartBad ? `${smartBad} failing` : 'All ok') : null],
          ['Containers', inv.docker ? `${inv.docker.running} running of ${inv.docker.total}` : undefined],
          ['Collector errors', Object.keys(inv.errors || {}).length ? Object.entries(inv.errors).map(([k, v]) => `${k}: ${v}`).join('; ') : undefined]]}/>
      <//>
      ${inv.proxmox && html`<${Proxmox} p=${inv.proxmox}/>`}
      ${inv.windows && html`<${Windows} w=${inv.windows}/>`}
      ${inv.darwin && html`<${Mac} d=${inv.darwin}/>`}
    </div>`;
  }}<//>`;
}

export default function OverviewTab({ host, hostId, addToast }) {
  const h = host || { id: hostId };
  return html`<div>
    <${Inner} host=${host} hostId=${hostId}/>
    <${VpsPanel} host=${h} view="overview" addToast=${addToast}/>
    <${ProxmoxPanel} host=${h} view="overview" addToast=${addToast}/>
  </div>`;
}
