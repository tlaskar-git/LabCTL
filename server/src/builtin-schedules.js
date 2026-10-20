// Built-in recurring schedules the operator switches on with one click. State lives in builtin_schedules (one row per
// key, so enabling twice never duplicates). All of them skip hosts in a maintenance window ("skipped: maintenance").
//   patch_weekly   three ring policies (created disabled, then enabled), ring 0 on the set day, rings 1 and 2 the next days
//   cleanup_weekly docker_cleanup + runner_cleanup (runner_cleanup_win on Windows) on runner hosts
//   mac_monthly    xcode_cleanup + mac_disk_cleanup on macOS hosts
//   health_report  daily report through the alerting channels (src/health-report.js)
//   cert_expiry    vps_cert_expiry for the cert_domains setting on VPS hosts
// CATALOGUE is the factory default. The operator can edit, hide and restore these and add custom entries
// (src/builtin-schedule-store.js); every function here works on the effective list. Template entries run each step
// ({template, params}) on the hosts the scope selects; the scope matches a host when any of its parts matches.
const { CronExpressionParser } = require('cron-parser');
const { ensureColumn, parseJson } = require('./db');
const { GRACE_MS } = require('./scheduler');
const healthReport = require('./health-report');
const { createStore } = require('./builtin-schedule-store');

const now = () => new Date().toISOString();
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const RING_NAMES = ['Test', 'General', 'Critical'];
const OSES = ['linux', 'darwin', 'windows'];
const PATCH_DEFAULTS = { update_type: 'security', reboot: { mode: 'if_required', delay_min: 1 }, drain: { enabled: true } };
const ringName = n => `Ring ${n} ${RING_NAMES[n].toLowerCase()} patching (built in)`;

// templates (ids) stays on each entry: other modules read it to find template references.
const CATALOGUE = [
  { key: 'patch_weekly', kind: 'patching', name: 'Weekly patching by ring', cron: '0 2 * * 2', guarded: true,
    description: 'Ring 0 (test) on the set day, Ring 1 (general) the next day, Ring 2 (critical) the day after. A failed ring stops the next. Hosts take their ring from the tags ring0, ring1 and ring2.' },
  { key: 'cleanup_weekly', kind: 'templates', name: 'Weekly Docker and runner cleanup', cron: '0 3 * * 0', templates: ['docker_cleanup', 'runner_cleanup', 'runner_cleanup_win'],
    scope: { runners: true },
    description: 'Cleans Docker and runner work folders on hosts that have a runner (tag runner, kind runner, or a runner in the inventory). Drains running builds first.' },
  { key: 'mac_monthly', kind: 'templates', name: 'Monthly Mac and Xcode cleanup', cron: '0 4 1 * *', templates: ['xcode_cleanup', 'mac_disk_cleanup'],
    scope: { os: ['darwin'] },
    description: 'Runs Xcode and disk cleanup on every macOS host. Drains running builds first.' },
  { key: 'health_report', kind: 'health_report', name: 'Daily health report email', cron: '0 7 * * *', health: { channels: [], sections: healthReport.SECTIONS },
    description: 'Sends fleet, compliance and active alert counts through the health_report_channels setting, or the default alert channels.' },
  { key: 'cert_expiry', kind: 'templates', name: 'Certificate expiry check', cron: '0 6 * * 1', templates: ['vps_cert_expiry'],
    params: { vps_cert_expiry: { WARN_DAYS: 21, FAIL_ON_EXPIRY: true } }, scope: { kinds: ['vps'], tags: ['certs'] },
    description: 'Checks the domains in the cert_domains setting from VPS hosts (kind vps or tag certs). Results feed the certificate alert rule.' }
];
for (const c of CATALOGUE) if (c.templates) c.steps = c.templates.map(template => ({ template, params: c.params?.[template] || {} }));
const byKey = new Map(CATALOGUE.map(c => [c.key, c]));

// The next n run times of a cron expression in a timezone, as ISO strings. Throws on an invalid expression.
function preview(expr, tz, n = 3, from = new Date()) {
  if (typeof expr !== 'string' || expr.trim().split(/\s+/).length !== 5) throw new Error('cron must have 5 fields: minute hour day-of-month month day-of-week');
  const it = CronExpressionParser.parse(expr.trim(), { currentDate: from, tz });
  return Array.from({ length: n }, () => it.next().toISOString());
}

