// Operator changes to the built-in schedule catalogue. The factory entries stay in builtin-schedules.js (CATALOGUE);
// this module stores what the operator did to them and the entries the operator added.
//   builtin_schedule_overrides  one row per factory key: action 'edit' (fields JSON holds the edited fields) or 'hide'
//   custom_builtin_schedules    operator entries, key 'custom-<id>', run through the same mechanism as the factory ones
// timezone is null for every entry: runs use the server timezone setting.
const { randomUUID } = require('crypto');
const { parseJson } = require('./db');

const now = () => new Date().toISOString();

function createStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS builtin_schedule_overrides (
      key TEXT PRIMARY KEY, action TEXT NOT NULL, fields TEXT, updated_by TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS custom_builtin_schedules (
      key TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, cron TEXT NOT NULL, timezone TEXT, templates TEXT NOT NULL,
      scope TEXT NOT NULL, guarded INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TEXT, updated_at TEXT)`);

  const custom = r => r ? { key: r.key, name: r.name, description: r.description || '', cron: r.cron, timezone: r.timezone || null,
    steps: parseJson(r.templates, []), scope: parseJson(r.scope, {}), guarded: !!r.guarded, created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at } : null;

  return {
    override(key) {
      const r = db.prepare('SELECT * FROM builtin_schedule_overrides WHERE key = ?').get(key);
      return r ? { action: r.action, fields: parseJson(r.fields, {}), updated_by: r.updated_by, updated_at: r.updated_at } : null;
    },
    hiddenKeys: () => db.prepare("SELECT key FROM builtin_schedule_overrides WHERE action = 'hide'").all().map(r => r.key),
    setEdit(key, fields, by) {
      db.prepare(`INSERT INTO builtin_schedule_overrides (key, action, fields, updated_by, updated_at) VALUES (?, 'edit', ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET action = 'edit', fields = excluded.fields, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(key, JSON.stringify(fields), by || null, now());
    },
    hide(key, by) {
      db.prepare(`INSERT INTO builtin_schedule_overrides (key, action, fields, updated_by, updated_at) VALUES (?, 'hide', NULL, ?, ?)
        ON CONFLICT(key) DO UPDATE SET action = 'hide', fields = NULL, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(key, by || null, now());
    },
    clear: key => db.prepare('DELETE FROM builtin_schedule_overrides WHERE key = ?').run(key).changes > 0,

    listCustom: () => db.prepare('SELECT * FROM custom_builtin_schedules ORDER BY created_at, key').all().map(custom),
    getCustom: key => custom(db.prepare('SELECT * FROM custom_builtin_schedules WHERE key = ?').get(key)),
    createCustom({ name, description = '', cron, steps, scope, guarded }, by) {
      const key = `custom-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const t = now();
      db.prepare(`INSERT INTO custom_builtin_schedules (key, name, description, cron, timezone, templates, scope, guarded, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`).run(key, name, description, cron, JSON.stringify(steps), JSON.stringify(scope), guarded ? 1 : 0, by || null, t, t);
      return key;
    },
    updateCustom(key, { name, description, cron, steps, scope, guarded }) {
      db.prepare(`UPDATE custom_builtin_schedules SET name = ?, description = ?, cron = ?, templates = ?, scope = ?, guarded = ?, updated_at = ? WHERE key = ?`)
        .run(name, description || '', cron, JSON.stringify(steps), JSON.stringify(scope), guarded ? 1 : 0, now(), key);
    },
    deleteCustom: key => db.prepare('DELETE FROM custom_builtin_schedules WHERE key = ?').run(key).changes > 0
  };
}

module.exports = { createStore };
