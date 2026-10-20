// Deploy wizard: pre-flight, install flow against a local ssh2 server acting as a Linux target (exec and SFTP, and a fake
// agent that registers with the token it finds in the uploaded env file), secrets handling, redeploy, remove agent,
// relay through a fake agent, manual commands, and unit tests for the WinRM and Windows layers (no real Windows needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Server, utils } = require('ssh2');
const { startApp, login, api, wsOpen, waitFor } = require('./helpers');
const unix = require('../src/deploy/unix');
const windows = require('../src/deploy/windows');
const winrm = require('../src/deploy/winrm');

const PW = 'login-pw-throwaway';
const SUDO = 'sudo-pw-throwaway';
const OK = utils.sftp.STATUS_CODE.OK;
const AGENT_DIR = path.join(__dirname, '..', '..', 'agent');

// Closed before the app stops, so no socket outlives the database.
const cleanup = [];
const frame = (ws, o) => ws.send(JSON.stringify(o));
const register = (ws, id, name, extra = {}) => frame(ws, { type: 'register', host_id: id, hostname: name, os: 'linux', kind: 'agent', agent_version: '2.0.0', info: {}, ...extra });
const PROBE = { kernel: 'Linux', arch: 'x86_64', uid: '1000', os_name: 'Debian GNU/Linux 12', python: 'python3 3.11', sudo: 'password', free_kb: '5000000', outbound: 'ok' };
const kvText = kv => Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';

// A Linux target. On the install command it registers a fake agent with the token from the uploaded env file.
function fakeLinux(appPort, o = {}) {
  const opt = { password: PW, sudoPw: SUDO, uid: 1000, hostId: 'h-deploy-1', failInstall: false, probe: {}, ...o };
  const seen = { commands: [], stdin: [], files: new Map(), removed: [], agents: [], tokens: [] };
  const hostKey = utils.generateKeyPairSync('ed25519').private;

  async function agentUp(token) {
    const ws = await wsOpen(appPort, token);
    ws.on('message', raw => { if (JSON.parse(raw).type === 'uninstall') frame(ws, { type: 'agent_gone', host_id: opt.hostId }); });
    register(ws, opt.hostId, 'deploy-target.example.test');
    seen.agents.push(ws);
  }

  async function handle(cmd, input, stream) {
    if (cmd === 'sh -s') { stream.write(kvText({ ...PROBE, uid: opt.uid, sudo: opt.uid === 0 ? 'root' : 'password', ...opt.probe })); return 0; }
    if (cmd === 'id -u') { stream.write(`${opt.uid}\n`); return 0; }
    if (cmd.startsWith("sudo -S -p '' -v")) {
      seen.stdin.push(input);
      if (input.trim() === opt.sudoPw) return 0;
      stream.stderr.write('Sorry, try again.\n');
      return 1;
    }
    if (cmd.includes('bash -c')) {
      if (cmd.startsWith('sudo')) {
        seen.stdin.push(input);
        if (input.split('\n')[0] !== opt.sudoPw) { stream.stderr.write('sudo: 1 incorrect password attempt\n'); return 1; }
      }
      if (cmd.includes('--uninstall')) { stream.write('Agent removed\n'); return 0; }
      const envKey = [...seen.files.keys()].filter(k => k.endsWith('/deploy.env')).pop();
      const env = seen.files.get(envKey).toString();
      const token = /TOKEN='([^']+)'/.exec(env)[1];
      seen.tokens.push(token);
      if (opt.failInstall) { stream.write('Installing\n'); stream.stderr.write('ERROR: simulated failure in setup\n'); return 1; }
      stream.write('Installing the agent\n');
      if (!opt.noAgent) await agentUp(token);
      stream.write('Agent started\n');
      return 0;
    }
    if (cmd.startsWith('rm -rf')) { seen.removed.push(cmd); return 0; }
    return 127;
  }

  const server = new Server({ hostKeys: [hostKey] }, client => {
    client.on('authentication', c => (c.method === 'password' && c.username === 'tester' && c.password === opt.password ? c.accept() : c.reject(['password'])));
    client.on('error', () => {});
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec();
        seen.commands.push(info.command);
        let input = '';
        stream.on('data', d => { input += d; });
        stream.on('end', async () => { const code = await handle(info.command, input, stream); stream.exit(code); stream.end(); });
      });
      session.on('sftp', acceptSftp => {
        const sftp = acceptSftp();
        const handles = new Map();
        let n = 0;
        sftp.on('OPEN', (id, filename) => { const h = Buffer.alloc(4); h.writeUInt32BE(++n); handles.set(n, { filename, chunks: [] }); sftp.handle(id, h); });
        sftp.on('WRITE', (id, h, _off, data) => { handles.get(h.readUInt32BE()).chunks.push(Buffer.from(data)); sftp.status(id, OK); });
        sftp.on('CLOSE', (id, h) => { const f = handles.get(h.readUInt32BE()); seen.files.set(f.filename, Buffer.concat(f.chunks)); handles.delete(h.readUInt32BE()); sftp.status(id, OK); });
        sftp.on('MKDIR', id => sftp.status(id, OK));
        sftp.on('SETSTAT', id => sftp.status(id, OK));
        sftp.on('FSETSTAT', id => sftp.status(id, OK));
      });
    }));
  });
  const close = () => { seen.agents.forEach(w => w.terminate()); server.close(); };
  cleanup.push(close);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen, close })));
}

