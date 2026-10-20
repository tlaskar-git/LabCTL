// Alert engine, default rule pack, maintenance windows and notification channels. Uses local mock servers only.
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { startApp, login, api } = require('./helpers');
const { smtpSend, buildMail, validate, merge, mask } = require('../src/alerting/notify');
const { toCron, fromCron } = require('../src/alerting/maintenance');

const GB = 1024 ** 3;
const MIN = 60000;
const T0 = Date.parse('2026-10-20T10:00:00Z');

// ---- mock servers -------------------------------------------------------------------------------------------------

function fakeSmtp({ auth = null, user = 'relay-user', pass = 'relay-pass' } = {}) {
  const mails = [];
  const server = net.createServer(sock => {
    let mode = 'cmd';
    let cur = { rcpt: [] };
    let data = '';
    let step = null;
    let who = null;
    let authed = false;
    let buf = '';
    sock.write('220 fake.example.test ESMTP\r\n');
    const reply = s => sock.write(`${s}\r\n`);
    const check = (u, p) => { authed = u === user && p === pass; reply(authed ? '235 authenticated' : '535 5.7.8 bad credentials'); };
    function handle(line) {
      if (mode === 'data') {
        if (line === '.') { mails.push({ ...cur, data }); cur = { rcpt: [] }; data = ''; mode = 'cmd'; return reply('250 queued'); }
        data += (data ? '\n' : '') + (line.startsWith('..') ? line.slice(1) : line);
        return undefined;
      }
      if (step === 'user') { who = Buffer.from(line, 'base64').toString(); step = 'pass'; return reply('334 UGFzc3dvcmQ6'); }
      if (step === 'pass') { step = null; return check(who, Buffer.from(line, 'base64').toString()); }
      const up = line.toUpperCase();
      if (up.startsWith('EHLO')) return sock.write(`250-fake.example.test\r\n${auth ? `250-AUTH ${auth}\r\n` : ''}250 SIZE 1000000\r\n`);
      if (up === 'AUTH LOGIN') { step = 'user'; return reply('334 VXNlcm5hbWU6'); }
      if (up.startsWith('AUTH PLAIN ')) { const [, u, p] = Buffer.from(line.slice(11), 'base64').toString().split('\0'); return check(u, p); }
      if (up.startsWith('MAIL FROM:')) { if (auth && !authed) return reply('530 5.7.0 authentication required'); cur.from = line.slice(10); return reply('250 ok'); }
      if (up.startsWith('RCPT TO:')) { cur.rcpt.push(line.slice(8)); return reply('250 ok'); }
      if (up === 'DATA') { mode = 'data'; return reply('354 go ahead'); }
      if (up === 'QUIT') { reply('221 bye'); return sock.end(); }
      return reply('502 unknown');
    }
    sock.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); handle(line); }
    });
    sock.on('error', () => {});
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, mails, close: () => new Promise(r => server.close(r)) })));
}

function mockHttp(respond = () => ({ status: 200, body: { ok: true } })) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => (raw += d));
    req.on('end', () => {
      let json = null;
      try { json = JSON.parse(raw); } catch { /* not json */ }
      requests.push({ method: req.method, url: req.url, headers: req.headers, raw, body: json });
      const r = respond(requests.length, req);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) })));
}

// ---- app helpers --------------------------------------------------------------------------------------------------

function seedHost(db, id, { hostname = id, status = 'online', kind = 'agent', inv = {}, hb = {}, agent_version = null } = {}) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO hosts (id, hostname, os, kind, status, last_seen, agent_version, inventory, heartbeat, created_at, updated_at)
    VALUES (?, ?, 'linux', ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, hostname, kind, status, now, agent_version, JSON.stringify(inv), JSON.stringify(hb), now, now);
}
const setInv = (db, id, inv) => db.prepare('UPDATE hosts SET inventory = ? WHERE id = ?').run(JSON.stringify(inv), id);

async function setup({ keepPack = false } = {}) {
  const app = await startApp();
  const call = api(app.base, await login(app.base));
  const A = app.ctx.alerting;
  A.notifier.delays = [0, 0];
  if (!keepPack) app.ctx.db.exec('DELETE FROM alert_rules');
  let clock = T0;
  A.now = () => clock;
  return { app, call, A, db: app.ctx.db, setClock: ms => { clock = ms; }, at: () => clock, advance: ms => { clock += ms; return clock; } };
}

async function diskRule(call, extra = {}) {
  return (await call('POST', '/api/alert-rules', { name: 'Disk high', severity: 'warning',
    condition: { metric: 'disk_pct', op: '>=', threshold: 90, for_minutes: 10 }, ...extra })).data;
}

async function withHook(fn) {
  const ctx = await setup();
  const hook = await mockHttp();
  try {
    seedHost(ctx.db, 'h1', { hostname: 'host-a', inv: { disks: [{ mount: '/', percent: 95 }] } });
    const ch = (await ctx.call('POST', '/api/channels', { name: 'hook', kind: 'webhook', config: { url: hook.url } })).data;
    await fn({ ...ctx, hook, ch });
  } finally { await hook.close(); await ctx.app.stop(); }
}

