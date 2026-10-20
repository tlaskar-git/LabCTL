// Self-hosted runners (A7): the merged runner view and the runner actions.
// Actions run the runner_* templates through ctx.templates.run. Registration and removal tokens come from the GitHub API
// at dispatch, travel in a credential row that lives for one synchronous call, and reach the script as LABCTL_SECRET_*.
// GitHub has no cordon API: Drain first narrows the race with a job being assigned, it does not close it.
const { randomUUID } = require('crypto');
const { parseJson } = require('../db');
const { needsConfirm, confirmWord } = require('../guards');

const ACTIONS = new Set(['runner_update', 'runner_restart', 'runner_health_check', 'runner_cleanup', 'runner_reregister', 'runner_remove', 'runner_add']);
const TOKENS = { runner_reregister: ['REG_TOKEN', 'registration'], runner_add: ['REG_TOKEN', 'registration'], runner_remove: ['REMOVE_TOKEN', 'remove'] };
const VERIFY = new Set(['runner_update', 'runner_reregister', 'runner_restart']);

module.exports = (app, ctx) => {
  const { db, settings } = ctx;
  const gh = () => ctx.github;
  const fail = (status, error, extra = {}) => Object.assign(new Error(error), { status, extra });
  const hostRow = id => db.prepare('SELECT * FROM hosts WHERE id = ?').get(String(id));
  const prefKey = (hostId, name) => `${hostId}/${name}`;

  app.get('/api/runners', (req, res) => res.json({ runners: gh().fleet(), github: gh().status(), queued: gh().queued(), latest: gh().latestRunner() }));

  // Per-runner setting: GitHub's built-in runner auto-update. Sent as DISABLE_UPDATE on re-register and add.
  app.put('/api/runners/prefs', (req, res) => {
    const { host_id, runner, disable_update } = req.body || {};
    if (!hostRow(host_id) || !runner || typeof disable_update !== 'boolean') return res.status(400).json({ error: 'host_id, runner and disable_update (true or false) are required' });
    const prefs = { ...(settings.get('github_runner_prefs') || {}) };
    prefs[prefKey(host_id, runner)] = { disable_update };
    settings.set('github_runner_prefs', prefs);
    res.json({ ok: true });
  });

  // ---- running a template ---------------------------------------------------------------------------------------------
  // tokenValue goes into a sealed credential row that is deleted before this function returns. ctx.templates.run reads
  // it synchronously, so the value never waits in the database and never reaches the jobs table, job log or audit.
  function runTemplate({ tpl, host, params, drain, force, actor, tokenName, tokenValue }) {
    let credId = null;
    try {
      const secrets = {};
      if (tokenName) {
        credId = `tmp-${randomUUID()}`;
        const now = new Date().toISOString();
        db.prepare("INSERT INTO credentials (id, host_id, name, username, purpose, kind, sealed, created_at, updated_at) VALUES (?, ?, 'runner token', NULL, 'runner-token', 'token', ?, ?, ?)")
          .run(credId, host.id, ctx.crypto.sealJson({ token: tokenValue }), now, now);
        secrets[tokenName] = credId;
      }
      return ctx.templates.run({ tpl, hosts: [host], params, secrets, drain: !!drain && tpl.drain, force: !!force && tpl.drain, actor });
    } finally {
      if (credId) db.prepare('DELETE FROM credentials WHERE id = ?').run(credId);
    }
  }

  const templateFor = (base, host) => ctx.templates.catalogue.byId.get(host.os === 'windows' ? `${base}_win` : base);

  app.post('/api/runners/action', async (req, res) => {
    const b = req.body || {};
    const base = String(b.template || '').replace(/_win$/, '');
    try {
      if (!ACTIONS.has(base)) throw fail(400, `template must be one of ${[...ACTIONS].join(', ')}`);
      const host = hostRow(b.host_id);
      if (!host) throw fail(404, 'Host not found');
      const tpl = templateFor(base, host);
      if (!tpl || !tpl.os.includes(host.os)) throw fail(400, `${base} does not support ${host.os || 'this host'}`);
      if (tpl.admin && req.user.role !== 'admin') throw fail(403, 'admin role required');
      const inv = parseJson(host.inventory, {}) || {};
      const runner = base === 'runner_add' ? null : (Array.isArray(inv.runners) ? inv.runners : []).find(r => r.name === b.runner);
      if (base !== 'runner_add' && !runner) throw fail(404, 'Runner not found on this host');
      const word = confirmWord(tpl, [host]);
      if (needsConfirm(tpl, b) && String(b.confirm ?? '') !== word) throw fail(400, 'Typed confirmation required', { confirm_required: true, confirm_word: word });

      const params = {};
      for (const [k, v] of Object.entries(b.params || {})) params[String(k).toUpperCase()] = v;
      if (runner) params.RUNNER_DIR = runner.path; // the action targets this runner only
      const prefs = settings.get('github_runner_prefs') || {};
      if (['runner_reregister', 'runner_add'].includes(base)) {
        const name = String(params.NAME || (runner && runner.name) || '');
        if (params.DISABLE_UPDATE === undefined) params.DISABLE_UPDATE = !!(runner && prefs[prefKey(host.id, name)]?.disable_update);
        else if (name) settings.set('github_runner_prefs', { ...prefs, [prefKey(host.id, name)]: { disable_update: ['1', 'true', true, 1].includes(params.DISABLE_UPDATE) } });
      }

      let tokenName = null, tokenValue = null;
      const scopeText = base === 'runner_add' || base === 'runner_reregister' ? (params.URL || (runner && runner.url)) : (runner && runner.url);
      const sc = gh().parseScope(scopeText);
      if (TOKENS[base]) {
        if (!sc) throw fail(400, 'A repository or organisation URL is required (https://github.com/owner/repo or https://github.com/org)');
        if (!gh().configured()) throw fail(400, 'GitHub token is not configured (Settings > GitHub)');
        [tokenName] = TOKENS[base];
        try { tokenValue = await (TOKENS[base][1] === 'registration' ? gh().registrationToken(sc) : gh().removeToken(sc)); } catch (err) {
          throw fail(502, err.message);
        }
        if (base === 'runner_reregister' && !params.URL) params.URL = runner.url;
      }

      let started;
      try { started = runTemplate({ tpl, host, params, drain: b.drain, force: b.force, actor: req.user.username, tokenName, tokenValue }); } finally { tokenValue = null; }
      const job = started[0];
      const dry = ['1', 'true', true, 1].includes(params.DRY_RUN);
      const stopOnly = base === 'runner_restart' && String(params.ACTION || 'restart') === 'stop';
      const verifying = VERIFY.has(base) && !dry && !stopOnly && !!sc && gh().configured();
      if (verifying) {
        verify({ job_id: job.job_id, base, host, name: String(params.NAME || runner.name), scope: sc.scope, dir: runner.path, actor: req.user.username }).catch(err => ctx.logger.warn('[runners] verify failed:', err.message));
      }
      res.json({ jobs: started, verify: verifying, note: 'Drain first narrows the race with a job being assigned. GitHub has no cordon API, so it cannot close it.' });
    } catch (err) {
      if (!err.status) throw err;
      res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    }
  });

  // ---- verify after update, re-register or restart --------------------------------------------------------------------
  function patchJob(jobId, verifyState) {
    const row = db.prepare('SELECT params FROM jobs WHERE id = ?').get(jobId);
    if (!row) return;
    const params = parseJson(row.params, {}) || {};
    params.verify = { ...(params.verify || {}), ...verifyState, updated_at: new Date().toISOString() };
    db.prepare('UPDATE jobs SET params = ? WHERE id = ?').run(JSON.stringify(params), jobId);
  }

  function waitJob(jobId) {
    return new Promise(resolve => {
      const done = () => ctx.events.off('job', onJob);
      const check = job => (job && !ctx.jobs.OPEN_STATES.includes(job.status));
      const onJob = job => { if (job && job.id === jobId && check(job)) { done(); clearTimeout(t); resolve(job); } };
      const current = ctx.jobs.get(jobId);
      if (check(current)) return resolve(current);
      const t = setTimeout(() => { done(); resolve(ctx.jobs.get(jobId)); }, ((current && current.timeout_s) || 7200) * 1000 + 120000).unref();
      ctx.events.on('job', onJob);
    });
  }

  async function verify(v) {
    const record = state => { patchJob(v.job_id, state); ctx.audit(v.actor, 'runner.verify', v.host.id, { job_id: v.job_id, runner: v.name, ...state }); };
    patchJob(v.job_id, { status: 'waiting', runner: v.name });
    const job = await waitJob(v.job_id);
    if (!job || job.status !== 'completed') return record({ status: 'skipped', detail: `job ${job ? job.status : 'missing'}` });
    patchJob(v.job_id, { status: 'checking' });
    const timeoutMs = Number(settings.get('github_verify_timeout_s') ?? 180) * 1000;
    let online = false, detail = '';
    try {
      if (!ctx.github.runnerOnline) throw new Error('GitHub token is not configured');
      online = await ctx.github.runnerOnline(v.host, v.name, timeoutMs, { scope: v.scope });
    } catch (err) { detail = err.message; }
    if (online) {
      record({ status: 'online' });
      if (v.base === 'runner_update') { // the update is proven: drop the kept folder
        try { runTemplate({ tpl: templateFor('runner_rollback', v.host), host: v.host, params: { ACTION: 'discard', RUNNER_DIR: v.dir }, actor: v.actor }); } catch (err) { ctx.logger.warn('[runners] discard skipped:', err.message); }
      }
      return;
    }
    const state = { status: 'failed', detail: detail || `Runner ${v.name} did not return online within ${timeoutMs / 1000} s` };
    // Only an update leaves something to restore. Re-register and restart record the failure.
    if (v.base === 'runner_update') {
      try {
        const rb = runTemplate({ tpl: templateFor('runner_rollback', v.host), host: v.host, params: { ACTION: 'rollback', RUNNER_DIR: v.dir }, actor: v.actor });
        state.rollback_job_id = rb[0].job_id;
        state.status = 'rolling_back';
      } catch (err) { state.detail += `. Rollback could not start: ${err.message}`; }
    }
    record(state);
  }

  // ---- CI host patch cycle --------------------------------------------------------------------------------------------
  // Body: { confirm (host name), runner (name, default the first runner on the host) }.
  app.post('/api/hosts/:id/ci-patch-cycle', (req, res) => {
    const host = hostRow(req.params.id);
    if (!host) return res.status(404).json({ error: 'Host not found' });
    if (!ctx.runbooks || typeof ctx.runbooks.start !== 'function') return res.status(501).json({ error: 'The runbook engine is not available on this server' });
    const word = host.hostname || host.id;
    if (String(req.body?.confirm ?? '') !== word) return res.status(400).json({ error: 'Typed confirmation required', confirm_required: true, confirm_word: word });
    const rb = db.prepare("SELECT * FROM runbooks WHERE id = 'ci_host_patch_cycle'").get();
    if (!rb) return res.status(404).json({ error: 'Runbook ci_host_patch_cycle is not installed' });
    const runners = (parseJson(host.inventory, {}) || {}).runners || [];
    const runner = req.body?.runner ? runners.find(r => r.name === req.body.runner) : runners[0];
    const sc = runner && gh().parseScope(runner.url);
    if (!runner || !sc) return res.status(400).json({ error: 'This host has no GitHub runner with a known repository or organisation' });
    const r = ctx.runbooks.start(rb, { host_ids: [host.id], params: { RUNNER_NAME: runner.name, RUNNER_SCOPE: sc.scope }, confirm: rb.name }, req.user.username);
    if (!r.run) return res.status(r.status || 400).json({ error: r.error, confirm_required: r.confirm_required });
    res.json({ id: r.run.id, status: r.run.status });
  });
};