async function setup(t) {
  const s = await startApp();
  t.after(async () => { cleanup.splice(0).forEach(fn => fn()); await new Promise(r => setTimeout(r, 100)); await s.stop(); });
  s.ctx.deploy.config.waitMs = 3000;
  const admin = api(s.base, await login(s.base));
  await admin('POST', '/api/users', { username: 'op1', password: 'pw-op', role: 'operator' });
  const op = api(s.base, await login(s.base, 'op1', 'pw-op'));
  const tok = (await admin('POST', '/api/tokens', { label: 'deploy-test' })).data;
  return { s, admin, op, tok };
}
const body = (port, extra = {}) => ({ address: '127.0.0.1', port, os: 'linux', name: 'target-a', auth: { user: 'tester', password: PW, sudo_password: SUDO }, ...extra });
async function finished(call, id, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await call('GET', `/api/deploy/${id}`);
    if (r.data.state !== 'running') return r.data;
    await new Promise(r2 => setTimeout(r2, 50));
  }
  throw new Error('deploy did not finish');
}

test('pre-flight: every check passes against a healthy Linux target, and the response holds no secret', async (t) => {
  const { s, op } = await setup(t);
  const srv = await fakeLinux(s.port);
  const r = await op('POST', '/api/deploy/preflight', body(srv.port));
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.deepEqual(r.data.checks.map(c => c.name), ['Port reachability', 'SSH sign-in', 'Operating system', 'Administrator rights', 'Python 3', 'Disk space', 'Server reachable from the target']);
  assert.ok(r.data.checks.every(c => c.ok));
  assert.match(r.data.host_key, /^SHA256:/);
  const text = JSON.stringify(r.data);
  for (const secret of [PW, SUDO]) assert.ok(!text.includes(secret));
  assert.equal(s.ctx.tokens.list().filter(x => /^deploy /.test(x.label)).length, 0, 'pre-flight creates no token');
});

test('pre-flight: clear failures for a wrong password, a closed port, a wrong sudo password, low disk and a wrong OS', async (t) => {
  const { s, op } = await setup(t);
  const srv = await fakeLinux(s.port);
  let r = await op('POST', '/api/deploy/preflight', body(srv.port, { auth: { user: 'tester', password: 'nope' } }));
  assert.equal(r.data.ok, false);
  const login1 = r.data.checks.find(c => c.name === 'SSH sign-in');
  assert.equal(login1.ok, false);
  assert.match(login1.detail, /Authentication failed for tester/);
  assert.equal(r.data.checks.length, 2, 'stops after the failed sign-in');

  r = await op('POST', '/api/deploy/preflight', body(1));
  assert.equal(r.data.checks[0].ok, false);
  assert.match(r.data.checks[0].detail, /not reachable/);

  r = await op('POST', '/api/deploy/preflight', body(srv.port, { auth: { user: 'tester', password: PW, sudo_password: 'wrong' } }));
  assert.match(r.data.checks.find(c => c.name === 'Administrator rights').detail, /sudo rejected the password/);

  const low = await fakeLinux(s.port, { probe: { free_kb: '1000', kernel: 'Darwin' } });
  r = await op('POST', '/api/deploy/preflight', body(low.port));
  assert.equal(r.data.checks.find(c => c.name === 'Disk space').ok, false);
  assert.match(r.data.checks.find(c => c.name === 'Operating system').detail, /host reports Darwin/);
});