// ---- state machine, dedup, ack, silence, maintenance ----------------------------------------------------------

test('pending, firing, repeat after the interval, one recovery notice', () => withHook(async ({ call, A, db, hook, ch, at, advance }) => {
  await diskRule(call, { channels: [ch.id] });
  await A.evaluate(at());
  assert.strictEqual((await call('GET', '/api/alerts?state=pending')).data.rows.length, 1);
  assert.strictEqual(hook.requests.length, 0);
  await A.evaluate(advance(9 * MIN));
  assert.strictEqual(hook.requests.length, 0, 'still pending after 9 minutes');
  await A.evaluate(advance(MIN));
  assert.strictEqual(hook.requests.length, 1);
  const first = hook.requests[0].body;
  assert.strictEqual(first.recovery, false);
  assert.strictEqual(first.severity, 'warning');
  assert.strictEqual(first.host, 'host-a');
  assert.strictEqual(first.value, 95);
  assert.ok(first.link && first.since);
  await A.evaluate(advance(MIN));
  assert.strictEqual(hook.requests.length, 1, 'no duplicate while firing');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM alerts').get().n, 1, 'one row per rule and subject');
  await A.evaluate(advance(4 * 60 * MIN));
  assert.strictEqual(hook.requests.length, 2, 'repeat after 4 hours');
  setInv(db, 'h1', { disks: [{ mount: '/', percent: 50 }] });
  await A.evaluate(advance(30000));
  assert.strictEqual(hook.requests.length, 3);
  assert.strictEqual(hook.requests[2].body.recovery, true);
  await A.evaluate(advance(30000));
  assert.strictEqual(hook.requests.length, 3, 'recovery is sent once');
  const history = (await call('GET', '/api/alerts/history')).data;
  assert.strictEqual(history.rows.length, 1);
  assert.strictEqual(history.rows[0].state, 'resolved');
}));

test('a condition that clears while pending leaves no alert and no notice', () => withHook(async ({ call, A, db, hook, ch, advance, at }) => {
  await diskRule(call, { channels: [ch.id] });
  await A.evaluate(at());
  setInv(db, 'h1', { disks: [{ mount: '/', percent: 10 }] });
  await A.evaluate(advance(5 * MIN));
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM alerts').get().n, 0);
  assert.strictEqual(hook.requests.length, 0);
}));

test('acknowledge stops repeats, the recovery notice still goes out', () => withHook(async ({ call, A, db, hook, ch, advance, at }) => {
  await diskRule(call, { channels: [ch.id], condition: { metric: 'disk_pct', op: '>=', threshold: 90, for_minutes: 0 } });
  await A.evaluate(at());
  assert.strictEqual(hook.requests.length, 1);
  const id = (await call('GET', '/api/alerts?state=active')).data.rows[0].id;
  const ack = await call('POST', `/api/alerts/${id}/ack`);
  assert.strictEqual(ack.data.state, 'acknowledged');
  await A.evaluate(advance(5 * 60 * MIN));
  assert.strictEqual(hook.requests.length, 1);
  assert.strictEqual((await call('GET', '/api/alerts?state=ack')).data.rows.length, 1);
  setInv(db, 'h1', { disks: [{ mount: '/', percent: 20 }] });
  await A.evaluate(advance(MIN));
  assert.strictEqual(hook.requests.length, 2);
  assert.strictEqual(hook.requests[1].body.recovery, true);
  assert.strictEqual((await call('POST', `/api/alerts/${id}/ack`)).status, 404, 'a resolved alert cannot be acknowledged');
}));

test('silence on an alert and on a rule holds back notices until it ends', () => withHook(async ({ call, A, hook, ch, advance, at }) => {
  const rule = await diskRule(call, { channels: [ch.id], condition: { metric: 'disk_pct', op: '>=', threshold: 90, for_minutes: 0 } });
  await call('POST', `/api/alert-rules/${rule.id}/silence`, { minutes: 60 });
  await A.evaluate(at());
  assert.strictEqual(hook.requests.length, 0, 'rule silenced: recorded, not sent');
  assert.strictEqual((await call('GET', '/api/alerts?state=active')).data.rows.length, 1);
  await A.evaluate(advance(61 * MIN));
  assert.strictEqual(hook.requests.length, 1, 'first notice once the rule silence ends');
  const id = (await call('GET', '/api/alerts')).data.rows[0].id;
  assert.strictEqual((await call('POST', `/api/alerts/${id}/silence`, { minutes: 600 })).data.state, 'silenced');
  await A.evaluate(advance(5 * 60 * MIN));
  assert.strictEqual(hook.requests.length, 1);
  assert.strictEqual((await call('GET', '/api/alerts?state=silenced')).data.rows.length, 1);
  await A.evaluate(advance(6 * 60 * MIN));
  assert.strictEqual(hook.requests.length, 2, 'repeat after the silence ended');
  assert.strictEqual((await call('POST', `/api/alerts/${id}/silence`, { minutes: -5 })).status, 400);
}));

