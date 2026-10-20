// Ephemeral runner manager (A15): replacement after a job, guards, backoff and stuck flag, flag persistence.
// Fake GitHub API on a random port and a fake agent over the real WebSocket. No real GitHub call, no real token.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startApp, login, api, wsOpen, waitFor } = require('./helpers');
const { inventory } = require('./inventory-fixture');
const { METRICS } = require('../src/alerting/rules');

const TOKEN = 'gh' + 'p_FAKE0000000000000000000000000000TEST';
const REG = 'REGTOKEN-EPHEMERAL-SECRET';
const URL_REPO = 'https://github.example.test/example-org/repo';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fakeGithub() {
  const st = { present: [], tokens: 0, tokenFail: false }; // present: [{ name, busy }]
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Bad credentials' });
    if (p === '/repos/example-org/repo/actions/runners' && req.method === 'GET') {
      return send(200, { total_count: st.present.length, runners: st.present.map((r, i) => ({ id: i + 1, name: r.name, os: 'linux', status: 'online', busy: !!r.busy, labels: [{ name: 'self-hosted' }, { name: 'build' }] })) });
    }
    if (p === '/repos/example-org/repo') return send(200, { private: true });
    if (p === '/repos/example-org/repo/actions/runs') return send(200, { total_count: 0, workflow_runs: [] });
    if (p === '/repos/actions/runner/releases/latest') return send(200, { tag_name: 'v2.330.0', published_at: '2026-10-01T00:00:00Z', body: '' });
    if (req.method === 'POST' && p.endsWith('/registration-token')) {
      if (st.tokenFail) return send(500, { message: 'Server error' });
      st.tokens++;
      return send(201, { token: REG });
    }
    return send(404, { message: 'Not Found' });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ st, base: `http://127.0.0.1:${server.address().port}`, close: () => server.closeAllConnections() || server.close() })));
}

const runner = (name, over = {}) => ({ path: `/opt/${name}`, name, url: URL_REPO, pool: 'default', level: 'repo', labels: ['self-hosted', 'linux', 'build'],
  service: `actions.runner.example-org-repo.${name}.service`, service_state: 'inactive', run_as: 'runner', source: 'systemd', version: '2.330.0',
  busy: false, job: null, sizes: { work: 1e6, diag: 0, temp: 0, tool_cache: 0 }, sizes_partial: false, log_tail: [], ...over });

// One agent host (h-ci) with an admin client. setInventory(runners) pushes a new inventory and waits until the server has it.
async function setup(t) {
  const gh = await fakeGithub();
  const s = await startApp();
  const sockets = [];
  t.after(async () => {
    await Promise.all(sockets.map(w => new Promise(r => { if (w.readyState === 3) return r(); w.on('close', r); w.close(); })));
    await sleep(50);
    await s.stop();
    gh.close();
  });
  s.ctx.settings.set('github_api_base', gh.base);
  s.ctx.settings.set('github_verify_interval_s', 0.05); // a manual re-register starts a verify loop: keep it short
  s.ctx.settings.set('github_verify_timeout_s', 0.3);
  const admin = api(s.base, await login(s.base));
  const enrol = (await admin('POST', '/api/tokens', { label: 'eph' })).data.value;
  const agent = { ran: [], fail: false, frames: [] };
  const ws = await wsOpen(s.port, enrol);
  sockets.push(ws);
  ws.send(JSON.stringify({ type: 'register', host_id: 'h-ci', hostname: 'alpha.example.test', os: 'linux', kind: 'agent', agent_version: '2.0.0', info: {} }));
  ws.on('message', d => {
    const m = JSON.parse(d.toString());
    agent.frames.push(m.type);
    if (m.type !== 'run_job') return;
    agent.ran.push({ job_id: m.job_id, env: m.env });
    ws.send(JSON.stringify({ type: 'job_complete', job_id: m.job_id, status: agent.fail ? 'failed' : 'success', exit_code: agent.fail ? 1 : 0, duration_ms: 5 }));
  });
  await waitFor(() => s.ctx.db.prepare("SELECT 1 FROM hosts WHERE id = 'h-ci'").get());
  const setInventory = async runners => {
    const before = s.ctx.db.prepare("SELECT inventory_at FROM hosts WHERE id = 'h-ci'").get().inventory_at;
    await sleep(5);
    ws.send(JSON.stringify({ type: 'inventory', host_id: 'h-ci', ts: new Date().toISOString(), data: inventory({ runners }) }));
    await waitFor(() => s.ctx.db.prepare("SELECT inventory_at FROM hosts WHERE id = 'h-ci'").get().inventory_at !== before);
    await sleep(5);
  };
  await admin('PUT', '/api/github/token', { token: TOKEN });
  const poll = async () => { await s.ctx.github.poll(); return s.ctx.github.poll(); };
  let offset = 0;
  s.ctx.ephemeral.clock = () => Date.now() + offset;
  const later = secs => { offset += secs * 1000; };
  const entry = async name => (await admin('GET', '/api/runners')).data.runners.find(r => r.name === name);
  const flag = (name, ephemeral = true) => admin('PUT', '/api/runners/ephemeral', { host_id: 'h-ci', runner: name, ephemeral, apply: false });
  const tick = () => s.ctx.ephemeral.tick();
  return { s, gh, admin, agent, setInventory, poll, later, entry, flag, tick };
}

