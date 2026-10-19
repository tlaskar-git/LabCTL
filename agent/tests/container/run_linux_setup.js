#!/usr/bin/env node
// Container test for setup-linux.sh. For each image (default debian:12 and ubuntu:24.04):
//   1. start a throwaway LabCTL server (this repo) in a node container on a private docker network,
//   2. start a throwaway distro container, run `curl .../install/linux.sh?token=... | bash -s -- --no-service`,
//   3. assert the agent registers (GET /api/hosts shows the host with this agent's version and os linux),
//      websocket-client is not installed system wide, a re-run upgrades in place and --uninstall removes it.
// Uses local docker when present, else the docker host named in LABCTL_TEST_SSH_HOST (ssh BatchMode, key login).
// Skips with a message when neither works.
// Every container, the network and the temp folder are named labctl-test-<random> and removed at the end.
// Run: node agent/tests/container/run_linux_setup.js
// Env: LABCTL_TEST_SSH_HOST=<ssh host alias with docker>, LABCTL_TEST_IMAGES=debian:12,ubuntu:24.04
'use strict';
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const IMAGES = (process.env.LABCTL_TEST_IMAGES || 'debian:12,ubuntu:24.04').split(',').map(s => s.trim()).filter(Boolean);
const SSH_HOST = process.env.LABCTL_TEST_SSH_HOST;
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
const P = `labctl-test-${crypto.randomBytes(4).toString('hex')}`;
const NET = `${P}-net`;
const SRV = `${P}-srv`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shq = s => `'${String(s).replace(/'/g, "'\\''")}'`;
const log = (...a) => console.log('[container-test]', ...a);

let mode = null;
let tmpDir = null;
let forward = null;
const containers = [];

