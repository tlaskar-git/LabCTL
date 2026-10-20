// host.view (src/host-view.js) over synthetic payloads with the same shapes real agents send per OS, plus the API output.
// Placeholders only: example.test names, 192.0.2.x addresses, made-up numbers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildView } = require('../src/host-view');
const { check } = require('./host-view-check');
const { startApp, login, api } = require('./helpers');

const GB = 1024 ** 3;
const osInfo = (o = {}) => ({ name: 'Debian GNU/Linux', version: '12', build: null, pretty: 'Debian GNU/Linux 12', kernel: '6.1.0-example', arch: 'x86_64',
  model: 'Example Virtual Machine', domain: 'example.test', ip: '192.0.2.21', boot_time: '2026-10-17T06:00:00Z', uptime_s: 250000, ...o });
const si = (o = {}) => JSON.stringify({ cpus: 4, ram_total: 8 * GB, ip: '192.0.2.21', platform: 'Linux-6.1.0-example-x86_64', python: '3.11.2', install_dir: '/opt/labctl', ...o });
const disk = (mount, totalGb, usedGb, o = {}) => ({ device: `/dev/${mount.replace(/\W/g, '') || 'root'}`, mount, fstype: 'ext4', total: totalGb * GB, used: usedGb * GB,
  free: (totalGb - usedGb) * GB, percent: Math.round((usedGb / totalGb) * 1000) / 10, inodes_total: 1000, inodes_used: 100, inodes_percent: 10, ...o });

// Linux / Proxmox shape: swap_total 0 with swap_percent null, a proxmox key, heartbeat with a load array.
const linux = {
  id: 'fx-linux', hostname: 'alpha.example.test', os: 'linux', ip: '192.0.2.21', kind: 'agent', status: 'online', last_seen: '2026-10-20T10:00:00Z',
  agent_version: '2.0.0', os_version: 'Debian GNU/Linux 12', arch: 'x86_64', system_info: si(), inventory_at: '2026-10-20T09:58:00Z',
  heartbeat: JSON.stringify({ cpu: 5.2, ram: 60, load: [1.5, 1.25, 1], uptime: 251000, ts: '2026-10-20T10:00:00Z' }),
  inventory: JSON.stringify({ schema: 2, agent_version: '2.0.0', os: 'linux', hostname: 'alpha.example.test', errors: {}, os_info: osInfo(),
    cpu: { count: 4, percent: 7.5, load: [1.4, 1.2, 1] },
    memory: { total: 8 * GB, used: 4 * GB, available: 4 * GB, percent: 50, swap_total: 0, swap_used: 0, swap_percent: null },
    disks: [disk('/', 100, 40), disk('/var/lib/vz', 400, 360)],
    net: [{ iface: 'lo', rx_bytes: 1, tx_bytes: 1, rx_bytes_per_s: 1, tx_bytes_per_s: 1 }, { iface: 'vmbr0', rx_bytes: 9e9, tx_bytes: 4e9, rx_bytes_per_s: 1200, tx_bytes_per_s: 800 }],
    temps: [{ sensor: 'coretemp Package id 0', celsius: 48 }], smart: [{ device: '/dev/sda', health: 'ok', detail: null }],
    procs: { top_cpu: [{ pid: 10, user: 'root', name: 'pvestatd', cpu: 3, mem_percent: 1, rss: 1e8 }], top_mem: [] },
    services: { failed: [{ name: 'example.service', state: 'failed', detail: 'exit 1' }] },
    updates: { pending: 3, security: 1, restart_required: null, reboot_required: false, reboot_pending_days: null, last_patch: '2026-10-01T03:00:00Z', items: [] },
    time: { drift_s: 0.1, source: 'chrony', synced: true }, security: { firewall: null },
    proxmox: { version: '8.2', zpool_healthy: true, zpools: [], arc_bytes: 1, arc_max_bytes: 2, vms: [], containers: [] },
    docker: { running: 1, total: 2, containers: [{ id: 'a1', name: 'web', image: 'example/web:1', state: 'running', status: 'Up', health: 'healthy', restart_count: 0, cpu_percent: 1, mem_bytes: 1e8, mem_percent: 1 },
      { id: 'b2', name: 'old', image: 'example/old:1', state: 'exited', status: 'Exited (1)', health: null, restart_count: 4, cpu_percent: 0, mem_bytes: 0, mem_percent: 0 }] },
    runners: [] })
};

