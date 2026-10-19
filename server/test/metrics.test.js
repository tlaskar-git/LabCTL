// Metric storage, rollups, range queries, inventory slices and the fleet summary.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, login, api, wsOpen, waitFor } = require('./helpers');
const { inventory } = require('./inventory-fixture');

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);          // fixed clock for the storage tests
const iso = ms => new Date(ms).toISOString();
const count = (s, where = '1=1') => s.ctx.db.prepare(`SELECT COUNT(*) AS n FROM metric_points WHERE ${where}`).get().n;

async function setup(t) {
  const s = await startApp();
  t.after(() => s.stop());
  return { s, admin: api(s.base, await login(s.base)), m: s.ctx.metrics };
}

const addHost = (s, id, over = {}) => {
  const h = { id, hostname: `${id}.example.test`, os: 'linux', kind: 'agent', status: 'online', last_seen: iso(Date.now()),
    agent_version: '2.0.0', inventory: null, ...over };
  s.ctx.db.prepare(`INSERT INTO hosts (id, hostname, os, kind, status, last_seen, agent_version, inventory)
    VALUES (@id, @hostname, @os, @kind, @status, @last_seen, @agent_version, @inventory)`).run(h);
};

test('ingest keeps one row per 30 s and carries inventory values into each point', async (t) => {
  const { s, m } = await setup(t);
  m.ingest('h1', { type: 'inventory', data: inventory() }, NOW - 3600000);
  for (let i = 0; i < 120; i++) {
    const at = NOW - 3600000 + i * 30000;
    m.ingest('h1', { type: 'heartbeat', cpu: 10 + (i % 10), ram: 40, load: [0.5, 0.4, 0.3], uptime: 100 }, at);
    m.ingest('h1', { type: 'heartbeat', cpu: 99, ram: 99, load: [9, 9, 9] }, at + 5000); // same 30 s slot: ignored
  }
  assert.equal(count(s), 120);
  const q = m.query('h1', '1h', ['cpu', 'ram', 'swap', 'load1', 'disk', 'rx', 'tx', 'disk:/data', 'net:eth0:rx', 'temp:nvme Composite'], NOW);
  assert.equal(q.step, 30);
  assert.ok(q.ts.length >= 119 && q.ts.length <= 600);
  assert.equal(q.series.cpu[0], 10);
  assert.equal(q.series.ram[5], 40);
  assert.equal(q.series.load1[0], 0.5);
  assert.equal(q.series.swap[0], 12.5);
  assert.equal(q.series.disk[0], 86);        // highest mount
  assert.equal(q.series.rx[0], 120000);      // loopback excluded
  assert.equal(q.series.tx[0], 45000);
  assert.deepEqual(q.series['disk:/data'].filter(v => v !== null), [86]);
  assert.deepEqual(q.series['net:eth0:rx'].filter(v => v !== null), [120000]);
  assert.deepEqual(q.series['temp:nvme Composite'].filter(v => v !== null), [41]);
  assert.ok(q.available.includes('disk:/') && q.available.includes('net:eth0:tx'));
});