test('a maintenance window suppresses notices but the alert is recorded', () => withHook(async ({ call, A, hook, ch, advance, at }) => {
  const rule = await diskRule(call, { channels: [ch.id], condition: { metric: 'disk_pct', op: '>=', threshold: 90, for_minutes: 0 } });
  const w = await call('POST', '/api/maintenance', { name: 'Patching', scope: { type: 'hosts', ids: ['h1'] },
    starts_at: new Date(at() - MIN).toISOString(), ends_at: new Date(at() + 60 * MIN).toISOString() });
  assert.strictEqual(w.status, 201);
  await A.evaluate(at());
  const rows = (await call('GET', `/api/alerts?rule=${rule.id}`)).data.rows;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].suppressed, true);
  assert.strictEqual(hook.requests.length, 0);
  await A.evaluate(advance(61 * MIN));
  assert.strictEqual(hook.requests.length, 1, 'notice goes out after the window');
  assert.strictEqual((await call('GET', '/api/alerts')).data.rows[0].suppressed, false);
}));

test('disabling a rule closes its open alerts without a notice', () => withHook(async ({ call, A, hook, ch, at }) => {
  const rule = await diskRule(call, { channels: [ch.id], condition: { metric: 'disk_pct', op: '>=', threshold: 90, for_minutes: 0 } });
  await A.evaluate(at());
  assert.strictEqual(hook.requests.length, 1);
  assert.strictEqual((await call('POST', `/api/alert-rules/${rule.id}/disable`)).data.enabled, false);
  assert.strictEqual((await call('GET', '/api/alerts?state=resolved')).data.rows.length, 1);
  await A.evaluate(at() + MIN);
  assert.strictEqual(hook.requests.length, 1);
}));

test('severity filter on a channel and default channels', () => withHook(async ({ call, A, hook, ch, at }) => {
  await call('PUT', `/api/channels/${ch.id}`, { config: { min_severity: 'critical' } });
  await call('PUT', '/api/alert-config', { default_channels: [ch.id] });
  await diskRule(call, { condition: { metric: 'disk_pct', op: '>=', threshold: 90, for_minutes: 0 } });
  await A.evaluate(at());
  assert.strictEqual(hook.requests.length, 0, 'warning is below the channel minimum');
  await call('PUT', `/api/channels/${ch.id}`, { config: { min_severity: 'info' } });
  await A.evaluate(at() + 5 * 60 * 60 * MIN);
  assert.strictEqual(hook.requests.length, 1, 'default channel used when the rule lists none');
}));

// ---- maintenance windows ----------------------------------------------------------------------------------------

test('recurring weekly window in the time zone setting, with group and tag scope', async () => {
  const { app, call, db } = await setup();
  try {
    seedHost(db, 'h1');
    seedHost(db, 'h2');
    db.prepare("INSERT INTO tags (id, name) VALUES ('t1', 'Build')").run();
    db.prepare("INSERT INTO host_tags (host_id, tag_id) VALUES ('h1', 't1')").run();
    // Monday 02:00 for 2 hours, Europe/Dublin. On 19 October 2026 Dublin is UTC+1.
    const w = await call('POST', '/api/maintenance', { name: 'Weekly', scope: { type: 'tag', value: 'build' }, recurrence: { days: ['mon'], time: '02:00', duration_min: 120 } });
    assert.strictEqual(w.status, 201);
    assert.deepStrictEqual(w.data.recurrence, { days: [1], time: '02:00', duration_min: 120 });
    const m = app.ctx.maintenance;
    assert.ok(m.isInMaintenance('h1', new Date('2026-10-19T01:30:00Z')));
    assert.ok(m.isInMaintenance('h1', new Date('2026-10-19T01:00:00Z')), 'start is inclusive');
    assert.ok(m.isInMaintenance('h1', new Date('2026-10-19T02:59:00Z')));
    assert.ok(!m.isInMaintenance('h1', new Date('2026-10-19T03:00:00Z')), 'end is exclusive');
    assert.ok(!m.isInMaintenance('h1', new Date('2026-10-19T00:30:00Z')));
    assert.ok(!m.isInMaintenance('h1', new Date('2026-10-20T01:30:00Z')), 'Tuesday is outside');
    assert.ok(!m.isInMaintenance('h2', new Date('2026-10-19T01:30:00Z')), 'host without the tag');
    assert.strictEqual((await call('GET', '/api/maintenance/check?host_id=h1&at=2026-10-19T01:30:00Z')).data.in_maintenance, true);
    db.prepare("INSERT INTO groups (id, name) VALUES ('g1', 'Lab')").run();
    db.prepare("INSERT INTO host_groups (host_id, group_id) VALUES ('h2', 'g1')").run();
    await call('POST', '/api/maintenance', { name: 'One off', scope: { type: 'group', value: 'LAB' }, starts_at: '2026-11-01T10:00:00Z', ends_at: '2026-11-01T11:00:00Z' });
    assert.ok(m.isInMaintenance('h2', new Date('2026-11-01T10:30:00Z')));
    assert.ok(!m.isInMaintenance('h1', new Date('2026-11-01T10:30:00Z')));
    assert.strictEqual((await call('POST', '/api/maintenance', { name: 'Bad', starts_at: '2026-11-01T11:00:00Z', ends_at: '2026-11-01T10:00:00Z' })).status, 400);
    assert.strictEqual((await call('POST', '/api/maintenance', { name: 'Bad', recurrence: { days: [9], time: '02:00', duration_min: 5 } })).status, 400);
    assert.strictEqual((await call('DELETE', `/api/maintenance/${w.data.id}`)).status, 200);
    assert.ok(!m.isInMaintenance('h1', new Date('2026-10-19T01:30:00Z')));
  } finally { await app.stop(); }
  assert.deepStrictEqual(fromCron(toCron([1, 3], '07:05').cron), { days: [1, 3], time: '07:05' });
});