// Windows shape: heartbeat load null, cpu.load null, temps null, inodes null, procs user null, windows.pending_reboot.
const windows = {
  id: 'fx-win', hostname: 'beta.example.test', os: 'windows', ip: '192.0.2.22', kind: 'agent', status: 'online', last_seen: '2026-10-20T10:00:00Z',
  agent_version: '2.0.0', os_version: 'Windows Server 2022', arch: 'AMD64', system_info: si({ cpus: 8, ram_total: 16 * GB, platform: 'Windows-10-10.0.20348' }),
  heartbeat: JSON.stringify({ cpu: 12, ram: 40, load: null, uptime: 90000, ts: '2026-10-20T10:00:00Z' }),
  inventory: JSON.stringify({ schema: 2, os: 'windows', errors: {}, os_info: osInfo({ name: 'Windows Server 2022', version: '10.0.20348', build: '20348', arch: 'AMD64', uptime_s: 89000 }),
    cpu: { count: 8, percent: 11, load: null },
    memory: { total: 16 * GB, used: 6 * GB, available: 10 * GB, percent: 37.5, swap_total: 2 * GB, swap_used: GB, swap_percent: 50 },
    disks: [disk('C:\\', 120, 60, { device: 'C:\\', fstype: 'NTFS', inodes_total: null, inodes_used: null, inodes_percent: null })],
    net: [{ iface: 'Ethernet', rx_bytes: 1, tx_bytes: 1, rx_bytes_per_s: 10, tx_bytes_per_s: 20 }], temps: null, smart: [],
    procs: { top_cpu: [{ pid: 4, user: null, name: 'System', cpu: 1, mem_percent: null, rss: 1e6 }], top_mem: [] },
    services: { failed: [] }, updates: { pending: 2, security: null, restart_required: false, reboot_required: false, reboot_pending_days: null, last_patch: '2026-10-10T00:00:00Z', items: ['KB0000001'] },
    security: { defender: { realtime: true } }, windows: { pending_reboot: { file_rename: false, wu: false, cbs: true, any: true }, failed_tasks: [] },
    time: { drift_s: 0, source: 'w32tm', synced: true }, docker: null, runners: [] })
};

// macOS shape: fstype null, domain null, page_size and encrypted in memory, darwin key.
const mac = {
  id: 'fx-mac', hostname: 'gamma.example.test', os: 'darwin', ip: '192.0.2.23', kind: 'agent', status: 'offline', last_seen: '2026-10-19T10:00:00Z',
  agent_version: '2.0.0', os_version: '15.0', arch: 'arm64', system_info: si({ cpus: 10, ram_total: 32 * GB, platform: 'macOS-15.0-arm64' }),
  heartbeat: JSON.stringify({ cpu: 20, ram: 70, load: [2, 2, 2], uptime: 500000, ts: '2026-10-19T10:00:00Z' }),
  inventory: JSON.stringify({ schema: 2, os: 'darwin', errors: {}, os_info: osInfo({ name: 'macOS', version: '15.0', pretty: undefined, arch: 'arm64', model: 'ExampleBook1,1', domain: null }),
    cpu: { count: 10, percent: 18, load: [2, 2, 2] },
    memory: { total: 32 * GB, used: 20 * GB, available: 12 * GB, percent: 62, page_size: 16384, swap_total: 2 * GB, swap_used: 0, swap_percent: 0, encrypted: true },
    disks: [disk('/', 500, 200, { device: '/dev/disk3s1', fstype: null }), disk('/System/Volumes/Data', 500, 300, { device: '/dev/disk3s5', fstype: null })],
    net: [], temps: null, smart: [], procs: { top_cpu: [], top_mem: [] }, services: { failed: [] },
    updates: { pending: 0, security: null, restart_required: false, reboot_required: null, last_patch: '2026-10-01T00:00:00Z', items: [] },
    security: { filevault: true, firewall: true, gatekeeper: true, sip: true }, darwin: { softwareupdate: { pending: 0 } }, docker: null, runners: [] })
};

