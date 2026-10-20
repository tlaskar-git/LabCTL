// Built-in schedules: idempotent enabling, ring policies, targeting and maintenance skips, cert facts, health report, tick.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startApp, login, api, tempDir } = require('./helpers');
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

test('a built-in can be edited, removed, restored and reset; the list keeps factory order then custom entries', async (t) => {
  const { s, admin, host, jobsOf } = await setup(t);
  host('m1', 'darwin');
  host('l1', 'linux');
  s.ctx.db.prepare("INSERT INTO tags (id, name) VALUES ('t1', 'macs')").run();
  s.ctx.db.prepare("INSERT INTO host_tags (host_id, tag_id) VALUES ('m1', 't1')").run();
  const ed = await admin('PUT', '/api/builtin-schedules/mac_monthly', { name: 'Mac tidy', cron: '15 5 2 * *', scope: { tags: ['macs'] },
    steps: [{ template: 'xcode_cleanup', params: { DAYS: 10 } }] });
  assert.equal(ed.status, 200, JSON.stringify(ed.data));
  assert.equal(ed.data.name, 'Mac tidy');
  assert.equal(ed.data.edited, true);
  assert.deepEqual(ed.data.templates, ['xcode_cleanup']);

  const on = await admin('POST', '/api/builtin-schedules/mac_monthly/enable', {});
  assert.equal(on.data.cron, '15 5 2 * *', 'enabling uses the edited time');
  assert.equal(s.ctx.db.prepare("SELECT cron FROM builtin_schedules WHERE key = 'mac_monthly'").get().cron, '15 5 2 * *');
  await admin('POST', '/api/builtin-schedules/mac_monthly/run');
  const jobs = jobsOf('xcode_cleanup');
  assert.deepEqual(jobs.map(j => j.host_id), ['m1'], 'the edited scope picks the hosts');
  assert.equal(JSON.parse(jobs[0].params).env.LABCTL_P_DAYS, '10');
  assert.equal(jobsOf('mac_disk_cleanup').length, 0, 'the removed step does not run');

  const rm = await admin('DELETE', '/api/builtin-schedules/mac_monthly');
  assert.equal(rm.status, 200);
  assert.equal(s.ctx.db.prepare("SELECT * FROM builtin_schedules WHERE key = 'mac_monthly'").get(), undefined, 'remove disables it and deletes its row');
  assert.ok(!(await admin('GET', '/api/builtin-schedules')).data.some(x => x.key === 'mac_monthly'));
  assert.deepEqual((await admin('GET', '/api/builtin-schedules?removed=1')).data.map(x => x.key), ['mac_monthly']);
  assert.equal((await admin('POST', '/api/builtin-schedules/mac_monthly/run')).status, 404);

  const back = await admin('POST', '/api/builtin-schedules/mac_monthly/restore');
  assert.equal(back.status, 200);
  assert.equal(back.data.name, 'Monthly Mac and Xcode cleanup', 'restore brings back the factory definition');
  assert.equal(back.data.edited, false);
  assert.equal(back.data.enabled, false);

  await admin('PUT', '/api/builtin-schedules/cleanup_weekly', { description: 'Changed', cron: '0 6 * * 0' });
  await admin('POST', '/api/builtin-schedules/cleanup_weekly/enable', {});
  const reset = await admin('POST', '/api/builtin-schedules/cleanup_weekly/reset');
  assert.equal(reset.data.edited, false);
  assert.equal(reset.data.cron, '0 3 * * 0');
  assert.match(reset.data.description, /runner work folders/);
  assert.equal(reset.data.enabled, true, 'reset keeps it switched on');

  const c = await admin('POST', '/api/builtin-schedules', { name: 'Linux tidy', cron: '0 1 * * *', scope: { os: ['linux'] }, steps: [{ template: 'docker_cleanup', params: {} }] });
  const keys = (await admin('GET', '/api/builtin-schedules')).data.map(x => x.key);
  assert.deepEqual(keys, ['patch_weekly', 'cleanup_weekly', 'mac_monthly', 'health_report', 'cert_expiry', c.data.key]);
});