test('install: dedicated token, sudo password on stdin only, files removed, no secret in logs or audit, nothing saved', async (t) => {
  const { s, admin, op } = await setup(t);
  const srv = await fakeLinux(s.port);
  const start = await op('POST', '/api/deploy/start', body(srv.port));
  assert.equal(start.status, 202);
  const d = await finished(op, start.data.deploy_id);
  assert.equal(d.state, 'done', d.error);
  assert.equal(d.host_id, 'h-deploy-1');
  assert.deepEqual(d.checks.map(c => c.ok), d.checks.map(() => true));

  // dedicated token: label, used by the agent, one token only for this deploy
  const dedicated = s.ctx.tokens.get(d.token_id);
  assert.match(dedicated.label, /^deploy 127\.0\.0\.1 \d{4}-\d{2}-\d{2}$/);
  assert.equal(dedicated.revoked, false);
  assert.equal(s.ctx.db.prepare('SELECT token_id FROM hosts WHERE id = ?').get('h-deploy-1').token_id, d.token_id);
  assert.ok(s.ctx.tokens.verify(srv.seen.tokens[0]), 'the token the target received is valid');

  // sudo password: stdin only. Token and passwords: not in any command line.
  assert.ok(srv.seen.stdin.some(x => x === `${SUDO}\n`));
  for (const cmd of srv.seen.commands) for (const secret of [PW, SUDO, srv.seen.tokens[0]]) assert.ok(!cmd.includes(secret), `secret in command line: ${cmd}`);
  assert.ok(srv.seen.commands.some(c => /^sudo -S -p '' bash -c /.test(c)));
  assert.ok(srv.seen.removed.length === 1 && /labctl-deploy-/.test(srv.seen.removed[0]), 'temp folder removed');
  const names = [...srv.seen.files.keys()].map(k => path.basename(k)).sort();
  assert.deepEqual(names, ['deploy.env', 'labctl-agent.py', 'setup-linux.sh']);
  assert.equal(srv.seen.files.get([...srv.seen.files.keys()].find(k => k.endsWith('setup-linux.sh'))).toString(), fs.readFileSync(path.join(AGENT_DIR, 'setup-linux.sh'), 'utf8'));

  // logs, state and audit never hold a secret
  const everything = JSON.stringify(d) + JSON.stringify((await admin('GET', '/api/audit?limit=500')).data) + d.lines.join('\n');
  for (const secret of [PW, SUDO, srv.seen.tokens[0]]) assert.ok(!everything.includes(secret), 'secret leaked');
  assert.ok(d.lines.some(l => /Waiting up to/.test(l)));
  assert.ok((await admin('GET', '/api/audit?action=deploy.&limit=100')).data.rows.length >= 4);

  // not saved unless asked
  assert.equal(s.ctx.db.prepare('SELECT COUNT(*) AS n FROM credentials').get().n, 0);
  const data = JSON.parse(s.ctx.db.prepare('SELECT data FROM hosts WHERE id = ?').get('h-deploy-1').data);
  assert.equal(data.deploy.credential_id, undefined);
  assert.equal(data.deploy.address, '127.0.0.1');
  assert.match(data.deploy.host_key, /^SHA256:/);
});

test('install failure: exact failure line, token revoked, agent never registers', async (t) => {
  const { s, op } = await setup(t);
  const srv = await fakeLinux(s.port, { failInstall: true });
  const start = await op('POST', '/api/deploy/start', body(srv.port));
  const d = await finished(op, start.data.deploy_id);
  assert.equal(d.state, 'failed');
  assert.equal(d.error, 'ERROR: simulated failure in setup');
  assert.equal(s.ctx.tokens.get(d.token_id).revoked, true);
  assert.equal(s.ctx.tokens.verify(srv.seen.tokens[0]), null, 'the revoked token no longer works');
  assert.ok(d.lines.some(l => /token was revoked/.test(l)));
  assert.equal(s.ctx.db.prepare('SELECT COUNT(*) AS n FROM hosts').get().n, 0);
});

