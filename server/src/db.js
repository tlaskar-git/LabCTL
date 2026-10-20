// SQLite storage (better-sqlite3, WAL). Schema changes are numbered migrations recorded in schema_version.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const MIGRATIONS = [
  // 1: v2 base schema
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, role TEXT NOT NULL,
    password_hash TEXT NOT NULL, created_at TEXT, updated_at TEXT);
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT, last_seen TEXT);
  CREATE TABLE hosts (
    id TEXT PRIMARY KEY, hostname TEXT, os TEXT, ip TEXT, kind TEXT NOT NULL DEFAULT 'agent',
    status TEXT, last_seen TEXT, group_id TEXT, token_id TEXT, agent_version TEXT, os_version TEXT,
    arch TEXT, system_info TEXT, inventory TEXT, inventory_at TEXT, heartbeat TEXT, data TEXT,
    created_at TEXT, updated_at TEXT);
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY, host_id TEXT, type TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', exit_code INTEGER, duration_ms INTEGER,
    shell TEXT, script TEXT, timeout_s INTEGER, script_id TEXT, schedule_id TEXT, actor TEXT,
    created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT);
  CREATE INDEX jobs_host ON jobs(host_id, created_at);
  CREATE INDEX jobs_status ON jobs(status);
  CREATE TABLE metrics (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX metrics_host ON metrics(host_id, created_at);
  CREATE TABLE schedules (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, host_id TEXT, type TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}',
    cron TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, last_run TEXT, next_run TEXT,
    last_missed TEXT, missed_count INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT);
  CREATE TABLE scripts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', os TEXT NOT NULL DEFAULT 'any',
    target TEXT NOT NULL DEFAULT 'host', command TEXT NOT NULL, timeout INTEGER NOT NULL DEFAULT 300,
    builtin INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT);
  CREATE TABLE credentials (
    id TEXT PRIMARY KEY, host_id TEXT, name TEXT, username TEXT, purpose TEXT NOT NULL DEFAULT 'autologin',
    kind TEXT NOT NULL DEFAULT 'password', sealed TEXT NOT NULL, created_at TEXT, updated_at TEXT);
  CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, ord INTEGER NOT NULL DEFAULT 0, created_at TEXT);
  CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT, created_at TEXT);
  CREATE TABLE host_tags (host_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (host_id, tag_id));
  CREATE TABLE host_groups (host_id TEXT NOT NULL, group_id TEXT NOT NULL, PRIMARY KEY (host_id, group_id));
  CREATE TABLE alert_rules (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL DEFAULT '{}', created_at TEXT, updated_at TEXT);
  CREATE TABLE alerts (
    id TEXT PRIMARY KEY, rule_id TEXT, host_id TEXT, severity TEXT NOT NULL DEFAULT 'warning',
    status TEXT NOT NULL DEFAULT 'open', message TEXT, data TEXT, created_at TEXT NOT NULL, resolved_at TEXT);
  CREATE TABLE channels (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    config_sealed TEXT, created_at TEXT, updated_at TEXT);
  CREATE TABLE maintenance_windows (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '{}', starts_at TEXT, ends_at TEXT,
    cron TEXT, duration_min INTEGER, created_at TEXT, updated_at TEXT);
  CREATE TABLE patch_policies (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, ring INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '{}',
    created_at TEXT, updated_at TEXT);
  CREATE TABLE runbooks (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', steps TEXT NOT NULL DEFAULT '[]',
    created_at TEXT, updated_at TEXT);
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
    host_id TEXT, detail TEXT, ip TEXT);
  CREATE INDEX audit_ts ON audit_log(ts);
  CREATE TABLE blocklist (host_id TEXT PRIMARY KEY, hostname TEXT, reason TEXT, actor TEXT, created_at TEXT);
  CREATE TABLE enrolment_tokens (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
    created_by TEXT, last_used TEXT, revoked INTEGER NOT NULL DEFAULT 0, revoked_at TEXT);
  `
];

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'labctl.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get().v;
  MIGRATIONS.forEach((sql, i) => {
    const version = i + 1;
    if (version <= current) return;
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
    })();
  });
  scrubJobSecrets(db);
  return db;
}

// v1 stored the auto-login password in the job row. Remove any password or secret key from stored job params.
function scrubJobSecrets(db) {
  const rows = db.prepare("SELECT id, params FROM jobs WHERE params LIKE '%password%' OR params LIKE '%secret%'").all();
  if (!rows.length) return;
  const upd = db.prepare('UPDATE jobs SET params = ? WHERE id = ?');
  db.transaction(() => {
    for (const r of rows) {
      const p = parseJson(r.params, null);
      if (!p || typeof p !== 'object') continue;
      let changed = false;
      for (const k of Object.keys(p)) if (/password|secret/i.test(k)) { delete p[k]; changed = true; }
      if (changed) upd.run(JSON.stringify(p), r.id);
    }
  })();
}

// For feature modules: add a column once without editing this file.
function ensureColumn(db, table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

module.exports = { openDb, ensureColumn, parseJson, MIGRATIONS };
