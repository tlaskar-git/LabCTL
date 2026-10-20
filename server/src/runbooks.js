// Runbook engine: an ordered list of steps run across hosts, with per-step per-host results and job links.
// Step kinds: template (a job action template, by id or per-OS map), script (inline), wait_agent, github_runner_online,
// sleep, note. `kind: "script"` with a `template` field is a template step (the shape the seed runbook uses).
// Per step: on_failure stop|continue (optional:true means continue), hosts selector, when {key: value} against
// LABCTL_RESULT lines printed by earlier steps, timeout_s, params with {{NAME}} filled from the run params.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { ensureColumn, parseJson } = require('./db');

const KINDS = ['template', 'script', 'wait_agent', 'github_runner_online', 'sleep', 'note'];
const NEEDS_HOSTS = ['template', 'script', 'wait_agent', 'github_runner_online'];
const SHELLS = ['bash', 'powershell', 'python'];
const RESULT_LINE = /^LABCTL_RESULT\s+([A-Za-z0-9_]+)=(.*)$/gm;
// 1/true/yes and 0/false/no/empty compare equal to each other, anything else compares as lower-case text.
const norm = v => { const t = String(v).trim().toLowerCase(); return ['1', 'true', 'yes'].includes(t) ? 'true' : ['0', 'false', 'no', ''].includes(t) ? 'false' : t; };

const now = () => new Date().toISOString();
const sleepMs = ms => new Promise(r => setTimeout(r, ms).unref()); // unref: a pending run never holds the process open
const fill = (value, params) => (typeof value === 'string'
  ? value.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, k) => (params[k.toUpperCase()] ?? ''))
  : value);

function cleanSelector(sel) {
  const out = {};
  if (sel && Array.isArray(sel.host_ids) && sel.host_ids.length) out.host_ids = sel.host_ids.map(String);
  if (sel && sel.group) out.group = String(sel.group);
  if (sel && sel.tag) out.tag = String(sel.tag);
  return out;
}

// Returns { steps } or { error }.
function normaliseSteps(input, catalogue) {
  if (!Array.isArray(input) || !input.length) return { error: 'steps must be a non-empty array' };
  if (input.length > 100) return { error: 'at most 100 steps' };
  const steps = [];
  for (const [i, s] of input.entries()) {
    const at = `step ${i + 1}`;
    if (!s || typeof s !== 'object') return { error: `${at}: must be an object` };
    if (!KINDS.includes(s.kind)) return { error: `${at}: kind must be one of ${KINDS.join(', ')}` };
    const step = { id: String(s.id || `s${i + 1}`).slice(0, 64), name: String(s.name || s.kind).slice(0, 120), kind: s.kind,
      on_failure: s.on_failure === 'continue' || s.optional ? 'continue' : 'stop' };
    const hosts = cleanSelector(s.hosts);
    if (Object.keys(hosts).length) step.hosts = hosts;
    if (s.params && typeof s.params === 'object' && !Array.isArray(s.params)) step.params = s.params;
    if (s.when && typeof s.when === 'object' && !Array.isArray(s.when)) step.when = s.when;
    if (s.timeout_s !== undefined) {
      if (!(Number(s.timeout_s) > 0)) return { error: `${at}: timeout_s must be a positive number` };
      step.timeout_s = Number(s.timeout_s);
    }
    if (s.drain) step.drain = true;
    if (s.optional) step.optional = true;
    if (s.kind === 'template' || (s.kind === 'script' && s.template)) {
      if (!s.template || (typeof s.template !== 'string' && typeof s.template !== 'object')) return { error: `${at}: template is required` };
      const refs = typeof s.template === 'string' ? [s.template] : Object.values(s.template);
      if (catalogue) for (const r of refs) if (!catalogue.byId.has(r)) return { error: `${at}: unknown template ${r}` };
      step.template = s.template;
    } else if (s.kind === 'script') {
      if (typeof s.script !== 'string' || !s.script.trim()) return { error: `${at}: script is required` };
      if (s.shell && !SHELLS.includes(s.shell)) return { error: `${at}: shell must be one of ${SHELLS.join(', ')}` };
      step.script = s.script;
      if (s.shell) step.shell = s.shell;
    } else if (s.kind === 'sleep') {
      const seconds = Number(s.seconds);
      if (!(seconds >= 0 && seconds <= 86400)) return { error: `${at}: seconds must be between 0 and 86400` };
      step.seconds = seconds;
    } else if (s.kind === 'note') {
      step.text = String(s.text || '').slice(0, 2000);
    } else if (s.kind === 'github_runner_online') {
      if (!s.runner) return { error: `${at}: runner is required` };
      step.runner = String(s.runner);
      if (s.scope) step.scope = String(s.scope);
    } else if (s.kind === 'wait_agent') {
      if (s.require_restart === false) step.require_restart = false;
    }
    steps.push(step);
  }
  return { steps };
}

