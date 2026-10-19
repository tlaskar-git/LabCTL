const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createJobLog, MARKER } = require('../src/joblog');
const { tempDir } = require('./helpers');

test('job log keeps head and tail with a marker once over the cap', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = createJobLog(dir, () => 2000);
  const lines = Array.from({ length: 400 }, (_, i) => `line ${String(i).padStart(4, '0')}\n`); // 4000 bytes
  for (const l of lines) log.append('job1', l);
  const running = log.read('job1');
  assert.ok(running.startsWith('line 0000\n'));
  assert.ok(running.includes(MARKER));
  log.finish('job1');
  const text = fs.readFileSync(path.join(dir, 'job1.log'), 'utf8');
  assert.ok(Buffer.byteLength(text) <= 2000 + MARKER.length);
  assert.ok(text.startsWith('line 0000\n'));
  assert.ok(text.endsWith('line 0399\n'));
  assert.ok(text.includes(MARKER));
  assert.ok(!fs.existsSync(path.join(dir, 'job1.tail')));
  assert.equal(log.read('job1'), text);
});

test('job log under the cap is stored whole; bad ids are refused', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = createJobLog(dir, () => 2000);
  log.append('job2', 'hello ');
  log.append('job2', 'world');
  log.finish('job2');
  assert.equal(log.read('job2'), 'hello world');
  assert.equal(log.tail('job2', 5), 'world');
  assert.throws(() => log.append('../evil', 'x'), /Invalid job id/);
});
