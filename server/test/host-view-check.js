// Checks host-view over a JSON file of host rows ({ hosts: [row, ...] } or [row, ...]) and prints counts only, never
// values, so it can run against a private export without leaking it. Usage: node test/host-view-check.js <file>
// Exits 1 when a field is null although the payload carries it. Not a test by itself: host-data.test.js calls check().
const { buildView } = require('../src/host-view');
const { parseJson } = require('../src/db');

const FIELDS = ['cpu_percent', 'cpu_cores', 'ram', 'swap', 'disks', 'uptime_s', 'arch', 'os_version', 'ip', 'load'];

// What the payload carries for each field, so a null in the view is a mapping bug, not missing data.
function carried(row) {
  const p = v => (typeof v === 'string' ? parseJson(v, null) : v) || {};
  const hb = p(row.heartbeat), inv = p(row.inventory), si = p(row.system_info);
  const n = v => typeof v === 'number';
  return {
    cpu_percent: n(hb.cpu) || n(inv.cpu?.percent),
    cpu_cores: n(inv.cpu?.count) || n(si.cpus),
    ram: n(inv.memory?.total) || n(si.ram_total) || n(si.ram_mb),
    swap: n(inv.memory?.swap_total),
    disks: (Array.isArray(inv.disks) && inv.disks.length > 0) || (Array.isArray(si.drives) && si.drives.length > 0),
    uptime_s: n(hb.uptime) || n(inv.os_info?.uptime_s) || n(si.uptime_hours),
    arch: !!(row.arch || inv.os_info?.arch || si.arch),
    os_version: !!(row.os_version || inv.os_info?.version),
    ip: !!(row.ip || inv.os_info?.ip || si.ip),
    load: Array.isArray(hb.load) || Array.isArray(inv.cpu?.load)
  };
}

const present = (f, v) => {
  if (f === 'ram') return v.ram.total !== null && v.ram.percent !== null && v.ram.used !== null;
  if (f === 'swap') return v.swap.total !== null;
  if (f === 'disks') return v.disks.length > 0 && v.disks.every(d => d.total !== null && d.percent !== null);
  return v[f] !== null && v[f] !== undefined;
};

function check(rows) {
  const counts = Object.fromEntries(FIELDS.map(f => [f, { carried: 0, shown: 0 }]));
  const missing = [];
  rows.forEach((row, i) => {
    const v = buildView(row, { full: true });
    const c = carried(row);
    for (const f of FIELDS) {
      if (!c[f]) continue;
      counts[f].carried++;
      if (present(f, v)) counts[f].shown++;
      else missing.push(`host #${i + 1} (${row.os || 'unknown os'}): ${f}`);
    }
  });
  return { hosts: rows.length, counts, missing };
}

if (require.main === module && process.argv[2]) {
  const data = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
  const r = check(Array.isArray(data) ? data : data.hosts);
  for (const [f, c] of Object.entries(r.counts)) console.log(`${f}: ${c.shown} of ${c.carried} hosts that carry it (of ${r.hosts})`);
  for (const m of r.missing) console.log(`MISSING ${m}`);
  process.exit(r.missing.length ? 1 : 0);
}

module.exports = { check };
