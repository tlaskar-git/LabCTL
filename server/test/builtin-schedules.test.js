// Built-in schedules: idempotent enabling, ring policies, targeting and maintenance skips, cert facts, health report, tick.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, login, api } = require('./helpers');
const healthReport = require('../src/health-report');
const { ringCron } = require('../src/builtin-schedules');

async function setup(t) {
  const s = await startApp();
  t.after(() => s.stop());
  const admin = api(s.base, await login(s.base));
  const t0 = new Date().toISOString();
  const host = (id, os, kind = 'agent', extra = {}) => s.ctx.db.prepare(`INSERT INTO hosts (id, hostname, os, kind, status, last_seen, inventory, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'online', ?, ?, ?, ?)`).run(id, `${id}.example.test`, os, kind, t0, JSON.stringify(extra.inventory || {}), t0, t0);
  const jobsOf = type => s.ctx.db.prepare("SELECT host_id, params FROM jobs WHERE type = ? ORDER BY host_id").all(`template:${type}`);
  return { s, admin, host, jobsOf };
}

test('ringCron moves ring days only for a single weekday', () => {
  assert.equal(ringCron('0 2 * * 2', 0), '0 2 * * 2');
  assert.equal(ringCron('0 2 * * 2', 2), '0 2 * * 4');
  assert.equal(ringCron('0 2 * * 6', 2), '0 2 * * 1');
  assert.equal(ringCron('0 2 * * 1,3', 1), '0 2 * * 1,3');
});

test('the catalogue lists all five built-in schedules, disabled', async (t) => {
  const { admin } = await setup(t);
  const list = (await admin('GET', '/api/builtin-schedules')).data;
  assert.deepEqual(list.map(x => x.key), ['patch_weekly', 'cleanup_weekly', 'mac_monthly', 'health_report', 'cert_expiry']);
  assert.ok(list.every(x => x.enabled === false && x.cron));
});