test('rollups: 30 s for 24 h, 5 minute to 7 days, 30 minute to 30 days, then gone', async (t) => {
  const { s, m } = await setup(t);
  const beat = (agoMs, cpu) => m.ingest('h1', { type: 'heartbeat', cpu, ram: 50, load: [1] }, NOW - agoMs);
  for (let i = 0; i < 10; i++) beat(2 * 3600000 + i * 30000, 10);              // 2 h ago: stays raw
  for (let i = 0; i < 20; i++) beat(3 * 86400000 + i * 30000, i < 10 ? 20 : 40); // 3 days ago: becomes 5 minute rows
  for (let i = 0; i < 20; i++) beat(10 * 86400000 + i * 30000, 60);            // 10 days ago: becomes 30 minute rows
  for (let i = 0; i < 5; i++) beat(40 * 86400000 + i * 30000, 99);             // 40 days ago: deleted
  m.rollup(NOW);
  assert.equal(count(s, 'res = 30'), 10);
  assert.ok(count(s, 'res = 300') >= 1 && count(s, 'res = 300') <= 3);
  assert.ok(count(s, 'res = 1800') >= 1 && count(s, 'res = 1800') <= 2);
  assert.equal(count(s, `ts < ${Math.floor(NOW / 1000) - 31 * 86400}`), 0);
  const avg = s.ctx.db.prepare('SELECT AVG(cpu) AS a FROM metric_points WHERE res = 300').get().a;
  assert.ok(avg > 20 && avg < 40);
  m.rollup(NOW);                                                                 // idempotent
  assert.equal(count(s, 'res = 30'), 10);

  const week = m.query('h1', '7d', ['cpu'], NOW);
  assert.equal(week.step, 1020);
  assert.ok(week.ts.length <= 600);
  assert.ok(week.series.cpu.some(v => v === 10) || week.series.cpu.some(v => v !== null));
  const month = m.query('h1', '30d', ['cpu'], NOW);
  assert.equal(month.step, 4320);
  assert.ok(month.series.cpu.includes(60) || month.series.cpu.some(v => v === 60), 'the 10 day old rows are still in the 30 day chart');

  s.ctx.settings.set('metrics_days', 5);                                         // retention follows the setting
  m.rollup(NOW);
  assert.equal(count(s, 'res = 1800'), 0);
});

test('API: range and series validation, unknown host, inventory slices', async (t) => {
  const { s, admin } = await setup(t);
  addHost(s, 'h1', { inventory: JSON.stringify(inventory()) });
  assert.equal((await admin('GET', '/api/hosts/nope/metrics')).status, 404);
  assert.equal((await admin('GET', '/api/hosts/h1/metrics?range=2h')).status, 400);
  assert.equal((await admin('GET', '/api/hosts/h1/metrics?series=cpu,evil;drop')).status, 400);
  const ok = await admin('GET', '/api/hosts/h1/metrics?range=1h&series=cpu');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.ts, []);
  const inv = await admin('GET', '/api/hosts/h1/inventory');
  assert.equal(inv.data.data.cpu.count, 8);
  assert.equal((await admin('GET', '/api/hosts/h1/processes')).data.data.top_cpu[0].name, 'dockerd');
  assert.equal((await admin('GET', '/api/hosts/h1/network')).data.data[1].iface, 'eth0');
  assert.equal((await admin('GET', '/api/hosts/h1/updates')).data.data.pending, 7);
  assert.equal((await admin('GET', '/api/hosts/nope/processes')).status, 404);
});

test('a fake agent feeds a heartbeat and an inventory that the API serves', async (t) => {
  const { s, admin } = await setup(t);
  const token = (await admin('POST', '/api/tokens', { label: 'metrics-test' })).data.value;
  const ws = await wsOpen(s.port, token);
  ws.send(JSON.stringify({ type: 'register', host_id: 'fa-1', hostname: 'fake.example.test', os: 'linux', kind: 'agent', agent_version: '2.0.0', info: {} }));
  await waitFor(() => s.ctx.db.prepare("SELECT 1 FROM hosts WHERE id = 'fa-1'").get());
  ws.send(JSON.stringify({ type: 'inventory', host_id: 'fa-1', ts: Date.now(), data: inventory() }));
  await waitFor(() => s.ctx.db.prepare("SELECT inventory FROM hosts WHERE id = 'fa-1'").get().inventory);
  ws.send(JSON.stringify({ type: 'heartbeat', host_id: 'fa-1', agent_version: '2.0.0', ts: Date.now(), cpu: 33, ram: 44, load: [1.5, 1, 1], uptime: 5 }));
  await waitFor(() => count(s, "host_id = 'fa-1'") === 1);
  const q = (await admin('GET', '/api/hosts/fa-1/metrics?range=1h&series=cpu,ram,load1,disk,disk:/')).data;
  const last = k => q.series[k].filter(v => v !== null).pop();
  assert.deepEqual(['cpu', 'ram', 'load1', 'disk'].map(last), [33, 44, 1.5, 86]);
  assert.deepEqual(q.series['disk:/'].filter(v => v !== null), [62]);
  const closed = new Promise(r => ws.on('close', r)); // let the server's close handler run before the database closes
  ws.close();
  await closed;
  await new Promise(r => setTimeout(r, 50));
});