// v1 / agentless ssh poll shape: system_info carries ram_mb, drives in GB and uptime_hours; no inventory.
const ssh = {
  id: 'fx-ssh', hostname: 'delta.example.test', os: 'linux', ip: '192.0.2.24', kind: 'ssh', status: 'online', last_seen: '2026-10-20T10:00:00Z',
  agent_version: null, os_version: null, arch: null, inventory: null,
  heartbeat: JSON.stringify({ cpu: null, ram: 25, load: [0.1, 0.2, 0.3], uptime: 7200, ts: '2026-10-20T10:00:00Z' }),
  system_info: JSON.stringify({ ram_mb: 4096, ram_available_mb: 3072, uptime_hours: 2, drives: [{ device: '/', mount: '/', total_gb: 50, used_gb: 10, free_gb: 40, percent: 20 }] })
};

const empty = { id: 'fx-new', hostname: 'epsilon.example.test', os: 'linux', kind: 'agent', status: 'offline', system_info: '{}', inventory: null, heartbeat: null };

test('host view: Linux and Proxmox shape', () => {
  const v = buildView(linux, { full: true, online: true });
  assert.equal(v.cpu_percent, 5.2); // heartbeat wins over the older inventory value
  assert.equal(v.cpu_cores, 4);
  assert.deepEqual(v.load, [1.5, 1.25, 1]);
  assert.deepEqual(v.ram, { used: Math.round(8 * GB * 0.6), total: 8 * GB, percent: 60 }); // heartbeat percent with inventory total
  assert.deepEqual(v.swap, { used: 0, total: 0, percent: null });
  assert.equal(v.uptime_s, 251000);
  assert.equal(v.arch, 'x86_64');
  assert.equal(v.os_name, 'Debian GNU/Linux');
  assert.equal(v.os_version, '12');
  assert.equal(v.disks.length, 2);
  assert.deepEqual(v.disks[1], { mount: '/var/lib/vz', device: '/dev/varlibvz', fs: 'ext4', total: 400 * GB, used: 360 * GB, free: 40 * GB, percent: 90, inodes_percent: 10 });
  assert.equal(v.disk_max_percent, 90);
  assert.deepEqual(v.net, [{ iface: 'vmbr0', rx_bps: 1200, tx_bps: 800 }]);
  assert.equal(v.failed_services_count, 1);
  assert.equal(v.docker_running, 1);
  assert.equal(v.containers.length, 2);
  assert.equal(v.reboot_required, false);
  assert.equal(v.pending_updates, 3);
  assert.equal(v.cpu_model, null); // the agent sends no CPU model: null, not invented
  assert.equal(v.online, true);
});

test('host view: Windows shape', () => {
  const v = buildView(windows, { full: true });
  assert.equal(v.load, null);
  assert.equal(v.cpu_cores, 8);
  assert.equal(v.ram.total, 16 * GB);
  assert.equal(v.ram.percent, 40);
  assert.deepEqual(v.swap, { used: GB, total: 2 * GB, percent: 50 });
  assert.equal(v.disks[0].mount, 'C:\\');
  assert.equal(v.disks[0].inodes_percent, null);
  assert.equal(v.temps, null);
  assert.equal(v.arch, 'AMD64');
  assert.equal(v.uptime_s, 90000);
  assert.equal(v.reboot_required, true); // from windows.pending_reboot.any
  assert.equal(v.docker_total, null);
  assert.equal(v.containers, null);
});

test('host view: macOS shape', () => {
  const v = buildView(mac, { full: true, online: false });
  assert.equal(v.arch, 'arm64');
  assert.equal(v.model, 'ExampleBook1,1');
  assert.equal(v.ram.percent, 70);
  assert.equal(v.disks[0].fs, null);
  assert.equal(v.disk_max_percent, 60);
  assert.equal(v.uptime_s, 500000);
  assert.equal(v.heartbeat_at, '2026-10-19T10:00:00Z');
});