function docker(args, opts = {}) {
  const r = mode === 'local'
    ? spawnSync('docker', args, { encoding: 'utf8', timeout: opts.timeout || 120000 })
    : spawnSync('ssh', [...SSH, SSH_HOST, ['docker', ...args].map(shq).join(' ')], { encoding: 'utf8', timeout: opts.timeout || 120000 });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function detect() {
  const fmt = '{{.Server.Version}}';
  if (spawnSync('docker', ['version', '--format', fmt], { encoding: 'utf8' }).status === 0) return 'local';
  if (SSH_HOST && spawnSync('ssh', [...SSH, SSH_HOST, `docker version --format '${fmt}'`], { encoding: 'utf8' }).status === 0) return 'ssh';
  return null;
}

// Copies the server, agent and VERSION (no node_modules, no data) to a temp folder on the docker host.
function copyRepo() {
  const tarArgs = ['-C', REPO, '--exclude=node_modules', '--exclude=__pycache__', '--exclude=data', '-cf', '-', 'server', 'agent', 'VERSION'];
  if (mode === 'local') {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), P + '-'));
    return new Promise((resolve, reject) => {
      const c = spawn('tar', tarArgs);
      const x = spawn('tar', ['-xf', '-', '-C', tmpDir]);
      c.stdout.pipe(x.stdin);
      x.on('close', code => (code === 0 ? resolve() : reject(new Error('tar extract failed'))));
    });
  }
  tmpDir = `/tmp/${P}`;
  return new Promise((resolve, reject) => {
    const c = spawn('tar', tarArgs);
    const x = spawn('ssh', [...SSH, SSH_HOST, `mkdir -p ${shq(tmpDir)} && tar -xf - -C ${shq(tmpDir)}`]);
    c.stdout.pipe(x.stdin);
    x.on('close', code => (code === 0 ? resolve() : reject(new Error('copy to the docker host failed'))));
  });
}

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function cleanup() {
  if (forward) forward.kill();
  for (const c of [...containers].reverse()) docker(['rm', '-f', c]);
  docker(['network', 'rm', NET]);
  if (tmpDir) {
    if (mode === 'local') fs.rmSync(tmpDir, { recursive: true, force: true });
    else spawnSync('ssh', [...SSH, SSH_HOST, `rm -rf ${shq(tmpDir)}`]);
  }
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function startServer() {
  log('starting the test server (npm ci inside a node container, this takes a minute)');
  docker(['network', 'create', NET]);
  const script = 'cp -r /src /work && cd /work/server && { npm ci --omit=dev --no-audit --no-fund >/tmp/npm.log 2>&1 || { tail -n 10 /tmp/npm.log; exit 1; }; } && PORT=7700 exec node /work/agent/tests/container/test-server.js';
  const r = docker(['run', '-d', '--name', SRV, '--network', NET, '-p', '127.0.0.1::7700', '-v', `${tmpDir}:/src:ro`, 'node:22-bookworm', 'sh', '-c', script], { timeout: 600000 });
  if (r.code !== 0) throw new Error(`could not start the server container: ${r.err}`);
  containers.push(SRV);
  const ready = await waitFor(() => {
    const out = docker(['logs', SRV]);
    const m = /READY (\{.*\})/.exec(out.out + '\n' + out.err);
    if (m) return JSON.parse(m[1]);
    if (docker(['inspect', '-f', '{{.State.Running}}', SRV]).out === 'false') throw new Error(`server container stopped:\n${out.out}\n${out.err}`);
    return null;
  }, 600000, 'the test server');
  const hostPort = docker(['port', SRV, '7700']).out.split('\n')[0].split(':').pop();
  let api = `http://127.0.0.1:${hostPort}`;
  if (mode === 'ssh') {
    const lp = await freePort();
    forward = spawn('ssh', [...SSH, '-o', 'ExitOnForwardFailure=yes', '-N', '-L', `${lp}:127.0.0.1:${hostPort}`, SSH_HOST], { stdio: 'ignore' });
    api = `http://127.0.0.1:${lp}`;
  }
  await waitFor(async () => (await fetch(`${api}/api/health`)).ok, 60000, 'the server health check');
  const login = await fetch(`${api}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'LabCTLAdmin', password: 'LabCTL' }) });
  return { api, session: (await login.json()).token, enrol: ready.token };
}

const exec = (c, cmd) => docker(['exec', c, 'bash', '-c', cmd], { timeout: 300000 });

async function testImage(image, srv) {
  const name = `${P}-${image.replace(/[^a-z0-9]/gi, '')}`;
  const expected = /^VERSION = "([^"]+)"/m.exec(fs.readFileSync(path.join(REPO, 'agent', 'labctl-agent.py'), 'utf8'))[1];
  const run = 'set -o pipefail; curl -fsSL "$LABCTL_URL/install/linux.sh?token=$LABCTL_TOKEN" | bash -s -- --no-service';
  const boot = `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq curl ca-certificates procps >/dev/null && { ${run}; echo SETUP_EXIT=$?; }; sleep 900`;
  log(`${image}: starting ${name}`);
  const r = docker(['run', '-d', '--name', name, '--hostname', name, '--network', NET, '-e', `LABCTL_URL=http://${SRV}:7700`, '-e', `LABCTL_TOKEN=${srv.enrol}`, image, 'bash', '-c', boot]);
  if (r.code !== 0) throw new Error(`could not start ${image}: ${r.err}`);
  containers.push(name);
  await waitFor(() => /SETUP_EXIT=\d+/.test(docker(['logs', name]).out), 420000, `${image} setup to finish`);
  const logs = docker(['logs', name]);
  if (!/SETUP_EXIT=0/.test(logs.out)) throw new Error(`setup failed on ${image}:\n${(logs.out + '\n' + logs.err).split('\n').slice(-10).join('\n')}`);

  const host = await waitFor(async () => {
    const hosts = await (await fetch(`${srv.api}/api/hosts`, { headers: { authorization: `Bearer ${srv.session}` } })).json();
    return hosts.find(h => h.hostname === name);
  }, 120000, `${image} agent to register`);
  const problems = [];
  if (host.agent_version !== expected) problems.push(`agent_version ${host.agent_version}, expected ${expected}`);
  if (host.os !== 'linux') problems.push(`os ${host.os}`);
  if (exec(name, 'python3 -c "import websocket"').code === 0) problems.push('websocket-client is installed system wide');
  if (exec(name, 'test -x /opt/labctl/agent/venv/bin/python && /opt/labctl/agent/venv/bin/python -c "import websocket"').code !== 0) problems.push('websocket-client is missing from the venv');
  if (exec(name, 'test "$(stat -c %a /opt/labctl/agent/agent.json)" = 600').code !== 0) problems.push('agent.json is not mode 600');

  // Re-run upgrades in place: the agent connects again and the log shows two connections.
  const again = exec(name, run);
  if (again.code !== 0) problems.push(`re-run failed: ${again.err.split('\n').slice(-3).join(' ')}`);
  await waitFor(() => exec(name, '[ "$(grep -c "\\[ws\\] connected" /opt/labctl/agent/agent.log)" -ge 2 ]').code === 0, 90000, `${image} agent to reconnect after the re-run`)
    .catch(e => problems.push(e.message));

  if (exec(name, "pgrep -f '[l]abctl-agent.py'").code !== 0) problems.push('no agent process is running');
  const un = exec(name, 'curl -fsSL "$LABCTL_URL/install/linux.sh?token=$LABCTL_TOKEN" | bash -s -- --uninstall && test ! -e /opt/labctl/agent && ! pgrep -f "[l]abctl-agent.py"');
  if (un.code !== 0) problems.push('--uninstall did not remove the agent');
  if (problems.length) throw new Error(`${image}: ${problems.join('; ')}`);
  return `${image}: agent registered (agent_version ${host.agent_version}, os ${host.os}), venv only, re-run ok, uninstall ok`;
}

async function main() {
  mode = detect();
  if (!mode) { log('SKIPPED: neither local docker nor the ssh docker host (LABCTL_TEST_SSH_HOST) is reachable.'); return 0; }
  log(`docker via ${mode === 'local' ? 'the local docker CLI' : `ssh ${SSH_HOST}`}, run id ${P}`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => cleanup().finally(() => process.exit(130)));
  const results = [];
  let failed = false;
  try {
    await copyRepo();
    const srv = await startServer();
    for (const image of IMAGES) {
      try { results.push('PASS ' + await testImage(image, srv)); } catch (e) { failed = true; results.push('FAIL ' + e.message); }
    }
  } catch (e) {
    failed = true;
    results.push('FAIL ' + e.message);
  } finally {
    await cleanup();
  }
  results.forEach(r => log(r));
  return failed ? 1 : 0;
}

main().then(code => process.exit(code));
