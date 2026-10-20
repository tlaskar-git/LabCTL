// GitHub integration (A7): sealed token, poller, flags, permission probe, runner actions and verify/rollback.
// Runs against a fake GitHub API on a random port. No real GitHub call, no real token.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { startApp, login, api, wsOpen, waitFor } = require('./helpers');
const { inventory } = require('./inventory-fixture');
const { versionBehind, parseRunnerUrl, parseScope } = require('../src/github');

const TOKEN = 'gh' + 'p_FAKE0000000000000000000000000000TEST';
const REG = 'REGTOKEN-SECRET-VALUE';
const REMOVE = 'REMOVETOKEN-SECRET-VALUE';
const hoursAgo = h => new Date(Date.now() - h * 3600000).toISOString();

function fakeGithub() {
  const st = {
    requests: [], notModified: 0, isPrivate: false, rateLimited: false, deny: [],
    runners: { 'runner-a': { status: 'offline', busy: false }, 'runner-b': { status: 'online', busy: true } },
    queued: [{ created_at: hoursAgo(1) }, { created_at: hoursAgo(2) }]
  };
  const entry = (id, name) => ({ id, name, os: 'linux', status: st.runners[name].status, busy: st.runners[name].busy, labels: [{ name: 'self-hosted' }, { name: 'linux' }] });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    st.requests.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Bad credentials' });
    if (st.rateLimited) return send(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) });
    if (st.deny.some(p => url.pathname.startsWith(p))) return send(403, { message: 'Resource not accessible by personal access token' });
    const p = url.pathname;
    if (p === '/user') return send(200, { login: 'test-user' });
    if (p === '/repos/example-org/repo/actions/runners' && req.method === 'GET') {
      const body = { total_count: 1, runners: [entry(1, 'runner-a')] };
      const etag = `"${JSON.stringify(body).length}-${body.runners[0].status}"`;
      if (req.headers['if-none-match'] === etag) { st.notModified++; res.writeHead(304, { etag }); return res.end(); }
      return send(200, body, { etag });
    }
    if (p === '/orgs/example-org/actions/runners' && req.method === 'GET') {
      if (url.searchParams.get('page') === '2') return send(200, { total_count: 2, runners: [{ ...entry(3, 'runner-b'), name: 'runner-extra', status: 'offline', busy: false }] });
      return send(200, { total_count: 2, runners: [entry(2, 'runner-b')] }, { link: `<http://${req.headers.host}/orgs/example-org/actions/runners?per_page=100&page=2>; rel="next"` });
    }
    if (p === '/repos/example-org/repo') return send(200, { private: st.isPrivate });
    if (p === '/repos/example-org/repo/actions/runs') return send(200, { total_count: st.queued.length, workflow_runs: st.queued });
    if (p === '/repos/actions/runner/releases/latest') {
      return send(200, { tag_name: 'v2.330.0', published_at: '2026-10-01T00:00:00Z', body: `<!-- BEGIN SHA linux-x64 -->${'a'.repeat(64)}<!-- END SHA linux-x64 -->` });
    }
    if (req.method === 'POST' && p.endsWith('/registration-token')) return send(201, { token: REG });
    if (req.method === 'POST' && p.endsWith('/remove-token')) return send(201, { token: REMOVE });
    return send(404, { message: 'Not Found' });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ st, base: `http://127.0.0.1:${server.address().port}`, close: () => server.closeAllConnections() || server.close() })));
}