test('host view: v1 and agentless ssh shape', () => {
  const v = buildView(ssh);
  assert.equal(v.ram.total, 4096 * 1048576);
  assert.equal(v.ram.percent, 25);
  assert.equal(v.cpu_percent, null);
  assert.equal(v.uptime_s, 7200);
  assert.equal(v.disks[0].total, 50 * GB);
  assert.equal(v.disks[0].percent, 20);
});

test('host view: a host with no data gives nulls, never invented values', () => {
  const v = buildView(empty);
  for (const k of ['cpu_percent', 'cpu_cores', 'load', 'uptime_s', 'arch', 'ip', 'reboot_required', 'pending_updates', 'disk_max_percent']) assert.equal(v[k], null, k);
  assert.deepEqual(v.ram, { used: null, total: null, percent: null });
  assert.deepEqual(v.disks, []);
  assert.equal('containers' in v, false); // light view
});

test('host view check: every field the fixtures carry is shown', () => {
  const r = check([linux, windows, mac, ssh, empty]);
  assert.deepEqual(r.missing, []);
  assert.equal(r.counts.ram.shown, 4);
  assert.equal(r.counts.disks.shown, 4);
  assert.equal(r.counts.load.shown, 3);
});

test('API: hosts list, host detail and health rows carry the view', async () => {
  const s = await startApp();
  try {
    const admin = api(s.base, await login(s.base));
    const ins = s.ctx.db.prepare(`INSERT INTO hosts (id, hostname, os, ip, kind, status, last_seen, agent_version, os_version, arch, system_info, inventory, inventory_at, heartbeat)
      VALUES (@id, @hostname, @os, @ip, @kind, @status, @last_seen, @agent_version, @os_version, @arch, @system_info, @inventory, @inventory_at, @heartbeat)`);
    for (const h of [linux, windows, mac, empty]) ins.run({ ip: null, last_seen: null, agent_version: null, os_version: null, arch: null, inventory_at: null, ...h });

    const list = await admin('GET', '/api/hosts');
    assert.equal(list.status, 200);
    const byId = Object.fromEntries(list.data.map(h => [h.id, h]));
    assert.equal(byId['fx-linux'].view.ram.percent, 60);
    assert.equal(byId['fx-linux'].view.disks.length, 2);
    assert.equal(byId['fx-win'].view.arch, 'AMD64');
    assert.equal(byId['fx-mac'].view.uptime_s, 500000);
    assert.equal(byId['fx-linux'].view.containers, undefined); // light in the list
    assert.ok(byId['fx-linux'].system_info && byId['fx-linux'].inventory, 'raw fields kept for compatibility');

    const one = await admin('GET', '/api/hosts/fx-linux');
    assert.equal(one.status, 200);
    assert.equal(one.data.view.containers.length, 2);
    assert.equal(one.data.view.top_processes[0].name, 'pvestatd');
    assert.equal((await admin('GET', '/api/hosts/nope')).status, 404);
    // macOS mount paths can pass 100 characters; the Metrics tab asks for one series per mount.
    const longMount = encodeURIComponent(`disk:/Library/Developer/CoreSimulator/Volumes/${'x'.repeat(110)}`);
    assert.equal((await admin('GET', `/api/hosts/fx-mac/metrics?range=24h&series=${longMount}`)).status, 200);

    const health = await admin('GET', '/api/health/hosts');
    assert.equal(health.status, 200);
    const lh = health.data.find(h => h.host_id === 'fx-linux');
    assert.equal(lh.view.cpu_percent, 5.2);
    assert.equal(lh.view.docker_problems, 1);
    assert.ok(lh.criticals.includes('Disk at 90%'));
    assert.ok(lh.criticals.includes('1 failed service(s)'));
    assert.equal(health.data.find(h => h.host_id === 'fx-new').view.ram.percent, null);
  } finally { await s.stop(); }
});
