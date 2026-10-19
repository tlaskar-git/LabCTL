// Key/value settings stored as JSON in the settings table, with defaults.
const DEFAULTS = {
  retention_days: 30,            // v1 name for metrics retention, kept as an alias of metrics_days
  poll_interval_seconds: 300,
  theme: 'dark',
  timezone: 'Europe/Dublin',
  jobs_days: 90,
  metrics_days: 30,
  job_logs_days: 90,
  audit_days: 365,
  job_log_max_bytes: 20971520
};

// Numeric settings and their allowed range.
const NUMERIC = {
  retention_days: [1, 3650], metrics_days: [1, 3650], jobs_days: [1, 3650], job_logs_days: [1, 3650],
  audit_days: [1, 3650], poll_interval_seconds: [60, 86400], job_log_max_bytes: [1024, 1073741824]
};

function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}

function createSettings(db) {
  const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const self = {
    DEFAULTS,
    get(key) {
      const row = getStmt.get(key);
      if (!row) return DEFAULTS[key];
      try { return JSON.parse(row.value); } catch { return DEFAULTS[key]; }
    },
    set(key, value) { setStmt.run(key, JSON.stringify(value)); },
    all() {
      const out = { ...DEFAULTS };
      for (const row of db.prepare('SELECT key, value FROM settings').all()) {
        if (row.key.startsWith('_')) continue; // internal flags
        try { out[row.key] = JSON.parse(row.value); } catch { /* ignore bad row */ }
      }
      return out;
    },
    // Validate and apply a patch of known settings. Returns { error } or { changed: [keys] }.
    update(patch = {}) {
      const changed = [];
      const next = {};
      for (const [key, raw] of Object.entries(patch)) {
        if (NUMERIC[key]) {
          const [min, max] = NUMERIC[key];
          const n = Number(raw);
          if (!Number.isFinite(n)) return { error: `${key} must be a number` };
          next[key] = Math.max(min, Math.min(max, Math.round(n)));
        } else if (key === 'theme') {
          if (!['dark', 'light'].includes(raw)) return { error: 'theme must be dark or light' };
          next.theme = raw;
        } else if (key === 'timezone') {
          if (typeof raw !== 'string' || !validTimezone(raw)) return { error: 'timezone must be an IANA time zone name' };
          next.timezone = raw;
        }
      }
      if (next.retention_days !== undefined && next.metrics_days === undefined) next.metrics_days = next.retention_days;
      if (next.metrics_days !== undefined) next.retention_days = next.metrics_days;
      db.transaction(() => { for (const [k, v] of Object.entries(next)) { self.set(k, v); changed.push(k); } })();
      return { changed };
    }
  };
  return self;
}

module.exports = { createSettings, DEFAULTS, validTimezone };