// An app with a fake GitHub, one agent host (alpha) holding runner-a (repo) and runner-b (organisation), and an admin client.
async function setup(t, { token = true } = {}) {
  const gh = await fakeGithub();
  const s = await startApp();
  const sockets = [];
  t.after(async () => {
    await Promise.all(sockets.map(w => new Promise(r => { if (w.readyState === 3) return r(); w.on('close', r); w.close(); })));
    await new Promise(r => setTimeout(r, 50));
    await s.stop();
    gh.close();
  });
  s.ctx.settings.set('github_api_base', gh.base);
  s.ctx.settings.set('github_verify_interval_s', 0.05);
  const admin = api(s.base, await login(s.base));
  const enrol = (await admin('POST', '/api/tokens', { label: 'gh' })).data.value;
  const agent = { ran: [], jobs: [] };
  const ws = await wsOpen(s.port, enrol);
  sockets.push(ws);
  ws.send(JSON.stringify({ type: 'register', host_id: 'h-ci', hostname: 'alpha.example.test', os: 'linux', kind: 'agent', agent_version: '2.0.0', info: {} }));
  ws.on('message', d => {
    const m = JSON.parse(d.toString());
    if (m.type !== 'run_job') return;
    agent.ran.push({ job_id: m.job_id, env: m.env });
    ws.send(JSON.stringify({ type: 'job_complete', job_id: m.job_id, status: 'success', exit_code: 0, duration_ms: 5 }));
  });
  await waitFor(() => s.ctx.db.prepare("SELECT 1 FROM hosts WHERE id = 'h-ci'").get());
  ws.send(JSON.stringify({ type: 'inventory', host_id: 'h-ci', ts: new Date().toISOString(), data: inventory() }));
  await waitFor(() => s.ctx.db.prepare("SELECT 1 FROM hosts WHERE id = 'h-ci' AND inventory IS NOT NULL").get());
  if (token) await admin('PUT', '/api/github/token', { token: TOKEN });
  const poll = async () => { await s.ctx.github.poll(); return s.ctx.github.poll(); }; // a poll that starts after any running one
  const jobParams = id => JSON.parse(s.ctx.db.prepare('SELECT params FROM jobs WHERE id = ?').get(id).params);
  const jobType = id => s.ctx.db.prepare('SELECT type FROM jobs WHERE id = ?').get(id).type;
  return { s, gh, admin, agent, poll, jobParams, jobType };
}

test('helpers: runner URL parsing and version comparison', () => {
  assert.deepEqual(parseRunnerUrl('https://github.example.test/example-org/repo.git').scope, 'example-org/repo');
  assert.equal(parseRunnerUrl('https://github.example.test/example-org').kind, 'org');
  assert.equal(parseRunnerUrl('https://github.example.test/enterprises/x'), null);
  assert.equal(parseRunnerUrl('https://github.example.test/a/b/c'), null);
  assert.equal(parseScope('example-org/repo').kind, 'repo');
  assert.ok(versionBehind('2.329.0', 'v2.330.0'));
  assert.ok(!versionBehind('2.330.0', '2.330.0'));
  assert.ok(!versionBehind('2.331.1', '2.330.9'));
});

test('token: sealed at rest, write-only, never in responses, audit or settings', async t => {
  const { s, admin } = await setup(t, { token: false });
  assert.equal((await admin('GET', '/api/github/status')).data.configured, false);
  assert.equal((await admin('PUT', '/api/github/token', {})).status, 400); // nothing in the body or the environment
  const put = await admin('PUT', '/api/github/token', { token: TOKEN });
  assert.equal(put.status, 200);
  assert.deepEqual(put.data, { configured: true });
  const status = await admin('GET', '/api/github/status');
  assert.equal(status.data.configured, true);
  for (const p of ['/api/github/status', '/api/settings', '/api/runners', '/api/audit?limit=200']) {
    assert.ok(!JSON.stringify((await admin('GET', p)).data).includes(TOKEN), `${p} leaks the token`);
  }
  const raw = s.ctx.db.prepare("SELECT value FROM settings WHERE key = '_github_token'").get().value;
  assert.ok(!raw.includes(TOKEN));
  assert.equal(s.ctx.crypto.open(JSON.parse(raw)), TOKEN);
  // a viewer cannot set or clear it
  await admin('POST', '/api/users', { username: 'viewer1', password: 'pw-viewer-1', role: 'viewer' });
  const viewer = api(s.base, await login(s.base, 'viewer1', 'pw-viewer-1'));
  assert.equal((await viewer('PUT', '/api/github/token', { token: TOKEN })).status, 403);
  assert.equal((await admin('DELETE', '/api/github/token')).data.configured, false);
});

