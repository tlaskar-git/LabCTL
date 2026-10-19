// Job lifecycle: create, dispatch to an agent (or a registered dispatcher for other host kinds), output, completion.
// Output goes to job log files only, never to the database.
const { randomUUID } = require('crypto');
const { parseJson } = require('./db');

const OPEN_STATES = ['pending', 'sent', 'running', 'waiting'];

function createJobs(ctx) {
  const { db } = ctx;
  const now = () => new Date().toISOString();
  const dispatchers = new Map(); // host kind -> (job, host) => boolean (true when handed off)

  const get = id => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  const setStatus = (id, status, extra = {}) => {
    const fields = { status, ...extra };
    const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE jobs SET ${sets} WHERE id = @id`).run({ ...fields, id });
    const job = get(id);
    ctx.events.emit('job', job);
    return job;
  };

  // Message for the agent. Script jobs use the v2 run_job frame, typed v1 jobs keep the v1 'job' frame.
  function agentMessage(job) {
    const params = parseJson(job.params, {});
    if (job.script) {
      return { type: 'run_job', job_id: job.id, shell: job.shell || 'bash', script: job.script,
        env: params.env || {}, timeout_s: job.timeout_s || 3600 };
    }
    let sentParams = job.params;
    if (job.type === 'autologin' && params.credential_id) {
      // Secrets are resolved at send time only, so they never sit in the jobs table.
      const cred = db.prepare('SELECT * FROM credentials WHERE id = ?').get(params.credential_id);
      if (cred) sentParams = JSON.stringify({ username: cred.username, password: ctx.crypto.openJson(cred.sealed).password });
    }
    return { type: 'job', job: { id: job.id, host_id: job.host_id, type: job.type, params: sentParams, status: job.status, created_at: job.created_at } };
  }

  function dispatch(job) {
    if (!job || job.status !== 'pending') return job;
    const host = db.prepare('SELECT * FROM hosts WHERE id = ?').get(job.host_id);
    const custom = host && dispatchers.get(host.kind);
    if (custom) return custom(job, host) ? setStatus(job.id, 'sent') : job;
    if (ctx.agents.send(job.host_id, agentMessage(job))) return setStatus(job.id, 'sent');
    return job;
  }

  const self = {
    OPEN_STATES,
    get,
    registerDispatcher(kind, fn) { dispatchers.set(kind, fn); },
    create({ host_id, type, params = {}, status = 'pending', script = null, shell = null, timeout_s = null,
      script_id = null, schedule_id = null, actor = null, dispatchNow = true }) {
      const job = { id: randomUUID(), host_id, type, params: typeof params === 'string' ? params : JSON.stringify(params),
        status, error: '', shell, script, timeout_s, script_id, schedule_id, actor, created_at: now() };
      db.prepare(`INSERT INTO jobs (id, host_id, type, params, status, error, shell, script, timeout_s, script_id, schedule_id, actor, created_at)
        VALUES (@id, @host_id, @type, @params, @status, @error, @shell, @script, @timeout_s, @script_id, @schedule_id, @actor, @created_at)`).run(job);
      ctx.events.emit('job', get(job.id));
      return dispatchNow ? dispatch(get(job.id)) : get(job.id);
    },
    dispatch,
    dispatchPending(hostId) {
      db.prepare("SELECT * FROM jobs WHERE host_id = ? AND status = 'pending' ORDER BY created_at").all(hostId).forEach(dispatch);
    },
    list({ host_id, status, limit = 200, offset = 0 } = {}) {
      const where = [];
      const args = [];
      if (host_id) { where.push('host_id = ?'); args.push(host_id); }
      if (status) { where.push('status = ?'); args.push(status); }
      const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      return db.prepare(sql).all(...args, Math.max(1, Math.min(5000, Number(limit) || 200)), Math.max(0, Number(offset) || 0));
    },
    // API shape (v1 compatible): adds hostname and result (from the log file).
    out(job, { full = false } = {}) {
      if (!job) return null;
      const host = job.host_id && db.prepare('SELECT hostname FROM hosts WHERE id = ?').get(job.host_id);
      return { ...job, hostname: host?.hostname || job.host_id, result: full ? ctx.joblog.read(job.id) : ctx.joblog.tail(job.id, 4096) };
    },
    markRunning(id) { return setStatus(id, 'running', { started_at: now() }); },
    output(id, chunk, stream = 'stdout', seq = null) {
      ctx.joblog.append(id, chunk);
      ctx.events.emit('job_output', { job_id: id, seq, stream, chunk: String(chunk ?? '') });
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
      const done = setStatus(id, final, { completed_at: now(), exit_code, duration_ms, error: String(error || '').slice(0, 2000) });
      if (final === 'completed') self.runChains(done);
      return done;
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
  return self;
}

module.exports = { createJobs, OPEN_STATES };