// ---- default rule pack ------------------------------------------------------------------------------------------

test('every default rule fires on seeded inputs and the GitHub rules are dormant without data', async () => {
  const { app, call, A, db } = await setup({ keepPack: true });
  try {
    A.now = () => Date.now();
    const now = Date.now();
    const ids = A.listRules().map(r => r.id);
    for (const id of ['host-offline', 'disk-high', 'ram-high', 'cpu-sustained', 'failed-service', 'docker-problem', 'reboot-pending', 'agent-outdated', 'job-failed',
      'schedule-missed', 'cert-expiry', 'runner-offline', 'runner-busy', 'queued-wait', 'runner-volume', 'runner-work-size', 'docker-disk', 'runner-behind',
      'runner-public', 'github-permission']) assert.ok(ids.includes(`default-${id}`), `missing default-${id}`);
    assert.ok(A.listRules().every(r => r.enabled));

    seedHost(db, 'a', { hostname: 'host-a', agent_version: '1.0.0', hb: { cpu: 95, ram: 93 }, inv: {
      disks: [{ mount: '/', percent: 50 }, { mount: '/home', percent: 96 }], memory: { percent: 70 },
      services: { failed: [{ name: 'nginx' }] },
      docker: { containers: [{ name: 'web', health: 'unhealthy', state: 'running' }, { name: 'db', health: 'healthy', state: 'running' }], disk_bytes: 150 * GB },
      updates: { reboot_required: true, reboot_pending_days: 9 },
      runners: [{ name: 'r1', path: '/home/runner/r1', sizes: { work: 60 * GB } }] } });
    seedHost(db, 'b', { hostname: 'host-b', agent_version: '2.0.0', hb: { cpu: 10, ram: 20 }, inv: {
      disks: [{ mount: '/', percent: 30 }], services: { failed: [] }, docker: { containers: [{ name: 'x', health: 'healthy', state: 'running' }] },
      updates: { reboot_required: false }, runners: [{ name: 'r9', path: '/srv/r9', sizes: { work: 1 * GB } }] } });
    seedHost(db, 'c', { hostname: 'host-c', status: 'offline', agent_version: '2.0.0', hb: { cpu: 99 }, inv: { disks: [{ mount: '/', percent: 99 }] } });
    const nowSec = Math.floor(now / 1000);
    for (let i = 0; i < 4; i++) db.prepare("INSERT INTO metric_points (host_id, ts, res, cpu) VALUES ('a', ?, 30, 95)").run(nowSec - 30 * i);
    db.prepare("INSERT INTO jobs (id, host_id, type, status, created_at, completed_at) VALUES ('j1', 'a', 'backup', 'failed', ?, ?)").run(new Date(now - 5 * MIN).toISOString(), new Date(now - MIN).toISOString());
    db.prepare("INSERT INTO schedules (id, name, host_id, type, cron, last_missed, created_at) VALUES ('s1', 'Nightly', 'a', 'backup', '0 1 * * *', ?, ?)").run(new Date(now - 10 * MIN).toISOString(), new Date(now).toISOString());
    db.prepare("INSERT INTO alert_facts (host_id, key, value, ts) VALUES ('a', 'cert_expiry_days', '5', ?)").run(new Date(now).toISOString());

    const hit = id => A.dryRun(A.getRule(`default-${id}`)).matches.map(r => r.subject).sort();
    assert.deepStrictEqual(hit('host-offline'), ['c']);
    assert.deepStrictEqual(hit('disk-high'), ['a'], 'offline host is skipped, healthy host is not flagged');
    assert.deepStrictEqual(hit('ram-high'), ['a']);
    assert.deepStrictEqual(hit('cpu-sustained'), ['a']);
    assert.deepStrictEqual(hit('failed-service'), ['a']);
    assert.deepStrictEqual(hit('docker-problem'), ['a']);
    assert.deepStrictEqual(hit('reboot-pending'), ['a']);
    assert.deepStrictEqual(hit('agent-outdated'), ['a']);
    assert.deepStrictEqual(hit('job-failed'), ['a']);
    assert.deepStrictEqual(hit('schedule-missed'), ['a']);
    assert.deepStrictEqual(hit('cert-expiry'), ['a']);
    assert.deepStrictEqual(hit('runner-volume'), ['a:r1']);
    assert.deepStrictEqual(hit('runner-work-size'), ['a:r1']);
    assert.deepStrictEqual(hit('docker-disk'), ['a']);
    assert.strictEqual(A.dryRun(A.getRule('default-disk-high')).matches[0].detail, '/home');
    A.setConfig({ runner_work_limit_gb: 100, docker_disk_limit_gb: 200 });
    assert.deepStrictEqual(hit('runner-work-size'), [], 'threshold comes from the alert setting');
    assert.deepStrictEqual(hit('docker-disk'), []);

    for (const id of ['runner-offline', 'runner-busy', 'queued-wait', 'runner-behind', 'runner-public', 'github-permission']) {
      assert.strictEqual(A.dryRun(A.getRule(`default-${id}`)).results.length, 0, `${id} is dormant without GitHub data`);
    }
    const ago = ms => new Date(now - ms).toISOString();
    ctxSet(app, 'github_runners', { runners: [
      { host_id: 'a', name: 'r1', online: false, busy: false, offline_since: ago(6 * MIN), repo: 'org/app' },
      { host_id: 'a', name: 'r2', online: true, busy: true, busy_since: ago(7 * 3600000), public_repo: true, behind_days: 20, version: '2.300.0', repo: 'org/app' },
      { host_id: 'b', name: 'r3', online: true, busy: false, busy_since: null, public_repo: false, behind_days: 3, repo: 'org/other' }] });
    ctxSet(app, 'github_queued', { 'org/app': { count: 2, oldest_age_s: 900 }, 'org/other': { count: 1, oldest_age_s: 900 } });
    ctxSet(app, 'github_last_check', { ok: false, error: 'missing administration scope' });
    assert.deepStrictEqual(hit('runner-offline'), ['a:r1']);
    assert.deepStrictEqual(hit('runner-busy'), ['a:r2']);
    assert.deepStrictEqual(hit('queued-wait'), ['org/app'], 'org/other has a free runner');
    assert.deepStrictEqual(hit('runner-behind'), ['a:r2']);
    assert.deepStrictEqual(hit('runner-public'), ['a:r2']);
    assert.deepStrictEqual(hit('github-permission'), ['github']);
    ctxSet(app, 'github_last_check', { ok: true });
    assert.deepStrictEqual(hit('github-permission'), []);

    // A real evaluation creates alerts for the pack and the API lists them.
    await A.evaluate(now);
    const names = state => call('GET', `/api/alerts?state=${state}`).then(r => r.data.rows.map(a => a.rule_name));
    const firing = await names('active');
    assert.ok(firing.includes('Job failed') && firing.includes('Runner offline in GitHub for more than 5 minutes'));
    const pending = await names('pending');
    assert.ok(pending.includes('Disk high') && pending.includes('Host offline'), 'rules with for_minutes wait first');
  } finally { await app.stop(); }
});

