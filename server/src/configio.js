// Config export and import (JSON). Natural keys (name, username, host name) make a re-import idempotent.
// Secrets never leave: no credentials, tokens, channel secrets, GitHub token or password hashes (see SECRET_KEY).
// Import never creates or deletes hosts, never changes an existing user, and applies in one transaction.
const { randomUUID } = require('crypto');
const { parseJson } = require('./db');
const ops = require('./hostops');
const { KINDS: CHANNEL_KINDS } = require('./alerting/notify');
const backup = require('./backup');
const { CATALOGUE } = require('./builtin-schedules');
const { ensureDisplayColumns, cleanDisplayName, cleanIcon } = require('./host-display');

const FORMAT = 'labctl-config';
const VERSION = 1;
const MAX_BYTES = 5 * 1024 * 1024;
const SECRET_KEY = /pass|secret|token|hmac|^headers$|(^|_)keys?$|^auth(orization)?$|credential/i;
const BACKUP_KEYS = ['backup_enabled', 'backup_time', 'backup_keep_days'];
const ROLES = ['viewer', 'operator', 'admin'];
// Sections in apply order (later ones may refer to earlier ones by name).
const ORDER = ['settings', 'groups', 'tags', 'scripts', 'hosts', 'channels', 'alert_rules', 'schedules', 'runbooks',
  'maintenance_windows', 'patch_policies', 'builtin_schedules', 'users'];
// replace_sections deletes rows missing from the file, for these sections only. Everything else behaves as merge.
const REPLACEABLE = ['groups', 'tags', 'scripts', 'schedules', 'runbooks', 'alert_rules', 'maintenance_windows'];

// Field types: s string, S required string, i integer, b boolean, o JSON object or array.
const TABLES = {
  groups: { table: 'groups', fields: { color: 's', ord: 'i' } },
  tags: { table: 'tags', fields: { color: 's' } },
  scripts: { table: 'scripts', where: 'builtin = 0', fields: { description: 's', os: 's', target: 's', command: 'S', timeout: 'i' }, insert: { builtin: 0 } },
  schedules: { table: 'schedules', fields: { type: 'S', params: 'o', cron: 'S', enabled: 'b' }, extra: ['host'] },
  runbooks: { table: 'runbooks', fields: { description: 's', steps: 'o', params: 'o' } },
  alert_rules: { table: 'alert_rules', fields: { kind: 'S', enabled: 'b', config: 'o' } },
  maintenance_windows: { table: 'maintenance_windows', fields: { scope: 'o', starts_at: 's', ends_at: 's', cron: 's', duration_min: 'i' } },
  patch_policies: { table: 'patch_policies', fields: { ring: 'i', config: 'o', enabled: 'b', cron: 's' } }
};

const lc = v => String(v).toLowerCase();
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bad = (error, status = 400) => Object.assign(new Error(error), { status, expose: true });

// Removes every property whose name looks secret, at any depth.
function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!isObj(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !SECRET_KEY.test(k)).map(([k, v]) => [k, stripSecrets(v)]));
}

function checkType(type, v) {
  if (type === 's' || type === 'S') return typeof v === 'string' && v.length <= 200000 && (type === 's' || v.length > 0) ? null : 'must be text';
  if (type === 'i') return Number.isInteger(v) && Math.abs(v) <= 1e9 ? null : 'must be a whole number';
  if (type === 'b') return typeof v === 'boolean' ? null : 'must be true or false';
  return v && typeof v === 'object' ? null : 'must be an object or list';
}
const toDb = (type, v) => (type === 'b' ? (v ? 1 : 0) : type === 'o' ? JSON.stringify(v) : v);
const fromDb = (type, v) => (type === 'b' ? !!v : type === 'o' ? parseJson(v, null) : v);