test('install: pre-flight failure stops before any token is made, wrong sudo password is reported', async (t) => {
  const { s, op } = await setup(t);
  const srv = await fakeLinux(s.port);
  const start = await op('POST', '/api/deploy/start', body(srv.port, { auth: { user: 'tester', password: PW, sudo_password: 'wrong' } }));
  const d = await finished(op, start.data.deploy_id);
  assert.equal(d.state, 'failed');
  assert.match(d.error, /Pre-flight failed\. Administrator rights: sudo rejected the password/);
  assert.equal(d.token_id, null);
  assert.equal(s.ctx.tokens.list().filter(x => /^deploy /.test(x.label)).length, 0);
});

test('install with no agent registering in time fails with a clear message and revokes the token', async (t) => {
  const { s, op } = await setup(t);
  s.ctx.deploy.config.waitMs = 300;
  const srv = await fakeLinux(s.port, { noAgent: true });
  const d = await finished(op, (await op('POST', '/api/deploy/start', body(srv.port))).data.deploy_id);
  assert.equal(d.state, 'failed');
  assert.match(d.error, /no agent registered within 0 s|no agent registered within d+ s/);
  assert.equal(s.ctx.tokens.get(d.token_id).revoked, true);
});

test('save_credential: operators are refused, admins get a sealed credential and redeploy keeps the host id', async (t) => {
  const { s, admin, op } = await setup(t);
  const srv = await fakeLinux(s.port);
  assert.equal((await op('POST', '/api/deploy/start', body(srv.port, { save_credential: true }))).status, 403);

  const start = await admin('POST', '/api/deploy/start', body(srv.port, { save_credential: true }));
  const d = await finished(admin, start.data.deploy_id);
  assert.equal(d.state, 'done', d.error);
  const cred = s.ctx.db.prepare('SELECT * FROM credentials WHERE host_id = ?').get('h-deploy-1');
  assert.equal(cred.purpose, 'deploy');
  assert.equal(cred.username, 'tester');
  assert.ok(!cred.sealed.includes(PW) && !Buffer.from(cred.sealed, 'base64').includes(PW));
  assert.deepEqual(s.ctx.crypto.openJson(cred.sealed), { password: PW, sudo_password: SUDO });
  assert.equal(JSON.parse(s.ctx.db.prepare('SELECT data FROM hosts WHERE id = ?').get('h-deploy-1').data).deploy.credential_id, cred.id);

  // redeploy with the saved credential only
  const first = d.token_id;
  srv.seen.agents.forEach(w => w.terminate());
  await waitFor(() => !s.ctx.agents.isOnline('h-deploy-1'));
  const re = await admin('POST', '/api/hosts/h-deploy-1/redeploy', {});
  assert.equal(re.status, 202);
  const d2 = await finished(admin, re.data.deploy_id);
  assert.equal(d2.state, 'done', d2.error);
  assert.equal(d2.host_id, 'h-deploy-1');
  assert.notEqual(d2.token_id, first);
  assert.equal(s.ctx.db.prepare('SELECT COUNT(*) AS n FROM hosts').get().n, 1);
  assert.equal(s.ctx.db.prepare('SELECT COUNT(*) AS n FROM credentials').get().n, 1);
});