const ctxSet = (app, key, value) => app.ctx.settings.set(key, value);

test('LABCTL_RESULT lines from job logs are kept as the latest value per host', async () => {
  const { app, A, db } = await setup();
  try {
    seedHost(db, 'a');
    app.ctx.joblog.write('job-1', 'checking\nLABCTL_RESULT cert_expiry_days=40\nLABCTL_RESULT cert_expiry_days=9\n');
    app.ctx.events.emit('job', { id: 'job-1', host_id: 'a', status: 'completed' });
    app.ctx.events.emit('job', { id: 'job-1', host_id: 'a', status: 'running' });
    assert.strictEqual(db.prepare("SELECT value FROM alert_facts WHERE host_id = 'a' AND key = 'cert_expiry_days'").get().value, '9');
    const rule = { name: 'Cert', severity: 'warning', scope: { type: 'all' }, params: {}, condition: { metric: 'cert_expiry_days', op: '<', threshold: 14, for_minutes: 0 } };
    assert.strictEqual(A.dryRun(rule).matches.length, 1);
  } finally { await app.stop(); }
});

// ---- rule API ---------------------------------------------------------------------------------------------------

test('rule API validates, dry-runs and enforces roles', async () => {
  const { app, call } = await setup();
  try {
    seedHost(app.ctx.db, 'h1', { hostname: 'host-a', inv: { disks: [{ mount: '/', percent: 95 }] } });
    const base = { name: 'X', severity: 'warning', condition: { metric: 'disk_pct', op: '>=', threshold: 90, for_minutes: 5 } };
    assert.strictEqual((await call('POST', '/api/alert-rules', { ...base, condition: { ...base.condition, metric: 'nope' } })).status, 400);
    assert.strictEqual((await call('POST', '/api/alert-rules', { ...base, severity: 'bad' })).status, 400);
    assert.strictEqual((await call('POST', '/api/alert-rules', { ...base, scope: { type: 'group' } })).status, 400);
    assert.strictEqual((await call('POST', '/api/alert-rules', { ...base, condition: { ...base.condition, threshold: 'x' } })).status, 400);
    const dry = await call('POST', '/api/alert-rules/test', base);
    assert.strictEqual(dry.status, 200);
    assert.strictEqual(dry.data.matches.length, 1);
    assert.strictEqual(dry.data.matches[0].hostname, 'host-a');
    const scoped = await call('POST', '/api/alert-rules/test', { ...base, scope: { type: 'hosts', ids: ['other'] } });
    assert.strictEqual(scoped.data.evaluated, 0);
    const created = (await call('POST', '/api/alert-rules', base)).data;
    const upd = await call('PUT', `/api/alert-rules/${created.id}`, { severity: 'critical', condition: { ...base.condition, threshold: 99 } });
    assert.strictEqual(upd.data.severity, 'critical');
    assert.strictEqual((await call('POST', `/api/alert-rules/${created.id}/test`)).data.matches.length, 0);
    assert.strictEqual((await call('GET', '/api/alert-metrics')).data.metrics.length >= 20, true);
    assert.strictEqual((await call('DELETE', `/api/alert-rules/${created.id}`)).status, 200);
    assert.strictEqual((await call('GET', `/api/alert-rules/${created.id}`)).status, 404);

    app.ctx.auth.makeUser('viewer1', 'viewer-pass-1', 'viewer');
    app.ctx.auth.makeUser('op1', 'op-pass-1', 'operator');
    const view = api(app.base, await login(app.base, 'viewer1', 'viewer-pass-1'));
    const op = api(app.base, await login(app.base, 'op1', 'op-pass-1'));
    assert.strictEqual((await view('GET', '/api/alerts')).status, 200);
    assert.strictEqual((await view('POST', '/api/alert-rules', base)).status, 403);
    assert.strictEqual((await op('POST', '/api/alert-rules', base)).status, 201);
    assert.strictEqual((await op('POST', '/api/channels', { name: 'n', kind: 'webhook', config: { url: 'http://127.0.0.1:9/' } })).status, 403);
    assert.strictEqual((await op('PUT', '/api/alert-config', { repeat_hours: 1 })).status, 403);
  } finally { await app.stop(); }
});

