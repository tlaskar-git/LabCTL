// Alert engine. Every 30 s it evaluates the enabled rules and keeps one alert row per (rule, subject):
//   (no row) -> pending (condition true, waiting for for_minutes) -> firing -> resolved
// Deduplication is the open row itself. One notification when it fires, a repeat every repeat_hours, one recovery notice.
// Acknowledge stops repeats, silence (alert or rule) and maintenance windows stop all notices but the alert is still recorded.
const { randomUUID } = require('crypto');
const { ensureColumn, parseJson } = require('../db');
const { METRICS, OPS, DEFAULT_RULES, SEVERITIES } = require('./rules');
const { createMaintenance, matchesScope, normalizeScope } = require('./maintenance');
const { createNotifier } = require('./notify');
const { latestAgentVersion } = require('../hostops');

const TICK_MS = 30000;
const RESULT_LINE = /^LABCTL_RESULT\s+([A-Za-z0-9_]+)=(.*)$/gm;
const CONFIG_DEFAULTS = {
  repeat_hours: 4, default_channels: [], base_url: '', runner_work_limit_gb: 50, docker_disk_limit_gb: 100,
  telegram_api_base: 'https://api.telegram.org'
};

const fmt = v => String(Math.round(v * 100) / 100);

function createAlerting(ctx) {
  const { db } = ctx;
  for (const [col, decl] of [['rule_name', 'TEXT'], ['subject', 'TEXT'], ['fingerprint', 'TEXT'], ['value', 'REAL'], ['fired_at', 'TEXT'],
    ['last_notified_at', 'TEXT'], ['notify_count', 'INTEGER NOT NULL DEFAULT 0'], ['acked_by', 'TEXT'], ['acked_at', 'TEXT'],
    ['silenced_until', 'TEXT'], ['suppressed', 'INTEGER NOT NULL DEFAULT 0']]) ensureColumn(db, 'alerts', col, decl);
  db.exec(`CREATE INDEX IF NOT EXISTS alerts_fp ON alerts(fingerprint, status);
    CREATE TABLE IF NOT EXISTS alert_facts (host_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, ts TEXT NOT NULL, job_id TEXT, PRIMARY KEY (host_id, key))`);

  const maintenance = createMaintenance(ctx);
  const notifier = createNotifier(ctx);
  const mem = {};            // first-seen maps for the runner metrics
  let running = false;
  let timer = null;

  // ---- config ---------------------------------------------------------------------------------------------------
  const config = () => ({ ...CONFIG_DEFAULTS, ...(ctx.settings.get('alert_config') || {}) });
  function setConfig(patch) {
    const next = { ...config() };
    const num = (k, min, max) => { const n = Number(patch[k]); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${k} must be ${min} to ${max}`); next[k] = n; };
    if ('repeat_hours' in patch) num('repeat_hours', 0, 720);
    if ('runner_work_limit_gb' in patch) num('runner_work_limit_gb', 0.1, 1e6);
    if ('docker_disk_limit_gb' in patch) num('docker_disk_limit_gb', 0.1, 1e6);
    if ('default_channels' in patch) {
      if (!Array.isArray(patch.default_channels)) throw new Error('default_channels must be a list of channel ids');
      next.default_channels = patch.default_channels.map(String);
    }
    for (const k of ['base_url', 'telegram_api_base']) {
      if (!(k in patch)) continue;
      const v = String(patch[k] || '').trim();
      if (v && !/^https?:\/\/[^\s]+$/.test(v)) throw new Error(`${k} must be an http or https URL`);
      next[k] = v || CONFIG_DEFAULTS[k];
    }
    ctx.settings.set('alert_config', next);
    return next;
  }

  // ---- rules ----------------------------------------------------------------------------------------------------
  const ruleView = row => {
    const c = parseJson(row.config, {});
    return { id: row.id, name: row.name, enabled: !!row.enabled, severity: c.severity || 'warning', scope: c.scope || { type: 'all' },
      condition: c.condition, params: c.params || {}, channels: c.channels || [], silenced_until: c.silenced_until || null,
      description: c.description || '', builtin: row.id.startsWith('default-'), created_at: row.created_at, updated_at: row.updated_at };
  };
  const ruleConfig = r => JSON.stringify({ severity: r.severity, scope: r.scope, condition: r.condition, params: r.params,
    channels: r.channels, silenced_until: r.silenced_until || null, description: r.description || '' });
  const listRules = () => db.prepare('SELECT * FROM alert_rules ORDER BY created_at, name').all().map(ruleView);
  const getRule = id => { const r = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id); return r ? ruleView(r) : null; };

  function validateRule(body, base = {}) {
    const b = { ...base, ...body };
    const name = String(b.name || '').trim();
    if (!name) return { error: 'name is required' };
    if (!SEVERITIES.includes(b.severity)) return { error: `severity must be one of ${SEVERITIES.join(', ')}` };
    const sc = normalizeScope(b.scope);
    if (sc.error) return sc;
    const c = b.condition || {};
    if (!METRICS[c.metric]) return { error: `unknown metric ${c.metric}` };
    if (!OPS[c.op]) return { error: `op must be one of ${Object.keys(OPS).join(' ')}` };
    const threshold = Number(c.threshold);
    if (c.threshold === '' || c.threshold === null || c.threshold === undefined || !Number.isFinite(threshold)) return { error: 'condition.threshold must be a number' };
    const forMin = c.for_minutes === undefined ? 0 : Number(c.for_minutes);
    if (!Number.isInteger(forMin) || forMin < 0 || forMin > 10080) return { error: 'condition.for_minutes must be 0 to 10080' };
    if (b.params && (typeof b.params !== 'object' || Array.isArray(b.params))) return { error: 'params must be an object' };
    if (b.channels && !Array.isArray(b.channels)) return { error: 'channels must be a list of channel ids' };
    return { rule: { name, enabled: b.enabled !== false, severity: b.severity, scope: sc.scope,
      condition: { metric: c.metric, op: c.op, threshold, for_minutes: forMin }, params: b.params || {},
      channels: (b.channels || []).map(String), silenced_until: b.silenced_until || null, description: String(b.description || '').slice(0, 500) } };
  }

  function saveRule(rule, id) {
    const now = new Date().toISOString();
    if (id && db.prepare('SELECT 1 FROM alert_rules WHERE id = ?').get(id)) {
      db.prepare('UPDATE alert_rules SET name = ?, kind = ?, enabled = ?, config = ?, updated_at = ? WHERE id = ?')
        .run(rule.name, rule.condition.metric, rule.enabled ? 1 : 0, ruleConfig(rule), now, id);
      if (!rule.enabled) closeSilently(id);
      return id;
    }
    const newId = id || randomUUID();
    db.prepare('INSERT INTO alert_rules (id, name, kind, enabled, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(newId, rule.name, rule.condition.metric, rule.enabled ? 1 : 0, ruleConfig(rule), now, now);
    return newId;
  }

  // Alerts of a rule that was disabled or deleted end without a notice.
  function closeSilently(ruleId) {
    const now = new Date().toISOString();
    db.prepare("DELETE FROM alerts WHERE rule_id = ? AND status = 'pending'").run(ruleId);
    db.prepare("UPDATE alerts SET status = 'resolved', resolved_at = ? WHERE rule_id = ? AND status = 'firing'").run(now, ruleId);
  }

  if (!ctx.settings.get('_alert_pack_v2')) {
    db.transaction(() => { for (const r of DEFAULT_RULES) { const { id, ...rule } = r; if (!db.prepare('SELECT 1 FROM alert_rules WHERE id = ?').get(id)) saveRule(rule, id); } })();
    ctx.settings.set('_alert_pack_v2', true);
  }

  // ---- evaluation -------------------------------------------------------------------------------------------------
  function makeEnv(now) {
    const hosts = db.prepare('SELECT id, hostname, kind, status, agent_version, inventory, heartbeat FROM hosts').all();
    const asObject = v => (typeof v === 'string' ? parseJson(v, {}) : v) || {};
    const runnersSetting = asObject(ctx.settings.get('github_runners'));
    let latest;
    return {
      now, db, mem, cfg: config(), hosts,
      inv: h => (h._inv ||= parseJson(h.inventory, {}) || {}),
      hb: h => (h._hb ||= parseJson(h.heartbeat, {}) || {}),
      fact(hostId, key) {
        const v = db.prepare('SELECT value FROM alert_facts WHERE host_id = ? AND key = ?').get(hostId, key)?.value;
        return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : v ?? null;
      },
      githubRunners: () => (Array.isArray(runnersSetting.runners) ? runnersSetting.runners.filter(r => r && r.name) : []),
      githubQueued: () => asObject(ctx.settings.get('github_queued')),
      githubCheck: () => asObject(ctx.settings.get('github_last_check')),
      latestAgent: () => (latest === undefined ? (latest = latestAgentVersion(db)) : latest)
    };
  }

  const thresholdOf = (rule, env) => {
    const key = rule.params?.threshold_setting;
    const n = key ? Number(env.cfg[key]) : NaN;
    return Number.isFinite(n) ? n : rule.condition.threshold;
  };

  // Evaluates one rule against current data without touching alert state.
  // Returns { results: [{ host_id, hostname, subject, key, value, detail, breached, nodata }], skipHosts, complete }.
  function evaluateRule(rule, env) {
    const m = METRICS[rule.condition.metric];
    const out = { results: [], skipHosts: new Set(), complete: true };
    if (!m) return out;
    const op = OPS[rule.condition.op];
    const thr = thresholdOf(rule, env);
    const hostById = new Map(env.hosts.map(h => [h.id, h]));
    const push = (hostId, item) => {
      const subject = hostId ? (item.key ? `${hostId}:${item.key}` : hostId) : item.key;
      const nodata = item.value === null || item.value === undefined;
      out.results.push({ host_id: hostId || null, hostname: hostById.get(hostId)?.hostname || null, subject, key: item.key || '',
        value: nodata ? null : item.value, detail: item.detail, nodata, breached: !nodata && op(item.value, thr) });
    };
    try {
      if (m.scope === 'host') {
        for (const h of env.hosts) {
          if (!matchesScope(db, rule.scope, h.id)) continue;
          if (m.live && h.status !== 'online') { out.skipHosts.add(h.id); continue; }
          for (const item of m.eval(env, h, rule)) push(h.id, item);
        }
      } else {
        for (const item of m.eval(env, rule)) {
          if (rule.scope.type !== 'all' && !(item.host_id && matchesScope(db, rule.scope, item.host_id))) continue;
          push(item.host_id, item);
        }
      }
    } catch (err) {
      ctx.logger.error(`[alerting] rule ${rule.name}: ${err.message}`);
      out.complete = false;
    }
    return out;
  }

  const describe = (rule, r, env) => {
    const m = METRICS[rule.condition.metric];
    const where = r.hostname ? ` on ${r.hostname}` : '';
    const sub = r.key ? ` (${r.key})` : '';
    const tail = r.detail ? ` - ${r.detail}` : '';
    if (m.flag) return `${m.label}${where}${sub}${tail}`;
    return `${m.label}: ${fmt(r.value)}${m.unit}${where}${sub}, rule ${rule.condition.op} ${fmt(thresholdOf(rule, env))}${m.unit}${tail}`;
  };

  const ruleSilenced = (rule, nowMs) => !!rule.silenced_until && Date.parse(rule.silenced_until) > nowMs;
  const iso = ms => new Date(ms).toISOString();

  function payloadFor(row, rule, hostname, recovery, env) {
    const m = METRICS[rule.condition.metric];
    return { alert_id: row.id, rule: rule.name, rule_id: rule.id, host: hostname, host_id: row.host_id, target: row.subject, severity: row.severity,
      value: row.value, unit: m.unit.trim(), message: row.message, since: row.fired_at, resolved_at: recovery ? iso(env.now) : null,
      link: notifier.link('alerts'), recovery };
  }

  // Applies one rule's results to the alert table. Notifications are queued in `sends`.
  function apply(rule, ev, env, sends) {
    const now = env.now;
    const open = new Map(db.prepare("SELECT * FROM alerts WHERE rule_id = ? AND status IN ('pending','firing')").all(rule.id).map(r => [r.fingerprint, r]));
    const forMs = rule.condition.for_minutes * 60000;
    const repeatMs = Number(env.cfg.repeat_hours) * 3600000;

    for (const r of ev.results) {
      const fp = `${rule.id}|${r.subject}`;
      if (r.nodata) continue;
      if (!r.breached) continue; // closed below
      let row = open.get(fp);
      const message = describe(rule, r, env);
      if (!row) {
        const id = randomUUID();
        const status = forMs > 0 ? 'pending' : 'firing';
        db.prepare(`INSERT INTO alerts (id, rule_id, rule_name, host_id, subject, fingerprint, severity, status, message, value, data, created_at, fired_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, rule.id, rule.name, r.host_id, r.subject, fp, rule.severity, status, message, r.value,
          JSON.stringify({ detail: r.detail || null, key: r.key }), iso(now), status === 'firing' ? iso(now) : null);
        row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
      } else {
        db.prepare('UPDATE alerts SET message = ?, value = ?, severity = ?, rule_name = ? WHERE id = ?').run(message, r.value, rule.severity, rule.name, row.id);
        row = { ...row, message, value: r.value, severity: rule.severity };
      }
      if (row.status === 'pending' && now - Date.parse(row.created_at) >= forMs) {
        db.prepare("UPDATE alerts SET status = 'firing', fired_at = ? WHERE id = ?").run(iso(now), row.id);
        row = { ...row, status: 'firing', fired_at: iso(now) };
      }
      if (row.status === 'firing') notifyFiring(row, rule, r.hostname, env, repeatMs, sends);
    }

    // Open alerts whose condition is now false or whose subject is gone. No-data subjects keep their state.
    if (!ev.complete) return;
    const keep = new Set(ev.results.filter(r => r.breached || r.nodata).map(r => `${rule.id}|${r.subject}`));
    for (const [fp, row] of open) {
      if (keep.has(fp) || (row.host_id && ev.skipHosts.has(row.host_id))) continue;
      if (row.status === 'pending') { db.prepare('DELETE FROM alerts WHERE id = ?').run(row.id); continue; }
      db.prepare("UPDATE alerts SET status = 'resolved', resolved_at = ? WHERE id = ?").run(iso(now), row.id);
      if (row.notify_count === 0) continue;
      const quiet = (row.host_id && maintenance.windowFor(row.host_id, new Date(now))) || ruleSilenced(rule, now)
        || (row.silenced_until && Date.parse(row.silenced_until) > now);
      if (quiet) continue;
      const hostname = env.hosts.find(h => h.id === row.host_id)?.hostname || null;
      sends.push(() => notifier.dispatch(payloadFor(row, rule, hostname, true, env), rule.channels));
    }
  }

  function notifyFiring(row, rule, hostname, env, repeatMs, sends) {
    const now = env.now;
    const inWindow = !!(row.host_id && maintenance.windowFor(row.host_id, new Date(now)));
    if (!!row.suppressed !== inWindow) db.prepare('UPDATE alerts SET suppressed = ? WHERE id = ?').run(inWindow ? 1 : 0, row.id);
    if (inWindow || row.acked_at || ruleSilenced(rule, now)) return;
    if (row.silenced_until && Date.parse(row.silenced_until) > now) return;
    const due = row.notify_count === 0 || (repeatMs > 0 && now - Date.parse(row.last_notified_at) >= repeatMs);
    if (!due) return;
    db.prepare('UPDATE alerts SET last_notified_at = ?, notify_count = notify_count + 1 WHERE id = ?').run(iso(now), row.id);
    sends.push(() => notifier.dispatch(payloadFor(row, rule, hostname, false, env), rule.channels));
  }

  const self = {
    maintenance, notifier, config, setConfig, METRICS, DEFAULT_RULES,
    now: () => Date.now(),
    listRules, getRule, validateRule, saveRule,
    deleteRule(id) { closeSilently(id); return db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id).changes > 0; },

    // Dry run: the current value for every subject, nothing is stored or sent.
    dryRun(rule) {
      const env = makeEnv(self.now());
      const ev = evaluateRule(rule, env);
      return { evaluated: ev.results.length, matches: ev.results.filter(r => r.breached), results: ev.results, skipped_offline_hosts: ev.skipHosts.size };
    },

    async evaluate(nowMs = self.now()) {
      if (running) return;
      running = true;
      try {
        const env = makeEnv(nowMs);
        const sends = [];
        const known = new Set();
        for (const rule of listRules()) {
          known.add(rule.id);
          if (!rule.enabled) continue;
          apply(rule, evaluateRule(rule, env), env, sends);
        }
        for (const row of db.prepare("SELECT DISTINCT rule_id FROM alerts WHERE status IN ('pending','firing')").all()) if (!known.has(row.rule_id)) closeSilently(row.rule_id);
        await Promise.allSettled(sends.map(f => f()));
      } finally { running = false; }
    },

    // Alert actions. Return the updated row or null when the alert is not open.
    ack(id, actor) {
      const r = db.prepare("UPDATE alerts SET acked_by = ?, acked_at = ? WHERE id = ? AND status IN ('pending','firing')").run(actor || 'unknown', iso(self.now()), id);
      return r.changes ? self.getAlert(id) : null;
    },
    silence(id, minutes) {
      const until = minutes > 0 ? iso(self.now() + minutes * 60000) : null;
      const r = db.prepare("UPDATE alerts SET silenced_until = ? WHERE id = ? AND status IN ('pending','firing')").run(until, id);
      return r.changes ? self.getAlert(id) : null;
    },
    silenceRule(id, minutes) {
      const rule = getRule(id);
      if (!rule) return null;
      saveRule({ ...rule, silenced_until: minutes > 0 ? iso(self.now() + minutes * 60000) : null }, id);
      return getRule(id);
    },

    alertView(row) {
      const now = self.now();
      const silenced = !!row.silenced_until && Date.parse(row.silenced_until) > now;
      const state = row.status === 'resolved' ? 'resolved' : row.status === 'pending' ? 'pending' : row.acked_at ? 'acknowledged' : silenced ? 'silenced' : 'active';
      const data = parseJson(row.data, {});
      return { id: row.id, rule_id: row.rule_id, rule_name: row.rule_name, host_id: row.host_id, hostname: row.hostname || null, subject: row.subject,
        severity: row.severity, status: row.status, state, message: row.message, value: row.value, detail: data.detail || null,
        created_at: row.created_at, fired_at: row.fired_at, resolved_at: row.resolved_at, acked_by: row.acked_by, acked_at: row.acked_at,
        silenced_until: silenced ? row.silenced_until : null, suppressed: !!row.suppressed && row.status !== 'resolved', notify_count: row.notify_count, last_notified_at: row.last_notified_at };
    },
    getAlert(id) {
      const row = db.prepare('SELECT a.*, h.hostname FROM alerts a LEFT JOIN hosts h ON h.id = a.host_id WHERE a.id = ?').get(id);
      return row ? self.alertView(row) : null;
    },
    listAlerts({ state, severity, host, rule, history, limit = 200, offset = 0 } = {}) {
      const where = [];
      const args = [];
      const nowIso = iso(self.now());
      const states = {
        active: "a.status = 'firing' AND a.acked_at IS NULL AND (a.silenced_until IS NULL OR a.silenced_until <= ?)",
        ack: "a.status = 'firing' AND a.acked_at IS NOT NULL",
        acknowledged: "a.status = 'firing' AND a.acked_at IS NOT NULL",
        silenced: "a.status = 'firing' AND a.acked_at IS NULL AND a.silenced_until > ?",
        pending: "a.status = 'pending'", resolved: "a.status = 'resolved'"
      };
      if (state && state !== 'all') {
        if (!states[state]) return { error: `state must be one of ${Object.keys(states).join(', ')}, all` };
        where.push(states[state]);
        if (states[state].includes('?')) args.push(nowIso);
      } else if (history) where.push("a.status != 'pending'");
      if (severity) { where.push('a.severity = ?'); args.push(severity); }
      if (host) { where.push('a.host_id = ?'); args.push(host); }
      if (rule) { where.push('a.rule_id = ?'); args.push(rule); }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const lim = Math.max(1, Math.min(500, Number(limit) || 200));
      const off = Math.max(0, Number(offset) || 0);
      const total = db.prepare(`SELECT COUNT(*) AS n FROM alerts a ${clause}`).get(...args).n;
      const rows = db.prepare(`SELECT a.*, h.hostname FROM alerts a LEFT JOIN hosts h ON h.id = a.host_id ${clause} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`)
        .all(...args, lim, off).map(self.alertView);
      return { total, limit: lim, offset: off, rows };
    },

    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (!db.open) { clearInterval(timer); timer = null; return; }
        self.evaluate().catch(err => ctx.logger.error('[alerting]', err.message));
      }, TICK_MS);
      timer.unref();
    },
    stop() { clearInterval(timer); timer = null; }
  };

  // Latest LABCTL_RESULT values per host (for example cert_expiry_days from the certificate template).
  ctx.events.on('job', job => {
    if (!job?.host_id || !['completed', 'failed'].includes(job.status)) return;
    try {
      const upsert = db.prepare(`INSERT INTO alert_facts (host_id, key, value, ts, job_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(host_id, key) DO UPDATE SET value = excluded.value, ts = excluded.ts, job_id = excluded.job_id`);
      for (const m of String(ctx.joblog.tail(job.id, 65536) || '').matchAll(RESULT_LINE)) upsert.run(job.host_id, m[1], m[2].trim().slice(0, 200), iso(self.now()), job.id);
    } catch { /* a log that cannot be read just gives no facts */ }
  });

  return self;
}

// Route modules load in file order (alerts, channels, maintenance); whichever runs first creates the shared instance.
function ensure(ctx) {
  if (!ctx.alerting) {
    ctx.alerting = createAlerting(ctx);
    ctx.maintenance = ctx.alerting.maintenance;
    ctx.alerting.start();
    ctx.onClose?.(() => ctx.alerting.stop());
  }
  return ctx.alerting;
}

module.exports = { createAlerting, ensure, CONFIG_DEFAULTS };