test('remove agent: typed confirmation, online uninstall leaves the record, also_remove deletes it, offline uninstalls over ssh', async (t) => {
  const { s, admin, op } = await setup(t);
  const srv = await fakeLinux(s.port);
  const d = await finished(admin, (await admin('POST', '/api/deploy/start', body(srv.port, { save_credential: true }))).data.deploy_id);
  assert.equal(d.state, 'done', d.error);
  const name = s.ctx.db.prepare('SELECT hostname FROM hosts WHERE id = ?').get('h-deploy-1').hostname;

  assert.equal((await op('POST', '/api/hosts/h-deploy-1/remove-agent', { confirm: name })).status, 403, 'admin only');
  assert.equal((await admin('POST', '/api/hosts/h-deploy-1/remove-agent', { confirm: 'wrong' })).status, 400);
  const online = await admin('POST', '/api/hosts/h-deploy-1/remove-agent', { confirm: name });
  assert.equal(online.data.uninstall, 'confirmed');
  assert.equal(s.ctx.db.prepare('SELECT status FROM hosts WHERE id = ?').get('h-deploy-1').status, 'gone');
  srv.seen.agents.forEach(w => w.terminate()); // a real agent exits after its uninstall
  await waitFor(() => !s.ctx.agents.isOnline('h-deploy-1'));

  // offline: uses the saved credential and runs the uninstall over ssh
  const off = await admin('POST', '/api/hosts/h-deploy-1/remove-agent', { confirm: name });
  assert.equal(off.status, 202);
  const du = await finished(admin, off.data.deploy_id);
  assert.equal(du.state, 'done', du.error);
  assert.ok(srv.seen.commands.some(c => /setup-linux\.sh --uninstall/.test(c)));
  assert.ok(s.ctx.db.prepare('SELECT 1 FROM hosts WHERE id = ?').get('h-deploy-1'), 'record stays');

  // no credential and offline: clear 409
  s.ctx.db.prepare("DELETE FROM credentials WHERE host_id = 'h-deploy-1'").run();
  const data = JSON.parse(s.ctx.db.prepare('SELECT data FROM hosts WHERE id = ?').get('h-deploy-1').data);
  delete data.deploy.credential_id;
  s.ctx.db.prepare('UPDATE hosts SET data = ? WHERE id = ?').run(JSON.stringify(data), 'h-deploy-1');
  assert.equal((await admin('POST', '/api/hosts/h-deploy-1/remove-agent', { confirm: name })).status, 409);

  const also = await admin('POST', '/api/hosts/h-deploy-1/remove-agent', { confirm: name, also_remove: true });
  assert.equal(also.data.removed, true);
  assert.equal(s.ctx.db.prepare('SELECT 1 FROM hosts WHERE id = ?').get('h-deploy-1'), undefined);
});

test('relay: the install runs as jobs on an online agent, secrets travel in the run_job env only', async (t) => {
  const { s, op, tok } = await setup(t);
  const relayWs = await wsOpen(s.port, tok.value);
  register(relayWs, 'h-relay', 'relay.example.test');
  await waitFor(() => s.ctx.agents.isOnline('h-relay'));
  const frames = [];
  const targets = [];
  let relayProbe = { ...PROBE, uid: '0', sudo: 'root' };
  let relayFails = '';
  relayWs.on('message', async raw => {
    const m = JSON.parse(raw);
    if (m.type !== 'run_job') return;
    frames.push(m);
    const out = chunk => frame(relayWs, { type: 'job_output', job_id: m.job_id, seq: 1, stream: 'stdout', chunk });
    if (m.env.T_MODE === 'probe') out(relayFails || kvText(relayProbe));
    else {
      out('Uploading the setup files to /tmp/x on 192.0.2.50 through the relay\nInstalling the agent\n');
      const ws = await wsOpen(s.port, m.env.LABCTL_SECRET_TOKEN);
      register(ws, 'h-behind', 'behind.example.test');
      targets.push(ws);
    }
    frame(relayWs, { type: 'job_complete', job_id: m.job_id, status: 'success', exit_code: 0, duration_ms: 5 });
  });
  cleanup.push(() => { relayWs.terminate(); targets.forEach(w => w.terminate()); });

  const rel = await op('GET', '/api/deploy/relays');
  assert.deepEqual(rel.data.map(x => x.id), ['h-relay']);
  assert.equal((await op('POST', '/api/deploy/start', { ...body(22), os: 'windows', relay_host_id: 'h-relay', address: '192.0.2.50' })).status, 400);

  const b = body(22, { address: '192.0.2.50', relay_host_id: 'h-relay' });
  const pre = await op('POST', '/api/deploy/preflight', b);
  assert.equal(pre.data.ok, true, JSON.stringify(pre.data));
  assert.equal(pre.data.transport, 'relay');

  const start = await op('POST', '/api/deploy/start', b);
  const d = await finished(op, start.data.deploy_id);
  assert.equal(d.state, 'done', d.error);
  assert.equal(d.host_id, 'h-behind');
  const run = frames.find(f => f.env.T_MODE === 'install');
  assert.equal(run.env.LABCTL_SECRET_PASSWORD, PW);
  assert.equal(run.env.LABCTL_SECRET_TOKEN.length > 20, true);
  assert.match(run.env.T_CMD, /^bash -c /, 'root needs no sudo');
  assert.equal(run.env.T_SUDO, '0');
  assert.ok(!run.script.includes(PW) && !run.script.includes(run.env.LABCTL_SECRET_TOKEN));
  const jobs = s.ctx.db.prepare("SELECT * FROM jobs WHERE type = 'deploy-relay'").all();
  assert.equal(jobs.length, 3);
  for (const j of jobs) {
    const row = JSON.stringify(j);
    for (const secret of [PW, SUDO, run.env.LABCTL_SECRET_TOKEN]) assert.ok(!row.includes(secret), 'secret stored in jobs');
    assert.equal(j.status, 'completed');
  }
  assert.ok(!JSON.stringify(d).includes(run.env.LABCTL_SECRET_TOKEN));

  // the relay cannot reach the target: reported as a port failure, no token made
  relayFails = 'ssh_error=ssh: connect to host 192.0.2.50 port 22: Connection refused\n';
  const before = s.ctx.tokens.list().length;
  const bad = await finished(op, (await op('POST', '/api/deploy/start', b)).data.deploy_id);
  assert.equal(bad.state, 'failed');
  assert.match(bad.error, /Port reachability: From the relay: ssh: connect to host/);
  assert.equal(s.ctx.tokens.list().length, before);
});