// ---- SMTP -------------------------------------------------------------------------------------------------------

const smtpCfg = (port, extra = {}) => ({ host: '127.0.0.1', port, secure: 'none', from: 'labctl@example.test', to: ['ops@example.test', 'team@example.test'], ...extra });

test('SMTP: plain relay on a custom port with no auth, dot-stuffing and CRLF', async () => {
  const srv = await fakeSmtp();
  try {
    await smtpSend(smtpCfg(srv.port), { subject: '[FIRING] WARNING Disk high on host-a', text: 'Line one\n.starts with a dot\nLast line' });
    assert.strictEqual(srv.mails.length, 1);
    const m = srv.mails[0];
    assert.strictEqual(m.from, '<labctl@example.test>');
    assert.deepStrictEqual(m.rcpt, ['<ops@example.test>', '<team@example.test>']);
    assert.match(m.data, /Subject: \[FIRING\] WARNING Disk high on host-a/);
    assert.match(m.data, /\n\nLine one\n\.starts with a dot\nLast line$/, 'a leading dot survives the stuffing');
  } finally { await srv.close(); }
  assert.ok(buildMail({ from: 'a@example.test', to: ['b@example.test'], subject: 'x', text: '.a\n..b' }).includes('\r\n..a\r\n...b\r\n.\r\n'));
  assert.ok(!buildMail({ from: 'a@example.test', to: ['b@example.test'], subject: 'x\r\nBcc: evil@example.test', text: 't' }).includes('\r\nBcc:'));
});

test('health report: its own title, no alert wording, and multipart text plus HTML over SMTP', async () => {
  const { render } = require('../src/alerting/notify');
  const healthReport = require('../src/health-report');
  const s = await startApp();
  try {
    let sent = null;
    s.ctx.alerting.notifier.dispatch = async p => { sent = p; return [{ channel_id: 'c1', ok: true }]; };
    assert.ok((await healthReport.send(s.ctx)).ok);
    const msg = render(sent);
    assert.match(msg.title, /^LabCTL daily health report/);
    assert.doesNotMatch(`${msg.title}\n${msg.text}`, /FIRING|RESOLVED|Since:/);
    const srv = await fakeSmtp();
    try {
      await smtpSend(smtpCfg(srv.port), { subject: msg.title, text: msg.text, html: sent.html });
      const d = srv.mails[0].data;
      const boundary = d.match(/Content-Type: multipart\/alternative; boundary="([^"]+)"/)[1];
      const parts = d.split(`--${boundary}`);
      assert.match(parts[1], /Content-Type: text\/plain; charset=utf-8\n[^]*FLEET/);
      assert.match(parts[2], /Content-Type: text\/html; charset=utf-8\nContent-Transfer-Encoding: base64/);
      const html = Buffer.from(parts[2].split('\n\n')[1].replace(/\n/g, ''), 'base64').toString();
      assert.match(html, /^<h2>LabCTL daily health report/);
      assert.strictEqual(parts[3].trim(), '--');
    } finally { await srv.close(); }
  } finally { await s.stop(); }
});

