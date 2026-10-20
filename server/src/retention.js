// Daily pruning of jobs, job logs, metrics and audit rows by the retention settings.
function createRetention(ctx) {
  const { db } = ctx;
  let timer = null;
  const cutoff = days => new Date(Date.now() - Math.max(1, Number(days)) * 86400000).toISOString();
  const self = {
    run() {
      const s = ctx.settings;
      const oldJobs = db.prepare("SELECT id FROM jobs WHERE created_at < ? AND status NOT IN ('pending','sent','running','waiting')").all(cutoff(s.get('jobs_days')));
      db.transaction(() => { for (const j of oldJobs) db.prepare('DELETE FROM jobs WHERE id = ?').run(j.id); })();
      oldJobs.forEach(j => ctx.joblog.remove(j.id));
      const result = {
        jobs: oldJobs.length,
        job_logs: ctx.joblog.prune(Math.max(1, Number(s.get('job_logs_days')))),
        metrics: db.prepare('DELETE FROM metrics WHERE created_at < ?').run(cutoff(s.get('metrics_days'))).changes,
        audit: db.prepare('DELETE FROM audit_log WHERE ts < ?').run(cutoff(s.get('audit_days'))).changes
      };
      if (Object.values(result).some(Boolean)) ctx.logger.info('[retention] pruned', JSON.stringify(result));
      return result;
    },
    start() {
      const safe = () => { try { self.run(); } catch (err) { ctx.logger.error('[retention]', err.message); } };
      safe();
      timer = setInterval(safe, 86400000);
      timer.unref();
    },
    stop() { clearInterval(timer); }
  };
  return self;
}

module.exports = { createRetention };