test('custom entries: create, validate, enable through the same tick, edit, and delete with the name typed', async (t) => {
  const { s, admin, host, jobsOf } = await setup(t);
  host('l1', 'linux');
  host('w1', 'windows');
  assert.equal((await admin('POST', '/api/builtin-schedules', { name: 'x', cron: '0 1 * * *', scope: {}, steps: [{ template: 'docker_cleanup' }] })).status, 400, 'an empty scope is refused');
  assert.equal((await admin('POST', '/api/builtin-schedules', { name: 'x', cron: '0 1 * * *', scope: { all: true }, steps: [{ template: 'nope' }] })).status, 400);
  assert.equal((await admin('POST', '/api/builtin-schedules', { name: 'x', cron: 'bad', scope: { all: true }, steps: [{ template: 'docker_cleanup' }] })).status, 400);
  assert.equal((await admin('POST', '/api/builtin-schedules', { name: 'x', cron: '0 1 * * *', scope: { all: true }, steps: [{ template: 'docker_cleanup', params: { HOURS: 'many' } }] })).status, 400);

  const c = await admin('POST', '/api/builtin-schedules', { name: 'Nightly tidy', description: 'Docker on all hosts', cron: '0 1 * * *',
    scope: { all: true }, steps: [{ template: 'docker_cleanup', params: { HOURS: 48 } }] });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.match(c.data.key, /^custom-[0-9a-f]{12}$/);
  assert.equal(c.data.custom, true);
  assert.equal(c.data.guarded, false);
  const key = c.data.key;

  await admin('POST', `/api/builtin-schedules/${key}/enable`, {});
  const db = s.ctx.db;
  const at = new Date();
  db.prepare('UPDATE builtin_schedules SET next_run = ? WHERE key = ?').run(new Date(at.getTime() - 5000).toISOString(), key);
  await s.ctx.builtins.tick(at);
  assert.deepEqual(jobsOf('docker_cleanup').map(j => j.host_id), ['l1'], 'the scheduler runs it; the OS filter of the template still applies');
  assert.equal(JSON.parse(jobsOf('docker_cleanup')[0].params).env.LABCTL_P_HOURS, '48');
  db.prepare('UPDATE builtin_schedules SET next_run = ? WHERE key = ?').run(new Date(at.getTime() - 3600000).toISOString(), key);
  await s.ctx.builtins.tick(at);
  assert.equal(db.prepare('SELECT missed_count FROM builtin_schedules WHERE key = ?').get(key).missed_count, 1, 'a missed run is recorded');

  const ed = await admin('PUT', `/api/builtin-schedules/${key}`, { cron: '30 2 * * 1', scope: { hosts: ['w1'] }, steps: [{ template: 'runner_cleanup_win', params: {} }] });
  assert.equal(ed.data.cron, '30 2 * * 1');
  assert.ok(ed.data.next_run, 'an enabled entry gets a new next run');
  await admin('POST', `/api/builtin-schedules/${key}/run`);
  assert.deepEqual(jobsOf('runner_cleanup_win').map(j => j.host_id), ['w1']);

  const no = await admin('DELETE', `/api/builtin-schedules/${key}`, {});
  assert.equal(no.status, 400);
  assert.equal(no.data.confirm_word, 'Nightly tidy');
  assert.equal((await admin('DELETE', `/api/builtin-schedules/${key}`, { confirm: 'Nightly tidy' })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM custom_builtin_schedules').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM builtin_schedules WHERE key = ?').get(key).n, 0);
  assert.equal((await admin('GET', `/api/builtin-schedules/${key}`)).status, 404);
});

