// Shared credential library: create without a host, validation, secrets never leave, update, delete, migration, use().
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { startApp, login, api } = require('./helpers');
const { migrate } = require('../src/credentials');

const PW = 'Pw-Secret-9f3a1c-for-tests';
const SUDO = 'Sudo-Secret-77be20-for-tests';
const PEM = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;

async function setup(t) {
  const s = await startApp();
  t.after(() => s.stop());
  const admin = api(s.base, await login(s.base));
  await admin('POST', '/api/users', { username: 'op1', password: 'pw-op', role: 'operator' });
  await admin('POST', '/api/users', { username: 'viewer1', password: 'pw-viewer', role: 'viewer' });
  const op = api(s.base, await login(s.base, 'op1', 'pw-op'));
  const viewer = api(s.base, await login(s.base, 'viewer1', 'pw-viewer'));
  return { s, admin, op, viewer };
}

test('create without a host, list shows no secret, duplicate name is refused', async t => {
  const { s, admin } = await setup(t);
  const r = await admin('POST', '/api/credentials', { name: 'root', username: 'root', password: PW, sudo_password: SUDO, note: 'lab root' });
  assert.equal(r.status, 200);
  const k = await admin('POST', '/api/credentials', { name: 'domain admin', username: 'administrator', domain: 'corp.example.test', private_key: PEM, passphrase: 'pp-secret-1' });
  assert.equal(k.status, 200);

  const list = await admin('GET', '/api/credentials');
  const root = list.data.find(c => c.id === r.data.id);
  assert.deepEqual([root.name, root.username, root.kind, root.scope, root.host_id], ['root', 'root', 'password', 'shared', null]);
  assert.equal(list.data.find(c => c.id === k.data.id).kind, 'ssh_key');
  assert.equal(list.data.find(c => c.id === k.data.id).domain, 'corp.example.test');
  for (const secret of [PW, SUDO, 'pp-secret-1', 'BEGIN PRIVATE KEY']) assert.ok(!JSON.stringify(list.data).includes(secret));
  assert.ok(!s.ctx.db.prepare('SELECT sealed FROM credentials WHERE id = ?').get(r.data.id).sealed.includes(PW), 'sealed at rest');

  const dup = await admin('POST', '/api/credentials', { name: 'ROOT', username: 'x', password: 'p' });
  assert.equal(dup.status, 409);
});

test('validation', async t => {
  const { admin } = await setup(t);
  const post = body => admin('POST', '/api/credentials', { name: 'n', username: 'u', password: 'p', ...body });
  for (const [label, body] of [
    ['no name', { name: '' }], ['name too long', { name: 'x'.repeat(65) }], ['name control char', { name: 'a\nb' }],
    ['no username', { username: '' }], ['username too long', { username: 'u'.repeat(129) }], ['username control char', { username: 'a\u0007' }],
    ['no secret', { password: undefined }], ['both secrets', { private_key: PEM }], ['not a PEM', { password: undefined, private_key: 'ssh-rsa AAAA' }],
    ['key too big', { password: undefined, private_key: `-----BEGIN ${'PRIVATE'} KEY-----\n${'A'.repeat(17000)}\n-----END PRIVATE KEY-----` }],
    ['password too long', { password: 'p'.repeat(4097) }], ['bad domain', { domain: 'a b\\c' }], ['note too long', { note: 'n'.repeat(501) }],
    ['kind mismatch', { kind: 'ssh_key' }], ['name not text', { name: 5 }]
  ]) assert.equal((await post(body)).status, 400, label);
  assert.equal((await post({ name: 'ok' })).status, 200);
});

