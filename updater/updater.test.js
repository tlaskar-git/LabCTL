const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createUpdater, createServer, createBody, copyDbFiles, secretOk } = require('./updater');

const INSPECT = { Id: 'abc123def456', Image: 'sha256:old', Config: { Image: 'ghcr.io/tlaskar-git/labctl:v1.0.0', Env: ['A=1'] },
  HostConfig: { Binds: ['/srv/data:/app/data'] }, NetworkSettings: { Networks: { default: { Aliases: ['labctl', 'abc123def456'] } } } };

function fakeDocker() {
  const calls = [];
  return { calls,
    inspect: async () => { calls.push('inspect'); return INSPECT; },
    pull: async (img, tag) => { calls.push(`pull ${img}:${tag}`); },
    stop: async () => { calls.push('stop'); },
    remove: async () => { calls.push('remove'); },
    create: async (n, body) => { calls.push(`create ${body.Image}`); },
    start: async () => { calls.push('start'); } };
}
const opts = { pollMs: 1, healthTimeoutMs: 40 };

test('success: pull, backup, recreate, health reports the new version', async () => {
  const docker = fakeDocker();
  let recreated = false;
  const origCreate = docker.create;
  docker.create = async (...a) => { recreated = true; return origCreate(...a); };
  const u = createUpdater({ docker, backup: async () => { docker.calls.push('backup'); }, env: opts, sleep: async () => {},
    health: async () => (recreated ? '1.1.0' : '1.0.0'), run: null });
  const s = await u.update('v1.1.0');
  assert.equal(s.state, 'succeeded');
  assert.deepEqual(s.steps.map(x => x.name), ['inspect', 'pull', 'backup', 'recreate', 'health']);
  assert.ok(s.steps.every(x => x.status === 'ok' && x.at));
  assert.deepEqual(docker.calls, ['inspect', 'pull ghcr.io/tlaskar-git/labctl:v1.1.0', 'backup', 'stop', 'remove', 'create ghcr.io/tlaskar-git/labctl:v1.1.0', 'start']);
});

test('rollback: health never reports the new version, so the previous image id is recreated', async () => {
  const docker = fakeDocker();
  const u = createUpdater({ docker, backup: async () => {}, env: opts, sleep: async () => { await new Promise(r => setTimeout(r, 2)); },
    health: async () => '1.0.0', run: null });
  const s = await u.update('v1.1.0');
  assert.equal(s.state, 'rolled_back');
  assert.equal(s.steps.find(x => x.name === 'health').status, 'failed');
  assert.equal(s.steps.find(x => x.name === 'rollback').status, 'ok');
  assert.equal(s.steps.find(x => x.name === 'rollback_health').status, 'ok');
  assert.ok(docker.calls.includes('create sha256:old'));
});

test('rollback also runs when the new container fails to start', async () => {
  const docker = fakeDocker();
  let n = 0;
  docker.start = async () => { n++; if (n === 1) throw new Error('boom'); };
  const u = createUpdater({ docker, backup: async () => {}, env: opts, sleep: async () => {}, health: async () => '1.0.0', run: null });
  const s = await u.update('v1.1.0');
  assert.equal(s.state, 'rolled_back');
  assert.equal(s.steps.find(x => x.name === 'recreate').status, 'failed');
});

test('pull failure stops before the container is touched and does not roll back', async () => {
  const docker = fakeDocker();
  docker.pull = async () => { throw new Error('pull failed: denied'); };
  const u = createUpdater({ docker, backup: async () => {}, env: opts, health: async () => '1.0.0', run: null });
  const s = await u.update('v1.1.0');
  assert.equal(s.state, 'failed');
  assert.ok(!docker.calls.includes('stop'));
});

test('bad tag is refused and a second run is refused while one is running', async () => {
  const docker = fakeDocker();
  let release;
  docker.pull = () => new Promise(r => { release = r; });
  const u = createUpdater({ docker, backup: async () => {}, env: opts, sleep: async () => {}, health: async () => '1.1.0', run: null });
  await assert.rejects(u.update('latest; echo x'), { code: 400 });
  const first = u.update('v1.1.0');
  await new Promise(r => setTimeout(r, 5));
  await assert.rejects(u.update('v1.2.0'), { code: 409 });
  release();
  assert.equal((await first).state, 'succeeded');
});

test('manual rollback needs a recorded previous image', async () => {
  const u = createUpdater({ docker: fakeDocker(), backup: async () => {}, env: opts, health: async () => '1.0.0', run: null });
  await assert.rejects(u.rollback(), { code: 409 });
});

test('git mode: pull, build, up, and reset on health failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labctl-test-git-'));
  fs.writeFileSync(path.join(dir, 'VERSION'), '1.1.0\n');
  const cmds = [];
  const run = async (cmd, args) => { cmds.push(`${cmd} ${args.join(' ')}`); return args.includes('rev-parse') ? 'sha-old\n' : ''; };
  const u = createUpdater({ docker: fakeDocker(), backup: async () => {}, env: { ...opts, repoDir: dir }, sleep: async () => {}, health: async () => '1.0.0', run });
  const s = await u.updateGit();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(s.state, 'rolled_back');
  assert.ok(cmds.some(c => c.endsWith('reset --hard sha-old')));
  assert.ok(cmds.some(c => c.includes('build labctl')));
});

test('http: secret is required and compared in constant time', async (t) => {
  assert.equal(secretOk('s3cret', 's3cret'), true);
  assert.equal(secretOk('s3cret!', 's3cret'), false);
  assert.equal(secretOk(undefined, 's3cret'), false);
  assert.equal(secretOk('x', ''), false);
  const u = createUpdater({ docker: fakeDocker(), backup: async () => {}, env: opts, sleep: async () => {}, health: async () => '1.1.0', run: null });
  const srv = createServer(u, 's3cret');
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const call = (method, p, headers = {}, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, method, path: p, headers }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
    });
    req.on('error', reject); req.end(body);
  });
  assert.equal((await call('GET', '/status')).status, 401);
  assert.equal((await call('GET', '/status', { 'x-updater-secret': 'wrong' })).status, 401);
  assert.equal((await call('POST', '/update', {}, '{"image_tag":"v1.1.0"}')).status, 401);
  assert.equal((await call('GET', '/healthz')).status, 200);
  const ok = { 'x-updater-secret': 's3cret' };
  assert.equal((await call('GET', '/status', ok)).body.state, 'idle');
  assert.equal((await call('POST', '/update', ok, '{"image_tag":"bad"}')).status, 400);
  assert.equal((await call('POST', '/update', ok, '{"image_tag":"v1.1.0"}')).status, 202);
});

test('createBody keeps config, swaps image and drops the old container id alias', () => {
  const b = createBody(INSPECT, 'x:y');
  assert.equal(b.Image, 'x:y');
  assert.deepEqual(b.HostConfig, INSPECT.HostConfig);
  assert.deepEqual(b.NetworkingConfig.EndpointsConfig.default.Aliases, ['labctl']);
});

test('file-copy backup copies the db with its -wal and -shm files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labctl-test-bk-'));
  for (const f of ['labctl.db', 'labctl.db-wal', 'labctl.db-shm']) fs.writeFileSync(path.join(dir, f), f);
  const dest = copyDbFiles(dir);
  assert.deepEqual(fs.readdirSync(dest).sort(), ['labctl.db', 'labctl.db-shm', 'labctl.db-wal']);
  fs.rmSync(dir, { recursive: true, force: true });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'labctl-test-bk-'));
  assert.throws(() => copyDbFiles(empty), /no database file/);
  fs.rmSync(empty, { recursive: true, force: true });
});