test('fleet summary: totals, offline rule, reboot days, patch rule, 80 percent disk rule, jobs, runners', async (t) => {
  const { s, admin } = await setup(t);
  const day = 86400000;
  const inv = over => JSON.stringify(inventory(over));
  const fine = { updates: { pending: 0, security: 0, reboot_required: false, reboot_pending_days: 0, last_patch: iso(Date.now() - 2 * day), items: [] },
    disks: [{ mount: '/', percent: 80 }], runners: [], services: { failed: [] } };
  addHost(s, 'a-ok', { inventory: inv(fine) });                                      // exactly 80 percent: not counted
  addHost(s, 'b-busy', { os: 'linux', inventory: inv({}), agent_version: '2.0.1' }); // 86 percent, reboot 4 days, 7 pending, runner-b down
  addHost(s, 'c-stale', { os: 'windows', last_seen: iso(Date.now() - 95000), agent_version: '2.0.1',
    inventory: inv({ ...fine, updates: { ...fine.updates, last_patch: iso(Date.now() - 40 * day) }, windows: { pending_reboot: { any: true } } }) });
  addHost(s, 'd-just', { os: 'darwin', last_seen: iso(Date.now() - 85000), agent_version: '2.0.1', inventory: inv(fine) });
  addHost(s, 'e-gone', { os: 'darwin', status: 'offline', last_seen: null, inventory: null, kind: 'ssh' });
  const job = (id, status, completed) => s.ctx.db.prepare("INSERT INTO jobs (id, host_id, type, status, created_at, completed_at) VALUES (?, 'a-ok', 'x', ?, ?, ?)")
    .run(id, status, completed, completed);
  job('j1', 'failed', iso(Date.now() - 3600000));
  job('j2', 'failed', iso(Date.now() - 3 * day));
  job('j3', 'completed', iso(Date.now() - 3600000));
  s.ctx.settings.set('github_queued', 4);

  const f = (await admin('GET', '/api/fleet/summary')).data;
  assert.equal(f.totals.hosts, 5);
  assert.equal(f.totals.online, 3);                                                    // a-ok, b-busy, d-just (85 s)
  assert.equal(f.totals.offline, 2);                                                   // c-stale (95 s), e-gone
  assert.deepEqual(f.totals.by_os, { linux: 2, windows: 1, darwin: 2 });
  assert.deepEqual(f.totals.by_kind, { agent: 4, ssh: 1 });
  assert.deepEqual(f.offline_hosts.map(h => h.host_id).sort(), ['c-stale', 'e-gone']);
  assert.deepEqual(f.pending_reboots.map(h => [h.host_id, h.days]), [['b-busy', 4], ['c-stale', 0]]);
  assert.deepEqual(f.behind_on_patches.map(h => h.host_id).sort(), ['b-busy', 'c-stale']);
  assert.deepEqual(f.disks_over_80.map(d => [d.host_id, d.mount, d.percent]), [['b-busy', '/data', 86]]);
  assert.deepEqual(f.agents_out_of_date.map(h => h.host_id), ['a-ok']);                // newest seen is 2.0.1
  assert.equal(f.jobs_failed_24h, 1);
  assert.deepEqual(f.runners_offline.map(r => [r.host_id, r.runner]), [['b-busy', 'runner-b']]);
  assert.equal(f.queued_runs, 4);
  assert.deepEqual(Object.keys(f.trend), ['ts', 'cpu', 'ram']);
});