test('SMTP: AUTH LOGIN and AUTH PLAIN, bad credentials and missing STARTTLS give exact errors', async () => {
  const login = await fakeSmtp({ auth: 'LOGIN' });
  const plain = await fakeSmtp({ auth: 'PLAIN LOGIN' });
  try {
    const msg = { subject: 'hi', text: 'body' };
    await smtpSend(smtpCfg(login.port, { user: 'relay-user', password: 'relay-pass' }), msg);
    assert.strictEqual(login.mails.length, 1);
    await smtpSend(smtpCfg(plain.port, { user: 'relay-user', password: 'relay-pass' }), msg);
    assert.strictEqual(plain.mails.length, 1);
    await assert.rejects(smtpSend(smtpCfg(login.port, { user: 'relay-user', password: 'wrong' }), msg), /SMTP 535 .*bad credentials/);
    await assert.rejects(smtpSend(smtpCfg(login.port), msg), /SMTP 530/);
    await assert.rejects(smtpSend(smtpCfg(login.port, { secure: 'starttls' }), msg), /does not offer STARTTLS/);
  } finally { await login.close(); await plain.close(); }
});

// ---- webhook and Telegram ---------------------------------------------------------------------------------------

test('webhook: HMAC signature, secret header, template, retry with backoff, failures recorded', async () => {
  let failFirst = 2;
  const hook = await mockHttp(() => (failFirst-- > 0 ? { status: 500, body: { error: 'boom' } } : { status: 200, body: {} }));
  const { app, call, db } = await setup();
  try {
    const created = (await call('POST', '/api/channels', { name: 'n8n', kind: 'webhook', config: { url: `${hook.url}/hook`, method: 'POST',
      headers: { 'X-Auth': 'header-secret-123' }, hmac_secret: 'hmac-secret-456', template: '{"text": "{{title}}", "sev": "{{severity}}", "x": ["{{host}}"]}' } })).data;
    const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(created.id);
    const payload = { rule: 'Disk high', host: 'host-a', severity: 'critical', message: 'm', recovery: false, since: 'now', link: '#/alerts' };
    const out = await app.ctx.alerting.notifier.send(row, payload);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(hook.requests.length, 3, 'two failures then success');
    const last = hook.requests[2];
    assert.strictEqual(last.url, '/hook');
    assert.strictEqual(last.headers['x-auth'], 'header-secret-123');
    assert.strictEqual(last.headers['x-labctl-signature'], `sha256=${crypto.createHmac('sha256', 'hmac-secret-456').update(last.raw).digest('hex')}`);
    assert.deepStrictEqual(last.body, { text: '[FIRING] CRITICAL Disk high on host-a', sev: 'critical', x: ['host-a'] });

    failFirst = 99;
    const bad = await app.ctx.alerting.notifier.send(row, payload);
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /HTTP 500/);
    const list = (await call('GET', '/api/channels')).data;
    assert.match(list[0].last_error, /HTTP 500/);
    const errors = (await call('GET', `/api/channels/${created.id}/errors`)).data;
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].context, /alert: Disk high/);
  } finally { await hook.close(); await app.stop(); }
});

test('Telegram: message goes to the base URL setting, with topic id, and errors hide the token', async () => {
  const tg = await mockHttp((n) => (n === 1 ? { status: 200, body: { ok: true } } : { status: 400, body: { ok: false, description: 'Bad Request: chat not found' } }));
  const { app, call } = await setup();
  try {
    await call('PUT', '/api/alert-config', { telegram_api_base: tg.url });
    const ch = (await call('POST', '/api/channels', { name: 'tg', kind: 'telegram', config: { bot_token: '123456:TEST-token-abcdef', chat_id: '-100200', message_thread_id: 27 } })).data;
    const ok = await call('POST', `/api/channels/${ch.id}/test`);
    assert.deepStrictEqual(ok.data, { ok: true });
    assert.strictEqual(tg.requests[0].url, '/bot123456:TEST-token-abcdef/sendMessage');
    assert.strictEqual(tg.requests[0].body.chat_id, '-100200');
    assert.strictEqual(tg.requests[0].body.message_thread_id, 27);
    assert.match(tg.requests[0].body.text, /\[TEST\] INFO LabCTL test/);
    const fail = await call('POST', `/api/channels/${ch.id}/test`);
    assert.strictEqual(fail.data.ok, false);
    assert.match(fail.data.error, /chat not found/);
    assert.ok(!JSON.stringify(fail.data).includes('TEST-token-abcdef'));
  } finally { await tg.close(); await app.stop(); }
});