test('secrets never reach the audit log or the console', async t => {
  const { s, admin } = await setup(t);
  const seen = [];
  const spies = ['log', 'warn', 'error', 'info'].map(m => { const o = console[m]; console[m] = (...a) => seen.push(a.join(' ')); return [m, o]; });
  try {
    const r = await admin('POST', '/api/credentials', { name: 'root', username: 'root', password: PW, sudo_password: SUDO });
    await admin('PUT', `/api/credentials/${r.data.id}`, { password: PW + '2', sudo_password: SUDO + '2' });
    const k = await admin('POST', '/api/credentials', { name: 'key', username: 'u', private_key: PEM, passphrase: 'pp-secret-1' });
    await admin('POST', '/api/credentials', { name: 'bad', username: 'u', private_key: 'nope', password: PW });
    await admin('DELETE', `/api/credentials/${k.data.id}`, { confirm: 'key' });
  } finally { for (const [m, o] of spies) console[m] = o; }
  const audit = JSON.stringify(s.ctx.db.prepare('SELECT * FROM audit_log').all());
  for (const secret of [PW, SUDO, 'pp-secret-1', 'PRIVATE KEY']) {
    assert.ok(!audit.includes(secret), `audit holds ${secret}`);
    assert.ok(!seen.join('\n').includes(secret), `console holds ${secret}`);
  }
  assert.match(audit, /credential\.create/);
});

test('update without a secret keeps the old one, with a secret replaces it', async t => {
  const { s, admin } = await setup(t);
  const { data: { id } } = await admin('POST', '/api/credentials', { name: 'root', username: 'root', password: PW, sudo_password: SUDO });
  assert.equal((await admin('PUT', `/api/credentials/${id}`, { name: 'root2', username: 'toor', domain: 'example.test' })).status, 200);
  let got = s.ctx.credentials.use(id, 'test');
  assert.deepEqual([got.name, got.username, got.domain, got.password, got.sudo_password], ['root2', 'toor', 'example.test', PW, SUDO]);

  await admin('POST', '/api/credentials', { name: 'other', username: 'u', password: 'p' });
  assert.equal((await admin('PUT', `/api/credentials/${id}`, { name: 'Other' })).status, 409);

  assert.equal((await admin('PUT', `/api/credentials/${id}`, { private_key: PEM })).status, 200);
  got = s.ctx.credentials.use(id, 'test');
  assert.equal(got.kind, 'ssh_key');
  assert.equal(got.password, undefined);
  assert.equal(got.sudo_password, SUDO, 'sudo password survives a secret replacement');
  assert.equal((await admin('PUT', `/api/credentials/${id}`, { sudo_password: '' })).status, 200);
  assert.equal(s.ctx.credentials.use(id).sudo_password, undefined);
  assert.equal((await admin('PUT', '/api/credentials/missing', { name: 'x' })).status, 404);
});

test('delete needs the exact name and refuses a credential a host still uses', async t => {
  const { s, admin } = await setup(t);
  const { data: { id } } = await admin('POST', '/api/credentials', { name: 'root', username: 'root', password: PW });
  assert.equal((await admin('DELETE', `/api/credentials/${id}`, {})).status, 400);
  assert.equal((await admin('DELETE', `/api/credentials/${id}`, { confirm: 'Root' })).status, 400);
  s.ctx.db.prepare("INSERT INTO hosts (id, hostname, kind, data) VALUES ('h1', 'vps-1.example.test', 'ssh', ?)").run(JSON.stringify({ ssh: { credential_id: id } }));
  const used = await admin('DELETE', `/api/credentials/${id}`, { confirm: 'root' });
  assert.equal(used.status, 409);
  assert.match(used.data.error, /vps-1\.example\.test/);
  s.ctx.db.prepare("DELETE FROM hosts WHERE id = 'h1'").run();
  assert.equal((await admin('DELETE', `/api/credentials/${id}`, { confirm: 'root' })).status, 200);
  assert.equal(s.ctx.credentials.use(id), null);
});

