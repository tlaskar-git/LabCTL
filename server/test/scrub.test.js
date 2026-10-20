const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../src/db');

test('opening the database removes passwords that v1 left in job params', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labctl-scrub-'));
  let db = openDb(dir);
  const at = new Date().toISOString();
  db.prepare("INSERT INTO jobs (id, host_id, type, params, status, created_at) VALUES ('j1', 'h', 'autologin', ?, 'completed', ?)").run(JSON.stringify({ username: 'u', password: 'p-test-only', keep: 1 }), at);
  db.close();
  db = openDb(dir);
  const params = JSON.parse(db.prepare("SELECT params FROM jobs WHERE id = 'j1'").get().params);
  assert.deepEqual(params, { username: 'u', keep: 1 });
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