// ---- channels API, secrets, test endpoint -----------------------------------------------------------------------

test('channel test button reports exact errors and works against the fake relay', async () => {
  const srv = await fakeSmtp();
  const { app, call } = await setup();
  try {
    const dead = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    const smtp = (await call('POST', '/api/channels', { name: 'relay', kind: 'smtp', config: smtpCfg(srv.port) })).data;
    assert.deepStrictEqual((await call('POST', `/api/channels/${smtp.id}/test`)).data, { ok: true });
    assert.match(srv.mails[0].data, /\[TEST\] INFO LabCTL test/);
    await call('PUT', `/api/channels/${smtp.id}`, { config: { port: dead } });
    const refused = (await call('POST', `/api/channels/${smtp.id}/test`)).data;
    assert.strictEqual(refused.ok, false);
    assert.match(refused.error, /ECONNREFUSED/);
    const hook = (await call('POST', '/api/channels', { name: 'h', kind: 'webhook', config: { url: `http://127.0.0.1:${dead}/x` } })).data;
    assert.strictEqual((await call('POST', `/api/channels/${hook.id}/test`)).data.ok, false);
    assert.strictEqual((await call('POST', '/api/channels/missing/test')).status, 404);
    // validation
    assert.strictEqual((await call('POST', '/api/channels', { name: 'x', kind: 'smtp', config: { host: 'h', from: 'bad', to: ['a@example.test'] } })).status, 400);
    assert.strictEqual((await call('POST', '/api/channels', { name: 'x', kind: 'webhook', config: { url: 'ftp://example.test' } })).status, 400);
    assert.strictEqual((await call('POST', '/api/channels', { name: 'x', kind: 'telegram', config: { chat_id: '1' } })).status, 400);
    assert.strictEqual((await call('POST', '/api/channels', { name: 'x', kind: 'sms', config: {} })).status, 400);
    assert.strictEqual((await call('DELETE', `/api/channels/${hook.id}`)).status, 200);
  } finally { await srv.close(); await app.stop(); }
});

test('secrets never appear in API output, audit rows or the stored blob, and the mask keeps them', async () => {
  const secrets = ['smtp-pass-S3CRET', 'tg-token-S3CRET-1234', 'hook-hdr-S3CRET', 'hook-hmac-S3CRET'];
  const hook = await mockHttp();
  const { app, call, db } = await setup();
  try {
    const smtp = (await call('POST', '/api/channels', { name: 's', kind: 'smtp', config: smtpCfg(25, { user: 'u1', password: secrets[0] }) })).data;
    const tg = (await call('POST', '/api/channels', { name: 't', kind: 'telegram', config: { bot_token: secrets[1], chat_id: '5' } })).data;
    const wh = (await call('POST', '/api/channels', { name: 'w', kind: 'webhook', config: { url: hook.url, headers: { 'X-N8N-Auth': secrets[2] }, hmac_secret: secrets[3] } })).data;
    assert.strictEqual(smtp.config.password, '********');
    assert.strictEqual(tg.config.bot_token, '********');
    assert.deepStrictEqual(wh.config.headers, { 'X-N8N-Auth': '********' });
    await call('PUT', `/api/channels/${wh.id}`, { name: 'w2', config: wh.config }); // the UI round trip sends the masks back
    await call('POST', `/api/channels/${wh.id}/test`);
    const sig = hook.requests[0].headers['x-labctl-signature'];
    assert.strictEqual(sig, `sha256=${crypto.createHmac('sha256', secrets[3]).update(hook.requests[0].raw).digest('hex')}`, 'secret kept after the masked update');
    assert.strictEqual(hook.requests[0].headers['x-n8n-auth'], secrets[2]);
    const dump = JSON.stringify([(await call('GET', '/api/channels')).data, (await call('GET', `/api/channels/${tg.id}/errors`)).data,
      db.prepare('SELECT * FROM audit_log').all(), db.prepare('SELECT * FROM channels').all(), db.prepare('SELECT * FROM channel_errors').all()]);
    await new Promise(r => setTimeout(r, 50)); // the audit row is written after the response
    const dump2 = JSON.stringify([db.prepare('SELECT * FROM audit_log').all(), db.prepare('SELECT config_sealed FROM channels').all()]);
    for (const s of secrets) {
      assert.ok(!dump.includes(s) && !dump2.includes(s), `${s} leaked`);
    }
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'POST /api/channels%'").get().n >= 3, 'channel writes are audited');
  } finally { await hook.close(); await app.stop(); }
  const m = merge('smtp', { password: 'old-password' }, { password: '********' });
  assert.strictEqual(m.password, 'old-password');
  assert.strictEqual(merge('smtp', { password: 'old-password' }, { password: null }).password, undefined);
  assert.strictEqual(mask('telegram', validate('telegram', { bot_token: 'abc:def', chat_id: '1' }).config).bot_token, '********');
});