test('relay: offline or non-agent relay is refused', async (t) => {
  const { s, op } = await setup(t);
  s.ctx.db.prepare("INSERT INTO hosts (id, hostname, os, kind, status) VALUES ('h-off', 'off.example.test', 'linux', 'agent', 'offline')").run();
  const r = await op('POST', '/api/deploy/preflight', body(22, { address: '192.0.2.50', relay_host_id: 'h-off' }));
  assert.equal(r.data.ok, false);
  assert.match(r.data.checks[0].detail, /relay host is not online/);
});

test('manual commands: a fresh token inside each one-liner and the public URL', async (t) => {
  const { s, admin, op } = await setup(t);
  const r = await op('POST', '/api/deploy/manual-commands', {});
  assert.equal(r.status, 200);
  const { commands, token_id, server } = r.data;
  assert.equal(server, s.base);
  const value = /token=([A-Za-z0-9_-]+)/.exec(commands.linux)[1];
  assert.equal(s.ctx.tokens.verify(value), token_id);
  assert.equal(commands.linux, `curl -fsSL "${s.base}/install/linux.sh?token=${value}" | sudo bash`);
  assert.equal(commands.mac, `curl -fsSL "${s.base}/install/mac.sh?token=${value}" | sudo bash`);
  assert.equal(commands.windows, `irm "${s.base}/install/windows.ps1?token=${value}" | iex`);
  assert.equal(s.ctx.tokens.get(token_id).label.startsWith('manual install'), true);
  assert.ok(!JSON.stringify((await admin('GET', '/api/audit?action=deploy.manual')).data).includes(value));

  s.ctx.settings.set('public_url', 'https://labctl.example.test');
  const again = await op('POST', '/api/deploy/manual-commands', {});
  assert.match(again.data.commands.windows, /^irm "https:\/\/labctl\.example\.test\/install\/windows\.ps1\?token=/);
  s.ctx.settings.set('public_url', null);
  const gate = await fetch(`${s.base}/install/linux.sh?token=${value}`);
  assert.equal(gate.status, 200, 'the one-liner URL works');
});

test('input validation: os, address, user, credential, viewers cannot deploy, stream replays the log', async (t) => {
  const { s, admin, op } = await setup(t);
  assert.equal((await op('POST', '/api/deploy/preflight', body(22, { os: 'plan9' }))).status, 400);
  assert.equal((await op('POST', '/api/deploy/preflight', body(22, { address: '-oProxyCommand=x' }))).status, 400);
  assert.equal((await op('POST', '/api/deploy/preflight', body(22, { auth: { user: 'tester' } }))).status, 400);
  assert.equal((await op('POST', '/api/deploy/preflight', body(22, { auth: { user: '', password: 'x' } }))).status, 400);
  assert.equal((await op('POST', '/api/deploy/preflight', body(22, { auth: { credential_id: 'missing' } }))).status, 400);
  await admin('POST', '/api/users', { username: 'view1', password: 'pw-v', role: 'viewer' });
  const viewer = api(s.base, await login(s.base, 'view1', 'pw-v'));
  assert.equal((await viewer('POST', '/api/deploy/start', body(22))).status, 403);
  assert.equal((await op('GET', '/api/deploy/nope')).status, 404);

  const srv = await fakeLinux(s.port);
  const d = await finished(op, (await op('POST', '/api/deploy/start', body(srv.port))).data.deploy_id);
  const res = await fetch(`${s.base}/api/deploy/${d.id}/stream`, { headers: { authorization: `Bearer ${await login(s.base)}` } });
  const text = await res.text();
  assert.match(text, /event: log/);
  assert.match(text, /event: done\ndata: \{"state":"done"/);
  assert.ok(!text.includes(PW) && !text.includes(SUDO));
});

// ── unit tests: probe, checks, Windows and WinRM layers ───────────────────────

test('unix probe script runs on a real sh and the checks read it', { skip: process.platform === 'win32' ? 'needs a POSIX sh' : false }, () => {
  const r = spawnSync('sh', ['-s'], { input: unix.probeScript('http://127.0.0.1:9'), encoding: 'utf8' });
  const kv = unix.parseKv(r.stdout);
  assert.equal(kv.kernel, process.platform === 'darwin' ? 'Darwin' : 'Linux');
  assert.ok(Number(kv.free_kb) > 0);
  assert.equal(kv.outbound, 'fail', 'nothing listens on port 9');
  assert.ok(['root', 'nopasswd', 'password', 'none'].includes(kv.sudo));
});

test('unix checks: pass, warn and fail rows', () => {
  const t = { os: 'linux', user: 'u', password: 'p' };
  const ok = unix.unixChecks({ ...PROBE, sudo: 'nopasswd' }, t);
  assert.ok(ok.every(c => c.ok));
  const rows = unix.unixChecks({ ...PROBE, sudo: 'none', python: '', free_kb: '10', outbound: 'fail', kernel: 'Darwin' }, t);
  assert.deepEqual(rows.map(c => c.ok), [false, false, true, false, false]);
  assert.equal(rows[2].warn, true);
  assert.match(unix.unixChecks({ ...PROBE, sudo: 'password' }, { os: 'linux', user: 'u', private_key: 'k' })[1].detail, /needs a password/);
});

test('winrm adapter: NTLM user, shell reuse, encoded commands, error text', async () => {
  const calls = { cmds: [], deleted: 0 };
  const lib = {
    Shell: { doCreateShell: async p => { calls.params = p; return 'SHELL-1'; }, doDeleteShell: async () => { calls.deleted++; } },
    Command: { doExecuteCommand: async p => { calls.cmds.push(p.command); assert.equal(p.shellId, 'SHELL-1'); return 'CMD-1'; }, doReceiveOutput: async p => `out:${p.commandId}` }
  };
  const w = await winrm.open({ address: '192.0.2.60', port: 5986, user: 'Administrator', password: 'pw' }, lib);
  assert.equal(calls.params.username, '.\\Administrator');
  assert.equal(calls.params.authMethod, 'ntlm');
  assert.equal(calls.params.useHttps, true);
  assert.equal(await w.run("'hello'"), 'out:CMD-1');
  const m = /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand (\S+)$/.exec(calls.cmds[0]);
  assert.equal(Buffer.from(m[1], 'base64').toString('utf16le'), "'hello'");
  await w.close();
  assert.equal(calls.deleted, 1);
  assert.equal((await winrm.open({ address: 'a', port: 5985, user: 'D\\u', password: 'p' }, { ...lib, Shell: { doCreateShell: async p => { assert.equal(p.username, 'D\\u'); return 'S'; } } })).run instanceof Function, true);
  const failing = { Shell: { doCreateShell: async () => { throw new Error('HTTP 401 Unauthorized'); } } };
  await assert.rejects(winrm.open({ address: 'a', port: 5985, user: 'u', password: 'p' }, failing), /WinRM rejected the sign-in for u/);
  assert.match(winrm.cleanErr('#< CLIXML\n<Objs><S S="Error">Boom_x000D__x000A_</S></Objs>'), /^Boom/);
});

// A fake Windows session: records pushed files and answers the poll commands.
function fakeWindows(polls) {
  const files = new Map();
  const scripts = [];
  let n = 0;
  return { files, scripts, chunk: 1800, transport: 'ssh', hostKey: 'SHA256:test', close: async () => {}, async run(script) {
    scripts.push(script);
    assert.ok(!script.includes(String.fromCharCode(10)), 'PowerShell on stdin drops multi-line blocks: scripts must be one line');
    const push = /Join-Path \$d '([^']+)'\),'(Create|Append)'\);\$b=\[Convert\]::FromBase64String\('([^']*)'\)/.exec(script);
    if (push) { files.set(push[1], Buffer.concat([push[2] === 'Create' ? Buffer.alloc(0) : files.get(push[1]), Buffer.from(push[3], 'base64')])); return ''; }
    if (script.includes("'LINES='")) return polls[Math.min(n++, polls.length - 1)];
    return '';
  } };
}

test('windows install: pushes the files in chunks, starts the setup, streams the log lines, stops on the exit code', async () => {
  const session = fakeWindows(['LINES=0', 'LINES=2\nStep one\nStep two', 'LINES=3\nAgent installed\nEXITCODE=0']);
  const logs = [];
  let last = '';
  const h = { id: 'abc123', mode: 'install', server: 'https://labctl.example.test', token: 'TOKEN-VALUE-0123456789', phase: () => {}, log: l => logs.push(l),
    out: c => { for (const l of c.split('\n').filter(Boolean)) { logs.push(l); last = l; } }, lastLine: () => last,
    file: name => fs.readFileSync(path.join(AGENT_DIR, name)) };
  session.chunk = 1800;
  const res = await windows.install({ os: 'windows', address: '192.0.2.70', port: 22, user: 'Administrator' }, h, { pollMs: 1, open: async () => session });
  assert.equal(res.transport, 'ssh');
  assert.deepEqual([...session.files.keys()].sort(), ['labctl-agent.py', 'run.ps1', 'setup-windows.ps1', 'wrap.ps1']);
  assert.equal(session.files.get('labctl-agent.py').toString(), fs.readFileSync(path.join(AGENT_DIR, 'labctl-agent.py'), 'utf8'));
  assert.match(session.files.get('run.ps1').toString(), /-ServerUrl 'https:\/\/labctl\.example\.test' -Token 'TOKEN-VALUE-0123456789'/);
  assert.ok(session.scripts.some(s => s.includes('Start-Process')));
  assert.ok(session.scripts.at(-1).includes('Remove-Item'), 'temp folder removed');
  assert.deepEqual(logs.filter(l => /Step|Agent installed/.test(l)), ['Step one', 'Step two', 'Agent installed']);
  const encoded = session.scripts.filter(s => s.includes('FromBase64String'));
  assert.ok(encoded.every(s => s.length < 4000) || encoded.length > 40, 'WinRM-sized chunks');

  const failing = fakeWindows(['LINES=1\nERROR: Python install failed\nEXITCODE=3']);
  let lastFail = '';
  const h2 = { ...h, out: c => { lastFail = c.trim().split('\n').pop(); }, lastLine: () => lastFail };
  await assert.rejects(windows.install({ os: 'windows', address: '192.0.2.70', port: 5986, user: 'Administrator' }, h2, { pollMs: 1, open: async () => failing }), /ERROR: Python install failed/);
});

test('windows pre-flight: port rows, admin and python checks', async () => {
  const net = require('net');
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  try {
    const port = srv.address().port;
    const kv = { os_name: 'Microsoft Windows Server 2022 Standard 10.0.20348', arch: 'AMD64', admin: 'True', python: '', free_kb: '9000000', outbound: 'ok' };
    const session = { run: async () => kvText(kv), close: async () => {}, hostKey: null };
    const r = await windows.inspect({ os: 'windows', address: '127.0.0.1', port, user: 'Administrator', password: 'p' }, { server: 'https://labctl.example.test' }, async () => session);
    assert.ok(r.checks.every(c => c.ok), JSON.stringify(r.checks));
    assert.equal(r.checks.find(c => c.name === 'Python 3').warn, true);
    assert.match(r.checks[0].detail, /open \(OpenSSH\)/);
    kv.admin = 'False';
    const r2 = await windows.inspect({ os: 'windows', address: '127.0.0.1', port, user: 'Administrator', password: 'p' }, { server: 'https://labctl.example.test' }, async () => session);
    assert.equal(r2.checks.find(c => c.name === 'Administrator rights').ok, false);
  } finally { srv.close(); }
  const closed = await windows.inspect({ os: 'windows', address: '127.0.0.1', port: 1, user: 'a', password: 'p' }, { server: 'x' });
  assert.equal(closed.checks[0].ok, false);
});
