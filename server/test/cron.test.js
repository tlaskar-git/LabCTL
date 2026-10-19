const test = require('node:test');
const assert = require('node:assert/strict');
const { nextRun } = require('../src/scheduler');
const { startApp } = require('./helpers');

test('*/5 gives the next five-minute mark', () => {
  assert.equal(nextRun('*/5 * * * *', new Date('2026-01-01T10:02:00Z'), 'UTC'), '2026-01-01T10:05:00.000Z');
  assert.equal(nextRun('*/5 * * * *', new Date('2026-01-01T10:05:00Z'), 'UTC'), '2026-01-01T10:10:00.000Z');
});

test('day-of-month and day-of-week fields are honoured', () => {
  assert.equal(nextRun('0 9 15 * *', new Date('2026-01-20T00:00:00Z'), 'UTC'), '2026-02-15T09:00:00.000Z');
  assert.equal(nextRun('30 2 * * 1', new Date('2026-01-01T00:00:00Z'), 'UTC'), '2026-01-05T02:30:00.000Z'); // Monday
});

test('timezone Europe/Dublin follows summer time', () => {
  assert.equal(nextRun('0 9 * * *', new Date('2026-01-10T00:00:00Z'), 'Europe/Dublin'), '2026-01-10T09:00:00.000Z');
  assert.equal(nextRun('0 9 * * *', new Date('2026-07-01T00:00:00Z'), 'Europe/Dublin'), '2026-07-01T08:00:00.000Z');
});

test('invalid expressions throw', () => {
  assert.throws(() => nextRun('* * *', new Date(), 'UTC'), /5 fields/);
  assert.throws(() => nextRun('99 * * * *', new Date(), 'UTC'));
});

test('scheduler runs due schedules and records missed ones', async (t) => {
  const s = await startApp({ listen: false });
  t.after(() => s.stop());
  const { db, scheduler } = s.ctx;
  const now = new Date();
  const ago = ms => new Date(now.getTime() - ms).toISOString();
  const add = (id, nextRunAt) => db.prepare(`INSERT INTO schedules (id, name, host_id, type, params, cron, enabled, next_run, created_at)
    VALUES (?, ?, 'h1', 'reboot', '{}', '*/5 * * * *', 1, ?, ?)`).run(id, id, nextRunAt, ago(0));
  add('on-time', ago(30000));
  add('late', ago(600000));
  scheduler.tick(now);

  const onTime = db.prepare("SELECT * FROM schedules WHERE id = 'on-time'").get();
  assert.ok(onTime.last_run);
  assert.ok(onTime.next_run > now.toISOString());
  assert.equal(db.prepare("SELECT status FROM jobs WHERE schedule_id = 'on-time'").get().status, 'pending');

  const late = db.prepare("SELECT * FROM schedules WHERE id = 'late'").get();
  assert.equal(late.last_run, null);
  assert.ok(late.missed_count >= 1);
  assert.ok(late.next_run > now.toISOString());
  assert.equal(db.prepare("SELECT status FROM jobs WHERE schedule_id = 'late'").get().status, 'missed');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'schedule.missed'").get());
});