const stateOf = (s, key) => (s.ctx.settings.get('ephemeral_state') || {})[key];

test('a finished ephemeral runner is replaced once, the token reaches the script through the environment only', async t => {
  const { s, gh, admin, agent, setInventory, poll, later, entry, flag, tick } = await setup(t);
  await setInventory([runner('eph-1')]); // service stopped
  await flag('eph-1');
  await poll(); // GitHub no longer lists the runner: the job is done and it was deregistered

  assert.equal((await entry('eph-1')).flags.missing_in_github, true);
  const r1 = await tick();
  assert.deepEqual(r1.replaced, ['eph-1']);
  assert.equal(agent.ran.length, 1);
  const env = agent.ran[0].env;
  assert.equal(env.LABCTL_SECRET_REG_TOKEN, REG);
  assert.equal(env.LABCTL_P_EPHEMERAL, '1');
  assert.equal(env.LABCTL_P_CLEAN_WORK, '1');
  assert.equal(env.LABCTL_P_NAME, 'eph-1');
  assert.equal(env.LABCTL_P_URL, URL_REPO);
  assert.equal(env.LABCTL_P_LABELS, 'build'); // GitHub's built-in labels are left out
  assert.equal(gh.st.tokens, 1);

  // the token lives nowhere: not in jobs, audit, settings or credentials
  const dump = JSON.stringify([
    s.ctx.db.prepare('SELECT * FROM jobs').all(), s.ctx.db.prepare('SELECT * FROM audit_log').all(),
    s.ctx.db.prepare('SELECT * FROM settings').all(), s.ctx.db.prepare('SELECT * FROM credentials').all()]);
  assert.ok(!dump.includes(REG), 'registration token leaked');
  assert.equal(s.ctx.db.prepare("SELECT COUNT(*) AS n FROM credentials WHERE purpose = 'runner-token'").get().n, 0);

  // audited as the system, recorded as a runner event
  const rows = s.ctx.db.prepare("SELECT actor, detail FROM audit_log WHERE action = 'runner.ephemeral.replace'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, 'system');
  const e = await entry('eph-1');
  assert.ok(e.ephemeral.last_replaced_at);
  assert.equal(e.ephemeral.events.length, 1);
  assert.equal(e.ephemeral.events[0].ok, true);

  // stale data must not trigger a second replacement, even once the 20 s gap has passed.
  // The replacement registered with GitHub: the poll that the first replacement started in the background must see it,
  // otherwise the result depends on whether that poll finished before the next tick.
  gh.st.present = [{ name: 'eph-1' }];
  await poll();
  later(25);
  assert.equal((await tick()).replaced.length, 0);
  assert.equal(agent.ran.length, 1);

  // the new runner comes up healthy: nothing to do
  gh.st.present = [{ name: 'eph-1' }];
  await setInventory([runner('eph-1', { service_state: 'active' })]);
  await poll();
  assert.equal((await tick()).replaced.length, 0);

  // it takes a job, GitHub removes it: a second replacement
  gh.st.present = [];
  await setInventory([runner('eph-1')]);
  await poll();
  later(25);
  assert.deepEqual((await tick()).replaced, ['eph-1']);
  assert.equal(agent.ran.length, 2);
  assert.equal((await admin('GET', '/api/runners')).status, 200);
});

test('a busy host is never touched, local or GitHub busy', async t => {
  const { gh, agent, setInventory, poll, flag, tick } = await setup(t);
  await setInventory([runner('eph-1'), runner('other', { service_state: 'active', busy: true, job: 'build' })]);
  await flag('eph-1');
  gh.st.present = [{ name: 'other', busy: true }];
  await poll();
  let r = await tick();
  assert.equal(r.skipped['h-ci/eph-1'], 'busy');
  assert.equal(agent.ran.length, 0);

  // busy only in GitHub (the inventory is older)
  await setInventory([runner('eph-1'), runner('other', { service_state: 'active' })]);
  await poll();
  r = await tick();
  assert.equal(r.skipped['h-ci/eph-1'], 'busy');
  assert.equal(agent.ran.length, 0);

  // idle again: replaced
  gh.st.present = [{ name: 'other', busy: false }];
  await poll();
  assert.deepEqual((await tick()).replaced, ['eph-1']);
});

test('failures back off exponentially and the fifth raises ephemeral_stuck, a reset recovers', async t => {
  const { s, gh, admin, agent, setInventory, poll, later, entry, flag, tick } = await setup(t);
  await setInventory([runner('eph-1')]);
  await flag('eph-1');
  await poll();

  gh.st.tokenFail = true; // attempt 1: the token call fails
  await tick();
  assert.equal(stateOf(s, 'h-ci/eph-1').failures, 1);
  assert.equal(agent.ran.length, 0);
  assert.ok(!JSON.stringify(stateOf(s, 'h-ci/eph-1')).includes(REG));
  gh.st.tokenFail = false;
  agent.fail = true; // the script fails from now on

  assert.equal((await tick()).skipped['h-ci/eph-1'], 'rate limited'); // under 20 s
  later(25);
  assert.equal((await tick()).skipped['h-ci/eph-1'], 'backoff'); // 25 s is past the gap but inside the 30 s backoff
  later(10);
  await tick(); // attempt 2
  assert.equal(stateOf(s, 'h-ci/eph-1').failures, 2);
  const st2 = stateOf(s, 'h-ci/eph-1');
  assert.equal(Date.parse(st2.next_at) - Date.parse(st2.last_at), 60000);

  for (const n of [3, 4, 5]) { later(1000); await tick(); assert.equal(stateOf(s, 'h-ci/eph-1').failures, n); }
  const st = stateOf(s, 'h-ci/eph-1');
  assert.equal(st.stuck, true);
  assert.equal(agent.ran.length, 4); // attempt 1 never reached the agent
  const e = await entry('eph-1');
  assert.equal(e.flags.ephemeral_stuck, true);
  assert.equal(e.ephemeral.failures, 5);
  assert.equal(s.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'runner.ephemeral.stuck'").get().n, 1);

  // nothing more happens while stuck, and the alert metric sees it
  later(5000);
  assert.equal((await tick()).skipped['h-ci/eph-1'], 'stuck');
  assert.equal(agent.ran.length, 4);
  const items = METRICS.runner_ephemeral_stuck.eval({ db: s.ctx.db });
  assert.deepEqual(items.map(i => [i.host_id, i.key, i.value]), [['h-ci', 'eph-1', 1]]);

  // the operator resets it and the next pass replaces the runner
  agent.fail = false;
  assert.equal((await admin('POST', '/api/runners/ephemeral/reset', { host_id: 'h-ci', runner: 'eph-1' })).status, 200);
  assert.equal(METRICS.runner_ephemeral_stuck.eval({ db: s.ctx.db })[0].value, 0);
  later(5000);
  assert.deepEqual((await tick()).replaced, ['eph-1']);
  assert.equal(stateOf(s, 'h-ci/eph-1').failures, 0);
});

test('a maintenance window and the ephemeral_enabled setting hold the manager back', async t => {
  const { s, admin, agent, setInventory, poll, flag, tick } = await setup(t);
  await setInventory([runner('eph-1')]);
  await flag('eph-1');
  await poll();

  s.ctx.maintenance = { isInMaintenance: id => id === 'h-ci' };
  assert.equal((await tick()).skipped['h-ci/eph-1'], 'maintenance window');
  assert.equal(agent.ran.length, 0);
  s.ctx.maintenance = { isInMaintenance: () => false };

  assert.equal((await admin('GET', '/api/runners/ephemeral/settings')).data.enabled, true); // default on
  assert.equal((await admin('PUT', '/api/runners/ephemeral/settings', { enabled: 'no' })).status, 400);
  assert.equal((await admin('PUT', '/api/runners/ephemeral/settings', { enabled: false })).data.enabled, false);
  const off = await tick();
  assert.equal(off.disabled, true);
  assert.equal(agent.ran.length, 0);

  await admin('PUT', '/api/runners/ephemeral/settings', { enabled: true });
  assert.deepEqual((await tick()).replaced, ['eph-1']);
  assert.equal(s.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'runner.ephemeral.settings'").get().n, 2);
});

test('the flag is stored per runner, survives other prefs, feeds add and re-register, and unflagged runners are left alone', async t => {
  const { s, gh, admin, agent, setInventory, poll, entry, flag, tick } = await setup(t);
  await setInventory([runner('eph-1'), runner('plain')]);
  gh.st.present = [];
  await poll();

  assert.equal((await entry('eph-1')).ephemeral.enabled, false);
  assert.equal((await admin('PUT', '/api/runners/ephemeral', { host_id: 'h-ci', runner: 'eph-1', ephemeral: 'yes' })).status, 400);
  assert.equal((await admin('PUT', '/api/runners/ephemeral', { host_id: 'h-ci', runner: 'nope', ephemeral: true })).status, 404);
  assert.equal((await flag('eph-1')).data.applied, false);
  assert.equal((await entry('eph-1')).ephemeral.enabled, true);
  assert.equal((await entry('plain')).ephemeral.enabled, false);

  // the auto-update pref merges into the same record
  assert.equal((await admin('PUT', '/api/runners/prefs', { host_id: 'h-ci', runner: 'eph-1', disable_update: true })).status, 200);
  assert.deepEqual(s.ctx.settings.get('github_runner_prefs')['h-ci/eph-1'], { ephemeral: true, disable_update: true });

  // only the flagged runner is replaced, the plain stopped one is not
  const r = await tick();
  assert.deepEqual(r.replaced, ['eph-1']);
  assert.equal(r.skipped['h-ci/plain'], undefined);
  assert.equal(agent.ran.length, 1);
  assert.equal(agent.ran[0].env.LABCTL_P_DISABLE_UPDATE, '1');

  // a manual re-register keeps the stored mode
  await setInventory([runner('eph-1', { service_state: 'active' }), runner('plain')]);
  agent.ran.length = 0;
  const rr = await admin('POST', '/api/runners/action', { host_id: 'h-ci', runner: 'eph-1', template: 'runner_reregister', params: {}, drain: false });
  assert.equal(rr.status, 200, JSON.stringify(rr.data));
  await waitFor(() => agent.ran.length === 1);
  assert.equal(agent.ran[0].env.LABCTL_P_EPHEMERAL, '1');
  assert.equal(agent.ran[0].env.LABCTL_P_CLEAN_WORK, '1');

  // switching it off applies a persistent registration now
  agent.ran.length = 0;
  const off = await admin('PUT', '/api/runners/ephemeral', { host_id: 'h-ci', runner: 'eph-1', ephemeral: false });
  assert.equal(off.data.applied, true, JSON.stringify(off.data));
  await waitFor(() => agent.ran.length === 1);
  assert.equal(agent.ran[0].env.LABCTL_P_EPHEMERAL, '0');
  assert.equal(s.ctx.settings.get('github_runner_prefs')['h-ci/eph-1'].ephemeral, false);

  // runner_add with the toggle stores the flag and passes --ephemeral to the script
  agent.ran.length = 0;
  const add = await admin('POST', '/api/runners/action', { host_id: 'h-ci', template: 'runner_add', params: { URL: URL_REPO, NAME: 'new-eph', EPHEMERAL: true } });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  await waitFor(() => agent.ran.length === 1);
  assert.equal(agent.ran[0].env.LABCTL_P_EPHEMERAL, '1');
  assert.equal(s.ctx.settings.get('github_runner_prefs')['h-ci/new-eph'].ephemeral, true);
});

test('the alert rule exists and the runner scripts carry the new switches', () => {
  const fs = require('fs');
  const path = require('path');
  const { DEFAULT_RULES } = require('../src/alerting/rules');
  assert.ok(DEFAULT_RULES.some(r => r.condition.metric === 'runner_ephemeral_stuck'));
  const dir = path.join(__dirname, '..', 'src', 'templates');
  assert.match(fs.readFileSync(path.join(dir, 'unix', 'runner_reregister.sh'), 'utf8'), /LABCTL_P_EPHEMERAL[\s\S]*LABCTL_EPHEMERAL=1/);
  assert.match(fs.readFileSync(path.join(dir, 'unix', 'runner_reregister.sh'), 'utf8'), /clear_dir "\$DIR\/_work"/);
  const win = fs.readFileSync(path.join(dir, 'windows', 'runner_reregister_win.ps1'), 'utf8');
  assert.match(win, /Get-Flag 'EPHEMERAL'\) \{ \$cfg \+= '--ephemeral' \}/);
  assert.match(win, /Clear-Dir \(Join-Path \$dir '_work'\)/);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  for (const id of ['runner_reregister', 'runner_reregister_win']) {
    const names = manifest.templates.find(x => x.id === id).params.map(p => p.name);
    assert.ok(names.includes('EPHEMERAL') && names.includes('CLEAN_WORK'), id);
  }
});