test('token: first save reads LABCTL_GITHUB_TOKEN when the body omits it', async t => {
  const { s, admin } = await setup(t, { token: false });
  process.env.LABCTL_GITHUB_TOKEN = TOKEN;
  t.after(() => { delete process.env.LABCTL_GITHUB_TOKEN; });
  assert.equal((await admin('PUT', '/api/github/token', {})).status, 200);
  assert.equal(s.ctx.github.configured(), true);
});

test('poll: matches by runner name, pages, uses ETags, queued age, public repo, mismatch and behind-latest', async t => {
  const { s, gh, admin, poll } = await setup(t);
  await poll();
  const { data } = await admin('GET', '/api/runners');
  const a = data.runners.find(r => r.name === 'runner-a');
  const b = data.runners.find(r => r.name === 'runner-b');
  // runner-a: service active, GitHub offline
  assert.equal(a.github.status, 'offline');
  assert.match(a.flags.mismatch, /offline but its service is running/);
  assert.deepEqual(a.github.labels, ['self-hosted', 'linux']);
  assert.equal(a.scope, 'example-org/repo');
  assert.equal(a.settings_url, 'https://github.example.test/example-org/repo/settings/actions');
  // runner-b: organisation scope, service inactive, GitHub online and busy (found on page 1 of 2)
  assert.equal(b.scope_kind, 'org');
  assert.equal(b.github.status, 'online');
  assert.equal(b.github.busy, true);
  assert.match(b.flags.mismatch, /online but its service is not running/);
  assert.equal(s.ctx.settings.get('github_runners').scopes['example-org'].runners.length, 2); // pagination
  // public repository flag
  assert.equal(a.flags.public_repo, true);
  assert.equal(b.flags.public_repo, true); // inferred from a public repository seen under the organisation
  // queued runs: count and age of the oldest (2 h)
  assert.equal(data.queued.repos['example-org/repo'].count, 2);
  assert.ok(Math.abs(data.queued.repos['example-org/repo'].oldest_age_s - 7200) < 60);
  assert.equal(s.ctx.settings.get('github_queued'), 2); // number, read by the fleet summary
  assert.equal((await admin('GET', '/api/fleet/summary')).data.queued_runs, 2);
  // latest runner
  assert.equal(data.latest.version, '2.330.0');
  assert.equal(data.latest.shas['linux-x64'], 'a'.repeat(64));
  assert.equal(a.flags.behind_latest, true);
  // conditional requests: the second poll gets 304 for the repo runner list
  await poll();
  assert.ok(gh.st.notModified >= 1, 'expected a 304 answer');
  // private repo clears the flag; status carries the poll time
  gh.st.isPrivate = true;
  await poll();
  assert.equal((await admin('GET', '/api/hosts/h-ci/runners')).data.runners[0].flags.public_repo, false);
  const st = (await admin('GET', '/api/github/status')).data;
  assert.ok(st.last_poll_at);
  assert.equal(st.last_poll_ok, true);
  assert.equal((await admin('GET', '/api/hosts/nope/runners')).status, 404);
});

test('poll: a matching state shows no mismatch', async t => {
  const { gh, admin, poll } = await setup(t);
  gh.st.runners['runner-a'].status = 'online';
  await poll();
  const a = (await admin('GET', '/api/runners')).data.runners.find(r => r.name === 'runner-a');
  assert.equal(a.flags.mismatch, null);
});

test('poll: a rate limit stops further calls until the reset', async t => {
  const { gh, admin, poll } = await setup(t);
  gh.st.rateLimited = true;
  await poll();
  const status = (await admin('GET', '/api/github/status')).data;
  assert.equal(status.last_poll_ok, false);
  assert.ok(status.backoff_until);
  assert.ok(status.errors.length >= 1);
  const before = gh.st.requests.length;
  await poll();
  assert.equal(gh.st.requests.length, before, 'no request while backing off');
});