test('weekly patching edits change its ring policies; removing it deletes them only with DELETE typed', async (t) => {
  const { s, admin } = await setup(t);
  const pre = await admin('PUT', '/api/builtin-schedules/patch_weekly', { patch: { update_type: 'all', reboot: { mode: 'never', delay_min: 0 }, drain: { enabled: false } } });
  assert.equal(pre.status, 200, JSON.stringify(pre.data));
  await admin('POST', '/api/builtin-schedules/patch_weekly/enable', { confirm: 'patch_weekly' });
  let rings = s.ctx.patching.list().filter(p => p.builtin);
  assert.ok(rings.every(p => p.update_type === 'all' && p.reboot.mode === 'never'), 'policies are created with the edited settings');

  const ed = await admin('PUT', '/api/builtin-schedules/patch_weekly', { cron: '0 4 * * 1',
    patch: { update_type: 'security', reboot: { mode: 'if_required', delay_min: 5 }, drain: { enabled: true }, names: ['R0', 'R1', 'R2'] } });
  assert.equal(ed.status, 200, JSON.stringify(ed.data));
  rings = s.ctx.patching.list().filter(p => p.builtin).sort((a, b) => a.builtin.localeCompare(b.builtin));
  assert.deepEqual(rings.map(p => p.name), ['R0', 'R1', 'R2']);
  assert.deepEqual(rings.map(p => p.cron), ['0 4 * * 1', '0 4 * * 2', '0 4 * * 3']);
  assert.ok(rings.every(p => p.update_type === 'security' && p.reboot.delay_min === 5 && p.drain.enabled && p.enabled));
  assert.equal(rings[1].depends_on, rings[0].id, 'a failed ring still stops the next');
  assert.equal(rings[2].depends_on, rings[1].id);
  assert.equal((await admin('PUT', '/api/builtin-schedules/patch_weekly', { patch: { update_type: 'everything' } })).status, 400);

  const no = await admin('DELETE', '/api/builtin-schedules/patch_weekly', {});
  assert.equal(no.status, 400);
  assert.equal(no.data.confirm_word, 'DELETE');
  assert.equal(s.ctx.patching.list().filter(p => p.builtin).length, 3);
  assert.equal((await admin('DELETE', '/api/builtin-schedules/patch_weekly', { confirm: 'DELETE' })).status, 200);
  assert.equal(s.ctx.patching.list().filter(p => p.builtin).length, 0);
  const back = await admin('POST', '/api/builtin-schedules/patch_weekly/restore');
  assert.equal(back.data.patch.update_type, 'security');
  assert.equal(back.data.enabled, false);
});

test('roles: viewers read, operators enable and run, admins edit and delete', async (t) => {
  const { s, admin } = await setup(t);
  await admin('POST', '/api/users', { username: 'viewer1', password: 'pw-viewer-1', role: 'viewer' });
  await admin('POST', '/api/users', { username: 'op1', password: 'pw-operator-1', role: 'operator' });
  const viewer = api(s.base, await login(s.base, 'viewer1', 'pw-viewer-1'));
  const op = api(s.base, await login(s.base, 'op1', 'pw-operator-1'));
  assert.equal((await viewer('GET', '/api/builtin-schedules')).status, 200);
  assert.equal((await viewer('GET', '/api/builtin-schedules/cert_expiry')).status, 200);
  assert.equal((await viewer('POST', '/api/builtin-schedules/cert_expiry/enable', {})).status, 403);
  assert.equal((await viewer('PUT', '/api/builtin-schedules/cert_expiry', { name: 'x' })).status, 403);
  assert.equal((await op('POST', '/api/builtin-schedules/cert_expiry/enable', {})).status, 200);
  assert.equal((await op('POST', '/api/builtin-schedules/cert_expiry/run')).status, 200);
  assert.equal((await op('POST', '/api/builtin-schedules/cert_expiry/disable')).status, 200);
  for (const [m, p, b] of [['PUT', '/api/builtin-schedules/cert_expiry', { name: 'x' }], ['DELETE', '/api/builtin-schedules/cert_expiry', {}],
    ['POST', '/api/builtin-schedules/cert_expiry/reset'], ['POST', '/api/builtin-schedules', { name: 'x' }]]) {
    assert.equal((await op(m, p, b)).status, 403, `${m} ${p}`);
  }
  assert.equal((await admin('PUT', '/api/builtin-schedules/cert_expiry', { name: 'Certificates' })).status, 200);
  assert.equal((await admin('DELETE', '/api/builtin-schedules/cert_expiry', {})).status, 200);
});