test('enabling weekly patching is idempotent, needs the typed word, and creates three chained ring policies', async (t) => {
  const { s, admin } = await setup(t);
  const no = await admin('POST', '/api/builtin-schedules/patch_weekly/enable', {});
  assert.equal(no.status, 400);
  assert.equal(no.data.confirm_word, 'patch_weekly');
  for (let i = 0; i < 2; i++) {
    const r = await admin('POST', '/api/builtin-schedules/patch_weekly/enable', { confirm: 'patch_weekly', cron: '30 1 * * 1' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.enabled, true);
  }
  const rings = s.ctx.patching.list().filter(p => p.builtin);
  assert.equal(rings.length, 3, 'a second enable creates no duplicates');
  assert.deepEqual(rings.map(p => p.cron), ['30 1 * * 1', '30 1 * * 2', '30 1 * * 3']);
  assert.ok(rings.every(p => p.enabled && p.next_run));
  assert.deepEqual(rings.map(p => p.rings), [[0], [1], [2]]);
  assert.equal(rings[1].depends_on, rings[0].id);
  assert.equal(rings[2].depends_on, rings[1].id);

  const moved = await admin('PUT', '/api/builtin-schedules/patch_weekly', { cron: '0 3 * * 4' });
  assert.deepEqual(moved.data.policies.map(p => p.cron), ['0 3 * * 4', '0 3 * * 5', '0 3 * * 6']);
  const off = await admin('POST', '/api/builtin-schedules/patch_weekly/disable');
  assert.equal(off.data.enabled, false);
  assert.equal(s.ctx.patching.list().filter(p => p.builtin && p.enabled).length, 0);
  assert.equal(s.ctx.patching.list().filter(p => p.builtin).length, 3, 'disabling keeps the policies');
  assert.equal((await admin('PUT', '/api/builtin-schedules/patch_weekly', { cron: 'nope' })).status, 400);
  assert.equal((await admin('POST', '/api/builtin-schedules/unknown/enable', {})).status, 404);
});

test('cleanup targets runner hosts, mac cleanup targets macOS, maintenance hosts are skipped and counted', async (t) => {
  const { s, admin, host, jobsOf } = await setup(t);
  host('r1', 'linux', 'runner');
  host('r2', 'linux', 'agent', { inventory: { runners: [{ name: 'x' }] } });
  host('r3', 'windows', 'runner');
  host('plain', 'linux');
  host('m1', 'darwin');
  host('m2', 'darwin');
  s.ctx.maintenance = { isInMaintenance: id => id === 'r2' || id === 'm2' };
  const en = await admin('POST', '/api/builtin-schedules/cleanup_weekly/enable', { cron: '0 5 * * 0' });
  assert.equal(en.data.enabled, true);
  assert.equal((await admin('POST', '/api/builtin-schedules/cleanup_weekly/enable', {})).data.cron, '0 5 * * 0', 'enabling again keeps the edited time');
  const run = await admin('POST', '/api/builtin-schedules/cleanup_weekly/run');
  assert.equal(run.status, 200);
  assert.deepEqual(jobsOf('docker_cleanup').map(j => j.host_id), ['r1']);
  assert.deepEqual(jobsOf('runner_cleanup').map(j => j.host_id), ['r1']);
  assert.deepEqual(jobsOf('runner_cleanup_win').map(j => j.host_id), ['r3']);
  assert.equal(JSON.parse(jobsOf('docker_cleanup')[0].params).drain, true);
  assert.match(run.data.result.detail, /3 jobs started, 2 skipped: maintenance/);
  assert.equal(run.data.last_status, 'ok');

  const mac = await admin('POST', '/api/builtin-schedules/mac_monthly/run');
  assert.deepEqual(jobsOf('xcode_cleanup').map(j => j.host_id), ['m1']);
  assert.deepEqual(jobsOf('mac_disk_cleanup').map(j => j.host_id), ['m1']);
  assert.match(mac.data.result.detail, /2 jobs started, 2 skipped: maintenance/);
});

test('certificate check skips an empty domain list, runs on VPS hosts, and feeds the expiry fact', async (t) => {
  const { s, admin, host, jobsOf } = await setup(t);
  host('v1', 'linux', 'vps');
  host('a1', 'linux', 'agent');
  const empty = await admin('POST', '/api/builtin-schedules/cert_expiry/run');
  assert.equal(empty.data.result.status, 'skipped');
  assert.equal(jobsOf('vps_cert_expiry').length, 0);
  await admin('PUT', '/api/settings', { cert_domains: 'a.example.test,b.example.test:8443' });
  const run = await admin('POST', '/api/builtin-schedules/cert_expiry/run');
  assert.equal(run.data.result.status, 'ok');
  const jobs = jobsOf('vps_cert_expiry');
  assert.deepEqual(jobs.map(j => j.host_id), ['v1']);
  const env = JSON.parse(jobs[0].params).env;
  assert.equal(env.LABCTL_P_DOMAINS, 'a.example.test,b.example.test:8443');
  const id = s.ctx.db.prepare("SELECT id FROM jobs WHERE type = 'template:vps_cert_expiry'").get().id;
  s.ctx.joblog.append(id, 'a.example.test: valid until Jan  1 12:00:00 2099 GMT\nb.example.test: valid until Jan  1 12:00:00 2100 GMT\n', { stream: 'stdout', ts: Date.now() });
  s.ctx.jobs.complete(id, 'success', { exit_code: 0 });
  const fact = s.ctx.db.prepare("SELECT value FROM alert_facts WHERE host_id = 'v1' AND key = 'cert_expiry_days'").get();
  assert.ok(Number(fact.value) > 20000, `fact is the soonest expiry in days (${fact && fact.value})`);
});

test('health report: content, escaping, channel choice and failure reporting', async (t) => {
  const { s, admin, host } = await setup(t);
  host('h1', 'linux');
  s.ctx.db.prepare("INSERT INTO hosts (id, hostname, os, kind, status, last_seen, created_at, updated_at) VALUES ('x', '<b>old</b>', 'linux', 'agent', 'offline', NULL, 'a', 'a')").run();
  const calls = [];
  s.ctx.alerting = {
    listAlerts: () => ({ total: 1, rows: [{ severity: 'critical', rule_name: 'Disk full', hostname: 'h1.example.test', message: '95 percent used' }] }),
    notifier: { link: h => `#/${h}`, dispatch: async (payload, ids) => { calls.push({ payload, ids }); return [{ channel_id: 'c1', ok: true }]; } }
  };
  const rep = healthReport.build(s.ctx);
  assert.match(rep.text, /2 hosts, 1 online, 1 offline/);
  assert.match(rep.text, /Offline: <b>old<\/b>/);
  assert.match(rep.text, /CRITICAL Disk full on h1\.example\.test: 95 percent used/);
  assert.match(rep.text, /0 failed in the last 24 hours/);
  assert.ok(rep.html.includes('&lt;b&gt;old&lt;/b&gt;') && !rep.html.includes('<b>old</b>'), 'html escapes host names');
  assert.equal(rep.severity, 'warning');

  await admin('PUT', '/api/settings', { health_report_channels: ['c1'] });
  const run = await admin('POST', '/api/builtin-schedules/health_report/run');
  assert.equal(run.data.result.status, 'ok');
  assert.deepEqual(calls[0].ids, ['c1']);
  assert.equal(calls[0].payload.rule, 'Daily health report');

  s.ctx.alerting.notifier.dispatch = async () => [];
  const none = await admin('POST', '/api/builtin-schedules/health_report/run');
  assert.equal(none.data.result.status, 'error');
  assert.match(none.data.result.detail, /No enabled channel/);
  s.ctx.alerting = null;
  const gone = await healthReport.send(s.ctx);
  assert.equal(gone.ok, false);
  assert.match(gone.error, /not available/);
  assert.match(healthReport.build(s.ctx).text, /Alerting is not available/);
});

test('tick runs a due schedule, records a missed one and moves next_run', async (t) => {
  const { s, admin, host, jobsOf } = await setup(t);
  host('m1', 'darwin');
  await admin('POST', '/api/builtin-schedules/mac_monthly/enable', {});
  const db = s.ctx.db;
  const at = new Date();
  db.prepare("UPDATE builtin_schedules SET next_run = ? WHERE key = 'mac_monthly'").run(new Date(at.getTime() - 5000).toISOString());
  await s.ctx.builtins.tick(at);
  assert.equal(jobsOf('xcode_cleanup').length, 1);
  const row = db.prepare("SELECT * FROM builtin_schedules WHERE key = 'mac_monthly'").get();
  assert.equal(row.last_status, 'ok');
  assert.ok(row.next_run > at.toISOString());
  db.prepare("UPDATE builtin_schedules SET next_run = ? WHERE key = 'mac_monthly'").run(new Date(at.getTime() - 3600000).toISOString());
  await s.ctx.builtins.tick(at);
  assert.equal(jobsOf('xcode_cleanup').length, 1, 'a late run is not caught up');
  assert.equal(db.prepare("SELECT missed_count FROM builtin_schedules WHERE key = 'mac_monthly'").get().missed_count, 1);
});