test('check-permissions: per scope pass or fail with the exact permission names, write test only on request', async t => {
  const { gh, admin } = await setup(t);
  gh.st.deny = ['/orgs/example-org'];
  const read = (await admin('POST', '/api/github/check-permissions', {})).data;
  assert.equal(read.write_check, false);
  const find = (scope, name) => read.checks.find(c => c.scope === scope && c.name === name);
  assert.equal(find('token', 'Token accepted').ok, true);
  assert.equal(find('example-org/repo', 'Read self-hosted runners').ok, true);
  assert.equal(find('example-org/repo', 'Read queued workflow runs').ok, true);
  assert.equal(find('example-org/repo', 'Create registration tokens').ok, null);
  assert.deepEqual(find('example-org', 'Read self-hosted runners').missing, ['Self-hosted runners (read)']);
  assert.ok(!gh.st.requests.some(r => r.startsWith('POST')), 'no write call without write_check');
  gh.st.deny = ['/repos/example-org/repo/actions/runners/registration-token'];
  const write = await admin('POST', '/api/github/check-permissions', { write_check: true });
  assert.ok(!JSON.stringify(write.data).includes(REG));
  assert.deepEqual(write.data.checks.find(c => c.scope === 'example-org/repo' && c.name === 'Create registration tokens').missing, ['Administration (write)']);
  assert.equal(write.data.checks.find(c => c.scope === 'example-org' && c.name === 'Create registration tokens').ok, true);
  gh.st.deny = [];
});

test('runnerOnline: true once GitHub shows online, false at the deadline', async t => {
  const { s, gh } = await setup(t);
  const host = { id: 'h-ci' };
  assert.equal(await s.ctx.github.runnerOnline(host, 'runner-a', 300), false);
  setTimeout(() => { gh.st.runners['runner-a'].status = 'online'; }, 150);
  assert.equal(await s.ctx.github.runnerOnline(host, 'runner-a', 3000, { scope: 'example-org/repo' }), true);
});

test('runner_update: online in GitHub proves it, then the kept folder is discarded', async t => {
  const { s, gh, admin, agent, jobParams, jobType } = await setup(t);
  gh.st.runners['runner-a'].status = 'online';
  const r = await admin('POST', '/api/runners/action', { host_id: 'h-ci', runner: 'runner-a', template: 'runner_update', drain: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.verify, true);
  const id = r.data.jobs[0].job_id;
  await waitFor(() => jobParams(id).verify?.status === 'online');
  assert.equal(agent.ran[0].env.LABCTL_P_DRAIN, '1');
  assert.equal(agent.ran[0].env.LABCTL_P_RUNNER_DIR, '/opt/runner-a');
  await waitFor(() => agent.ran.length === 2);
  assert.equal(jobType(agent.ran[1].job_id), 'template:runner_rollback');
  assert.equal(agent.ran[1].env.LABCTL_P_ACTION, 'discard');
  assert.ok(s.ctx.audit.query({ action: 'runner.verify' }).total >= 1);
});

test('runner_update: not online within the limit starts runner_rollback and records it on the job', async t => {
  const { s, admin, agent, jobParams, jobType } = await setup(t); // runner-a stays offline in GitHub
  s.ctx.settings.set('github_verify_timeout_s', 0.3);
  const r = await admin('POST', '/api/runners/action', { host_id: 'h-ci', runner: 'runner-a', template: 'runner_update', drain: true });
  const id = r.data.jobs[0].job_id;
  await waitFor(() => jobParams(id).verify?.status === 'rolling_back', 5000);
  const v = jobParams(id).verify;
  assert.match(v.detail, /did not return online/);
  assert.equal(jobType(v.rollback_job_id), 'template:runner_rollback');
  await waitFor(() => agent.ran.some(x => x.job_id === v.rollback_job_id));
  assert.equal(agent.ran.find(x => x.job_id === v.rollback_job_id).env.LABCTL_P_ACTION, 'rollback');
});

test('runner_reregister: the registration token reaches the script as an environment value only', async t => {
  const { s, gh, admin, agent, jobParams } = await setup(t);
  gh.st.runners['runner-a'].status = 'online';
  assert.equal((await admin('PUT', '/api/runners/prefs', { host_id: 'h-ci', runner: 'runner-a', disable_update: true })).status, 200);
  const r = await admin('POST', '/api/runners/action', { host_id: 'h-ci', runner: 'runner-a', template: 'runner_reregister', drain: true });
  assert.equal(r.status, 200);
  const id = r.data.jobs[0].job_id;
  await waitFor(() => agent.ran.length >= 1);
  assert.equal(agent.ran[0].env.LABCTL_SECRET_REG_TOKEN, REG);
  assert.equal(agent.ran[0].env.LABCTL_P_DISABLE_UPDATE, '1');
  await waitFor(() => jobParams(id).verify?.status === 'online');
  // not in the response, the jobs table, the audit log, the job log files or the credentials table
  assert.ok(!JSON.stringify(r.data).includes(REG));
  assert.ok(!JSON.stringify(s.ctx.db.prepare('SELECT * FROM jobs').all()).includes(REG));
  assert.ok(!JSON.stringify(s.ctx.audit.query({ limit: 500 })).includes(REG));
  assert.ok(!JSON.stringify(s.ctx.audit.query({ limit: 500 })).includes(TOKEN));
  assert.equal(s.ctx.db.prepare("SELECT COUNT(*) AS n FROM credentials WHERE purpose = 'runner-token'").get().n, 0);
  const logDir = path.join(s.dataDir, 'job-logs');
  for (const f of fs.existsSync(logDir) ? fs.readdirSync(logDir) : []) assert.ok(!fs.readFileSync(path.join(logDir, f), 'utf8').includes(REG));
});

test('runner_remove: admin only, typed host name, removal token in the environment; force needs the host name too', async t => {
  const { s, gh, admin, agent } = await setup(t);
  gh.st.runners['runner-a'].status = 'online';
  const body = { host_id: 'h-ci', runner: 'runner-a', template: 'runner_remove', drain: true };
  const noConfirm = await admin('POST', '/api/runners/action', body);
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.data.confirm_word, 'alpha.example.test');
  await admin('POST', '/api/users', { username: 'op1', password: 'pw-operator-1', role: 'operator' });
  const op = api(s.base, await login(s.base, 'op1', 'pw-operator-1'));
  assert.equal((await op('POST', '/api/runners/action', { ...body, confirm: 'alpha.example.test' })).status, 403);
  assert.equal((await admin('POST', '/api/runners/action', { ...body, confirm: 'alpha.example.test' })).status, 200);
  await waitFor(() => agent.ran.length >= 1);
  assert.equal(agent.ran[0].env.LABCTL_SECRET_REMOVE_TOKEN, REMOVE);
  const force = { host_id: 'h-ci', runner: 'runner-a', template: 'runner_cleanup', force: true };
  assert.equal((await admin('POST', '/api/runners/action', force)).status, 400);
  assert.equal((await op('POST', '/api/runners/action', { ...force, confirm: 'alpha.example.test' })).status, 200);
});

