// Deploys that must always end: a silent target hits the phase limit, an engine exception ends as failed, the stream of an
// ended deploy closes at once, the polling endpoint, hosts imported from v1 (free-text OS, address with a port or scheme),
// address and OS overrides on redeploy, and the plain-words reasons for closed ports on Linux and Windows.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { startApp, login, api } = require('./helpers');
const unix = require('../src/deploy/unix');
const windows = require('../src/deploy/windows');

const PW = 'throwaway-pw';
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
async function closedPort() {
  const srv = net.createServer();
  const port = await listen(srv);
  await new Promise(r => srv.close(r));
  return port;
}
// Accepts TCP and never says a word: an SSH peer that hangs.
async function silentServer() {
  const socks = new Set();
  const srv = net.createServer(s => { socks.add(s); s.on('error', () => {}); });
  const port = await listen(srv);
  return { port, close: () => { for (const s of socks) s.destroy(); srv.close(); } };
}
async function finished(call, id, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await call('GET', `/api/deploy/${id}`);
    if (r.data.state !== 'running') return r.data;
    await new Promise(r2 => setTimeout(r2, 50));
  }
  throw new Error('deploy did not finish');
}
const addHost = (s, id, cols) => s.ctx.db.prepare(`INSERT INTO hosts (id, hostname, os, ip, kind, status, system_info, data, created_at, updated_at)
  VALUES (@id, @hostname, @os, @ip, 'agent', 'offline', '{}', NULL, @at, @at)`).run({ id, hostname: null, os: null, ip: null, at: new Date().toISOString(), ...cols });

