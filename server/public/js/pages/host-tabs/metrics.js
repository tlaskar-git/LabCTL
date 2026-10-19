import { useState } from 'preact/hooks';
import { html } from '../../ui.js';
import { RangeBar, MetricChart } from '../../components/chart.js';
import { useInventory, Section, DataTable, toneBadge, fmtBytes, fmtPct, arr } from '../../components/chart-kit.js';

// Props: host (record from the hosts list, may be undefined), hostId, addToast.
export default function MetricsTab({ hostId }) {
  const [range, setRange] = useState('24h');
  const { data: inv } = useInventory(hostId);
  const disks = arr(inv?.disks);
  const ifaces = arr(inv?.net).filter(n => n.iface !== 'lo');
  const temps = arr(inv?.temps);
  const procs = inv?.procs || {};
  const chart = (title, series, extra = {}) => html`<${MetricChart} key=${title} hostId=${hostId} range=${range} title=${title} series=${series} ...${extra}/>`;
  const procTable = rows => html`<${DataTable} empty="No process data" rows=${arr(rows).slice(0, 10)} cols=${[
    { h: 'PID', f: p => p.pid }, { h: 'Name', f: p => p.name }, { h: 'User', f: p => p.user },
    { h: 'CPU', num: true, f: p => fmtPct(p.cpu) }, { h: 'Memory', num: true, f: p => `${fmtPct(p.mem_percent)} (${fmtBytes(p.rss)})` }]}/>`;
  return html`<div>
    <div style=${{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}><${RangeBar} value=${range} onChange=${setRange}/></div>
    <div class="kit-grid">
      ${chart('CPU', [{ key: 'cpu', label: 'CPU' }], { unit: '%', max: 100 })}
      ${chart('Memory and swap', [{ key: 'ram', label: 'Memory' }, { key: 'swap', label: 'Swap' }], { unit: '%', max: 100 })}
      ${chart('Load average (1 minute)', [{ key: 'load1', label: 'Load' }])}
      ${disks.length > 0 && chart('Disk usage per mount', disks.slice(0, 12).map(d => ({ key: `disk:${d.mount}`, label: d.mount })), { unit: '%', max: 100 })}
      ${ifaces.length > 0 ? ifaces.slice(0, 8).map(n => chart(`Network ${n.iface}`, [{ key: `net:${n.iface}:rx`, label: 'Receive' }, { key: `net:${n.iface}:tx`, label: 'Send' }], { unit: 'B/s' }))
        : chart('Network (all interfaces)', [{ key: 'rx', label: 'Receive' }, { key: 'tx', label: 'Send' }], { unit: 'B/s' })}
      ${temps.length > 0 && chart('Temperatures', temps.slice(0, 12).map(t => ({ key: `temp:${t.sensor}`, label: t.sensor })), { unit: ' C' })}
    </div>
    <${Section} title="Disks">
      <${DataTable} empty="No disk data" rows=${disks} cols=${[{ h: 'Mount', f: d => d.mount }, { h: 'Device', f: d => d.device }, { h: 'Type', f: d => d.fstype },
        { h: 'Size', num: true, f: d => fmtBytes(d.total) }, { h: 'Used', num: true, f: d => fmtBytes(d.used) }, { h: 'Free', num: true, f: d => fmtBytes(d.free) },
        { h: 'Used %', num: true, f: d => toneBadge(d.percent > 90 ? 'bad' : d.percent > 80 ? 'warn' : 'ok', fmtPct(d.percent)) },
        { h: 'Inodes %', num: true, f: d => fmtPct(d.inodes_percent) }]}/>
    <//>
    ${arr(inv?.smart).length > 0 && html`<${Section} title="SMART health">
      <${DataTable} rows=${arr(inv.smart)} cols=${[{ h: 'Device', f: s => s.device }, { h: 'Health', f: s => toneBadge(s.health === 'ok' ? 'ok' : s.health === 'failing' ? 'bad' : 'warn', s.health) }, { h: 'Detail', f: s => s.detail || '-' }]}/>
    <//>`}
    <div class="kit-grid">
      <${Section} title="Top 10 processes by CPU">${procTable(procs.top_cpu)}<//>
      <${Section} title="Top 10 processes by memory">${procTable(procs.top_mem)}<//>
    </div>
  </div>`;
}