const strs = v => [...new Set([].concat(v ?? []).map(x => String(x).trim()).filter(Boolean))];
// Returns { value } or { error }. An empty scope selects nothing, so it is refused.
function cleanScope(s) {
  if (!isObj(s)) return { error: 'scope must be an object' };
  const out = {};
  if (s.all) out.all = true;
  for (const k of ['hosts', 'groups', 'tags', 'kinds']) { const v = strs(s[k]); if (v.length) out[k] = v; }
  const os = strs(s.os);
  if (os.some(o => !OSES.includes(o))) return { error: `scope.os must be ${OSES.join(', ')}` };
  if (os.length) out.os = os;
  const rings = strs(s.rings).map(Number);
  if (rings.some(n => ![0, 1, 2].includes(n))) return { error: 'scope.rings must be 0, 1 or 2' };
  if (rings.length) out.rings = rings;
  if (s.runners) out.runners = true;
  if (!Object.keys(out).length) return { error: 'Choose the hosts: all hosts, or at least one host, group, tag, OS, kind, ring or runner hosts' };
  return { value: out };
}

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

  const store = createStore(db);
  const tz = () => ctx.settings.get('timezone') || 'Europe/Dublin';
  // A template another agent hid or deleted counts as removed.
  const tplOf = id => { const t = ctx.templates?.catalogue?.byId?.get(id); return t && !t.hidden ? t : null; };
  const row = key => db.prepare('SELECT * FROM builtin_schedules WHERE key = ?').get(key);
  const hostsView = () => db.prepare('SELECT * FROM hosts').all().map(h => {
    const tags = db.prepare('SELECT t.name FROM tags t JOIN host_tags ht ON ht.tag_id = t.id WHERE ht.host_id = ?').all(h.id).map(t => t.name.toLowerCase());
    const groups = db.prepare('SELECT id, name FROM groups WHERE id = ? OR id IN (SELECT group_id FROM host_groups WHERE host_id = ?)').all(h.group_id, h.id)
      .flatMap(g => [g.id, String(g.name).toLowerCase()]);
    const inv = parseJson(h.inventory, null);
    return { ...h, tags, groups, hasRunner: h.kind === 'runner' || tags.includes('runner') || (Array.isArray(inv?.runners) && inv.runners.length > 0) };
  });
  const inScope = (h, sc = {}) => !!(sc.all || (sc.runners && h.hasRunner) || sc.hosts?.includes(h.id) || sc.os?.includes(h.os) || sc.kinds?.includes(h.kind) ||
    sc.groups?.some(g => h.groups.includes(g) || h.groups.includes(g.toLowerCase())) || sc.tags?.some(t => h.tags.includes(t.toLowerCase())) ||
    sc.rings?.some(n => h.tags.includes(`ring${n}`)));

  const policiesOf = () => (ctx.patching ? ctx.patching.list().filter(p => /^patch_ring_\d$/.test(p.builtin || '')).sort((a, b) => a.builtin.localeCompare(b.builtin)) : []);
  const patchSettings = def => {
    const ps = policiesOf();
    if (!ps.length) return { ...PATCH_DEFAULTS, ...def.patch, names: def.patch?.names || [0, 1, 2].map(ringName) };
    return { update_type: ps[0].update_type, reboot: ps[0].reboot, drain: { enabled: !!ps[0].drain?.enabled }, names: ps.map(p => p.name) };
  };

  // The effective definition: the factory entry with its edits, or a custom entry. A hidden entry only on request.
  function get(key, { hidden = false } = {}) {
    const base = byKey.get(key);
    if (base) {
      const o = store.override(key);
      if (o?.action === 'hide' && !hidden) return null;
      return { ...base, ...(o?.action === 'edit' ? o.fields : {}), builtin: true, hidden: o?.action === 'hide', overridden: o?.action === 'edit' };
    }
    const c = store.getCustom(key);
    return c && { ...c, kind: 'templates', custom: true };
  }
  const ask = word => ({ status: 400, error: 'Typed confirmation required', confirm_required: true, confirm_word: word });

  const self = {
    CATALOGUE,
    get,
    view(def) {
      const r = row(def.key);
      const base = byKey.get(def.key);
      const steps = def.steps || [];
      const cron = r?.cron || def.cron;
      const out = { key: def.key, kind: def.kind, name: def.name, description: def.description || '', templates: steps.map(s => s.template), steps, scope: def.scope || null,
        builtin: !!def.builtin, custom: !!def.custom, hidden: !!def.hidden, edited: !!def.overridden || (!!base && cron !== base.cron),
        default_cron: base?.cron || null, timezone: tz(), missing_templates: steps.map(s => s.template).filter(id => !tplOf(id)),
        guarded: !!def.guarded || steps.some(s => tplOf(s.template)?.guard), confirm_word: def.key === 'patch_weekly' ? 'patch_weekly' : def.name,
        enabled: !!r?.enabled, cron, last_run: r?.last_run || null, next_run: r?.next_run || null,
        last_status: r?.last_status || null, last_detail: r?.last_detail || null, missed_count: r?.missed_count || 0 };
      if (def.kind === 'health_report') out.health = def.health;
      if (def.key === 'patch_weekly') {
        const ps = policiesOf();
        out.policies = ps.map(p => ({ id: p.id, name: p.name, enabled: p.enabled, cron: p.cron, next_run: p.next_run, last_run: p.last_run }));
        out.patch = patchSettings(def);
        out.enabled = ps.length === 3 && ps.every(p => p.enabled);
        out.next_run = ps[0]?.enabled ? ps[0].next_run : null;
        out.last_run = ps[0]?.last_run || null;
      }
      if (def.key === 'cert_expiry') out.domains = ctx.settings.get('cert_domains') || '';
      return out;
    },
    // Factory order first, then custom entries by creation time.
    list: () => [...CATALOGUE.map(c => get(c.key)).filter(Boolean), ...store.listCustom().map(c => get(c.key))].map(self.view),
    removed: () => CATALOGUE.filter(c => store.override(c.key)?.action === 'hide').map(c => self.view(get(c.key, { hidden: true }))),
    preview: (cron, n = 3, from = new Date()) => preview(cron, tz(), n, from),

    // Validates the editable fields of an entry of this kind. Returns { value } (only the fields given) or { error }.
    clean(body, kind) {
      const b = isObj(body) ? body : {};
      const out = {};
      if (b.name !== undefined) {
        out.name = String(b.name ?? '').trim();
        if (!out.name || out.name.length > 120) return { error: 'name is required (up to 120 characters)' };
      }
      if (b.description !== undefined) out.description = String(b.description ?? '').trim().slice(0, 500);
      if (b.cron !== undefined) {
        out.cron = String(b.cron ?? '').trim();
        const bad = ctx.scheduler.validate(out.cron);
        if (bad) return { error: `Invalid cron: ${bad}` };
      }
      if (kind === 'templates' && b.steps !== undefined) {
        if (!Array.isArray(b.steps) || !b.steps.length || b.steps.length > 10) return { error: 'Choose 1 to 10 template steps' };
        const { buildEnv } = require('./templates'); // lazy: the templates module loads this one
        out.steps = [];
        for (const s of b.steps) {
          const id = String(s?.template || '');
          const tpl = tplOf(id);
          if (!tpl) return { error: `Template ${id || '(none)'} not found` };
          const params = isObj(s.params) ? s.params : {};
          try { buildEnv(tpl, params); } catch (err) { return { error: `${tpl.name || id}: ${err.message}` }; }
          out.steps.push({ template: id, params });
        }
      }
      if (kind === 'templates' && b.scope !== undefined) {
        const sc = cleanScope(b.scope);
        if (sc.error) return sc;
        out.scope = sc.value;
      }
      if (kind === 'health_report' && b.health !== undefined) {
        const h = isObj(b.health) ? b.health : {};
        const sections = strs(h.sections);
        if (!sections.length || sections.some(x => !healthReport.SECTIONS.includes(x))) return { error: `health.sections must list some of ${healthReport.SECTIONS.join(', ')}` };
        out.health = { channels: strs(h.channels), sections };
      }
      if (kind === 'patching' && b.patch !== undefined) {
        if (!ctx.patching) return { error: 'Patch policies are not available' };
        const p = isObj(b.patch) ? b.patch : {};
        const v = ctx.patching.normalise({ name: 'check', update_type: p.update_type, rings: [0], reboot: p.reboot, drain: p.drain });
        if (v.error) return v;
        const names = p.names === undefined ? null : [].concat(p.names).map(x => String(x ?? '').trim());
        if (names && (names.length !== 3 || names.some(x => !x || x.length > 120))) return { error: 'patch.names must hold three policy names (up to 120 characters)' };
        out.patch = { update_type: v.value.update_type, reboot: v.value.reboot, drain: { enabled: v.value.drain.enabled }, ...(names ? { names } : {}) };
      }
      return { value: out };
    },

    create(body, actor) {
      const v = self.clean(body, 'templates');
      if (v.error) return { status: 400, error: v.error };
      const f = v.value;
      for (const k of ['name', 'cron', 'steps', 'scope']) if (!f[k]) return { status: 400, error: `${k} is required` };
      const key = store.createCustom({ ...f, guarded: f.steps.some(s => tplOf(s.template)?.guard) }, actor);
      ctx.audit(actor, 'builtin_schedule.create', null, { schedule: key, fields: Object.keys(f) });
      return { view: self.view(get(key)) };
    },

    // Built-in: the edits go to the override (the time to the schedule row, the ring settings to the ring policies).
    // Custom: the entry itself changes.
    edit(key, body, actor) {
      const def = get(key);
      if (!def) return { status: 404, error: 'Unknown built-in schedule' };
      const v = self.clean(body, def.kind);
      if (v.error) return { status: 400, error: v.error };
      const f = v.value;
      const fields = Object.keys(f);
      if (!fields.length) return { view: self.view(def) };
      if (f.patch) {
        const saves = [];
        for (const [n, p] of policiesOf().entries()) {
          const pv = ctx.patching.normalise({ update_type: f.patch.update_type, reboot: f.patch.reboot, drain: f.patch.drain, ...(f.patch.names ? { name: f.patch.names[n] } : {}) }, p);
          if (pv.error) return { status: 400, error: pv.error };
          saves.push([pv.value, p.id]);
        }
        saves.forEach(([value, id]) => ctx.patching.save(value, id));
      }
      if (f.cron) self.update(key, { cron: f.cron });
      const { cron, ...rest } = f; // eslint-disable-line no-unused-vars
      if (def.custom) store.updateCustom(key, { ...def, ...f, guarded: (f.steps || def.steps).some(s => tplOf(s.template)?.guard) });
      else if (Object.keys(rest).length) store.setEdit(key, { ...(store.override(key)?.fields || {}), ...rest }, actor);
      ctx.audit(actor, 'builtin_schedule.edit', null, { schedule: key, fields });
      return { view: self.view(get(key)) };
    },

    // Built-in: disabled, its schedule row deleted, then hidden. The weekly patching ring policies are deleted too, which
    // needs the word DELETE typed because they can hold operator edits. Custom: deleted for good, its name typed.
    remove(key, { confirm } = {}, actor) {
      const def = get(key);
      if (!def) return { status: 404, error: 'Unknown built-in schedule' };
      if (def.custom && confirm !== def.name) return ask(def.name);
      const policies = def.key === 'patch_weekly' ? policiesOf() : [];
      if (policies.length && confirm !== 'DELETE') return ask('DELETE');
      self.disable(key);
      policies.reverse().forEach(p => ctx.patching.remove(p.id));
      db.prepare('DELETE FROM builtin_schedules WHERE key = ?').run(key);
      if (def.custom) store.deleteCustom(key); else store.hide(key, actor);
      ctx.audit(actor, def.custom ? 'builtin_schedule.delete' : 'builtin_schedule.hide', null, { schedule: key, ...(policies.length ? { policies_deleted: policies.length } : {}) });
      return { view: { key, removed: true } };
    },

    restore(key, actor) {
      if (!byKey.has(key) || store.override(key)?.action !== 'hide') return { status: 404, error: 'Not a removed built-in schedule' };
      store.clear(key);
      ctx.audit(actor, 'builtin_schedule.restore', null, { schedule: key });
      return { view: self.view(get(key)) };
    },

    // Drops the edits of a built-in: factory fields, time and ring policy settings.
    reset(key, actor) {
      const def = get(key);
      if (!def?.builtin) return { status: 404, error: 'Only a built-in schedule can be reset' };
      store.clear(key);
      if (row(key)) self.update(key, { cron: byKey.get(key).cron });
      if (key === 'patch_weekly') {
        for (const [n, p] of policiesOf().entries()) {
          const pv = ctx.patching.normalise({ ...PATCH_DEFAULTS, name: ringName(n) }, p);
          if (!pv.error) ctx.patching.save(pv.value, p.id);
        }
      }
      ctx.audit(actor, 'builtin_schedule.reset', null, { schedule: key });
      return { view: self.view(get(key)) };
    },

    // Creates the three ring policies once (disabled), keyed by their builtin marker.
    ensurePolicies(cron, settings = PATCH_DEFAULTS) {
      const out = [];
      let prev = null;
      for (let n = 0; n < 3; n++) {
        const marker = `patch_ring_${n}`;
        let p = policiesOf().find(x => x.builtin === marker);
        if (!p) {
          const v = ctx.patching.normalise({ name: settings.names?.[n] || ringName(n), enabled: false, cron: ringCron(cron, n),
            rings: [n], update_type: settings.update_type, reboot: settings.reboot, drain: settings.drain, depends_on: prev });
          if (v.error) throw new Error(v.error);
          p = ctx.patching.get(ctx.patching.save({ ...v.value, builtin: marker }));
        }
        out.push(p);
        prev = p.id;
      }
      return out;
    },

    enable(key, { cron } = {}) {
      const def = get(key);
      if (!def) return { status: 404, error: 'Unknown built-in schedule' };
      const expr = String(cron || row(key)?.cron || def.cron).trim();
      const bad = ctx.scheduler.validate(expr);
      if (bad) return { status: 400, error: `Invalid cron: ${bad}` };
      if (key === 'patch_weekly') {
        if (!ctx.patching) return { status: 503, error: 'Patch policies are not available' };
        const ps = self.ensurePolicies(expr, { ...PATCH_DEFAULTS, ...def.patch });
        ps.forEach((p, n) => ctx.patching.patch(p.id, { enabled: true, cron: ringCron(expr, n) }));
      }
      const next = def.key === 'patch_weekly' ? null : ctx.scheduler.nextRun(expr);
      db.prepare(`INSERT INTO builtin_schedules (key, enabled, cron, next_run, updated_at) VALUES (?, 1, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET enabled = 1, cron = excluded.cron, next_run = excluded.next_run, updated_at = excluded.updated_at`).run(key, expr, next, now());
      return { view: self.view(def) };
    },

    disable(key) {
      const def = get(key);
      if (!def) return { status: 404, error: 'Unknown built-in schedule' };
      if (key === 'patch_weekly') policiesOf().forEach(p => ctx.patching.patch(p.id, { enabled: false }));
      db.prepare('UPDATE builtin_schedules SET enabled = 0, next_run = NULL, updated_at = ? WHERE key = ?').run(now(), key);
      return { view: self.view(def) };
    },

    // Changes the time of an enabled or disabled schedule.
    update(key, { cron }) {
      const def = get(key);
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
        const tpl = tplOf(template);
        if (!tpl) { missing = ctx.templates ? `Template ${template} was removed` : 'templates module not loaded'; continue; }
        const usable = hosts.filter(h => !h.os || tpl.os.includes(h.os));
        const free = usable.filter(h => !ctx.maintenance?.isInMaintenance?.(h.id));
        skipped += usable.length - free.length;
        if (!free.length) continue;
        try { jobs += ctx.templates.run({ tpl, hosts: free, params, drain, force: false, secrets: {}, actor }).length; } catch (err) { missing = err.message; }
      }
      return { jobs, skipped, missing };
    },

    // Health report: sends it. Template entries: each step on the hosts in scope (cert_expiry: DOMAINS from the
    // cert_domains setting when the step leaves it empty). A removed template fails the run before any job starts.
    async execute(key, actor = 'scheduler') {
      const def = get(key);
      if (!def) return { status: 'error', detail: 'This schedule was removed' };
      if (def.kind === 'health_report') {
        const r = await healthReport.send(ctx, new Date(), { channels: def.health?.channels, sections: def.health?.sections });
        return r.ok ? { status: 'ok', detail: `Sent to ${r.sent} channel${r.sent === 1 ? '' : 's'}` } : { status: 'error', detail: r.error };
      }
      if (def.kind !== 'templates') return { status: 'error', detail: 'This schedule has no direct run' };
      if (!ctx.templates) return { status: 'error', detail: 'templates module not loaded' };
      const gone = def.steps.find(s => !tplOf(s.template));
      if (gone) return { status: 'error', detail: `Template ${gone.template} was removed` };
      const hosts = hostsView().filter(h => inScope(h, def.scope));
      const specs = [];
      for (const s of def.steps) {
        const params = { ...s.params };
        if (s.template === 'vps_cert_expiry' && !params.DOMAINS) {
          params.DOMAINS = ctx.settings.get('cert_domains') || '';
          if (!params.DOMAINS) return { status: 'skipped', detail: 'The cert_domains setting is empty' };
        }
        specs.push({ template: s.template, params, drain: !!tplOf(s.template).drain, hosts });
      }
      const result = self.fire(specs, actor);
      const detail = `${result.jobs} job${result.jobs === 1 ? '' : 's'} started${result.skipped ? `, ${result.skipped} skipped: maintenance` : ''}${result.missing ? `, ${result.missing}` : ''}`;
      return { status: result.missing && !result.jobs ? 'error' : 'ok', detail };
    },

    async runNow(key, actor) {
      if (!get(key)) return { status: 404, error: 'Unknown built-in schedule' };
      if (key === 'patch_weekly') return { status: 400, error: 'Run the ring policies from the Patching page' };
      const r = await self.execute(key, actor);
      // A schedule that was never switched on has no row yet: keep the result anyway.
      db.prepare(`INSERT INTO builtin_schedules (key, enabled, cron, last_run, last_status, last_detail, updated_at) VALUES (?, 0, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET last_run = excluded.last_run, last_status = excluded.last_status, last_detail = excluded.last_detail`)
        .run(key, row(key)?.cron || get(key).cron, now(), r.status, r.detail, now());
      return { result: r, view: self.view(get(key)) };
    },

    async tick(at = new Date()) {
      const due = db.prepare("SELECT * FROM builtin_schedules WHERE enabled = 1 AND key != 'patch_weekly' AND next_run IS NOT NULL AND next_run <= ?").all(at.toISOString());
      for (const r of due) {
        let next = null;
        try { next = ctx.scheduler.nextRun(r.cron, at); } catch { /* cron became invalid */ }
        if (at.getTime() - Date.parse(r.next_run) > GRACE_MS) {
          db.prepare('UPDATE builtin_schedules SET last_missed = ?, missed_count = missed_count + 1, next_run = ? WHERE key = ?').run(r.next_run, next, r.key);
          ctx.audit('scheduler', 'builtin_schedule.missed', null, { schedule: r.key, due: r.next_run });
          continue;
        }
        db.prepare('UPDATE builtin_schedules SET next_run = ? WHERE key = ?').run(next, r.key);
        let out;
        try { out = await self.execute(r.key); } catch (err) { out = { status: 'error', detail: err.message }; }
        db.prepare('UPDATE builtin_schedules SET last_run = ?, last_status = ?, last_detail = ? WHERE key = ?').run(now(), out.status, String(out.detail || '').slice(0, 500), r.key);
        ctx.audit('scheduler', 'builtin_schedule.run', null, { schedule: r.key, status: out.status, detail: out.detail });
      }
    },
    startTimer() {
      if (timer) return;
      timer = setInterval(() => {
        if (!db.open) { clearInterval(timer); timer = null; return; }
        self.tick().catch(err => ctx.logger.error('[builtin-schedules]', err.message));
      }, 60000);
      timer.unref();
    },
    stopTimer() { clearInterval(timer); timer = null; }
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

module.exports = { createBuiltins, installMaintenanceGuard, CATALOGUE, ringCron, cleanScope, preview };