test('a deploy always ends: phase limit, engine exception, stream after the end, polling, server log lines', async (t) => {
  const s = await startApp();
  const silent = await silentServer();
  const warned = [];
  s.ctx.logger.warn = (...a) => warned.push(a.join(' '));
  t.after(async () => { silent.close(); await s.stop(); });
  const admin = api(s.base, await login(s.base));
  const start = extra => admin('POST', '/api/deploy/start', { address: '127.0.0.1', os: 'linux', name: 'target-v1', auth: { user: 'tester', password: PW }, ...extra });

  await t.test('a target that accepts TCP and never answers fails on the pre-flight limit', async () => {
    s.ctx.deploy.config.preflightMs = 600;
    const r = await start({ port: silent.port });
    assert.equal(r.status, 202);
    const d = await finished(admin, r.data.deploy_id);
    assert.equal(d.state, 'failed');
    assert.match(d.error, /The Pre-flight step timed out after 1 s/);
    assert.ok(warned.some(l => l.includes(`[deploy] ${d.id} host target-v1 phase preflight failed: The Pre-flight step timed out`)), warned.join('\n'));
    assert.ok(!warned.join('\n').includes(PW));
    s.ctx.deploy.config.preflightMs = 120000;
  });

  await t.test('an exception inside the engine ends the deploy as failed with its message', async () => {
    const real = unix.inspect;
    unix.inspect = () => { throw new TypeError('simulated engine bug'); };
    try {
      const r = await start({ port: silent.port });
      const d = await finished(admin, r.data.deploy_id);
      assert.equal(d.state, 'failed');
      assert.equal(d.error, 'simulated engine bug');
    } finally { unix.inspect = real; }
  });

  await t.test('the stream of an ended deploy sends the snapshot and done at once, then closes', async () => {
    const r = await start({ port: await closedPort() });
    const d = await finished(admin, r.data.deploy_id);
    const res = await fetch(`${s.base}/api/deploy/${d.id}/stream`, { headers: { authorization: `Bearer ${await login(s.base)}` }, signal: AbortSignal.timeout(3000) });
    assert.equal(res.status, 200);
    const text = await res.text(); // resolves only because the server ends the response
    assert.match(text, /^event: snapshot\ndata: \{"state":"failed"/m);
    assert.match(text, /event: done\ndata: \{"state":"failed","error":"Pre-flight failed. Port reachability: 127\.0\.0\.1:\d+ is not reachable: connection refused on port \d+\./);
  });

  await t.test('the polling endpoint returns state, phase and lines; an unknown id is 404', async () => {
    const r = await start({ port: await closedPort() });
    const d = await finished(admin, r.data.deploy_id);
    assert.equal(d.phase, 'preflight');
    assert.ok(d.lines.some(l => l.startsWith('[FAIL] Port reachability')));
    assert.ok(d.finished_at);
    assert.equal((await admin('GET', '/api/deploy/000000000000')).status, 404);
  });
});

test('v1 hosts: address and OS derived from what v1 stored, overrides validated', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const admin = api(s.base, await login(s.base));
  addHost(s, 'v1-linux', { hostname: 'linux-a', os: 'debian-12', ip: '192.0.2.44:2222' });
  addHost(s, 'v1-win', { hostname: 'win-a', os: 'windows-server-2025Server', ip: '[2001:db8::5]:22' });
  addHost(s, 'v1-url', { hostname: 'url-a', os: 'ubuntu-24.04', ip: 'ssh://admin@192.0.2.45:22/' });
  addHost(s, 'v1-none', { hostname: 'BOX', os: 'debian-13', ip: null });
  addHost(s, 'v1-name', { hostname: 'box.example.test', os: 'debian-13', ip: '' });
  const target = async id => (await admin('GET', `/api/hosts/${id}/deploy-target`)).data;

  await t.test('free-text OS and loose address forms', async () => {
    assert.deepEqual(await target('v1-linux'), { os: 'linux', address: '192.0.2.44', port: null, has_credential: false });
    assert.deepEqual(await target('v1-win'), { os: 'windows', address: '2001:db8::5', port: null, has_credential: false });
    assert.equal((await target('v1-url')).address, '192.0.2.45');
    assert.equal((await target('v1-none')).address, '');
    assert.equal((await target('v1-name')).address, 'box.example.test');
  });

  const redeploy = (id, extra) => admin('POST', `/api/hosts/${id}/redeploy`, { auth: { user: 'tester', password: PW }, ...extra });
  await t.test('no known address: a plain error asking for one', async () => {
    const r = await redeploy('v1-none', {});
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'LabCTL does not know an address for this host. Enter its address.');
  });

  await t.test('address override: shell metacharacters refused, a good one accepted and used', async () => {
    for (const bad of ['192.0.2.1;reboot', '$(id)', '-oProxyCommand=x', 'a b']) {
      const r = await redeploy('v1-none', { address: bad });
      assert.equal(r.status, 400, bad);
      assert.match(r.data.error, /address must be a host name or IP address/);
    }
    assert.equal((await redeploy('v1-none', { address: '127.0.0.1', os: 'plan9' })).status, 400);
    assert.equal((await redeploy('v1-none', { address: '127.0.0.1', port: 70000 })).status, 400);
    const port = await closedPort();
    const r = await redeploy('v1-none', { address: '127.0.0.1', os: 'linux', port, ignored_empty: '' });
    assert.equal(r.status, 202);
    const d = await finished(admin, r.data.deploy_id);
    assert.equal(d.address, '127.0.0.1');
    assert.match(d.error, new RegExp(`127\\.0\\.0\\.1:${port} is not reachable: connection refused on port ${port}\\.`));
  });

  await t.test('empty override fields fall back to the derived target', async () => {
    const r = await redeploy('v1-linux', { address: '', os: '', port: '' });
    assert.equal(r.status, 202);
    const d = (await admin('GET', `/api/deploy/${r.data.deploy_id}`)).data;
    assert.equal(d.address, '192.0.2.44');
    assert.equal(d.os, 'linux');
  });
});

test('redeploy with a shared credential: needs no user in the request, unknown ids are refused', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const admin = api(s.base, await login(s.base));
  addHost(s, 'v1-shared', { hostname: 'shared-a', os: 'debian-12', ip: '192.0.2.50' });
  const made = await admin('POST', '/api/credentials', { name: 'root', username: 'root', password: PW });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const bad = await admin('POST', '/api/hosts/v1-shared/redeploy', { auth: { credential_id: 'nope' } });
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(bad.data), /Unknown credential/);
  const ok = await admin('POST', '/api/hosts/v1-shared/redeploy', { auth: { credential_id: made.data.id }, port: await closedPort() });
  assert.equal(ok.status, 202, JSON.stringify(ok.data));
  const d = await finished(admin, ok.data.deploy_id, 20000);
  assert.equal(d.state, 'failed');
  assert.doesNotMatch(d.error || '', /user name is required/);
});

test('windows: both ways in closed gives the two options in plain words', async () => {
  const port = await closedPort();
  const r = await windows.inspect({ os: 'windows', address: '127.0.0.1', port, user: 'a', password: 'p' }, { server: 'http://192.0.2.1' });
  const row = r.checks[0];
  assert.equal(row.ok, false);
  assert.match(row.detail, new RegExp(`${port} closed \\(OpenSSH\\): connection refused on port ${port}`));
  assert.match(row.detail, /OpenSSH Server optional feature on port 22/);
  assert.match(row.detail, /WinRM on port 5985 \(HTTP\) or 5986 \(HTTPS\)/);
  assert.match(row.detail, /winrm quickconfig/);
});
