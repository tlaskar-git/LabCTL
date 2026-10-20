// Built-in recurring schedules the operator switches on with one click. State lives in builtin_schedules (one row per
// key, so enabling twice never duplicates). All of them skip hosts in a maintenance window ("skipped: maintenance").
//   patch_weekly   three ring policies (created disabled, then enabled), ring 0 on the set day, rings 1 and 2 the next days
//   cleanup_weekly docker_cleanup + runner_cleanup (runner_cleanup_win on Windows) on runner hosts
//   mac_monthly    xcode_cleanup + mac_disk_cleanup on macOS hosts
//   health_report  daily report through the alerting channels (src/health-report.js)
//   cert_expiry    vps_cert_expiry for the cert_domains setting on VPS hosts
const { ensureColumn, parseJson } = require('./db');
const { GRACE_MS } = require('./scheduler');
const healthReport = require('./health-report');

const now = () => new Date().toISOString();
const RING_NAMES = ['Test', 'General', 'Critical'];

const CATALOGUE = [
  { key: 'patch_weekly', name: 'Weekly patching by ring', cron: '0 2 * * 2', guarded: true,
    description: 'Ring 0 (test) on the set day, Ring 1 (general) the next day, Ring 2 (critical) the day after. A failed ring stops the next. Hosts take their ring from the tags ring0, ring1 and ring2.' },
  { key: 'cleanup_weekly', name: 'Weekly Docker and runner cleanup', cron: '0 3 * * 0', templates: ['docker_cleanup', 'runner_cleanup', 'runner_cleanup_win'],
    description: 'Cleans Docker and runner work folders on hosts that have a runner (tag runner, kind runner, or a runner in the inventory). Drains running builds first.' },
  { key: 'mac_monthly', name: 'Monthly Mac and Xcode cleanup', cron: '0 4 1 * *', templates: ['xcode_cleanup', 'mac_disk_cleanup'],
    description: 'Runs Xcode and disk cleanup on every macOS host. Drains running builds first.' },
  { key: 'health_report', name: 'Daily health report email', cron: '0 7 * * *',
    description: 'Sends fleet, compliance and active alert counts through the health_report_channels setting, or the default alert channels.' },
  { key: 'cert_expiry', name: 'Certificate expiry check', cron: '0 6 * * 1', templates: ['vps_cert_expiry'],
    description: 'Checks the domains in the cert_domains setting from VPS hosts (kind vps or tag certs). Results feed the certificate alert rule.' }
];
const byKey = new Map(CATALOGUE.map(c => [c.key, c]));

// Ring n runs n days after ring 0 when the cron has a single weekday.
function ringCron(cron, n) {
  const f = cron.trim().split(/\s+/);
  if (f.length === 5 && /^[0-6]$/.test(f[4])) f[4] = String((Number(f[4]) + n) % 7);
  return f.join(' ');
}

// Wraps ctx.jobs.create once: a job the scheduler creates for a host in a maintenance window is stored as skipped.
function installMaintenanceGuard(ctx) {
  const jobs = ctx.jobs;
  if (jobs.create.maintenanceGuard) return;
  const create = jobs.create;
  jobs.create = function guarded(opts) {
    if (opts && opts.actor === 'scheduler' && opts.status !== 'missed' && opts.host_id && ctx.maintenance?.isInMaintenance?.(opts.host_id)) {
      const job = create({ ...opts, status: 'skipped', dispatchNow: false });
      ctx.db.prepare('UPDATE jobs SET error = ?, completed_at = ? WHERE id = ?').run('skipped: maintenance', now(), job.id);
      ctx.audit('scheduler', 'schedule.skipped_maintenance', opts.host_id, { job_id: job.id, type: opts.type });
      return ctx.jobs.get(job.id);
    }
    return create(opts);
  };
  jobs.create.maintenanceGuard = true;
}