test('migration keeps host-bound rows from an old-shape table', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE credentials (id TEXT PRIMARY KEY, host_id TEXT, name TEXT, username TEXT, purpose TEXT NOT NULL DEFAULT 'autologin',
    kind TEXT NOT NULL DEFAULT 'password', sealed TEXT NOT NULL, created_at TEXT, updated_at TEXT)`);
  db.prepare("INSERT INTO credentials (id, host_id, username, purpose, sealed) VALUES ('c1', 'h1', 'admin', 'autologin', 'blob1')").run();
  db.prepare("INSERT INTO credentials (id, host_id, name, username, purpose, kind, sealed) VALUES ('c2', 'h2', 'h2 ssh', 'root', 'ssh', 'key', 'blob2')").run();
  migrate(db);
  migrate(db); // idempotent
  assert.deepEqual(db.prepare('SELECT id, host_id, username, purpose, sealed, domain, last_used FROM credentials ORDER BY id').all(), [
    { id: 'c1', host_id: 'h1', username: 'admin', purpose: 'autologin', sealed: 'blob1', domain: null, last_used: null },
    { id: 'c2', host_id: 'h2', username: 'root', purpose: 'ssh', sealed: 'blob2', domain: null, last_used: null }]);
  db.prepare("INSERT INTO credentials (id, name, purpose, sealed) VALUES ('s1', 'Root', 'shared', 'x')").run();
  assert.throws(() => db.prepare("INSERT INTO credentials (id, name, purpose, sealed) VALUES ('s2', 'root', 'shared', 'x')").run(), /UNIQUE/);
  db.prepare("INSERT INTO credentials (id, name, purpose, sealed) VALUES ('s3', 'root', 'ssh', 'x')").run(); // only shared names are unique
  db.close();
});

test('host-bound credentials still work and show their host name', async t => {
  const { s, admin } = await setup(t);
  s.ctx.db.prepare("INSERT INTO hosts (id, hostname, kind) VALUES ('h1', 'node-a.example.test', 'agent')").run();
  const a = await admin('POST', '/api/credentials', { host_id: 'h1', username: 'admin', password: PW });
  assert.equal(a.data.created, true);
  assert.equal((await admin('POST', '/api/credentials', { host_id: 'h1', username: 'admin2', password: PW })).data.updated, true);
  assert.equal((await admin('POST', '/api/credentials', { host_id: 'h1', username: 'admin' })).status, 400);
  const row = (await admin('GET', '/api/credentials')).data.find(c => c.id === a.data.id);
  assert.deepEqual([row.hostname, row.username, row.purpose, row.scope], ['node-a.example.test', 'admin2', 'autologin', 'host']);
  assert.equal((await admin('DELETE', `/api/credentials/${a.data.id}`)).status, 200);
});

test('ctx.credentials.use returns the secret in memory only and stamps last_used', async t => {
  const { s, admin } = await setup(t);
  const { data: { id } } = await admin('POST', '/api/credentials', { name: 'root', username: 'root', password: PW });
  assert.equal((await admin('GET', '/api/credentials')).data[0].last_used, null);
  const got = s.ctx.credentials.use(id, 'ssh poll');
  assert.equal(got.password, PW);
  assert.equal(got.username, 'root');
  const row = (await admin('GET', '/api/credentials')).data[0];
  assert.ok(Date.now() - Date.parse(row.last_used) < 5000);
  assert.equal(row.last_purpose, 'ssh poll');
  assert.ok(!JSON.stringify(row).includes(PW));
  assert.equal(s.ctx.credentials.use('nope'), null);
});

test('operators and viewers cannot create or read secrets, operators can list names', async t => {
  const { admin, op, viewer } = await setup(t);
  const { data: { id } } = await admin('POST', '/api/credentials', { name: 'root', username: 'root', password: PW, domain: 'example.test' });
  assert.equal((await op('POST', '/api/credentials', { name: 'x', username: 'u', password: 'p' })).status, 403);
  assert.equal((await op('GET', '/api/credentials')).status, 403);
  assert.equal((await op('PUT', `/api/credentials/${id}`, { name: 'x' })).status, 403);
  assert.equal((await op('DELETE', `/api/credentials/${id}`, { confirm: 'root' })).status, 403);
  const names = await op('GET', '/api/credentials/names');
  assert.equal(names.status, 200);
  assert.deepEqual(names.data, [{ id, name: 'root', kind: 'password', domain: 'example.test' }]);
  assert.ok(!JSON.stringify(names.data).includes(PW));
  assert.equal((await viewer('GET', '/api/credentials/names')).status, 403);
});
