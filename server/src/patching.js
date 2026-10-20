// Patch policies with rings. A policy walks Ring 0, then Ring 1, then Ring 2 (any subset). Hosts inside a ring run in
// parallel up to the patch_concurrency setting. If any host in a ring fails, the next rings do not run
// (stopped_at_ring). Per host: maintenance gate, optional Proxmox snapshot, update templates, optional reboot, and a
// post-update health check (agent back, services, GitHub runner online).
// Work goes through ctx.templates.run (one job per host and step, awaited in order). ctx.runbooks is not used: a policy
// run keeps its own per-host results in patch_runs, which the runbook engine cannot express (health check, ring stop).
// Collaborators are read lazily and with optional chaining: ctx.templates, ctx.maintenance, ctx.github.
const { randomUUID } = require('crypto');
const { ensureColumn, parseJson } = require('./db');
const { GRACE_MS } = require('./scheduler');

const UPDATE_TYPES = ['security', 'all', 'os-only', 'apps-only'];
const REBOOT_MODES = ['never', 'if_required', 'always'];
const REBOOT_TEMPLATE = { linux: 'vps_scheduled_reboot', windows: 'win_reboot', darwin: 'mac_reboot' };
const SERVICE_TEMPLATE = { linux: ['vps_post_reboot_check', 'SERVICES'], windows: ['win_service_health', 'SERVICES'] };
const SNAPSHOT_TEMPLATE = 'pve_snapshot';
const SERVICE_RE = /^[A-Za-z0-9_.@:-]{1,100}$/;
const now = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

const DEFAULTS = {
  rings: [0, 1, 2],
  update_type: 'security',
  reboot: { mode: 'if_required', delay_min: 1 },
  drain: { enabled: true, force: false },
  snapshot: { enabled: false, host_id: null, vmids: 'running' },
  health: { heartbeat_minutes: 10, services: [], runner_online: true },
  maintenance: { mode: 'skip', wait_max_minutes: 120 },
  depends_on: null,
  builtin: null
};

// The templates one host needs for an update type. security maps to the same template as os-only because the
// templates have no security-only switch.
function updateSteps(host, type) {
  if (host.os === 'darwin') {
    const os = { template: 'mac_update', params: {} };
    const apps = { template: 'brew_update', params: {} };
    return type === 'apps-only' ? [apps] : type === 'all' ? [os, apps] : [os];
  }
  if (host.os === 'windows') return type === 'apps-only' ? [] : [{ template: 'win_update', params: { INSTALL: true, INCLUDE_DRIVERS: type === 'all' } }];
  if (host.os === 'linux' || host.kind === 'proxmox') {
    return [{ template: 'vps_apt_upgrade', params: { FULL_UPGRADE: type === 'all' || host.kind === 'proxmox' } }];
  }
  return [];
}