function createConfigIo(ctx) {
  const { db } = ctx;
  ensureDisplayColumns(db);
  const columns = table => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  const now = () => new Date().toISOString();
  const hostByName = name => db.prepare('SELECT * FROM hosts WHERE hostname = ? COLLATE NOCASE').get(name);
  const channelId = name => db.prepare('SELECT id FROM channels WHERE name = ? COLLATE NOCASE').get(name)?.id;
  const setting = key => { const v = ctx.settings.get(key); return v === undefined ? backup.DEFAULTS[key] : v; };

  // ---- export -------------------------------------------------------------------------------------------------------

  function cleanChannel(row) {
    let config = {};
    try { config = ctx.crypto.openJson(row.config_sealed); } catch { /* sealed with another key */ }
    const clean = stripSecrets(config);
    const removed = Object.keys(config).some(k => SECRET_KEY.test(k)) || row.kind === 'telegram';
    return { clean, needs_secret: removed };
  }

  function exportConfig() {
    const settings = {};
    for (const [k, v] of Object.entries(ctx.settings.all())) if (!k.startsWith('_') && !SECRET_KEY.test(k)) settings[k] = stripSecrets(v);
    for (const k of BACKUP_KEYS) settings[k] = setting(k);

    const data = { settings };
    for (const [name, sp] of Object.entries(TABLES)) {
      const cols = columns(sp.table);
      const fields = Object.entries(sp.fields).filter(([k]) => cols.has(k));
      let rows = db.prepare(`SELECT * FROM ${sp.table}${sp.where ? ` WHERE ${sp.where}` : ''} ORDER BY name COLLATE NOCASE`).all();
      if (name === 'patch_policies') rows = rows.filter(r => !parseJson(r.config, {}).builtin); // covered by builtin_schedules
      data[name] = rows.map(r => {
        const out = { name: r.name };
        for (const [k, t] of fields) out[k] = fromDb(t, r[k]);
        if (name === 'schedules') out.host = r.host_id ? (db.prepare('SELECT hostname FROM hosts WHERE id = ?').get(r.host_id)?.hostname ?? null) : null;
        if (name === 'alert_rules' && isObj(out.config)) {
          out.config = { ...out.config, channels: (out.config.channels || []).map(id => db.prepare('SELECT name FROM channels WHERE id = ?').get(id)?.name).filter(Boolean) };
          delete out.config.silenced_until;
        }
        return out;
      });
    }
    data.channels = db.prepare('SELECT * FROM channels ORDER BY name COLLATE NOCASE').all().map(r => {
      const c = cleanChannel(r);
      return { name: r.name, kind: r.kind, enabled: !!r.enabled, config: c.clean, needs_secret: c.needs_secret };
    });
    data.users = db.prepare('SELECT username, role FROM users ORDER BY username COLLATE NOCASE').all();
    data.hosts = db.prepare('SELECT * FROM hosts ORDER BY hostname COLLATE NOCASE').all().map(h => {
      const d = ops.getData(db, h.id);
      return { name: h.hostname, display_name: h.display_name || null, icon: h.icon || null, kind: h.kind, os: h.os, address: d.ssh?.address || h.ip || null, port: d.ssh?.port ?? null,
        provider: d.provider || '', region: d.region || '', plan: d.plan || '', notes: d.notes || '',
        tags: db.prepare('SELECT t.name FROM tags t JOIN host_tags ht ON ht.tag_id = t.id WHERE ht.host_id = ? ORDER BY t.name').all(h.id).map(t => t.name),
        groups: db.prepare('SELECT g.name FROM groups g JOIN host_groups hg ON hg.group_id = g.id WHERE hg.host_id = ? ORDER BY g.ord').all(h.id).map(g => g.name) };
    });
    try { data.builtin_schedules = db.prepare('SELECT key, enabled, cron FROM builtin_schedules ORDER BY key').all().map(r => ({ key: r.key, enabled: !!r.enabled, cron: r.cron })); } catch { data.builtin_schedules = []; }
    return { format: FORMAT, version: VERSION, exported_at: now(), labctl_version: ctx.version, data };
  }

  // ---- import: planners ---------------------------------------------------------------------------------------------
  // A planner returns actions: { op: create|update|skip|conflict|delete, name, reason?, apply? }. apply runs in the transaction.

  const unknownField = (item, allowed) => Object.keys(item).find(k => !allowed.includes(k));
  const conflict = (name, reason) => ({ op: 'conflict', name: String(name ?? '?'), reason });
  const skip = (name, reason) => ({ op: 'skip', name, reason });

  function planTable(section, items, replace, pending) {
    const sp = TABLES[section];
    const cols = columns(sp.table);
    const fields = Object.entries(sp.fields).filter(([k]) => cols.has(k));
    const allowed = ['name', ...Object.keys(sp.fields), ...(sp.extra || [])];
    const rows = db.prepare(`SELECT * FROM ${sp.table}${sp.where ? ` WHERE ${sp.where}` : ''}`).all();
    const byName = new Map(rows.map(r => [lc(r.name), r]));
    const seen = new Set();
    const actions = [];

    // Values in database form, plus the fields that need a lookup. planning=true tolerates names created earlier in the same import.
    const build = (it, planning) => {
      const vals = {};
      for (const [k, t] of fields) if (it[k] !== undefined && it[k] !== null) vals[k] = toDb(t, it[k]);
      if (section === 'schedules') {
        if (it.host) {
          const h = hostByName(it.host);
          if (!h) return { skip: `host "${it.host}" not found on this server` };
          vals.host_id = h.id;
        } else if (it.host === null) vals.host_id = null;
        if (it.cron !== undefined) { const e = ctx.scheduler.validate(it.cron); if (e) return { error: `invalid cron: ${e}` }; }
      }
      if (section === 'patch_policies' && it.cron) { const e = ctx.scheduler.validate(it.cron); if (e) return { error: `invalid cron: ${e}` }; }
      if (section === 'alert_rules' && isObj(it.config)) {
        const names = Array.isArray(it.config.channels) ? it.config.channels.filter(n => typeof n === 'string') : [];
        const ids = names.map(n => channelId(n) || (planning && pending.channels?.has(lc(n)) ? `pending:${lc(n)}` : null)).filter(Boolean);
        vals.config = JSON.stringify({ ...it.config, channels: ids });
      }
      return { vals };
    };
    const norm = (t, v) => (t === 'o' ? JSON.stringify(parseJson(v, null)) : v);

    for (const [n, it] of items.entries()) {
      const label = isObj(it) && typeof it.name === 'string' && it.name ? it.name : `#${n + 1}`;
      if (!isObj(it) || typeof it.name !== 'string' || !it.name.trim() || it.name.length > 200) { actions.push(conflict(label, 'name must be text up to 200 characters')); continue; }
      const key = lc(it.name.trim());
      if (seen.has(key)) { actions.push(conflict(it.name, 'duplicate name in the file')); continue; }
      seen.add(key);
      const unknown = unknownField(it, allowed);
      if (unknown) { actions.push(conflict(it.name, `unknown field "${unknown}"`)); continue; }
      const typeErr = fields.find(([k, t]) => it[k] !== undefined && it[k] !== null && checkType(t, it[k]));
      if (typeErr) { actions.push(conflict(it.name, `${typeErr[0]} ${checkType(typeErr[1], it[typeErr[0]])}`)); continue; }
      const b = build(it, true);
      if (b.error) { actions.push(conflict(it.name, b.error)); continue; }
      if (b.skip) { actions.push(skip(it.name.trim(), b.skip)); continue; }
      const name = it.name.trim();
      const cur = byName.get(key);
      const missing = !cur && fields.find(([k, t]) => t === 'S' && b.vals[k] === undefined);
      if (missing) { actions.push(conflict(name, `${missing[0]} is required`)); continue; }
      const write = () => {
        const { vals } = build(it, false);
        if (cur) {
          const sets = { ...vals, ...(cols.has('updated_at') ? { updated_at: now() } : {}) };
          db.prepare(`UPDATE ${sp.table} SET ${Object.keys(sets).map(k => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...sets, id: cur.id });
          return cur.id;
        }
        const id = randomUUID();
        const row = { id, name, ...vals, ...(sp.insert || {}), ...(cols.has('created_at') ? { created_at: now() } : {}), ...(cols.has('updated_at') ? { updated_at: now() } : {}) };
        db.prepare(`INSERT INTO ${sp.table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(k => `@${k}`).join(', ')})`).run(row);
        return id;
      };
      const after = id => {
        if (section === 'schedules' || section === 'patch_policies') {
          const r = db.prepare(`SELECT cron, enabled FROM ${sp.table} WHERE id = ?`).get(id);
          const next = r.cron && (section === 'schedules' || r.enabled) ? ctx.scheduler.nextRun(r.cron) : null;
          db.prepare(`UPDATE ${sp.table} SET next_run = ? WHERE id = ?`).run(next, id);
        }
      };
      if (!cur) { actions.push({ op: 'create', name, apply: () => after(write()) }); continue; }
      const changed = Object.keys(b.vals).filter(k => {
        const t = sp.fields[k];
        if (k === 'host_id') return cur.host_id !== b.vals.host_id;
        if (section === 'alert_rules' && k === 'config') {
          const live = parseJson(cur.config, {});
          delete live.silenced_until;
          const want = parseJson(b.vals.config, {});
          delete want.silenced_until;
          return !same(live, want);
        }
        return norm(t, cur[k]) !== norm(t, b.vals[k]);
      });
      if (!changed.length) actions.push(skip(name, 'unchanged'));
      else actions.push({ op: 'update', name, reason: `changes: ${changed.join(', ')}`, apply: () => after(write()) });
    }

    if (replace && REPLACEABLE.includes(section)) {
      for (const r of rows) {
        if (seen.has(lc(r.name)) || (section === 'alert_rules' && String(r.id).startsWith('default-'))) continue;
        actions.push({ op: 'delete', name: r.name, apply: () => {
          if (section === 'groups') { db.prepare('DELETE FROM host_groups WHERE group_id = ?').run(r.id); db.prepare('UPDATE hosts SET group_id = NULL WHERE group_id = ?').run(r.id); }
          if (section === 'tags') db.prepare('DELETE FROM host_tags WHERE tag_id = ?').run(r.id);
          db.prepare(`DELETE FROM ${sp.table} WHERE id = ?`).run(r.id);
        } });
      }
    }
    return actions;
  }

  function planSettings(obj) {
    if (!isObj(obj)) return [conflict('settings', 'must be an object')];
    const actions = [];
    const patch = {};
    const own = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_') || SECRET_KEY.test(k)) { actions.push(skip(k, 'not importable')); continue; }
      if (BACKUP_KEYS.includes(k)) {
        const r = backup.validateSettings({ [k]: v });
        if (r.error) { actions.push(conflict(k, r.error)); continue; }
        if (same(setting(k), v)) actions.push(skip(k, 'unchanged')); else { own[k] = v; actions.push({ op: 'update', name: k }); }
      } else if (k in ctx.settings.DEFAULTS) {
        let err = null;
        try { db.transaction(() => { err = ctx.settings.update({ [k]: v }).error; throw new Error('dry'); })(); } catch (e) { if (e.message !== 'dry') throw e; }
        if (err) { actions.push(conflict(k, err)); continue; }
        if (same(ctx.settings.get(k), v)) actions.push(skip(k, 'unchanged')); else { patch[k] = v; actions.push({ op: 'update', name: k }); }
      } else actions.push(skip(k, 'not an importable setting'));
    }
    const first = actions.find(a => a.op === 'update');
    if (first) first.apply = () => {
      const before = ctx.settings.get('timezone');
      if (Object.keys(patch).length) ctx.settings.update(patch);
      for (const [k, v] of Object.entries(own)) ctx.settings.set(k, v);
      if (ctx.settings.get('timezone') !== before) ctx.scheduler.recomputeAll();
      ctx.backups?.reschedule();
    };
    for (const a of actions) if (a.op === 'update' && a !== first) a.apply = () => {};
    return actions;
  }

  function planChannels(items) {
    const allowed = ['name', 'kind', 'enabled', 'config', 'needs_secret'];
    const seen = new Set();
    return items.map((it, n) => {
      if (!isObj(it) || typeof it.name !== 'string' || !it.name.trim() || it.name.length > 200) return conflict(`#${n + 1}`, 'name must be text up to 200 characters');
      const name = it.name.trim();
      if (seen.has(lc(name))) return conflict(name, 'duplicate name in the file');
      seen.add(lc(name));
      const unknown = unknownField(it, allowed);
      if (unknown) return conflict(name, `unknown field "${unknown}"`);
      if (!CHANNEL_KINDS.includes(it.kind)) return conflict(name, `kind must be one of ${CHANNEL_KINDS.join(', ')}`);
      if (!isObj(it.config)) return conflict(name, 'config must be an object');
      if (it.enabled !== undefined && typeof it.enabled !== 'boolean') return conflict(name, 'enabled must be true or false');
      const config = stripSecrets(it.config);
      const cur = db.prepare('SELECT * FROM channels WHERE name = ? COLLATE NOCASE').get(name);
      if (!cur) {
        // A channel without its secret cannot send, so it is created disabled. The operator enters the secret in the UI.
        return { op: 'create', name, reason: 'created disabled, secrets must be entered', apply: () => {
          const stamp = now();
          db.prepare('INSERT INTO channels (id, name, kind, enabled, config_sealed, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)')
            .run(randomUUID(), name, it.kind, ctx.crypto.sealJson(config), stamp, stamp);
        } };
      }
      if (cur.kind !== it.kind) return conflict(name, `a channel with this name has kind ${cur.kind}`);
      let existing = {};
      try { existing = ctx.crypto.openJson(cur.config_sealed); } catch { /* unreadable: replaced below */ }
      const merged = { ...existing, ...config }; // existing secrets stay
      const disable = it.enabled === false && cur.enabled;
      if (same(merged, existing) && !disable) return skip(name, 'unchanged');
      return { op: 'update', name, apply: () => db.prepare('UPDATE channels SET config_sealed = ?, enabled = ?, updated_at = ? WHERE id = ?')
        .run(ctx.crypto.sealJson(merged), disable ? 0 : cur.enabled, now(), cur.id) };
    });
  }

  function planUsers(items, includeUsers) {
    return items.map((it, n) => {
      if (!isObj(it) || typeof it.username !== 'string' || !it.username.trim() || it.username.length > 100) return conflict(`#${n + 1}`, 'username must be text up to 100 characters');
      const name = it.username.trim();
      const unknown = unknownField(it, ['username', 'role']);
      if (unknown) return conflict(name, `unknown field "${unknown}"`);
      if (!ROLES.includes(it.role)) return conflict(name, `role must be one of ${ROLES.join(', ')}`);
      if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(name)) return skip(name, 'user exists, never changed by import');
      if (!includeUsers) return skip(name, 'users are skipped unless include_users is set');
      // A hash without ":" never verifies, so the user cannot sign in until an admin sets a password.
      return { op: 'create', name, reason: 'created disabled, an admin must set a password', apply: () => {
        const stamp = now();
        db.prepare('INSERT INTO users (id, username, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), name, it.role, '!disabled', stamp, stamp);
      } };
    });
  }

  function planHosts(items) {
    const allowed = ['name', 'display_name', 'icon', 'kind', 'os', 'address', 'port', 'provider', 'region', 'plan', 'notes', 'tags', 'groups'];
    const seen = new Set();
    return items.map((it, n) => {
      if (!isObj(it) || typeof it.name !== 'string' || !it.name.trim() || it.name.length > 200) return conflict(`#${n + 1}`, 'name must be text up to 200 characters');
      const name = it.name.trim();
      if (seen.has(lc(name))) return conflict(name, 'duplicate name in the file');
      seen.add(lc(name));
      const unknown = unknownField(it, allowed);
      if (unknown) return conflict(name, `unknown field "${unknown}"`);
      for (const k of ['provider', 'region', 'plan', 'notes']) if (it[k] !== undefined && (typeof it[k] !== 'string' || it[k].length > 2000)) return conflict(name, `${k} must be text`);
      // display_name and icon: same rules as PATCH /api/hosts/:id. null clears; a missing field leaves the host as it is.
      const look = {};
      for (const [k, clean] of [['display_name', cleanDisplayName], ['icon', cleanIcon]]) {
        if (it[k] === undefined) continue;
        const c = clean(it[k]);
        if (c.error) return conflict(name, c.error);
        look[k] = c.value;
      }
      for (const k of ['tags', 'groups']) {
        if (it[k] !== undefined && (!Array.isArray(it[k]) || it[k].length > 100 || it[k].some(x => typeof x !== 'string' || !x.trim() || x.length > 100))) return conflict(name, `${k} must be a list of names`);
      }
      const h = hostByName(name);
      if (!h) return skip(name, 'host not found (agents register themselves, ssh hosts need a credential)');
      const d = ops.getData(db, h.id);
      const meta = {};
      for (const k of ['provider', 'region', 'plan', 'notes']) if (it[k] !== undefined && (d[k] || '') !== it[k]) meta[k] = it[k];
      const curTags = db.prepare('SELECT t.name FROM tags t JOIN host_tags ht ON ht.tag_id = t.id WHERE ht.host_id = ?').all(h.id).map(t => lc(t.name)).sort();
      const curGroups = db.prepare('SELECT g.name FROM groups g JOIN host_groups hg ON hg.group_id = g.id WHERE hg.host_id = ?').all(h.id).map(g => lc(g.name)).sort();
      const tagsChanged = it.tags !== undefined && !same([...new Set(it.tags.map(lc))].sort(), curTags);
      const groupsChanged = it.groups !== undefined && !same([...new Set(it.groups.map(lc))].sort(), curGroups);
      for (const k of Object.keys(look)) if ((h[k] || null) === look[k]) delete look[k];
      if (!Object.keys(meta).length && !Object.keys(look).length && !tagsChanged && !groupsChanged) return skip(name, 'unchanged');
      return { op: 'update', name, reason: `changes: ${[...Object.keys(look), ...Object.keys(meta), tagsChanged && 'tags', groupsChanged && 'groups'].filter(Boolean).join(', ')}`, apply: () => {
        for (const [k, v] of Object.entries(look)) db.prepare(`UPDATE hosts SET ${k} = ? WHERE id = ?`).run(v, h.id);
        if (Object.keys(meta).length) ops.saveData(db, h.id, meta);
        if (tagsChanged) ops.setTags(db, h.id, ops.tagIds(db, it.tags));
        if (groupsChanged) {
          ops.setGroups(db, h.id, it.groups.map(g => db.prepare('SELECT id FROM groups WHERE name = ? COLLATE NOCASE').get(g)?.id).filter(Boolean));
        }
      } };
    });
  }

  function planBuiltins(items) {
    return items.map((it, n) => {
      if (!isObj(it) || typeof it.key !== 'string') return conflict(`#${n + 1}`, 'key must be text');
      const unknown = unknownField(it, ['key', 'enabled', 'cron']);
      if (unknown) return conflict(it.key, `unknown field "${unknown}"`);
      if (typeof it.enabled !== 'boolean') return conflict(it.key, 'enabled must be true or false');
      if (!CATALOGUE.some(c => c.key === it.key)) return skip(it.key, 'unknown built-in schedule');
      if (!ctx.builtins) return skip(it.key, 'built-in schedules are not available');
      if (it.cron !== undefined) { const e = ctx.scheduler.validate(it.cron); if (e) return conflict(it.key, `invalid cron: ${e}`); }
      const cur = db.prepare('SELECT enabled, cron FROM builtin_schedules WHERE key = ?').get(it.key);
      const sameCron = it.cron === undefined || cur?.cron === it.cron;
      if (!!cur?.enabled === it.enabled && (!it.enabled || sameCron)) return skip(it.key, 'unchanged');
      return { op: 'update', name: it.key, apply: () => {
        const r = it.enabled ? ctx.builtins.enable(it.key, { cron: it.cron }) : ctx.builtins.disable(it.key);
        if (r?.error) throw bad(`${it.key}: ${r.error}`);
      } };
    });
  }

  // ---- import: entry ------------------------------------------------------------------------------------------------

  function importConfig(body, actor) {
    const { mode = 'merge', sections, dry_run: dry = true, data, include_users: includeUsers = false } = body || {};
    if (!['merge', 'replace_sections'].includes(mode)) throw bad('mode must be merge or replace_sections');
    if (typeof dry !== 'boolean') throw bad('dry_run must be true or false');
    if (!isObj(data)) throw bad('data must be the "data" object of an export file');
    if (body.format !== FORMAT) throw bad(`format must be ${FORMAT}`);
    if (body.version !== VERSION) throw bad(`Unsupported version ${body.version}. This server reads version ${VERSION}.`);
    if (JSON.stringify(data).length > MAX_BYTES) throw bad('Import is larger than 5 MB', 413);
    for (const k of Object.keys(data)) if (!ORDER.includes(k)) throw bad(`Unknown section "${k}"`);
    for (const k of ORDER) {
      if (data[k] === undefined) continue;
      if (k === 'settings' ? !isObj(data[k]) : !Array.isArray(data[k])) throw bad(`Section "${k}" must be ${k === 'settings' ? 'an object' : 'a list'}`);
    }
    const chosen = sections === undefined ? ORDER.filter(k => data[k] !== undefined) : sections;
    if (!Array.isArray(chosen) || chosen.some(k => !ORDER.includes(k))) throw bad(`sections must be a list drawn from: ${ORDER.join(', ')}`);

    const pending = { channels: new Set((chosen.includes('channels') && Array.isArray(data.channels) ? data.channels : []).filter(c => typeof c?.name === 'string').map(c => lc(c.name))) };
    const replace = mode === 'replace_sections';
    const actions = [];
    for (const section of ORDER.filter(k => chosen.includes(k) && data[k] !== undefined)) {
      let list;
      if (section === 'settings') list = planSettings(data.settings);
      else if (section === 'channels') list = planChannels(data.channels);
      else if (section === 'users') list = planUsers(data.users, !!includeUsers);
      else if (section === 'hosts') list = planHosts(data.hosts);
      else if (section === 'builtin_schedules') list = planBuiltins(data.builtin_schedules);
      else list = planTable(section, data[section], replace, pending);
      for (const a of list) actions.push({ section, ...a });
    }

    const plan = { create: [], update: [], skip: [], conflicts: [], delete: [] };
    for (const a of actions) {
      const row = { section: a.section, name: a.name, ...(a.reason ? { reason: a.reason } : {}) };
      plan[a.op === 'conflict' ? 'conflicts' : a.op].push(row);
    }
    const counts = Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.length]));
    if (dry) return { dry_run: true, mode, plan, counts };
    if (plan.conflicts.length) throw Object.assign(bad(`${plan.conflicts.length} conflicts. Fix the file or run a dry run to see them.`, 409), { plan, counts });
    // Deletes first so a recreated name does not collide, then everything else in section order.
    db.transaction(() => {
      for (const a of actions.filter(x => x.op === 'delete')) a.apply();
      for (const a of actions.filter(x => ['create', 'update'].includes(x.op))) a.apply();
    })();
    ctx.audit(actor, 'config.import', null, { mode, sections: chosen, counts });
    return { dry_run: false, mode, plan, counts };
  }

  return { exportConfig, importConfig, MAX_BYTES, ORDER };
}

module.exports = { createConfigIo, stripSecrets, SECRET_KEY, FORMAT, VERSION };