function createBuiltins(ctx) {
  const { db } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS builtin_schedules (
    key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, cron TEXT NOT NULL, last_run TEXT, next_run TEXT,
    last_status TEXT, last_detail TEXT, last_missed TEXT, missed_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT)`);
  ensureColumn(db, 'builtin_schedules', 'last_detail', 'TEXT');
  let timer = null;

  const row = key => db.prepare('SELECT * FROM builtin_schedules WHERE key = ?').get(key);
  const hostsView = () => db.prepare('SELECT * FROM hosts').all().map(h => {
    const tags = db.prepare('SELECT t.name FROM tags t JOIN host_tags ht ON ht.tag_id = t.id WHERE ht.host_id = ?').all(h.id).map(t => t.name.toLowerCase());
    const inv = parseJson(h.inventory, null);
    return { ...h, tags, hasRunner: h.kind === 'runner' || tags.includes('runner') || (Array.isArray(inv?.runners) && inv.runners.length > 0) };
  });

  const policiesOf = () => (ctx.patching ? ctx.patching.list().filter(p => /^patch_ring_\d$/.test(p.builtin || '')).sort((a, b) => a.builtin.localeCompare(b.builtin)) : []);

  const self = {
    CATALOGUE,
    view(def) {
      const r = row(def.key);
      const out = { key: def.key, name: def.name, description: def.description, templates: def.templates || [], default_cron: def.cron, guarded: !!def.guarded,
        enabled: !!r?.enabled, cron: r?.cron || def.cron, last_run: r?.last_run || null, next_run: r?.next_run || null,
        last_status: r?.last_status || null, last_detail: r?.last_detail || null, missed_count: r?.missed_count || 0 };
      if (def.key === 'patch_weekly') {
        const ps = policiesOf();
        out.policies = ps.map(p => ({ id: p.id, name: p.name, enabled: p.enabled, cron: p.cron, next_run: p.next_run, last_run: p.last_run }));
        out.enabled = ps.length === 3 && ps.every(p => p.enabled);
        out.next_run = ps[0]?.enabled ? ps[0].next_run : null;
        out.last_run = ps[0]?.last_run || null;
      }
      if (def.key === 'cert_expiry') out.domains = ctx.settings.get('cert_domains') || '';
      return out;
    },
    list: () => CATALOGUE.map(self.view),

    // Creates the three ring policies once (disabled), keyed by their builtin marker.
    ensurePolicies(cron) {
      const out = [];
      let prev = null;
      for (let n = 0; n < 3; n++) {
        const marker = `patch_ring_${n}`;
        let p = policiesOf().find(x => x.builtin === marker);
        if (!p) {
          const v = ctx.patching.normalise({ name: `Ring ${n} ${RING_NAMES[n].toLowerCase()} patching (built in)`, enabled: false, cron: ringCron(cron, n),
            rings: [n], update_type: 'security', reboot: { mode: 'if_required', delay_min: 1 }, depends_on: prev });
          if (v.error) throw new Error(v.error);
          p = ctx.patching.get(ctx.patching.save({ ...v.value, builtin: marker }));
        }
        out.push(p);
        prev = p.id;
      }
      return out;
    },

    enable(key, { cron } = {}) {
      const def = byKey.get(key);
      if (!def) return { status: 404, error: 'Unknown built-in schedule' };
      const expr = String(cron || row(key)?.cron || def.cron).trim();
      const bad = ctx.scheduler.validate(expr);
      if (bad) return { status: 400, error: `Invalid cron: ${bad}` };
      if (key === 'patch_weekly') {
        if (!ctx.patching) return { status: 503, error: 'Patch policies are not available' };
        const ps = self.ensurePolicies(expr);
        ps.forEach((p, n) => ctx.patching.patch(p.id, { enabled: true, cron: ringCron(expr, n) }));
      }
      const next = def.key === 'patch_weekly' ? null : ctx.scheduler.nextRun(expr);
      db.prepare(`INSERT INTO builtin_schedules (key, enabled, cron, next_run, updated_at) VALUES (?, 1, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET enabled = 1, cron = excluded.cron, next_run = excluded.next_run, updated_at = excluded.updated_at`).run(key, expr, next, now());
      return { view: self.view(def) };
    },

    disable(key) {
      const def = byKey.get(key);
      if (!def) return { status: 404, error: 'Unknown built-in schedule' };
      if (key === 'patch_weekly') policiesOf().forEach(p => ctx.patching.patch(p.id, { enabled: false }));
      db.prepare('UPDATE builtin_schedules SET enabled = 0, next_run = NULL, updated_at = ? WHERE key = ?').run(now(), key);
      return { view: self.view(def) };
    },

    // Changes the time of an enabled or disabled schedule.
    update(key, { cron }) {
      const def = byKey.get(key);
      if (!def) return { status: 404, error: 'Unknown built-in schedule' };
      const expr = String(cron || '').trim();
      const bad = ctx.scheduler.validate(expr);
      if (bad) return { status: 400, error: `Invalid cron: ${bad}` };
      const r = row(key);
      if (key === 'patch_weekly') policiesOf().forEach((p, n) => ctx.patching.patch(p.id, { cron: ringCron(expr, n) }));
      const next = r?.enabled && key !== 'patch_weekly' ? ctx.scheduler.nextRun(expr) : null;
      db.prepare(`INSERT INTO builtin_schedules (key, enabled, cron, next_run, updated_at) VALUES (?, 0, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET cron = excluded.cron, next_run = excluded.next_run, updated_at = excluded.updated_at`).run(key, expr, next, now());
      return { view: self.view(def) };
    },

    // Runs the templates for the chosen hosts. Hosts in a maintenance window are counted as skipped.
    fire(specs, actor) {
      let jobs = 0; let skipped = 0; let missing = '';
      for (const { template, params, drain, hosts } of specs) {
        const tpl = ctx.templates?.catalogue.byId.get(template);
        if (!tpl) { missing = ctx.templates ? `template ${template} not found` : 'templates module not loaded'; continue; }
        const usable = hosts.filter(h => !h.os || tpl.os.includes(h.os));
        const free = usable.filter(h => !ctx.maintenance?.isInMaintenance?.(h.id));
        skipped += usable.length - free.length;
        if (!free.length) continue;
        jobs += ctx.templates.run({ tpl, hosts: free, params, drain, force: false, secrets: {}, actor }).length;
      }
      return { jobs, skipped, missing };
    },

    async execute(key, actor = 'scheduler') {
      const hosts = hostsView();
      let result;
      if (key === 'health_report') {
        const r = await healthReport.send(ctx);
        return r.ok ? { status: 'ok', detail: `Sent to ${r.sent} channel${r.sent === 1 ? '' : 's'}` } : { status: 'error', detail: r.error };
      }
      if (key === 'cleanup_weekly') {
        const run = hosts.filter(h => h.hasRunner);
        result = self.fire([
          { template: 'docker_cleanup', params: {}, drain: true, hosts: run.filter(h => h.os !== 'windows') },
          { template: 'runner_cleanup', params: {}, drain: true, hosts: run.filter(h => h.os !== 'windows') },
          { template: 'runner_cleanup_win', params: {}, drain: true, hosts: run.filter(h => h.os === 'windows') }], actor);
      } else if (key === 'mac_monthly') {
        const mac = hosts.filter(h => h.os === 'darwin');
        result = self.fire([{ template: 'xcode_cleanup', params: {}, drain: true, hosts: mac }, { template: 'mac_disk_cleanup', params: {}, drain: true, hosts: mac }], actor);
      } else if (key === 'cert_expiry') {
        const domains = ctx.settings.get('cert_domains') || '';
        if (!domains) return { status: 'skipped', detail: 'The cert_domains setting is empty' };
        result = self.fire([{ template: 'vps_cert_expiry', params: { DOMAINS: domains, WARN_DAYS: 21, FAIL_ON_EXPIRY: true },
          hosts: hosts.filter(h => h.kind === 'vps' || h.tags.includes('certs')) }], actor);
      } else return { status: 'error', detail: 'This schedule has no direct run' };
      const detail = `${result.jobs} job${result.jobs === 1 ? '' : 's'} started${result.skipped ? `, ${result.skipped} skipped: maintenance` : ''}${result.missing ? `, ${result.missing}` : ''}`;
      return { status: result.missing && !result.jobs ? 'error' : 'ok', detail };
    },

    async runNow(key, actor) {
      if (!byKey.get(key)) return { status: 404, error: 'Unknown built-in schedule' };
      if (key === 'patch_weekly') return { status: 400, error: 'Run the ring policies from the Patching page' };
      const r = await self.execute(key, actor);
      db.prepare('UPDATE builtin_schedules SET last_run = ?, last_status = ?, last_detail = ? WHERE key = ?').run(now(), r.status, r.detail, key);
      return { result: r, view: self.view(byKey.get(key)) };
    },

    async tick(at = new Date()) {
      const due = db.prepare("SELECT * FROM builtin_schedules WHERE enabled = 1 AND key != 'patch_weekly' AND next_run IS NOT NULL AND next_run <= ?").all(at.toISOString());
      for (const r of due) {
        let next = null;
        try { next = ctx.scheduler.nextRun(r.cron, at); } catch { /* cron became invalid */ }
        if (at.getTime() - Date.parse(r.next_run) > GRACE_MS) {
          db.prepare('UPDATE builtin_schedules SET last_missed = ?, missed_count = missed_count + 1, next_run = ? WHERE key = ?').run(r.next_run, next, r.key);
          ctx.audit('scheduler', 'builtin_schedule.missed', null, { key: r.key, due: r.next_run });
          continue;
        }
        db.prepare('UPDATE builtin_schedules SET next_run = ? WHERE key = ?').run(next, r.key);
        let out;
        try { out = await self.execute(r.key); } catch (err) { out = { status: 'error', detail: err.message }; }
        db.prepare('UPDATE builtin_schedules SET last_run = ?, last_status = ?, last_detail = ? WHERE key = ?').run(now(), out.status, String(out.detail || '').slice(0, 500), r.key);
        ctx.audit('scheduler', 'builtin_schedule.run', null, { key: r.key, status: out.status, detail: out.detail });
      }
    },
    startTimer() {
      if (timer) return;
      timer = setInterval(() => {
        if (!db.open) { clearInterval(timer); timer = null; return; }
        self.tick().catch(err => ctx.logger.error('[builtin-schedules]', err.message));
      }, 60000);
      timer.unref();
    }
  };

  // The certificate template prints "valid until <date>" per domain. The soonest one becomes the cert_expiry_days fact
  // that the alert rule reads (the alerting module owns the alert_facts table).
  ctx.events.on('job', job => {
    if (!job || job.type !== 'template:vps_cert_expiry' || !['completed', 'failed'].includes(job.status)) return;
    try {
      const text = String(ctx.joblog.tail(job.id, 65536) || '');
      const days = [...text.matchAll(/(?:valid until|\()\s*([A-Z][a-z]{2}\s+\d{1,2}\s+[\d:]{8}\s+\d{4}\s+GMT)/g)]
        .map(m => Math.floor((Date.parse(m[1]) - Date.now()) / 86400000)).filter(Number.isFinite);
      if (!days.length) return;
      db.exec('CREATE TABLE IF NOT EXISTS alert_facts (host_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, ts TEXT NOT NULL, job_id TEXT, PRIMARY KEY (host_id, key))');
      db.prepare(`INSERT INTO alert_facts (host_id, key, value, ts, job_id) VALUES (?, 'cert_expiry_days', ?, ?, ?)
        ON CONFLICT(host_id, key) DO UPDATE SET value = excluded.value, ts = excluded.ts, job_id = excluded.job_id`).run(job.host_id, String(Math.min(...days)), now(), job.id);
    } catch { /* a log that cannot be read gives no fact */ }
  });

  return self;
}

module.exports = { createBuiltins, installMaintenanceGuard, CATALOGUE, ringCron };