function createPatching(ctx) {
  const { db, jobs, events, agents } = ctx;
  ensureColumn(db, 'patch_policies', 'enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'patch_policies', 'cron', 'TEXT');
  ensureColumn(db, 'patch_policies', 'next_run', 'TEXT');
  ensureColumn(db, 'patch_policies', 'last_run', 'TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS patch_runs (
    id TEXT PRIMARY KEY, policy_id TEXT, policy_name TEXT, status TEXT NOT NULL, trigger TEXT NOT NULL DEFAULT 'manual',
    dry_run INTEGER NOT NULL DEFAULT 0, actor TEXT, stopped_at_ring INTEGER, error TEXT, results TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT);
    CREATE INDEX IF NOT EXISTS patch_runs_policy ON patch_runs(policy_id, created_at)`);
  // A run cannot continue after a restart.
  db.prepare("UPDATE patch_runs SET status = 'failed', error = 'Interrupted by a server restart', ended_at = ? WHERE status = 'running'").run(now());

  const active = new Map(); // policy id -> run id
  const catalogue = () => ctx.templates?.catalogue;
  let timer = null;

  const self = {
    // Timings that tests shorten.
    pollMs: 2000, maintPollMs: 30000, pendingMs: 120000, runnerTimeoutMs: 180000,
    UPDATE_TYPES, REBOOT_MODES, DEFAULTS, updateSteps,

    // ---- policies -------------------------------------------------------------------------------------------------
    view(row) {
      if (!row) return null;
      const config = { ...DEFAULTS, ...parseJson(row.config, {}) };
      const last = db.prepare('SELECT id, status, started_at, dry_run FROM patch_runs WHERE policy_id = ? AND dry_run = 0 ORDER BY created_at DESC LIMIT 1').get(row.id);
      const view = { id: row.id, name: row.name, enabled: !!row.enabled, cron: row.cron || '', next_run: row.next_run || null, last_run: row.last_run || null,
        ...config, last_run_info: last || null, created_at: row.created_at, updated_at: row.updated_at };
      view.guarded = self.guarded(view);
      return view;
    },
    get: id => self.view(db.prepare('SELECT * FROM patch_policies WHERE id = ?').get(id)),
    list: () => db.prepare('SELECT * FROM patch_policies ORDER BY ring, name COLLATE NOCASE').all().map(self.view),

    // A policy that can reboot runs guard templates, so enabling it or running it by hand needs the policy name typed.
    guarded: p => p.reboot?.mode !== 'never',

    // Returns { value } (the stored fields) or { error }.
    normalise(body = {}, cur = null) {
      const b = isObj(body) ? body : {};
      const base = cur || { ...DEFAULTS, name: '', enabled: false, cron: '' };
      const out = {};
      out.name = String(b.name ?? base.name).trim();
      if (!out.name || out.name.length > 120) return { error: 'name is required (up to 120 characters)' };
      out.enabled = b.enabled === undefined ? !!base.enabled : !!b.enabled;
      out.cron = String(b.cron ?? base.cron ?? '').trim();
      if (out.cron) {
        const bad = ctx.scheduler.validate(out.cron);
        if (bad) return { error: `Invalid cron: ${bad}` };
      }
      out.update_type = b.update_type ?? base.update_type;
      if (!UPDATE_TYPES.includes(out.update_type)) return { error: `update_type must be one of ${UPDATE_TYPES.join(', ')}` };

      const rings = b.rings ?? base.rings;
      if (!Array.isArray(rings) || !rings.length) return { error: 'rings must list at least one ring' };
      const seen = new Set();
      out.rings = [];
      for (const r of rings) {
        const n = Number(isObj(r) ? r.ring : r);
        if (![0, 1, 2].includes(n)) return { error: 'ring must be 0, 1 or 2' };
        if (seen.has(n)) return { error: `ring ${n} is listed twice` };
        seen.add(n);
        const sel = isObj(r) && isObj(r.selector) ? r.selector : null;
        const selector = sel ? {
          ...(Array.isArray(sel.host_ids) && sel.host_ids.length ? { host_ids: sel.host_ids.map(String) } : {}),
          ...(sel.group ? { group: String(sel.group) } : {}), ...(sel.tag ? { tag: String(sel.tag) } : {}) } : null;
        out.rings.push(selector && Object.keys(selector).length ? { ring: n, selector } : n);
      }
      out.rings.sort((x, y) => (isObj(x) ? x.ring : x) - (isObj(y) ? y.ring : y));

      const reboot = { ...base.reboot, ...(isObj(b.reboot) ? b.reboot : {}) };
      if (!REBOOT_MODES.includes(reboot.mode)) return { error: `reboot.mode must be one of ${REBOOT_MODES.join(', ')}` };
      reboot.delay_min = Number(reboot.delay_min);
      if (!(Number.isInteger(reboot.delay_min) && reboot.delay_min >= 0 && reboot.delay_min <= 1440)) return { error: 'reboot.delay_min must be 0 to 1440' };
      out.reboot = { mode: reboot.mode, delay_min: reboot.delay_min };

      const drain = { ...base.drain, ...(isObj(b.drain) ? b.drain : {}) };
      if (drain.force) return { error: 'force is not allowed in a patch policy' };
      out.drain = { enabled: !!drain.enabled, force: false };

      const snap = { ...base.snapshot, ...(isObj(b.snapshot) ? b.snapshot : {}) };
      if (snap.host_id !== null && snap.host_id !== undefined && typeof snap.host_id !== 'string') return { error: 'snapshot.host_id must be a host id' };
      if (!/^(running|all|\d+(,\d+)*)$/.test(String(snap.vmids || 'running'))) return { error: 'snapshot.vmids must be running, all or a comma separated list of ids' };
      out.snapshot = { enabled: !!snap.enabled, host_id: snap.host_id || null, vmids: String(snap.vmids || 'running') };

      const health = { ...base.health, ...(isObj(b.health) ? b.health : {}) };
      const minutes = Number(health.heartbeat_minutes);
      if (!(Number.isInteger(minutes) && minutes >= 1 && minutes <= 240)) return { error: 'health.heartbeat_minutes must be 1 to 240' };
      if (!Array.isArray(health.services) || health.services.length > 20 || health.services.some(s => typeof s !== 'string' || !SERVICE_RE.test(s))) {
        return { error: 'health.services must be a list of up to 20 service names' };
      }
      out.health = { heartbeat_minutes: minutes, services: health.services, runner_online: !!health.runner_online };

      const m = { ...base.maintenance, ...(isObj(b.maintenance) ? b.maintenance : {}) };
      if (!['skip', 'wait'].includes(m.mode)) return { error: 'maintenance.mode must be skip or wait' };
      const wait = Number(m.wait_max_minutes);
      if (!(Number.isInteger(wait) && wait >= 1 && wait <= 1440)) return { error: 'maintenance.wait_max_minutes must be 1 to 1440' };
      out.maintenance = { mode: m.mode, wait_max_minutes: wait };

      out.depends_on = b.depends_on === undefined ? (base.depends_on || null) : (b.depends_on || null);
      if (out.depends_on && !db.prepare('SELECT 1 FROM patch_policies WHERE id = ?').get(out.depends_on)) return { error: 'depends_on policy not found' };
      out.builtin = base.builtin || null;
      return { value: out };
    },

    save(value, id = null) {
      const { name, enabled, cron, ...config } = value;
      const next = enabled && cron ? ctx.scheduler.nextRun(cron) : null;
      const ring = Math.min(...config.rings.map(r => (isObj(r) ? r.ring : r)));
      const t = now();
      if (id) {
        db.prepare('UPDATE patch_policies SET name = ?, ring = ?, config = ?, enabled = ?, cron = ?, next_run = ?, updated_at = ? WHERE id = ?')
          .run(name, ring, JSON.stringify(config), enabled ? 1 : 0, cron || null, next, t, id);
        return id;
      }
      const nid = randomUUID();
      db.prepare('INSERT INTO patch_policies (id, name, ring, config, enabled, cron, next_run, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(nid, name, ring, JSON.stringify(config), enabled ? 1 : 0, cron || null, next, t, t);
      return nid;
    },

    // The stored fields of a policy view, for save().
    valueOf: v => ({ name: v.name, enabled: v.enabled, cron: v.cron, update_type: v.update_type, rings: v.rings, reboot: v.reboot, drain: v.drain,
      snapshot: v.snapshot, health: v.health, maintenance: v.maintenance, depends_on: v.depends_on, builtin: v.builtin }),
    patch(id, change) { const v = self.get(id); self.save({ ...self.valueOf(v), ...change }, id); return self.get(id); },

    remove: id => db.prepare('DELETE FROM patch_policies WHERE id = ?').run(id).changes > 0,

    // ---- runs -----------------------------------------------------------------------------------------------------
    runOut(r) { return r && { ...r, dry_run: !!r.dry_run, results: parseJson(r.results, []), summary: self.summary(parseJson(r.results, [])) }; },
    getRun: id => self.runOut(db.prepare('SELECT * FROM patch_runs WHERE id = ?').get(id)),
    listRuns({ policy_id, limit = 50 } = {}) {
      const rows = policy_id
        ? db.prepare('SELECT * FROM patch_runs WHERE policy_id = ? ORDER BY created_at DESC LIMIT ?').all(policy_id, limit)
        : db.prepare('SELECT * FROM patch_runs ORDER BY created_at DESC LIMIT ?').all(limit);
      return rows.map(r => self.runOut(r));
    },
    summary(results) {
      const s = { hosts: 0, success: 0, failed: 0, skipped: 0, planned: 0 };
      for (const ring of results) for (const h of ring.hosts) { s.hosts++; if (s[h.status] !== undefined) s[h.status]++; }
      return s;
    },
    saveRun(run) {
      db.prepare('UPDATE patch_runs SET status = ?, stopped_at_ring = ?, error = ?, results = ?, started_at = ?, ended_at = ? WHERE id = ?')
        .run(run.status, run.stopped_at_ring ?? null, run.error || null, JSON.stringify(run.results), run.started_at || null, run.ended_at || null, run.id);
    },
    newRun(policy, { dry_run, trigger, actor, status = 'running', error = null }) {
      const run = { id: randomUUID(), policy_id: policy.id, status, results: [], stopped_at_ring: null, error, started_at: now(), ended_at: null };
      db.prepare('INSERT INTO patch_runs (id, policy_id, policy_name, status, trigger, dry_run, actor, error, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(run.id, policy.id, policy.name, status, trigger, dry_run ? 1 : 0, actor || null, error, now(), run.started_at);
      return run;
    },

    resolveRing(def) {
      const ring = isObj(def) ? def.ring : def;
      const selector = isObj(def) ? def.selector : { tag: `ring${ring}` };
      const t = ctx.templates;
      if (!t?.resolveHosts) throw new Error('The templates module is not loaded');
      const { hosts, unknown } = t.resolveHosts(selector);
      return { ring, selector, hosts, unknown };
    },

    // Starts a run. Returns { run, done } at once: run is the stored row, done resolves when the work ends.
    // Returns { error, status } when the policy is already running.
    start(policy, { dry_run = false, trigger = 'manual', actor = null } = {}) {
      if (active.has(policy.id)) return { error: 'This policy is already running', status: 409 };
      const run = self.newRun(policy, { dry_run, trigger, actor });
      active.set(policy.id, run.id);
      const done = self.execute(run, policy, { dry_run, actor }).catch(err => {
        run.status = 'failed'; run.error = err.message; run.ended_at = now();
        self.saveRun(run);
        ctx.logger.error('[patching]', err.message);
      }).finally(() => active.delete(policy.id));
      return { run: self.getRun(run.id), done };
    },

    async execute(run, policy, { dry_run, actor }) {
      const blocked = self.blockedByDependency(policy);
      if (blocked && !dry_run) {
        run.status = 'skipped'; run.error = blocked; run.ended_at = now();
        return self.saveRun(run);
      }
      const seen = new Set();
      const rows = []; // the host rows of each ring, parallel to run.results
      run.results = policy.rings.map(def => {
        const r = self.resolveRing(def);
        const hosts = r.hosts.filter(h => !seen.has(h.id) && seen.add(h.id));
        rows.push(hosts);
        return { ring: r.ring, selector: r.selector, status: 'pending', unknown: r.unknown,
          hosts: hosts.map(h => ({ host_id: h.id, hostname: h.hostname || h.id, os: h.os, kind: h.kind, status: 'pending', reason: '', steps: [] })) };
      });
      run.persist = () => self.saveRun(run);
      run.actor = actor;
      const plan = run.results;
      self.saveRun(run);

      if (dry_run) {
        plan.forEach((ring, i) => {
          ring.status = 'planned';
          ring.hosts.forEach((rec, j) => self.planHost(policy, rows[i][j], rec));
        });
        run.status = 'dry_run'; run.ended_at = now();
        return self.saveRun(run);
      }

      for (const [i, ring] of plan.entries()) {
        ring.status = 'running'; run.persist();
        await self.runPool(ring.hosts, rows[i], (rec, host) => self.patchHost(run, policy, host, rec));
        const failed = ring.hosts.filter(h => h.status === 'failed').length;
        ring.status = failed ? 'failed' : 'completed';
        run.persist();
        if (failed) {
          run.stopped_at_ring = ring.ring;
          for (const later of plan.slice(plan.indexOf(ring) + 1)) {
            later.status = 'not_run';
            later.hosts.forEach(h => { h.status = 'not_run'; h.reason = `Stopped: ring ${ring.ring} failed`; });
          }
          break;
        }
      }
      run.status = run.stopped_at_ring === null ? 'completed' : 'failed';
      if (run.status === 'failed') run.error = `Ring ${run.stopped_at_ring} failed, later rings did not run`;
      run.ended_at = now();
      db.prepare('UPDATE patch_policies SET last_run = ? WHERE id = ?').run(run.ended_at, policy.id);
      self.saveRun(run);
      ctx.audit(actor || 'system', 'patch_policy.run', null, { policy: policy.name, run_id: run.id, status: run.status, stopped_at_ring: run.stopped_at_ring });
    },

    // A policy that depends on another is skipped when that policy's latest real run in the last 7 days failed.
    blockedByDependency(policy) {
      if (!policy.depends_on) return null;
      const dep = db.prepare("SELECT status FROM patch_runs WHERE policy_id = ? AND dry_run = 0 AND status NOT IN ('skipped', 'missed') AND created_at > ? ORDER BY created_at DESC LIMIT 1")
        .get(policy.depends_on, new Date(Date.now() - 7 * 86400000).toISOString());
      return dep && dep.status === 'failed' ? 'skipped: the previous ring policy failed' : null;
    },

    async runPool(records, hosts, fn) {
      const limit = Math.max(1, Number(ctx.settings.get('patch_concurrency')) || 3);
      let next = 0;
      const worker = async () => {
        while (next < records.length) {
          const i = next++;
          try { await fn(records[i], hosts[i]); } catch (err) { records[i].status = 'failed'; records[i].reason = err.message; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, records.length) }, worker));
    },

    // Dry run: what would happen to this host, without creating a job.
    planHost(policy, host, rec) {
      if (ctx.maintenance?.isInMaintenance?.(host.id)) {
        rec.status = 'skipped'; rec.reason = policy.maintenance.mode === 'wait' ? 'would wait: maintenance' : 'skipped: maintenance';
        return;
      }
      const steps = self.stepsFor(policy, host);
      rec.steps = steps.map(s => ({ name: s.name, template: s.template, status: 'planned' }));
      rec.status = steps.length ? 'planned' : 'skipped';
      if (!steps.length) rec.reason = `No ${policy.update_type} update template for ${host.os}`;
    },

    // The ordered steps for a host, without the reboot (decided after the updates) and the health check.
    stepsFor(policy, host) {
      const steps = [];
      if (policy.snapshot.enabled && (policy.snapshot.host_id || host.kind === 'proxmox')) {
        steps.push({ name: 'Snapshot', template: SNAPSHOT_TEMPLATE, snapshot: true });
      }
      const updates = updateSteps(host, policy.update_type);
      if (updates.length) steps.push(...updates.map(u => ({ name: 'Update', ...u })));
      else return [];
      if (policy.reboot.mode !== 'never') steps.push({ name: 'Reboot', template: REBOOT_TEMPLATE[host.os] || null, reboot: true });
      return steps;
    },

    // ---- per host -------------------------------------------------------------------------------------------------
    hostUp(hostId) {
      if (agents.isOnline?.(hostId)) return true;
      const h = db.prepare('SELECT status, last_seen FROM hosts WHERE id = ?').get(hostId);
      return !!h && h.status === 'online' && !!h.last_seen && Date.now() - Date.parse(h.last_seen) <= 90000;
    },

    async waitBack(hostId, timeoutMs, requireRestart) {
      const end = Date.now() + timeoutMs;
      let sawOffline = !requireRestart;
      while (Date.now() < end) {
        if (!self.hostUp(hostId)) sawOffline = true;
        else if (sawOffline) return true;
        await sleep(self.pollMs);
      }
      return false;
    },

    // Waits for a job to end. A job that stays pending (host did not take it) is cancelled after pendingMs.
    waitJob(id, timeoutMs) {
      return new Promise(resolve => {
        const closed = j => j && !jobs.OPEN_STATES.includes(j.status);
        let t1; let t2;
        const finish = (j, status) => {
          clearTimeout(t1); clearTimeout(t2); events.off('job', on);
          resolve({ job_id: id, status: status || j.status, exit_code: j ? j.exit_code : null });
        };
        const on = j => { if (j && j.id === id && closed(j)) finish(j); };
        events.on('job', on);
        const first = jobs.get(id);
        if (closed(first)) return finish(first);
        t1 = setTimeout(() => { jobs.cancel(id); finish(jobs.get(id), 'timeout'); }, timeoutMs);
        t2 = setTimeout(() => { if (jobs.get(id)?.status === 'pending') { jobs.cancel(id); finish(jobs.get(id), 'not_accepted'); } }, self.pendingMs);
      });
    },

    // One template on one host. Returns { ok, job_id, reboot_required }.
    async runTemplate(rec, host, name, templateId, params, drain, actor) {
      const step = { name, template: templateId, status: 'running', job_id: null };
      rec.steps.push(step);
      const cat = catalogue();
      const tpl = cat?.byId.get(templateId);
      const fail = reason => { step.status = 'failed'; step.reason = reason; return { ok: false, step }; };
      if (!tpl) return fail(`Template ${templateId} is not available`);
      if (!tpl.os.includes(host.os)) return fail(`Template ${templateId} does not support ${host.os}`);
      let started;
      try {
        [started] = ctx.templates.run({ tpl, hosts: [host], params, secrets: {}, drain: !!(drain && tpl.drain), force: false, actor: actor || 'patching' });
      } catch (err) { return fail(err.message); }
      step.job_id = started.job_id;
      const job = jobs.get(started.job_id);
      const res = await self.waitJob(started.job_id, ((job && job.timeout_s) || 3600) * 1000 + 300000);
      step.status = res.status === 'completed' ? 'success' : 'failed';
      if (step.status === 'failed') step.reason = `Job ${res.status}${res.exit_code !== null && res.exit_code !== undefined ? ` (exit ${res.exit_code})` : ''}`;
      const tail = String(ctx.joblog.tail(started.job_id, 65536) || '');
      return { ok: step.status === 'success', step, reboot_required: /LABCTL_RESULT\s+reboot_required=(yes|true|1)\b/i.test(tail) };
    },

    async maintenanceGate(policy, host) {
      const inM = () => !!ctx.maintenance?.isInMaintenance?.(host.id);
      if (!inM()) return true;
      if (policy.maintenance.mode !== 'wait') return false;
      const end = Date.now() + policy.maintenance.wait_max_minutes * 60000;
      while (Date.now() < end) { await sleep(self.maintPollMs); if (!inM()) return true; }
      return false;
    },

    async patchHost(run, policy, host, rec) {
      const persist = () => run.persist();
      const stop = (status, reason) => { rec.status = status; rec.reason = reason; persist(); };
      if (!(await self.maintenanceGate(policy, host))) return stop('skipped', 'skipped: maintenance');
      if (!self.hostUp(host.id)) return stop('skipped', 'skipped: host offline');
      const steps = self.stepsFor(policy, host);
      if (!steps.length) return stop('skipped', `No ${policy.update_type} update template for ${host.os}`);
      rec.status = 'running'; persist();
      const drain = policy.drain.enabled;
      let rebootNeeded = policy.reboot.mode === 'always';
      let rebooted = false;
      for (const s of steps) {
        if (s.snapshot) {
          const r = await self.snapshot(run, policy, host, rec);
          persist();
          if (!r.ok) return stop('failed', `Snapshot failed: ${r.step.reason}`);
          continue;
        }
        if (s.reboot) {
          if (!rebootNeeded || !s.template) continue;
          const r = await self.runTemplate(rec, host, s.name, s.template, { DELAY_MIN: policy.reboot.delay_min }, drain, run.actor);
          persist();
          if (!r.ok) return stop('failed', `Reboot failed: ${r.step.reason}`);
          rebooted = true;
          continue;
        }
        const r = await self.runTemplate(rec, host, s.name, s.template, s.params, drain, run.actor);
        persist();
        if (!r.ok) return stop('failed', `${s.template} failed: ${r.step.reason}`);
        if (policy.reboot.mode === 'if_required' && r.reboot_required) rebootNeeded = true;
      }
      const health = await self.healthCheck(run, policy, host, rec, rebooted);
      persist();
      if (health) return stop('failed', health);
      rec.status = 'success'; persist();
    },

    // One snapshot per Proxmox host and VM list for the whole run.
    snapshot(run, policy, host, rec) {
      const nodeId = policy.snapshot.host_id || host.id;
      const key = `${nodeId}:${policy.snapshot.vmids}`;
      run.snaps = run.snaps || new Map();
      if (!run.snaps.has(key)) {
        const node = db.prepare('SELECT * FROM hosts WHERE id = ?').get(nodeId);
        const scratch = { steps: [] };
        run.snaps.set(key, node
          ? self.runTemplate(scratch, node, 'Snapshot', SNAPSHOT_TEMPLATE, { VMIDS: policy.snapshot.vmids }, false, run.actor)
          : Promise.resolve({ ok: false, step: { reason: 'Proxmox host not found' } }));
      }
      return run.snaps.get(key).then(r => { rec.steps.push({ ...r.step, name: 'Snapshot' }); return r; });
    },

    // Returns '' when healthy, else the reason. Each check is recorded as a step.
    async healthCheck(run, policy, host, rec, rebooted) {
      const h = policy.health;
      const add = (name, status, reason = '') => rec.steps.push({ name, template: null, status, reason });
      const wait = h.heartbeat_minutes * 60000 + (rebooted ? policy.reboot.delay_min * 60000 : 0);
      if (!(await self.waitBack(host.id, wait, rebooted))) {
        add('Health: agent heartbeat', 'failed', `No heartbeat within ${h.heartbeat_minutes} minutes`);
        return `Health check failed: no heartbeat within ${h.heartbeat_minutes} minutes`;
      }
      add('Health: agent heartbeat', 'success');
      if (h.services.length) {
        const [tplId, param] = SERVICE_TEMPLATE[host.os] || [];
        if (!tplId) add('Health: services', 'skipped', `No service check for ${host.os}`);
        else {
          const r = await self.runTemplate(rec, host, 'Health: services', tplId, { [param]: h.services.join(',') }, false, run.actor);
          if (!r.ok) return `Health check failed: services (${r.step.reason})`;
        }
      }
      const inv = parseJson(db.prepare('SELECT inventory FROM hosts WHERE id = ?').get(host.id)?.inventory, null);
      const runners = Array.isArray(inv?.runners) ? inv.runners : [];
      if (h.runner_online && runners.length) {
        if (!ctx.github?.runnerOnline) add('Health: runners online', 'skipped', 'GitHub integration is not configured');
        else {
          for (const r of runners) {
            let online = false; let why = '';
            try { online = await ctx.github.runnerOnline(db.prepare('SELECT * FROM hosts WHERE id = ?').get(host.id), r.name, self.runnerTimeoutMs); } catch (err) { why = err.message; }
            if (why) add(`Health: runner ${r.name}`, 'skipped', why);
            else if (!online) { add(`Health: runner ${r.name}`, 'failed', 'Runner is not online in GitHub'); return `Health check failed: runner ${r.name} is not online`; }
            else add(`Health: runner ${r.name}`, 'success');
          }
        }
      }
      return '';
    },

    // ---- schedule -------------------------------------------------------------------------------------------------
    tick(at = new Date()) {
      const due = db.prepare("SELECT id, cron, next_run FROM patch_policies WHERE enabled = 1 AND cron IS NOT NULL AND cron != '' AND next_run IS NOT NULL AND next_run <= ?").all(at.toISOString());
      const started = [];
      for (const row of due) {
        let next = null;
        try { next = ctx.scheduler.nextRun(row.cron, at); } catch { /* cron became invalid: leave unscheduled */ }
        db.prepare('UPDATE patch_policies SET next_run = ? WHERE id = ?').run(next, row.id);
        const policy = self.get(row.id);
        if (at.getTime() - Date.parse(row.next_run) > GRACE_MS) {
          self.newRun(policy, { trigger: 'schedule', actor: 'scheduler', status: 'missed', error: `Missed run due ${row.next_run}` });
          ctx.audit('scheduler', 'patch_policy.missed', null, { policy: policy.name, due: row.next_run });
          continue;
        }
        const r = self.start(policy, { trigger: 'schedule', actor: 'scheduler' });
        if (r.done) started.push(r.done);
      }
      return Promise.all(started);
    },
    startTimer() {
      if (timer) return;
      timer = setInterval(() => {
        if (!db.open) { clearInterval(timer); timer = null; return; }
        self.tick().catch(err => ctx.logger.error('[patching]', err.message));
      }, 60000);
      timer.unref();
    },
    stopTimer() { clearInterval(timer); timer = null; }
  };
  return self;
}

module.exports = { createPatching, updateSteps, UPDATE_TYPES, REBOOT_MODES };
