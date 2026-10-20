// Job lifecycle: create, dispatch to an agent (or a registered dispatcher for other host kinds), output, completion.
// Output goes to job log files only, never to the database.
const { randomUUID } = require('crypto');
const { parseJson, ensureColumn } = require('./db');
const legacy = require('./legacy-jobs');

const OPEN_STATES = ['pending', 'sent', 'running', 'waiting'];
const OFFLINE = 'Host is offline, the job starts when it reconnects';
const SWEEP_MS = 15000;

function createJobs(ctx) {
  const { db } = ctx;
  const now = () => new Date().toISOString();
  const dispatchers = new Map(); // host kind -> (job, host) => boolean (true when handed off)

  // Phase 6 columns and the job group table (one group = one child job per host).
  ensureColumn(db, 'jobs', 'group_id', 'TEXT');
  ensureColumn(db, 'jobs', 'bytes_received', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'jobs', 'sent_at', 'TEXT');
  ensureColumn(db, 'jobs', 'result_text', 'TEXT'); // job.result for legacy.RESULT_TYPES, kept whole for the UI parsers
  db.exec(`CREATE TABLE IF NOT EXISTS job_groups (id TEXT PRIMARY KEY, label TEXT, type TEXT, actor TEXT, retry_of TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS jobs_group ON jobs(group_id)`);
  const lastLine = text => {
    const lines = String(text || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean);
    return (lines[lines.length - 1] || '').slice(0, 160);
  };

  const get = id => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  const setStatus = (id, status, extra = {}) => {
    const fields = { status, ...extra };
    const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE jobs SET ${sets} WHERE id = @id`).run({ ...fields, id });
    const job = get(id);
    ctx.events.emit('job', job);
    return job;
  };

  // Auto-login secret, resolved at send time only so it never sits in the jobs table: the job's credential_id, else
  // the host's saved auto-login credential (schedules), else a password left in params by a v1 row.
  function autologinSecret(job, params) {
    let cred = params.credential_id ? db.prepare('SELECT * FROM credentials WHERE id = ?').get(params.credential_id) : null;
    if (!cred && !params.password) cred = db.prepare("SELECT * FROM credentials WHERE host_id = ? AND purpose = 'autologin'").get(job.host_id);
    if (!cred) return { password: params.password || '', username: params.username };
    return { password: ctx.crypto.openJson(cred.sealed).password || '', username: params.username || cred.username, domain: params.domain || cred.domain };
  }

  // A typed v1 job (no script) with the script, env and timeout of its translation; other jobs unchanged.
  // The result lives in memory for this send only and is never written back to the row.
  function runnable(job, host) {
    if (job.script || !legacy.supports(job.type)) return job;
    const params = parseJson(job.params, {});
    const t = legacy.translate(job.type, params, host?.os);
    if (job.type === 'autologin') {
      const s = autologinSecret(job, params);
      if (s.username) t.env.LABCTL_P_USERNAME = String(s.username);
      if (s.domain) t.env.LABCTL_P_DOMAIN = String(s.domain);
      t.env.LABCTL_SECRET_PASSWORD = String(s.password || '');
    }
    return { ...job, shell: t.shell, script: t.script, timeout_s: t.timeout_s, params: JSON.stringify({ env: t.env }) };
  }

  // Message for the agent: run_job for script jobs and translated typed jobs, the v1 'job' frame for unknown types.
  function agentMessage(job, host) {
    const run = runnable(job, host);
    if (run.script) {
      return { type: 'run_job', job_id: run.id, shell: run.shell || 'bash', script: run.script,
        env: parseJson(run.params, {}).env || {}, timeout_s: run.timeout_s || 3600 };
    }
    return { type: 'job', job: { id: job.id, host_id: job.host_id, type: job.type, params: job.params, status: job.status, created_at: job.created_at } };
  }

  function dispatch(job) {
    if (!job || job.status !== 'pending') return job;
    const host = db.prepare('SELECT * FROM hosts WHERE id = ?').get(job.host_id);
    const custom = host && dispatchers.get(host.kind);
    const sent = custom ? custom(runnable(job, host), host) : ctx.agents.send(job.host_id, agentMessage(job, host));
    if (sent) return setStatus(job.id, 'sent', { sent_at: now(), error: '' });
    return job.error === OFFLINE ? job : setStatus(job.id, 'pending', { error: OFFLINE });
  }

  const self = {
    OPEN_STATES,
    lastLine,
    get,
    registerDispatcher(kind, fn) { dispatchers.set(kind, fn); },
    create({ host_id, type, params = {}, status = 'pending', script = null, shell = null, timeout_s = null,
      script_id = null, schedule_id = null, actor = null, group_id = null, dispatchNow = true }) {
      const job = { id: randomUUID(), host_id, type, params: typeof params === 'string' ? params : JSON.stringify(params),
        status, error: '', shell, script, timeout_s, script_id, schedule_id, actor, group_id, created_at: now() };
      db.prepare(`INSERT INTO jobs (id, host_id, type, params, status, error, shell, script, timeout_s, script_id, schedule_id, actor, group_id, created_at)
        VALUES (@id, @host_id, @type, @params, @status, @error, @shell, @script, @timeout_s, @script_id, @schedule_id, @actor, @group_id, @created_at)`).run(job);
      ctx.events.emit('job', get(job.id));
      return dispatchNow ? dispatch(get(job.id)) : get(job.id);
    },
    dispatch,
    dispatchPending(hostId) {
      db.prepare("SELECT * FROM jobs WHERE host_id = ? AND status = 'pending' ORDER BY created_at").all(hostId).forEach(dispatch);
    },
    list({ host_id, status, type, actor, group_id, from, to, limit = 200, offset = 0 } = {}) {
      const where = [];
      const args = [];
      if (host_id) { where.push('host_id = ?'); args.push(host_id); }
      if (status) { where.push('status = ?'); args.push(status); }
      if (type) { where.push('type = ?'); args.push(type); }
      if (actor) { where.push('actor = ?'); args.push(actor); }
      if (group_id) { where.push('group_id = ?'); args.push(group_id); }
      if (from) { where.push('created_at >= ?'); args.push(from); }
      if (to) { where.push('created_at <= ?'); args.push(to); }
      const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      return db.prepare(sql).all(...args, Math.max(1, Math.min(5000, Number(limit) || 200)), Math.max(0, Number(offset) || 0));
    },
    // API shape (v1 compatible): adds hostname and result (from the log file).
    // log:false skips the log text (the drawer streams it instead) but keeps a stored result_text. started_by and ended_at name actor and completed_at.
    out(job, { full = false, log = true } = {}) {
      if (!job) return null;
      const host = job.host_id && db.prepare('SELECT hostname FROM hosts WHERE id = ?').get(job.host_id);
      return { ...job, hostname: host?.hostname || job.host_id, started_by: job.actor, ended_at: job.completed_at,
        result: job.result_text ?? (!log ? '' : full ? ctx.joblog.read(job.id) : ctx.joblog.tail(job.id, 4096)) };
    },
    markRunning(id) { return setStatus(id, 'running', { started_at: now() }); },
    output(id, chunk, stream = 'stdout', seq = null) {
      const ts = Date.now();
      ctx.joblog.append(id, chunk, { stream, ts });
      db.prepare('UPDATE jobs SET bytes_received = bytes_received + ? WHERE id = ?').run(Buffer.byteLength(String(chunk ?? '')), id);
      ctx.events.emit('job_output', { job_id: id, seq, stream, ts, chunk: String(chunk ?? '') });
    },
    cancel(id) {
      const job = get(id);
      if (!job) return null;
      if (['pending', 'sent', 'waiting', 'running'].includes(job.status)) {
        if (job.status !== 'pending') ctx.agents.send(job.host_id, { type: 'cancel_job', job_id: id });
        return setStatus(id, 'cancelled', { completed_at: now() });
      }
      return job;
    },
    // status: completed | failed | cancelled (agent 'success' maps to completed for v1 compatibility).
    complete(id, status, { exit_code = null, duration_ms = null, error = '' } = {}) {
      const job = get(id);
      if (!job) return null;
      const final = status === 'success' ? 'completed' : (['completed', 'failed', 'cancelled'].includes(status) ? status : 'failed');
      ctx.joblog.finish(id);
      const result_text = legacy.resultText(job.type, legacy.RESULT_TYPES.includes(job.type) ? ctx.joblog.read(id) : '');
      const done = setStatus(id, final, { completed_at: now(), exit_code, duration_ms, error: String(error || '').slice(0, 2000), result_text });
      if (final === 'completed') self.runChains(done);
      return done;
    },
    createGroup({ label = '', type = '', actor = null, retry_of = null } = {}) {
      const g = { id: 'grp-' + randomUUID(), label, type, actor, retry_of, created_at: now() };
      db.prepare('INSERT INTO job_groups (id, label, type, actor, retry_of, created_at) VALUES (@id, @label, @type, @actor, @retry_of, @created_at)').run(g);
      return g;
    },
    getGroup: id => db.prepare('SELECT * FROM job_groups WHERE id = ?').get(id),
    // Summary with a row per host: status, timing, bytes and the last output line.
    groupSummary(id) {
      const g = db.prepare('SELECT * FROM job_groups WHERE id = ?').get(id);
      if (!g) return null;
      const rows = db.prepare('SELECT * FROM jobs WHERE group_id = ? ORDER BY created_at, id').all(id);
      const counts = {};
      const hosts = rows.map(j => {
        counts[j.status] = (counts[j.status] || 0) + 1;
        const h = db.prepare('SELECT hostname FROM hosts WHERE id = ?').get(j.host_id);
        return { job_id: j.id, host_id: j.host_id, hostname: h?.hostname || j.host_id, status: j.status, exit_code: j.exit_code,
          duration_ms: j.duration_ms, started_at: j.started_at, completed_at: j.completed_at, bytes_received: j.bytes_received,
          last_line: lastLine(ctx.joblog.tail(j.id, 1024)) };
      });
      const done = rows.filter(j => !OPEN_STATES.includes(j.status)).length;
      return { ...g, total: rows.length, done, counts, finished: rows.length > 0 && done === rows.length,
        progress: rows.length ? Math.round(100 * done / rows.length) : 0, hosts };
    },
    // New group holding a copy of every failed job of `groupId`, one per host.
    retryFailed(groupId, actor) {
      const g = db.prepare('SELECT * FROM job_groups WHERE id = ?').get(groupId);
      if (!g) return null;
      const failed = db.prepare("SELECT * FROM jobs WHERE group_id = ? AND status = 'failed' ORDER BY created_at").all(groupId);
      if (!failed.length) return { group: null, jobs: [] };
      const ng = self.createGroup({ label: g.label, type: g.type, actor, retry_of: groupId });
      return { group: ng, jobs: failed.map(j => self.copyJob(j, { actor, group_id: ng.id })) };
    },
    // Fresh job with the same host, type, params and script as `j`.
    copyJob(j, { actor, group_id = null }) {
      return self.create({ host_id: j.host_id, type: j.type, params: j.params, shell: j.shell, script: j.script, timeout_s: j.timeout_s,
        script_id: j.script_id, actor, group_id });
    },
    // A job sent to an agent that never acknowledged it (no start, no bytes) fails after job_sent_timeout_s (120 s),
    // so nothing sits in 'sent' silently. A late job_complete still records the real result.
    sweepStale(at = Date.now()) {
      const limit = Number(ctx.settings?.get('job_sent_timeout_s')) || 120;
      const cutoff = new Date(at - limit * 1000).toISOString();
      const stale = db.prepare("SELECT id FROM jobs WHERE status = 'sent' AND bytes_received = 0 AND started_at IS NULL AND sent_at IS NOT NULL AND sent_at <= ?").all(cutoff);
      for (const j of stale) self.complete(j.id, 'failed', { error: `The agent did not respond within ${limit} s. Check that the agent is connected and up to date.` });
      return stale.length;
    },
    // v1 chains: waiting jobs released by their predecessor, and autologin after a chained reboot.
    runChains(job) {
      for (const w of db.prepare("SELECT * FROM jobs WHERE host_id = ? AND status = 'waiting'").all(job.host_id)) {
        if (parseJson(w.params, {})._wait_for === job.id) dispatch(setStatus(w.id, 'pending'));
      }
      const params = parseJson(job.params, {});
      if (job.type === 'reboot' && params._chain_autologin) {
        const cred = db.prepare("SELECT id FROM credentials WHERE host_id = ? AND purpose = 'autologin'").get(job.host_id);
        if (cred) self.create({ host_id: job.host_id, type: 'autologin', params: { credential_id: cred.id }, actor: 'chain', dispatchNow: false }); // sent when the host re-registers after the reboot
      }
    }
  };
  const sweeper = setInterval(() => { try { self.sweepStale(); } catch { /* database closing */ } }, SWEEP_MS);
  sweeper.unref();
  ctx.onClose?.(() => clearInterval(sweeper));
  return self;
}

module.exports = { createJobs, OPEN_STATES, OFFLINE };