function createRunbooks(ctx) {
  const { db, jobs, events, agents } = ctx;
  ensureColumn(db, 'runbooks', 'params', "TEXT NOT NULL DEFAULT '[]'");
  db.exec(`CREATE TABLE IF NOT EXISTS runbook_runs (
    id TEXT PRIMARY KEY, runbook_id TEXT, name TEXT, status TEXT NOT NULL, actor TEXT, parent_run_id TEXT,
    from_step INTEGER NOT NULL DEFAULT 0, hosts TEXT NOT NULL DEFAULT '{}', params TEXT NOT NULL DEFAULT '{}',
    steps TEXT NOT NULL DEFAULT '[]', results TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT);
    CREATE INDEX IF NOT EXISTS runbook_runs_rb ON runbook_runs(runbook_id, created_at)`);
  // A run cannot continue after a restart, so it ends as failed.
  db.prepare("UPDATE runbook_runs SET status = 'failed', ended_at = ? WHERE status = 'running'").run(now());

  const active = new Map(); // run id -> promise
  const catalogue = () => ctx.templates && ctx.templates.catalogue;

  const runOut = r => r && { ...r, hosts: parseJson(r.hosts, {}), params: parseJson(r.params, {}), steps: parseJson(r.steps, []), results: parseJson(r.results, []) };
  const getRun = id => runOut(db.prepare('SELECT * FROM runbook_runs WHERE id = ?').get(id));
  const save = run => db.prepare('UPDATE runbook_runs SET status = ?, started_at = ?, ended_at = ?, results = ? WHERE id = ?')
    .run(run.status, run.started_at, run.ended_at, JSON.stringify(run.results), run.id);

  const rbOut = r => r && { ...r, steps: parseJson(r.steps, []), params: parseJson(r.params, []) };

  // Template ids a step can run, over every OS.
  const templateIds = step => (typeof step.template === 'string' ? [step.template] : Object.values(step.template || {}));
  const needsGuard = steps => steps.some(s => templateIds(s).some(id => catalogue()?.byId.get(id)?.guard));

  function collectVars(jobId) {
    const vars = {};
    for (const m of ctx.joblog.tail(jobId, 65536).matchAll(RESULT_LINE)) vars[m[1]] = m[2].trim();
    return vars;
  }
  const whenOk = (when, vars) => Object.entries(when).every(([k, v]) => vars[k] !== undefined && norm(vars[k]) === norm(v));

  function waitJobs(ids, timeoutMs, onJob) {
    return new Promise(resolve => {
      const open = () => ids.some(id => jobs.OPEN_STATES.includes(jobs.get(id)?.status));
      let timer;
      const finish = timedOut => { clearTimeout(timer); events.off('job', handler); resolve(timedOut); };
      const handler = j => { if (ids.includes(j.id)) { onJob(j); if (!open()) finish(false); } };
      events.on('job', handler);
      timer = setTimeout(() => finish(true), timeoutMs);
      timer.unref();
      if (!open()) finish(false);
    });
  }

  const hostStatus = j => (j.status === 'completed' ? 'success' : j.status === 'failed' || j.status === 'cancelled' ? 'failed'
    : j.status === 'pending' || j.status === 'waiting' ? 'pending' : 'running');

  // Runs the jobs of a script or template step. Fills r.hosts and returns nothing; r.status is set by the caller.
  async function runJobs(run, step, r, targets, params, vars) {
    const group = jobs.createGroup({ label: `${run.name}: ${step.name}`, type: 'runbook', actor: run.actor });
    r.group_id = group.id;
    const byJob = new Map();
    const hostRes = new Map(r.hosts.map(h => [h.host_id, h]));
    const attach = (host, jobId, error) => {
      const h = hostRes.get(host.id);
      if (error) { h.status = 'failed'; h.error = error; return; }
      h.job_id = jobId; h.group_id = group.id; h.status = 'pending';
      byJob.set(jobId, h);
      db.prepare('UPDATE jobs SET group_id = ? WHERE id = ?').run(group.id, jobId);
    };
    const env = {};
    for (const [k, v] of Object.entries(step.params || {})) env[`LABCTL_P_${k.toUpperCase()}`] = String(fill(v, params));

    if (step.template) {
      if (!ctx.templates) throw new Error('Templates are not available');
      const buckets = new Map();
      for (const host of targets) {
        const id = typeof step.template === 'string' ? step.template : step.template[host.os];
        if (!id) { const h = hostRes.get(host.id); h.status = 'skipped'; h.error = `No template for ${host.os}`; continue; }
        if (!buckets.has(id)) buckets.set(id, []);
        buckets.get(id).push(host);
      }
      for (const [id, hosts] of buckets) {
        const tpl = catalogue().byId.get(id);
        if (!tpl) { hosts.forEach(h => attach(h, null, `Unknown template ${id}`)); continue; }
        const given = {};
        for (const [k, v] of Object.entries(step.params || {})) given[k.toUpperCase()] = fill(v, params);
        try {
          const started = ctx.templates.run({ tpl, hosts, params: given, secrets: {}, drain: !!(step.drain && tpl.drain), force: false, actor: run.actor });
          started.forEach(s => attach(hosts.find(h => h.id === s.host_id), s.job_id));
        } catch (err) { hosts.forEach(h => attach(h, null, err.message)); }
      }
    } else {
      for (const host of targets) {
        const shell = step.shell || (String(host.os).toLowerCase() === 'windows' ? 'powershell' : 'bash');
        const job = jobs.create({ host_id: host.id, type: 'runbook', params: { env, runbook_run: run.id }, shell, script: step.script,
          timeout_s: step.timeout_s || 3600, actor: run.actor, group_id: group.id });
        attach(host, job.id);
      }
    }
    const ids = [...byJob.keys()];
    const sync = j => {
      const h = byJob.get(j.id);
      h.status = hostStatus(j); h.exit_code = j.exit_code;
      if (h.status === 'failed') h.error = j.error || (j.status === 'cancelled' ? 'Cancelled' : `Exit code ${j.exit_code ?? 'unknown'}`);
      save(run);
    };
    ids.forEach(id => sync(jobs.get(id)));
    const timedOut = await waitJobs(ids, (step.timeout_s || 3600) * 1000, sync);
    for (const id of ids) {
      if (timedOut && jobs.OPEN_STATES.includes(jobs.get(id).status)) { jobs.cancel(id); byJob.get(id).error = 'Timed out'; }
      sync(jobs.get(id));
      if (byJob.get(id).status === 'success') vars.set(byJob.get(id).host_id, { ...vars.get(byJob.get(id).host_id), ...collectVars(id) });
    }
  }

  // wait_agent: needs the agent to go away and come back (a reboot) unless require_restart is false.
  async function waitAgent(step, r, targets) {
    const deadline = Date.now() + (step.timeout_s || 600) * 1000;
    await Promise.all(targets.map(async host => {
      const h = r.hosts.find(x => x.host_id === host.id);
      let sawOffline = step.require_restart === false || !agents.isOnline(host.id);
      h.status = 'running';
      // The host event catches a disconnect that is over before the next poll.
      const onHost = row => { if (row && row.id === host.id && !agents.isOnline(host.id)) sawOffline = true; };
      events.on('host', onHost);
      try {
        while (Date.now() < deadline) {
          const online = agents.isOnline(host.id);
          if (!online) sawOffline = true;
          else if (sawOffline) { h.status = 'success'; return; }
          await sleepMs(200);
        }
      } finally { events.off('host', onHost); }
      h.status = 'failed'; h.error = 'Agent did not come back in time';
    }));
  }

  async function runStep(run, step, r, params, vars) {
    if (step.kind === 'note') { r.note = fill(step.text, params); r.status = 'success'; return; }
    if (step.kind === 'sleep') { await sleepMs(step.seconds * 1000); r.status = 'success'; return; }
    if (!ctx.templates) throw new Error('Host lookup is not available');
    const { hosts, unknown } = ctx.templates.resolveHosts(step.hosts || run.hosts);
    if (unknown.length) throw new Error(`Not found: ${unknown.join(', ')}`);
    if (!hosts.length) throw new Error('No hosts matched');
    r.hosts = hosts.map(h => ({ host_id: h.id, hostname: h.hostname || h.id, status: 'pending' }));
    const targets = [];
    for (const h of hosts) {
      if (step.when && !whenOk(step.when, vars.get(h.id) || {})) {
        const x = r.hosts.find(y => y.host_id === h.id); x.status = 'skipped'; x.error = 'Condition not met';
      } else targets.push(h);
    }
    save(run);
    if (!targets.length) { r.status = 'skipped'; return; }

    if (step.kind === 'wait_agent') await waitAgent(step, r, targets);
    else if (step.kind === 'github_runner_online') {
      const gh = ctx.github && ctx.github.runnerOnline;
      if (typeof gh !== 'function') throw new Error('GitHub integration not configured');
      const name = fill(step.runner, params);
      const ms = (step.timeout_s || 300) * 1000;
      await Promise.all(targets.map(async host => {
        const h = r.hosts.find(x => x.host_id === host.id);
        try {
          const ok = await gh(host, name, ms, { scope: fill(step.scope || '', params) });
          h.status = ok ? 'success' : 'failed'; if (!ok) h.error = `Runner ${name} is not online`;
        } catch (err) { h.status = 'failed'; h.error = err.message; }
      }));
    } else await runJobs(run, step, r, targets, params, vars);

    const bad = r.hosts.filter(h => h.status === 'failed');
    if (bad.length) { r.status = 'failed'; r.error = `${bad.length} of ${targets.length} host(s) failed`; }
    else r.status = r.hosts.every(h => h.status === 'skipped') ? 'skipped' : 'success';
  }

  async function execute(runId) {
    const run = getRun(runId);
    const vars = new Map(); // host id -> LABCTL_RESULT values from earlier steps
    for (const r of run.results.slice(0, run.from_step)) for (const h of r.hosts || []) if (h.job_id && h.status === 'success') vars.set(h.host_id, { ...vars.get(h.host_id), ...collectVars(h.job_id) });
    run.status = 'running'; run.started_at = now(); save(run);
    let stopped = false, partial = false;
    for (let i = run.from_step; i < run.steps.length; i++) {
      const step = run.steps[i];
      const r = run.results[i];
      if (stopped) { r.status = 'skipped'; r.error = 'Not run: an earlier step failed'; continue; }
      r.status = 'running'; r.started_at = now(); save(run);
      try { await runStep(run, step, r, run.params, vars); } catch (err) { r.status = 'failed'; r.error = err.message; }
      r.ended_at = now(); save(run);
      ctx.audit(run.actor, 'runbook.step', null, { run_id: run.id, runbook_id: run.runbook_id, step: i, name: step.name, kind: step.kind, status: r.status });
      if (r.status === 'failed') { if (step.on_failure === 'continue') partial = true; else stopped = true; }
    }
    run.status = stopped ? 'failed' : partial ? 'partial' : 'completed';
    run.ended_at = now(); save(run);
    ctx.audit(run.actor, 'runbook.finish', null, { run_id: run.id, runbook_id: run.runbook_id, status: run.status });
  }

  function launch(row) {
    const p = execute(row.id).catch(err => {
      ctx.logger.error('[runbook]', err.message);
      db.prepare("UPDATE runbook_runs SET status = 'failed', ended_at = ? WHERE id = ?").run(now(), row.id);
    }).finally(() => active.delete(row.id));
    active.set(row.id, p);
  }

  function insertRun({ runbook_id, name, actor, parent_run_id = null, from_step = 0, hosts, params, steps, results }) {
    const row = { id: randomUUID(), runbook_id, name, status: 'queued', actor, parent_run_id, from_step, hosts: JSON.stringify(hosts),
      params: JSON.stringify(params), steps: JSON.stringify(steps), results: JSON.stringify(results), created_at: now() };
    db.prepare(`INSERT INTO runbook_runs (id, runbook_id, name, status, actor, parent_run_id, from_step, hosts, params, steps, results, created_at)
      VALUES (@id, @runbook_id, @name, @status, @actor, @parent_run_id, @from_step, @hosts, @params, @steps, @results, @created_at)`).run(row);
    ctx.audit(actor, 'runbook.run', null, { run_id: row.id, runbook_id, from_step, hosts, parent_run_id });
    launch(row);
    return getRun(row.id);
  }

  const skeleton = steps => steps.map((s, index) => ({ index, id: s.id, name: s.name, kind: s.kind, status: 'pending', hosts: [] }));
  const guardError = (rb, steps, confirm) => (needsGuard(steps) && String(confirm ?? '') !== rb.name
    ? { status: 400, error: 'Typed confirmation required', confirm_required: true, confirm_word: rb.name } : null);

  const self = {
    KINDS, normaliseSteps: steps => normaliseSteps(steps, catalogue()), getRun, rbOut,
    whenDone: id => active.get(id) || Promise.resolve(),
    // body: { host_ids, group, tag, params, confirm }. Returns { run } or { status, error }.
    start(rb, body, actor) {
      const steps = parseJson(rb.steps, []);
      const defs = parseJson(rb.params, []);
      const hosts = cleanSelector(body);
      const params = {};
      for (const d of defs) params[String(d.name).toUpperCase()] = d.default ?? '';
      for (const [k, v] of Object.entries(body.params || {})) {
        if (!defs.some(d => String(d.name).toUpperCase() === k.toUpperCase())) return { status: 400, error: `Unknown parameter ${k}` };
        params[k.toUpperCase()] = String(v);
      }
      if (!Object.keys(hosts).length && steps.some(s => NEEDS_HOSTS.includes(s.kind) && !s.hosts)) return { status: 400, error: 'host_ids, group or tag required' };
      const bad = guardError(rb, steps, body.confirm);
      if (bad) return bad;
      return { run: insertRun({ runbook_id: rb.id, name: rb.name, actor, hosts, params, steps, results: skeleton(steps) }) };
    },
    rerun(parent, body, actor) {
      if (parent.status === 'running' || parent.status === 'queued') return { status: 409, error: 'Run is still in progress' };
      const firstBad = parent.results.findIndex(r => r.status === 'failed');
      if (firstBad < 0) return { status: 400, error: 'Run has no failed step' };
      const from = body.from_step === undefined ? firstBad : Number(body.from_step);
      if (!Number.isInteger(from) || from < 0 || from >= parent.steps.length) return { status: 400, error: 'from_step is out of range' };
      if (from > firstBad) return { status: 400, error: `Steps before step ${from + 1} did not all succeed, start at step ${firstBad + 1} or earlier` };
      const rb = rbOut(db.prepare('SELECT * FROM runbooks WHERE id = ?').get(parent.runbook_id)) || { id: parent.runbook_id, name: parent.name };
      const bad = guardError(rb, parent.steps, body.confirm);
      if (bad) return bad;
      const results = skeleton(parent.steps).map((s, i) => (i < from ? { ...parent.results[i], carried: true } : s));
      return { run: insertRun({ runbook_id: parent.runbook_id, name: parent.name, actor, parent_run_id: parent.id, from_step: from,
        hosts: parent.hosts, params: parent.params, steps: parent.steps, results }) };
    },
    // Insert runbook definitions shipped as JSON files (src/templates/runbooks/*.json) when no row has that id yet.
    seed() {
      const dir = path.join(ctx.paths.serverDir, 'src', 'templates', 'runbooks');
      let files = [];
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return; }
      for (const f of files) {
        try {
          const def = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          const n = normaliseSteps(def.steps, null);
          if (!def.id || n.error) continue;
          const t = now();
          db.prepare('INSERT OR IGNORE INTO runbooks (id, name, description, steps, params, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(String(def.id), String(def.name || def.id), String(def.description || ''), JSON.stringify(n.steps), JSON.stringify(def.params || []), t, t);
        } catch (err) { ctx.logger.warn('[runbook] seed skipped', f, err.message); }
      }
    }
  };
  return self;
}

module.exports = { createRunbooks, normaliseSteps, KINDS };
