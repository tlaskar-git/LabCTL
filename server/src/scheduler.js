// Cron schedules (5 fields, cron-parser) evaluated in the `timezone` setting (default Europe/Dublin).
// A run found more than GRACE_MS late (for example after downtime) is recorded as missed, not run.
const { CronExpressionParser } = require('cron-parser');

const GRACE_MS = 120000;

function assertFiveFields(expr) {
  if (typeof expr !== 'string' || expr.trim().split(/\s+/).length !== 5) throw new Error('cron must have 5 fields: minute hour day-of-month month day-of-week');
}

// Next run strictly after `from`, as an ISO string in UTC. Throws on an invalid expression.
function nextRun(expr, from = new Date(), tz = 'Europe/Dublin') {
  assertFiveFields(expr);
  return CronExpressionParser.parse(expr.trim(), { currentDate: from, tz }).next().toISOString();
}

// Count scheduled times in (after, until], capped.
function countRuns(expr, after, until, tz, cap = 1000) {
  const it = CronExpressionParser.parse(expr.trim(), { currentDate: after, endDate: until, tz });
  let n = 0;
  while (n < cap && it.hasNext()) { it.next(); n++; }
  return n;
}

function createScheduler(ctx) {
  const { db } = ctx;
  const tz = () => ctx.settings.get('timezone') || 'Europe/Dublin';
  let timer = null;

  const self = {
    nextRun: (expr, from = new Date()) => nextRun(expr, from, tz()),
    validate(expr) { try { nextRun(expr, new Date(), tz()); return null; } catch (err) { return err.message; } },
    recomputeAll(from = new Date()) {
      const update = db.prepare('UPDATE schedules SET next_run = ? WHERE id = ?');
      for (const s of db.prepare('SELECT id, cron FROM schedules').all()) {
        let next = null;
        try { next = nextRun(s.cron, from, tz()); } catch { /* invalid v1 cron: leave unscheduled */ }
        update.run(next, s.id);
      }
    },
    tick(at = new Date()) {
      const t = at.toISOString();
      const due = db.prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?').all(t);
      for (const s of due) {
        let next = null;
        try { next = nextRun(s.cron, at, tz()); } catch { /* cron became invalid */ }
        const late = at.getTime() - new Date(s.next_run).getTime();
        if (late > GRACE_MS) {
          const missed = 1 + countRuns(s.cron, new Date(s.next_run), new Date(at.getTime() - GRACE_MS), tz());
          db.prepare('UPDATE schedules SET last_missed = ?, missed_count = missed_count + ?, next_run = ? WHERE id = ?').run(s.next_run, missed, next, s.id);
          ctx.jobs.create({ host_id: s.host_id, type: s.type, params: s.params, status: 'missed', schedule_id: s.id, actor: 'scheduler', dispatchNow: false });
          ctx.audit('scheduler', 'schedule.missed', s.host_id, { schedule_id: s.id, name: s.name, due: s.next_run, missed });
          continue;
        }
        db.prepare('UPDATE schedules SET last_run = ?, next_run = ? WHERE id = ?').run(t, next, s.id);
        ctx.jobs.create({ host_id: s.host_id, type: s.type, params: s.params, schedule_id: s.id, actor: 'scheduler' });
      }
    },
    start() { self.tick(); timer = setInterval(() => { try { self.tick(); } catch (err) { ctx.logger.error('[scheduler]', err.message); } }, 60000); timer.unref(); },
    stop() { clearInterval(timer); }
  };
  return self;
}

module.exports = { createScheduler, nextRun, GRACE_MS };
