const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { startApp, login, api, tempDir } = require('./helpers');
const { secretMatches, restore, serverRunning, FILE_RE } = require('../src/backup');

const SERVER_DIR = path.join(__dirname, '..');
const send = (base, method, p, headers = {}) => fetch(base + p, { method, headers }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }));

async function setup(t) {
  const s = await startApp();
  t.after(() => s.stop());
  const admin = api(s.base, await login(s.base));
  return { s, admin };
}

test('backup run writes an openable copy and stores the integrity result', async (t) => {
  const { s, admin } = await setup(t);
  await admin('POST', '/api/users', { username: 'marker-user', password: 'pw-marker-1', role: 'viewer' });
  const r = await admin('POST', '/api/backup/run');
  assert.equal(r.status, 200);
  assert.match(r.data.file, FILE_RE);
  assert.ok(r.data.size > 0);
  const file = path.join(s.dataDir, 'backups', r.data.file);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const copy = new Database(file, { readonly: true });
  assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
  assert.ok(copy.prepare('SELECT 1 FROM users WHERE username = ?').get('marker-user'));
  copy.close();
  assert.deepEqual(fs.readdirSync(path.join(s.dataDir, 'backups')), [r.data.file], 'no temp file is left behind');
  const status = await admin('GET', '/api/backup/status');
  assert.equal(status.data.last.ok, true);
  assert.equal(status.data.last.file, r.data.file);
  assert.equal(status.data.count, 1);
  assert.equal(status.data.enabled, true);
  assert.equal(status.data.time, '02:30');
  assert.equal(status.data.keep_days, 14);
  assert.ok(status.data.next, 'next nightly run is scheduled');
  const list = await admin('GET', '/api/backups');
  assert.deepEqual(list.data.map(f => f.file), [r.data.file]);
});

test('retention keeps the newest file and at least three', async (t) => {
  const { s } = await setup(t);
  const dir = path.join(s.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const old = n => {
    const f = path.join(dir, `labctl-2020010${n}T000000Z.db`);
    fs.writeFileSync(f, 'x');
    const when = new Date(Date.now() - (100 - n) * 86400000);
    fs.utimesSync(f, when, when);
    return path.basename(f);
  };
  const names = [1, 2, 3, 4, 5, 6].map(old); // 6 is the newest
  const gone = s.ctx.backups.prune();
  assert.deepEqual(gone.sort(), names.slice(0, 3).sort());
  assert.deepEqual(s.ctx.backups.list().map(f => f.file), names.slice(3).reverse());

  // Two old files only: nothing is deleted, whatever their age.
  fs.unlinkSync(path.join(dir, names[3]));
  assert.deepEqual(s.ctx.backups.prune(), []);
  assert.equal(s.ctx.backups.list().length, 2);
});

test('retention days setting is validated and drives the cutoff', async (t) => {
  const { s, admin } = await setup(t);
  assert.equal((await admin('PUT', '/api/backup/settings', { backup_time: '25:00' })).status, 400);
  assert.equal((await admin('PUT', '/api/backup/settings', { backup_keep_days: 0 })).status, 400);
  assert.equal((await admin('PUT', '/api/backup/settings', { backup_enabled: 'yes' })).status, 400);
  const ok = await admin('PUT', '/api/backup/settings', { backup_time: '03:15', backup_keep_days: 2, backup_enabled: false });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.time, '03:15');
  assert.equal(ok.data.keep_days, 2);
  assert.equal(ok.data.enabled, false);
  assert.equal(ok.data.next, null, 'disabled means no next run');
  assert.equal(s.ctx.backups.settings().keep_days, 2);
});

