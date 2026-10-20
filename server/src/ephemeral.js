// Ephemeral runner manager. An ephemeral GitHub Actions runner takes one job, GitHub removes it and the process exits.
// To keep capacity this manager registers a fresh runner after each job: it fetches a registration token, runs the
// runner_reregister template (same name, labels and group, --ephemeral, empty _work and _temp) and starts the service.
// State lives in the setting ephemeral_state, keyed "<host id>/<runner name>": failures, backoff, stuck flag, event list.
// Registration tokens go to ctx.github.registrationToken and straight into runTemplate. They are never stored or logged.
const KEY = 'ephemeral_state';
const TICK_MS = 30000;
const GAP_MS = 20000; // at most one replacement per runner in this time
const BACKOFF_BASE_MS = 30000; // doubles after every failure
const BACKOFF_CAP_MS = 900000;
const MAX_FAILURES = 5; // the fifth consecutive failure raises ephemeral_stuck
const MAX_EVENTS = 20;
const DEFAULT_LABELS = new Set(['self-hosted', 'linux', 'macos', 'windows', 'x64', 'arm', 'arm64']);
const LABEL_RE = /^[A-Za-z0-9_.:-]+$/;

// deps: { runTemplate(opts) from routes/runners.js, waitJob(jobId) }
function createEphemeral(ctx, { runTemplate, waitJob }) {
  const { db, settings } = ctx;
  const self = { clock: () => Date.now(), tickMs: TICK_MS }; // clock and tickMs are replaceable in tests
  let timer = null, inflight = null;

  const enabled = () => settings.get('ephemeral_enabled') !== false;
  const keyOf = e => `${e.host_id}/${e.name}`;
  const load = () => settings.get(KEY) || {};
  const iso = ms => new Date(ms).toISOString();
  const ms = s => Date.parse(s || '') || 0;
  const httpError = (status, message) => Object.assign(new Error(message), { status });

  function update(e, fn) {
    const all = load();
    const st = all[keyOf(e)] || { host_id: e.host_id, runner: e.name, failures: 0, events: [] };
    fn(st);
    st.events = st.events.slice(-MAX_EVENTS);
    all[keyOf(e)] = st;
    settings.set(KEY, all);
  }

  function reset(e) {
    if (load()[keyOf(e)]) update(e, st => { st.failures = 0; st.stuck = false; st.next_at = null; st.last_error = null; });
  }

  // Labels as GitHub knew them while the runner was healthy, else the local ones, without GitHub's built-in labels.
  const labelsFor = (e, st) => ((st.labels && st.labels.length ? st.labels : e.local.labels) || [])
    .filter(l => LABEL_RE.test(l) && !DEFAULT_LABELS.has(String(l).toLowerCase()));

  async function launch(e, on) {
    const host = db.prepare('SELECT * FROM hosts WHERE id = ?').get(e.host_id);
    const tpl = host && ctx.templates.catalogue.byId.get(host.os === 'windows' ? 'runner_reregister_win' : 'runner_reregister');
    const sc = ctx.github.parseScope(e.url);
    if (!host || !tpl || !sc) throw new Error('Host, template or GitHub scope not found for this runner');
    const labels = labelsFor(e, load()[keyOf(e)] || {}).join(',');
    const group = sc.kind === 'org' && e.local.pool && String(e.local.pool).toLowerCase() !== 'default' ? e.local.pool : '';
    const params = { NAME: e.name, URL: e.url, RUNNER_DIR: e.path, EPHEMERAL: on, CLEAN_WORK: on, DISABLE_UPDATE: !!e.disable_update,
      ...(labels ? { LABELS: labels } : {}), ...(group ? { RUNNER_GROUP: group } : {}) };
    let tokenValue = await ctx.github.registrationToken(sc);
    try { return runTemplate({ tpl, host, params, actor: 'system', tokenName: 'REG_TOKEN', tokenValue })[0]; } finally { tokenValue = null; }
  }

  function record(e, ok, reason, { job_id, detail } = {}) {
    if (!db.open) return;
    let newlyStuck = false;
    update(e, st => {
      const t = self.clock();
      st.last_at = iso(t);
      if (ok) { st.failures = 0; st.stuck = false; st.last_ok_at = iso(t); st.next_at = null; st.last_error = null; } else {
        st.failures = (st.failures || 0) + 1;
        st.last_error = String(detail || 'failed').slice(0, 200);
        st.next_at = iso(t + Math.min(BACKOFF_BASE_MS * 2 ** (st.failures - 1), BACKOFF_CAP_MS));
        if (st.failures >= MAX_FAILURES && !st.stuck) { st.stuck = true; newlyStuck = true; }
      }
      st.events.push({ at: iso(t), ok, reason, ...(job_id ? { job_id } : {}), ...(ok ? {} : { detail: st.last_error }) });
    });
    ctx.audit('system', ok ? 'runner.ephemeral.replace' : 'runner.ephemeral.fail', e.host_id, { runner: e.name, reason, ...(job_id ? { job_id } : {}), ...(ok ? {} : { detail: String(detail || '').slice(0, 200) }) });
    if (newlyStuck) ctx.audit('system', 'runner.ephemeral.stuck', e.host_id, { runner: e.name, failures: MAX_FAILURES });
    if (ok) { // refresh both views so the replacement is not repeated from stale data
      try { ctx.agents.send(e.host_id, { type: 'collect' }); } catch { /* host went offline */ }
      ctx.github.poll().catch(() => {});
    }
  }

  async function settle(e, job, reason) {
    const done = await waitJob(job.job_id);
    const ok = !!done && done.status === 'completed';
    record(e, ok, reason, { job_id: job.job_id, detail: ok ? undefined : `job ${done ? done.status : 'missing'}` });
  }

  const hostBusy = (fleet, hostId) => fleet.some(x => x.host_id === hostId && (x.local.busy || (x.github && x.github.busy)));

  // One pass. Returns { replaced: [names], skipped: { "<host>/<name>": reason } }.
  async function run() {
    const out = { replaced: [], skipped: {} };
    if (!db.open) return out;
    const fleet = ctx.github.fleet();
    prune(fleet);
    if (!enabled()) { out.disabled = true; return out; }
    if (!ctx.github.configured()) { out.disabled = true; return out; }
    const ghAt = ms((settings.get('github_runners') || {}).updated_at);
    const byHost = new Map();
    for (const e of fleet) if (e.ephemeral.enabled) byHost.set(e.host_id, [...(byHost.get(e.host_id) || []), e]);
    // Hosts run in parallel, one replacement at a time per host (the script's idle gate is machine wide).
    await Promise.all([...byHost.values()].map(async list => {
      for (const e of list) {
        const key = keyOf(e);
        const why = reasonToSkip(e, fleet, ghAt);
        if (why === 'healthy') { reset(e); continue; }
        if (why) { out.skipped[key] = why; continue; }
        try {
          const job = await launch(e, true);
          await settle(e, job, e.local.service_ok ? 'runner removed from GitHub' : 'service stopped');
          out.replaced.push(e.name);
        } catch (err) { record(e, false, 'replacement', { detail: err.message }); }
        break;
      }
    }));
    return out;
  }

  function reasonToSkip(e, fleet, ghAt) {
    const st = load()[keyOf(e)] || {};
    const healthy = e.local.service_ok && e.github && e.github.status === 'online';
    if (healthy) return st.failures || st.stuck ? 'healthy' : 'not needed';
    if (st.stuck) return 'stuck';
    if (e.host_status !== 'online' || ctx.agents.isOnline(e.host_id) === false) return 'host offline';
    const lastOk = ms(st.last_ok_at);
    const stopped = !!e.local.service_state && !e.local.service_ok && ms(e.local.inventory_at) > lastOk;
    const gone = e.flags.missing_in_github && ghAt > lastOk; // the poll after the last replacement
    if (!stopped && !gone) return 'not needed';
    if (hostBusy(fleet, e.host_id)) return 'busy';
    if (ctx.maintenance && ctx.maintenance.isInMaintenance && ctx.maintenance.isInMaintenance(e.host_id)) return 'maintenance window';
    const now = self.clock();
    if (now - ms(st.last_at) < GAP_MS) return 'rate limited';
    if (now < ms(st.next_at)) return 'backoff';
    return null;
  }

  // Drops state of runners that left a host which still reports its runner list.
  function prune(fleet) {
    const all = load();
    const hosts = new Set(fleet.map(x => x.host_id));
    const keys = new Set(fleet.map(keyOf));
    let changed = false;
    for (const [k, v] of Object.entries(all)) if (hosts.has(v.host_id) && !keys.has(k)) { delete all[k]; changed = true; }
    if (changed) settings.set(KEY, all);
  }

  // Remembers the custom labels while the runner is healthy, because GitHub forgets them once an ephemeral runner is gone.
  function rememberLabels(fleet) {
    for (const e of fleet) {
      if (!e.ephemeral.enabled || !e.github || e.github.status !== 'online') continue;
      const labels = labelsFor({ local: { labels: e.github.labels } }, {});
      const st = load()[keyOf(e)] || {};
      if (labels.join() !== (st.labels || []).join()) update(e, s => { s.labels = labels; });
    }
  }

  function tick() {
    if (!inflight) {
      inflight = (async () => { if (db.open && enabled() && ctx.github.configured()) rememberLabels(ctx.github.fleet()); return run(); })()
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  // Operator action: register the runner now with its current flag (on or off), clearing a stuck state.
  // Resolves when the job has started. The outcome is recorded when the job ends.
  async function apply(hostId, name) {
    const fleet = ctx.github.fleet();
    const e = fleet.find(x => x.host_id === hostId && x.name === name);
    if (!e) throw httpError(404, 'Runner not found on this host');
    if (!ctx.github.configured()) throw httpError(400, 'GitHub token is not configured (Settings > GitHub)');
    if (e.host_status !== 'online') throw httpError(409, 'The host is offline');
    if (hostBusy(fleet, hostId)) throw httpError(409, 'A job is running on this host. Re-register the runner when it is idle');
    reset(e);
    let job;
    try { job = await launch(e, e.ephemeral.enabled); } catch (err) { throw httpError(err.status || 502, err.message); }
    settle(e, job, e.ephemeral.enabled ? 'switched to ephemeral' : 'switched to persistent').catch(() => {});
    return job;
  }

  function start() {
    if (timer) return;
    const loop = async () => {
      if (!db.open) return;
      try { await tick(); } catch (err) { ctx.logger.warn('[ephemeral] pass failed:', err.message); }
      if (db.open) timer = setTimeout(loop, self.tickMs).unref();
    };
    timer = setTimeout(loop, self.tickMs).unref();
  }
  function stop() { clearTimeout(timer); timer = null; }

  return Object.assign(self, { tick, apply, reset, start, stop, enabled });
}

module.exports = { createEphemeral, KEY, GAP_MS, BACKOFF_BASE_MS, MAX_FAILURES };