test('a removed template fails the run with a clear message and flags the entry', async (t) => {
  const { s, admin, host } = await setup(t);
  host('l1', 'linux');
  const c = await admin('POST', '/api/builtin-schedules', { name: 'Tidy', cron: '0 1 * * *', scope: { all: true }, steps: [{ template: 'docker_cleanup', params: {} }] });
  const byId = s.ctx.templates.catalogue.byId;
  const tpl = byId.get('docker_cleanup');
  byId.delete('docker_cleanup');
  t.after(() => byId.set('docker_cleanup', tpl));
  const list = (await admin('GET', '/api/builtin-schedules')).data;
  assert.deepEqual(list.find(x => x.key === c.data.key).missing_templates, ['docker_cleanup']);
  assert.deepEqual(list.find(x => x.key === 'cleanup_weekly').missing_templates, ['docker_cleanup']);
  const run = await admin('POST', `/api/builtin-schedules/${c.data.key}/run`);
  assert.equal(run.data.result.status, 'error');
  assert.equal(run.data.result.detail, 'Template docker_cleanup was removed');
  assert.equal(s.ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type LIKE 'template:%'").get().n, 0, 'no step starts');
});

test('audit rows name the key and the changed fields only', async (t) => {
  const { s, admin } = await setup(t);
  const c = await admin('POST', '/api/builtin-schedules', { name: 'Audit me', cron: '0 1 * * *', scope: { all: true },
    steps: [{ template: 'docker_cleanup', params: { RUN_USER: 'marker-value-1' } }] });
  await admin('PUT', `/api/builtin-schedules/${c.data.key}`, { steps: [{ template: 'docker_cleanup', params: { RUN_USER: 'marker-value-2' } }] });
  await admin('PUT', '/api/builtin-schedules/health_report', { health: { channels: ['c1'], sections: ['Fleet'] } });
  await admin('DELETE', '/api/builtin-schedules/health_report', {});
  await admin('POST', '/api/builtin-schedules/health_report/restore');
  await admin('DELETE', `/api/builtin-schedules/${c.data.key}`, { confirm: 'Audit me' });
  const rows = s.ctx.db.prepare("SELECT actor, action, detail FROM audit_log WHERE action LIKE 'builtin_schedule.%' ORDER BY id").all();
  assert.deepEqual(rows.map(r => r.action), ['builtin_schedule.create', 'builtin_schedule.edit', 'builtin_schedule.edit', 'builtin_schedule.hide',
    'builtin_schedule.restore', 'builtin_schedule.delete']);
  assert.ok(rows.every(r => r.actor === 'LabCTLAdmin'));
  assert.deepEqual(JSON.parse(rows[1].detail), { schedule: c.data.key, fields: ['steps'] });
  assert.ok(rows.every(r => !r.detail.includes('marker-value')), 'parameter values stay out of these rows');
});

test('health report edits choose the channels and the sections', async (t) => {
  const { s, admin } = await setup(t);
  const calls = [];
  s.ctx.alerting = { stop() {}, listAlerts: () => ({ total: 0, rows: [] }),
    notifier: { link: h => `#/${h}`, dispatch: async (payload, ids) => { calls.push({ payload, ids }); return [{ ok: true }]; } } };
  assert.equal((await admin('PUT', '/api/builtin-schedules/health_report', { health: { sections: ['Nope'] } })).status, 400);
  await admin('PUT', '/api/builtin-schedules/health_report', { health: { channels: ['c9'], sections: ['Fleet', 'Jobs'] } });
  const run = await admin('POST', '/api/builtin-schedules/health_report/run');
  assert.equal(run.data.result.status, 'ok');
  assert.deepEqual(calls[0].ids, ['c9']);
  assert.match(calls[0].payload.message, /FLEET/);
  assert.doesNotMatch(calls[0].payload.message, /COMPLIANCE|ALERTS/);
});

test('the preview lists the next three runs and refuses a bad cron', async (t) => {
  const { admin } = await setup(t);
  const p = await admin('GET', '/api/builtin-schedules/preview?cron=' + encodeURIComponent('0 7 * * *'));
  assert.equal(p.data.runs.length, 3);
  assert.ok(p.data.timezone);
  assert.equal(Date.parse(p.data.runs[1]) - Date.parse(p.data.runs[0]), 86400000);
  assert.equal((await admin('GET', '/api/builtin-schedules/preview?cron=nope')).status, 400);
});

test('edits, hides and custom entries survive a restart', async (t) => {
  const dataDir = tempDir();
  let s = await startApp({ dataDir });
  t.after(async () => { await s.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  let admin = api(s.base, await login(s.base));
  await admin('PUT', '/api/builtin-schedules/cert_expiry', { name: 'Certificates' });
  await admin('DELETE', '/api/builtin-schedules/mac_monthly', {});
  const c = await admin('POST', '/api/builtin-schedules', { name: 'Kept', cron: '0 1 * * *', scope: { all: true }, steps: [{ template: 'docker_cleanup' }] });
  await admin('POST', `/api/builtin-schedules/${c.data.key}/enable`, {});
  await s.close();
  s = await startApp({ dataDir });
  admin = api(s.base, await login(s.base));
  const list = (await admin('GET', '/api/builtin-schedules')).data;
  assert.equal(list.find(x => x.key === 'cert_expiry').name, 'Certificates');
  assert.ok(!list.some(x => x.key === 'mac_monthly'));
  assert.equal(list.find(x => x.key === c.data.key).enabled, true);
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