test('file names that are not labctl-<timestamp>.db are rejected', async (t) => {
  const { s, admin } = await setup(t);
  const run = await admin('POST', '/api/backup/run');
  const names = ['..%2F..%2Flabctl.db', '..%5C..%5Clabctl.db', 'labctl.db', 'labctl-1.db%2F..%2F..%2Fx.db', 'labctl-20200101T000000Z.db.bak',
    '.tmp-labctl-20200101T000000Z', 'passwd', 'labctl-%2e%2e.db'];
  for (const n of names) {
    assert.equal((await admin('GET', `/api/backups/${n}/download`)).status, 400, `download ${n}`);
    assert.equal((await admin('DELETE', `/api/backups/${n}`, { confirm: n })).status, 400, `delete ${n}`);
  }
  assert.ok(fs.existsSync(path.join(s.dataDir, 'labctl.db')));
  // Download works for a real one, and delete needs the typed file name.
  const dl = await fetch(`${s.base}/api/backups/${run.data.file}/download`, { headers: { authorization: `Bearer ${await login(s.base)}` } });
  assert.equal(dl.status, 200);
  assert.equal((await dl.arrayBuffer()).byteLength, run.data.size);
  const noConfirm = await admin('DELETE', `/api/backups/${run.data.file}`, { confirm: 'wrong' });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.data.confirm_required, true);
  assert.equal((await admin('DELETE', `/api/backups/${run.data.file}`, { confirm: run.data.file })).status, 200);
  assert.equal((await admin('GET', '/api/backups')).data.length, 0);
});

test('only admins reach the backup routes', async (t) => {
  const { s, admin } = await setup(t);
  await admin('POST', '/api/users', { username: 'op1', password: 'pw-operator-1', role: 'operator' });
  const op = api(s.base, await login(s.base, 'op1', 'pw-operator-1'));
  for (const [m, p] of [['GET', '/api/backups'], ['GET', '/api/backup/status'], ['POST', '/api/backup/run'], ['GET', '/api/config/export'], ['POST', '/api/config/import']]) {
    assert.equal((await op(m, p, m === 'POST' ? {} : undefined)).status, 403, `${m} ${p}`);
  }
  assert.equal((await send(s.base, 'GET', '/api/backups')).status, 401);
});

test('POST /api/backup/run accepts the updater secret and rejects a wrong or missing one', async (t) => {
  process.env.LABCTL_UPDATER_SECRET = 'updater-secret-for-test';
  t.after(() => { delete process.env.LABCTL_UPDATER_SECRET; });
  const { s, admin } = await setup(t);
  const good = await send(s.base, 'POST', '/api/backup/run', { 'x-updater-secret': 'updater-secret-for-test' });
  assert.equal(good.status, 200);
  assert.match(good.data.file, FILE_RE);
  assert.ok(good.data.size > 0);
  assert.equal((await send(s.base, 'POST', '/api/backup/run', { 'x-updater-secret': 'updater-secret-for-tesT' })).status, 401);
  assert.equal((await send(s.base, 'POST', '/api/backup/run', { 'x-updater-secret': 'short' })).status, 401);
  assert.equal((await send(s.base, 'POST', '/api/backup/run', { 'x-updater-secret': '' })).status, 401);
  assert.equal((await send(s.base, 'POST', '/api/backup/run')).status, 401);
  // The secret does not open any other admin route.
  assert.equal((await send(s.base, 'GET', '/api/backups', { 'x-updater-secret': 'updater-secret-for-test' })).status, 401);
  const audit = await admin('GET', '/api/audit?action=' + encodeURIComponent('POST /api/backup/run'));
  assert.ok(audit.data.rows.some(r => r.actor === 'updater'));
  assert.ok(!JSON.stringify(audit.data).includes('updater-secret-for-test'));
});

test('with no LABCTL_UPDATER_SECRET set, no header value is accepted', async (t) => {
  delete process.env.LABCTL_UPDATER_SECRET;
  const { s } = await setup(t);
  for (const v of ['', 'undefined', 'anything']) assert.equal((await send(s.base, 'POST', '/api/backup/run', { 'x-updater-secret': v })).status, 401);
});

test('secret compare is fixed length and constant time', () => {
  assert.equal(secretMatches('abc', 'abc'), true);
  assert.equal(secretMatches('abc', 'abd'), false);
  assert.equal(secretMatches('abc', 'abcd'), false);
  assert.equal(secretMatches('abc', ''), false);
  assert.equal(secretMatches('abc', undefined), false);
  assert.equal(secretMatches(undefined, 'abc'), false);
  assert.match(fs.readFileSync(path.join(SERVER_DIR, 'src', 'backup.js'), 'utf8'), /timingSafeEqual/);
});

test('server lock exists while the app runs and goes on close', async () => {
  const s = await startApp();
  const lock = path.join(s.dataDir, 'labctl.lock');
  assert.ok(fs.existsSync(lock));
  assert.equal(serverRunning(s.dataDir), true);
  await s.close();
  assert.equal(fs.existsSync(lock), false);
  assert.equal(serverRunning(s.dataDir), false);
  fs.rmSync(s.dataDir, { recursive: true, force: true });
});

