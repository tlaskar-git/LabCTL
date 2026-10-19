const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers');

const entry = path.join(__dirname, '..', 'server.js');
const run = (key) => {
  const env = { ...process.env, DATA_DIR: tempDir(), PORT: '0' };
  delete env.LABCTL_MASTER_KEY;
  if (key !== undefined) env.LABCTL_MASTER_KEY = key;
  const r = spawnSync(process.execPath, [entry], { env, encoding: 'utf8', timeout: 15000 });
  fs.rmSync(env.DATA_DIR, { recursive: true, force: true });
  return r;
};

test('server refuses to start without LABCTL_MASTER_KEY', () => {
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /LABCTL_MASTER_KEY is not set/);
});

test('server refuses to start with a key of the wrong length', () => {
  const r = run('dG9vLXNob3J0');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /wrong length/);
});
