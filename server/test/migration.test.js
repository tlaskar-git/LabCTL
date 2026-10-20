const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir, startApp } = require('./helpers');
const { hashPassword } = require('../src/auth');

const legacy = () => ({
  hosts: { h1: { id: 'h1', hostname: 'node-a.example.test', os: 'linux', ip: '192.0.2.10', status: 'online', last_seen: '2026-01-01T00:00:00.000Z', system_info: { ram_mb: 1024 }, created_at: '2025-12-01T00:00:00.000Z', group_id: 'g1' } },
  jobs: {
    j1: { id: 'j1', host_id: 'h1', type: 'custom_command', params: '{"command":"uptime"}', status: 'completed', result: 'up 3 days', error: '', created_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:00:05.000Z' },
    j2: { id: 'j2', host_id: 'h1', type: 'reboot', params: '{}', status: 'sent', result: '', error: '', created_at: '2026-01-02T00:00:00.000Z' }
  },
  schedules: { s1: { id: 's1', name: 'Nightly', host_id: 'h1', type: 'reboot', params: '{}', cron: '0 3 * * *', enabled: true, next_run: '2020-01-01T00:00:00.000Z', created_at: '2025-12-01T00:00:00.000Z' } },
  credentials: { c1: { id: 'c1', host_id: 'h1', username: 'svc', password: 'plain-text-pw', purpose: 'autologin', created_at: '2025-12-01T00:00:00.000Z' } },
  groups: { g1: { id: 'g1', name: 'Lab', color: '#3b82f6', order: 0, created_at: '2025-12-01T00:00:00.000Z' } },
  users: {
    u1: { id: 'u1', username: 'admin1', role: 'admin', password_hash: hashPassword('pw1'), created_at: '2025-12-01T00:00:00.000Z' },
    u2: { id: 'u2', username: 'reader', role: 'readonly', password_hash: hashPassword('pw2'), created_at: '2025-12-01T00:00:00.000Z' }
  },
  sessions: { tok123: { token: 'tok123', user_id: 'u1', created_at: '2026-01-01T00:00:00.000Z', last_seen: '2026-01-01T00:00:00.000Z' } },
  metrics: [{ id: 'm1', host_id: 'h1', created_at: '2026-01-01T00:00:00.000Z', ram_used_percent: 40, drives: [] }],
  scripts: { sc1: { id: 'sc1', name: 'Uptime', description: '', os: 'any', target: 'host', command: 'uptime', timeout: 60, created_at: '2025-12-01T00:00:00.000Z', updated_at: '2025-12-01T00:00:00.000Z' } },
  settings: { retention_days: 14, poll_interval_seconds: 600, theme: 'light' }
});

test('v1 JSON store migrates once, with a backup, sealed credentials and job logs on disk', async (t) => {
  const dataDir = tempDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const src = path.join(dataDir, 'labctl-data.json');
  fs.writeFileSync(src, JSON.stringify(legacy()));

  let s = await startApp({ dataDir, listen: false });
  const { db, crypto, settings, joblog, auth } = s.ctx;
  const files = fs.readdirSync(dataDir);
  assert.ok(files.some(f => f.startsWith('labctl-data.json.bak-')), 'backup copy exists');
  assert.ok(files.some(f => f.startsWith('labctl-data.json.migrated-')), 'source renamed');
  assert.ok(!fs.existsSync(src));

  assert.equal(db.prepare("SELECT role FROM users WHERE id = 'u2'").get().role, 'viewer');
  assert.ok(auth.verifyPassword('pw1', db.prepare("SELECT password_hash FROM users WHERE id = 'u1'").get().password_hash));
  assert.equal(auth.userForToken('tok123').id, 'u1');
  const cred = db.prepare("SELECT * FROM credentials WHERE id = 'c1'").get();
  assert.ok(!cred.sealed.includes('plain-text-pw'));
  assert.equal(crypto.openJson(cred.sealed).password, 'plain-text-pw');
  assert.equal(joblog.read('j1'), 'up 3 days');
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id = 'j2'").get().status, 'cancelled');
  assert.ok(db.prepare("SELECT next_run FROM schedules WHERE id = 's1'").get().next_run > new Date().toISOString());
  assert.equal(db.prepare("SELECT group_id FROM host_groups WHERE host_id = 'h1'").get().group_id, 'g1');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM metrics').get().n, 1);
  assert.equal(settings.get('metrics_days'), 14);
  assert.equal(settings.get('theme'), 'light');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'LabCTLAdmin'").get().n, 0, 'no default admin when users were imported');
  await s.close(); // checkpoints the WAL into labctl.db
  const dbFile = fs.readFileSync(path.join(dataDir, 'labctl.db'));
  assert.ok(!dbFile.includes('plain-text-pw') && !dbFile.includes('up 3 days'));

  // Second start with the same file present again: no second import, nothing duplicated.
  fs.writeFileSync(src, JSON.stringify(legacy()));
  s = await startApp({ dataDir, listen: false });
  assert.equal(s.ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
  assert.ok(fs.existsSync(src), 'left untouched');
  await s.close();
});