test('runner actions: unknown runner, unknown template and a missing token are refused', async t => {
  const { admin } = await setup(t, { token: false });
  assert.equal((await admin('POST', '/api/runners/action', { host_id: 'h-ci', runner: 'nope', template: 'runner_cleanup' })).status, 404);
  assert.equal((await admin('POST', '/api/runners/action', { host_id: 'h-ci', runner: 'runner-a', template: 'win_update' })).status, 400);
  const noToken = await admin('POST', '/api/runners/action', { host_id: 'h-ci', runner: 'runner-a', template: 'runner_reregister' });
  assert.equal(noToken.status, 400);
  assert.match(noToken.data.error, /not configured/);
});

test('ci-patch-cycle: host name confirmation, runner and scope passed to the runbook engine', async t => {
  const { s, admin } = await setup(t);
  assert.equal((await admin('POST', '/api/hosts/h-ci/ci-patch-cycle', {})).status, 400);
  let seen = null;
  s.ctx.runbooks.start = (rb, body, actor) => { seen = { id: rb.id, body, actor }; return { run: { id: 'run-1', status: 'queued' } }; };
  const r = await admin('POST', '/api/hosts/h-ci/ci-patch-cycle', { confirm: 'alpha.example.test', runner: 'runner-b' });
  assert.equal(r.status, 200);
  assert.equal(r.data.id, 'run-1');
  assert.equal(seen.id, 'ci_host_patch_cycle');
  assert.deepEqual(seen.body.params, { RUNNER_NAME: 'runner-b', RUNNER_SCOPE: 'example-org' });
  assert.deepEqual(seen.body.host_ids, ['h-ci']);
  delete s.ctx.runbooks.start;
});
