// One normalised view of a host for every display: built from the hosts row columns, the last heartbeat
// (cpu %, ram %, load, uptime s), the latest inventory (bytes and percent, see agent/labctl-agent.py) and
// system_info (agent register info, or the v1 / ssh poll shape with ram_mb, drives[].total_gb, uptime_hours).
// Unknown values are null, never invented. Units: bytes, percent 0-100, seconds.
const { parseJson } = require('./db');

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pick = (...vals) => vals.find(v => v !== null && v !== undefined && v !== '') ?? null;
const arr = v => (Array.isArray(v) ? v : []);
const obj = v => (typeof v === 'string' ? parseJson(v, null) : v) || null;
const pct = (used, total) => (num(used) !== null && num(total) ? Math.round((used / total) * 1000) / 10 : null);
const MB = 1048576;
const GB = 1073741824;

function ramOf(mem, hb, si) {
  // v1 / ssh poll: ram_mb and ram_available_mb in MB.
  const v1Total = num(si.ram_mb) !== null ? si.ram_mb * MB : null;
  const v1Used = v1Total !== null && num(si.ram_available_mb) !== null ? v1Total - si.ram_available_mb * MB : null;
  const total = pick(num(mem.total), num(si.ram_total), v1Total);
  // The heartbeat is fresher than the inventory: when it carries a percent, derive used from it and the total.
  const percent = pick(num(hb.ram), num(mem.percent), pct(num(mem.used) ?? v1Used, total));
  const used = num(hb.ram) !== null && total ? Math.round(total * hb.ram / 100) : pick(num(mem.used), v1Used);
  return { used, total, percent };
}

function swapOf(mem) {
  const total = num(mem.swap_total);
  const used = num(mem.swap_used);
  return { used, total, percent: pick(num(mem.swap_percent), total ? pct(used, total) : null) };
}

function disksOf(inv, si) {
  if (Array.isArray(inv.disks)) {
    return inv.disks.map(d => ({ mount: pick(d.mount, d.device), device: d.device ?? null, fs: d.fstype ?? null,
      total: num(d.total), used: num(d.used), free: num(d.free), percent: pick(num(d.percent), pct(d.used, d.total)),
      inodes_percent: num(d.inodes_percent) }));
  }
  // v1 / ssh poll drives are in GB.
  return arr(si.drives).map(d => ({ mount: pick(d.mount, d.device), device: d.device ?? null, fs: null,
    total: num(d.total_gb) !== null ? Math.round(d.total_gb * GB) : null, used: num(d.used_gb) !== null ? Math.round(d.used_gb * GB) : null,
    free: num(d.free_gb) !== null ? Math.round(d.free_gb * GB) : null, percent: pick(num(d.percent), pct(d.used_gb, d.total_gb)), inodes_percent: null }));
}

// full = false gives the light fields for the hosts list; full = true adds network, temperatures, processes and lists.
function buildView(row, { full = false, online = null } = {}) {
  const hb = obj(row.heartbeat) || {};
  const inv = obj(row.inventory) || {};
  const si = obj(row.system_info) || {};
  const oi = inv.os_info || {};
  const mem = inv.memory || {};
  const cpu = inv.cpu || {};
  const up = inv.updates || {};
  const disks = disksOf(inv, si);
  const failed = arr(inv.services?.failed);
  const load = pick(Array.isArray(hb.load) ? hb.load : null, Array.isArray(cpu.load) ? cpu.load : null);
  const uptime = pick(num(hb.uptime), num(oi.uptime_s), num(si.uptime_hours) !== null ? Math.round(si.uptime_hours * 3600) : null);
  const reboot = [up.reboot_required, up.restart_required, inv.windows?.pending_reboot?.any].filter(v => typeof v === 'boolean');
  const docker = inv.docker && typeof inv.docker === 'object' ? inv.docker : null;
  const fullest = disks.reduce((a, d) => (d.percent !== null && (!a || d.percent > a.percent) ? d : a), null);
  const view = {
    cpu_percent: pick(num(hb.cpu), num(cpu.percent)),
    cpu_cores: pick(num(cpu.count), num(si.cpus)),
    cpu_model: pick(cpu.model, si.cpu_model), // the agent does not send a CPU model today
    model: oi.model ?? null,
    load: load ? load.slice(0, 3).map(num) : null,
    ram: ramOf(mem, hb, si),
    swap: swapOf(mem),
    uptime_s: uptime,
    arch: pick(row.arch, oi.arch, si.arch),
    os: row.os ?? inv.os ?? null,
    os_name: pick(oi.name, row.os),
    os_version: pick(oi.version, row.os_version),
    kernel: pick(oi.kernel, oi.build),
    platform: pick(si.platform, oi.pretty),
    ip: pick(row.ip, oi.ip, si.ip),
    disks,
    disk_max_percent: fullest ? fullest.percent : null,
    failed_services_count: Array.isArray(inv.services?.failed) ? failed.length : null,
    docker_running: docker ? num(docker.running) : num(si.docker_running),
    docker_total: docker ? num(docker.total) : num(si.docker_total),
    pending_updates: num(up.pending),
    security_updates: num(up.security),
    reboot_required: reboot.length ? reboot.some(Boolean) : null,
    last_patch: up.last_patch ?? null,
    agent_version: pick(row.agent_version, inv.agent_version),
    last_seen: row.last_seen ?? null,
    online,
    heartbeat_at: hb.ts ?? null,
    inventory_at: row.inventory_at ?? null
  };
  if (!full) return view;
  return { ...view,
    net: arr(inv.net).filter(n => n.iface !== 'lo').map(n => ({ iface: n.iface, rx_bps: num(n.rx_bytes_per_s), tx_bps: num(n.tx_bytes_per_s) })),
    temps: Array.isArray(inv.temps) ? inv.temps.map(t => ({ sensor: t.sensor, celsius: num(t.celsius) })) : null,
    top_processes: arr(inv.procs?.top_cpu).slice(0, 10).map(p => ({ pid: p.pid ?? null, name: p.name ?? null, user: p.user ?? null,
      cpu: num(p.cpu), mem_percent: num(p.mem_percent), rss: num(p.rss) })),
    failed_services: failed.map(s => ({ name: s.name ?? null, state: s.state ?? null, detail: s.detail ?? null })),
    containers: docker ? arr(docker.containers).map(c => ({ name: c.name ?? null, image: c.image ?? null, state: c.state ?? null,
      status: c.status ?? null, health: c.health ?? null, cpu_percent: num(c.cpu_percent), mem_bytes: num(c.mem_bytes) })) : null
  };
}

module.exports = { buildView };
