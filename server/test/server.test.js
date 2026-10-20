const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, login, api, wsStatus, wsOpen, nextMessage, waitFor } = require('./helpers');
const { readVersion } = require('../src/app');

test('health is public JSON with version, uptime and db status', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const r = await fetch(`${s.base}/api/health`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.version, readVersion());
  assert.equal(body.db, 'ok');
  assert.equal(typeof body.uptime_s, 'number');
  assert.equal((await fetch(`${s.base}/api/hosts`)).status, 401);
});

test('agent enrolment tokens: missing, bad and revoked tokens get 401; blocklisted host gets 4403', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const call = api(s.base, await login(s.base));

  const created = await call('POST', '/api/tokens', { label: 'test' });
  assert.equal(created.status, 200);
  assert.ok(created.data.value.length >= 40);
  const listed = await call('GET', '/api/tokens');
  assert.ok(listed.data.every(x => !('value' in x) && !('hash' in x)));

  assert.equal(await wsStatus(s.port, ''), 401);
  assert.equal(await wsStatus(s.port, 'not-a-real-token'), 401);

  const ws = await wsOpen(s.port, created.data.value);
  ws.send(JSON.stringify({ type: 'register', host_id: 'h-test', hostname: 'node-a.example.test', os: 'linux', kind: 'agent', agent_version: '2.0.0', info: {} }));
  const host = await waitFor(() => s.ctx.db.prepare("SELECT * FROM hosts WHERE id = 'h-test'").get());
  assert.equal(host.token_id, created.data.id);

  // Job round trip: dispatch, streamed output to the log file, completion.
  const framePromise = nextMessage(ws);
  const job = await call('POST', '/api/jobs', { host_id: 'h-test', type: 'custom_command', params: { command: 'uptime' } });
  const frame = await framePromise;
  assert.equal(frame.type, 'run_job'); // typed v1 jobs are translated to a script (legacy-jobs.js)
  assert.equal(frame.job_id, job.data.id);
  assert.equal(frame.env.LABCTL_P_COMMAND, 'uptime');
  ws.send(JSON.stringify({ type: 'job_output', job_id: job.data.id, seq: 1, stream: 'stdout', chunk: 'up 1 day\n' }));
  ws.send(JSON.stringify({ type: 'job_complete', job_id: job.data.id, status: 'success', exit_code: 0, duration_ms: 5 }));
  await waitFor(() => s.ctx.jobs.get(job.data.id).status === 'completed');
  const detail = await call('GET', `/api/jobs/${job.data.id}`);
  assert.equal(detail.data.result, 'up 1 day\n');
  assert.equal(detail.data.exit_code, 0);

  const closed = new Promise(resolve => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  assert.equal((await call('POST', `/api/tokens/${created.data.id}/revoke`)).status, 200);
  assert.equal((await closed).code, 4401);
  assert.equal(await wsStatus(s.port, created.data.value), 401);

  const t2 = await call('POST', '/api/tokens', { label: 'second' });
  s.ctx.db.prepare("INSERT INTO blocklist (host_id, reason, created_at) VALUES ('h-blocked', 'test', ?)").run(new Date().toISOString());
  const ws2 = await wsOpen(s.port, t2.data.value);
  const blocked = new Promise(resolve => ws2.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  ws2.send(JSON.stringify({ type: 'register', host_id: 'h-blocked', hostname: 'node-b.example.test' }));
  assert.deepEqual(await blocked, { code: 4403, reason: 'blocked' });

  // Rotation gives a new value; the old one stops working.
  const rotated = await call('POST', `/api/tokens/${t2.data.id}/rotate`);
  assert.notEqual(rotated.data.value, t2.data.value);
  assert.equal(await wsStatus(s.port, t2.data.value), 401);
  assert.equal(await wsStatus(s.port, rotated.data.value), 101);
});

test('roles, typed confirmation and the audit log', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const admin = api(s.base, await login(s.base));
  await admin('POST', '/api/users', { username: 'viewer1', password: 'pw-viewer', role: 'viewer' });
  await admin('POST', '/api/users', { username: 'op1', password: 'pw-op', role: 'operator' });
  const viewer = api(s.base, await login(s.base, 'viewer1', 'pw-viewer'));
  const op = api(s.base, await login(s.base, 'op1', 'pw-op'));

  assert.equal((await viewer('GET', '/api/hosts')).status, 200);
  assert.equal((await viewer('POST', '/api/scripts', { name: 'x', command: 'true' })).status, 403);
  assert.equal((await op('POST', '/api/scripts', { name: 'x', command: 'true' })).status, 200);
  assert.equal((await op('POST', '/api/tokens', {})).status, 403);
  assert.equal((await op('GET', '/api/credentials')).status, 403);
  assert.equal((await op('PUT', '/api/settings', { timezone: 'UTC' })).status, 403);
  assert.equal((await viewer('POST', '/api/auth/logout')).status, 200);

  s.ctx.db.prepare("INSERT INTO hosts (id, hostname, status) VALUES ('h9', 'node-c.example.test', 'offline')").run();
  assert.equal((await op('DELETE', '/api/hosts/h9', { confirm: 'node-c.example.test' })).status, 403); // removal is admin only
  assert.equal((await admin('DELETE', '/api/hosts/h9', {})).status, 400);
  assert.equal((await admin('DELETE', '/api/hosts/h9', { confirm: 'wrong' })).status, 400);
  assert.equal((await admin('DELETE', '/api/hosts/h9', { confirm: 'node-c.example.test' })).status, 200);

  assert.equal((await admin('PUT', '/api/settings', { timezone: 'Not/AZone' })).status, 400);
  assert.equal((await admin('POST', '/api/schedules', { name: 'n', host_id: 'h1', type: 'reboot', cron: 'bad cron' })).status, 400);

  const audit = await admin('GET', '/api/audit?action=/api/hosts&limit=10');
  const del = audit.data.rows.find(r => r.action === 'DELETE /api/hosts/:id' && r.detail.status === 200);
  assert.equal(del.actor, 'LabCTLAdmin');
  assert.equal(del.host_id, 'h9');
  const logins = await admin('GET', '/api/audit?action=login');
  assert.ok(logins.data.total >= 3);
  assert.ok(logins.data.rows.every(r => r.detail.body.password === '[redacted]'));
  const users = await admin('GET', '/api/audit?action=/api/users');
  assert.ok(users.data.rows.every(r => r.detail.body.password === '[redacted]'));
});