test('restore: refuses without --force or with a live lock, then replaces the database and keeps the old one', async () => {
  const dataDir = tempDir();
  const s = await startApp({ dataDir });
  const admin = api(s.base, await login(s.base));
  const run = await admin('POST', '/api/backup/run');
  await admin('POST', '/api/users', { username: 'after-backup', password: 'pw-after-1', role: 'viewer' });
  s.ctx.db.pragma('wal_checkpoint(PASSIVE)');
  await s.close();
  const file = path.join(dataDir, 'backups', run.data.file);
  const dbPath = path.join(dataDir, 'labctl.db');
  const hasUser = p => { const d = new Database(p, { readonly: true }); try { return !!d.prepare("SELECT 1 FROM users WHERE username = 'after-backup'").get(); } finally { d.close(); } };
  assert.equal(hasUser(dbPath), true);

  assert.throws(() => restore({ file, dataDir }), /--force/);
  fs.writeFileSync(path.join(dataDir, 'labctl.lock'), '{}'); // fresh lock: the server looks alive
  assert.throws(() => restore({ file, dataDir, force: true }), /lock is fresh/);
  const past = new Date(Date.now() - 120000);
  fs.utimesSync(path.join(dataDir, 'labctl.lock'), past, past); // stale lock: the server stopped without cleaning up
  fs.writeFileSync(`${dbPath}-wal`, 'leftover'); // pretend a WAL was left behind
  fs.writeFileSync(`${dbPath}-shm`, 'leftover');

  assert.throws(() => restore({ file: 'labctl-19990101T000000Z.db', dataDir, force: true }), /not found/);
  fs.writeFileSync(path.join(dataDir, 'backups', 'labctl-20000101T000000Z.db'), 'not a database');
  assert.throws(() => restore({ file: 'labctl-20000101T000000Z.db', dataDir, force: true }));
  assert.equal(hasUser(dbPath), true, 'a failed restore leaves the live database alone');

  const r = restore({ file: run.data.file, dataDir, force: true, now: new Date('2026-01-02T03:04:05Z') });
  assert.equal(r.kept, 'labctl.db.before-restore-20260102T030405Z');
  assert.equal(hasUser(dbPath), false, 'live database is the backup');
  assert.equal(hasUser(path.join(dataDir, r.kept)), true, 'replaced database is kept');
  assert.equal(fs.existsSync(`${dbPath}-wal`), false);
  assert.equal(fs.existsSync(`${dbPath}-shm`), false);
  assert.ok(fs.existsSync(`${path.join(dataDir, r.kept)}-wal`));
  assert.deepEqual(fs.readdirSync(dataDir).filter(f => f.startsWith('.restore-')), []);

  // The restored database starts cleanly in a new app.
  const again = await startApp({ dataDir });
  assert.equal(again.ctx.db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'after-backup'").get().n, 0);
  await again.stop();
});

test('restore CLI: scripts/restore.js and src/backup.js restore share one code path', async () => {
  const dataDir = tempDir();
  const s = await startApp({ dataDir });
  const run = await api(s.base, await login(s.base))('POST', '/api/backup/run');
  await s.close();
  const node = process.execPath;
  const noForce = spawnSync(node, [path.join(SERVER_DIR, 'scripts', 'restore.js'), run.data.file, '--data-dir', dataDir], { encoding: 'utf8' });
  assert.equal(noForce.status, 1);
  assert.match(noForce.stderr, /--force/);
  const viaScript = spawnSync(node, [path.join(SERVER_DIR, 'scripts', 'restore.js'), run.data.file, '--data-dir', dataDir, '--force'], { encoding: 'utf8' });
  assert.equal(viaScript.status, 0, viaScript.stderr);
  assert.match(viaScript.stdout, /Restored labctl-.*\.db/);
  const viaSrc = spawnSync(node, [path.join(SERVER_DIR, 'src', 'backup.js'), 'restore', run.data.file, '--data-dir', dataDir, '--force'], { encoding: 'utf8' });
  assert.equal(viaSrc.status, 0, viaSrc.stderr);
  assert.equal(fs.readdirSync(dataDir).filter(f => f.startsWith('labctl.db.before-restore-')).length >= 1, true);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
