// Operator edits on top of the built-in job templates. The files under src/templates are never written.
// template_overrides: one row per built-in id with action 'edit' (fields replace the manifest values) or 'hide'
// (soft delete; any edit fields are kept for a later restore). custom_templates: templates made in the app.
// The store owns the live catalogue object handed out as ctx.templates.catalogue. Its templates and byId are
// rebuilt in place after every change, so callers that read catalogue.byId at use time always see the merged set.
const { randomUUID, createHash } = require('crypto');
const { spawnSync } = require('child_process');
const { parseJson } = require('./db');
const T = require('./templates');
const { updateSteps, UPDATE_TYPES } = require('./patching');
const { CATALOGUE: BUILTIN_SCHEDULES } = require('./builtin-schedules');

const SHELLS = ['bash', 'powershell', 'python'];
const MAX_SCRIPT = 200 * 1024;
const PARAM_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const CTRL = /[\u0000-\u001f]/;
// Templates the patch engine runs by id: updateSteps plus its snapshot and reboot steps (constants in patching.js).
const PATCH_TEMPLATES = new Set([...['darwin', 'windows', 'linux'].flatMap(os => UPDATE_TYPES.flatMap(t => updateSteps({ os }, t).map(s => s.template))),
  'pve_snapshot', 'vps_scheduled_reboot', 'win_reboot', 'mac_reboot']);

class StoreError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const rawParams = t => t.params.filter(p => p.name !== T.DRAIN_TIMEOUT.name);
const withDrain = (params, drain) => (drain ? [...params, T.DRAIN_TIMEOUT] : params);
const fingerprint = text => ({ script_bytes: Buffer.byteLength(text), script_sha256: createHash('sha256').update(text).digest('hex').slice(0, 12) });

function cleanParams(list) {
  if (!Array.isArray(list)) throw new StoreError('params must be a list');
  if (list.length > 50) throw new StoreError('A template can have at most 50 parameters');
  const seen = new Set();
  return list.filter(p => p && p.name !== T.DRAIN_TIMEOUT.name).map(p => {
    const name = String(p.name || '');
    if (!PARAM_RE.test(name)) throw new StoreError(`Parameter name ${name || '(empty)'} must be capital letters, digits and _ (up to 32, starting with a letter)`);
    if (T.RESERVED.includes(name)) throw new StoreError(`Parameter name ${name} is reserved`);
    if (seen.has(name)) throw new StoreError(`Parameter ${name} appears twice`);
    seen.add(name);
    if (!T.PARAM_TYPES.includes(p.type)) throw new StoreError(`Parameter ${name}: type must be one of ${T.PARAM_TYPES.join(', ')}`);
    const label = String(p.label ?? '').trim() || name;
    if (label.length > 120 || CTRL.test(label)) throw new StoreError(`Parameter ${name}: label is too long or has control characters`);
    const out = { name, type: p.type, label, default: p.default };
    if (p.type === 'enum') {
      const options = Array.isArray(p.options) ? p.options.map(String) : [];
      if (!options.length || options.length > 50 || options.some(o => !o || o.length > 100 || CTRL.test(o)) || new Set(options).size !== options.length) {
        throw new StoreError(`Parameter ${name}: a select needs 1 to 50 distinct options`);
      }
      out.options = options;
      if (out.default === undefined || out.default === '') out.default = options[0];
    }
    if (p.type === 'bool' && out.default === undefined) out.default = false;
    if (p.type === 'int' && (out.default === undefined || out.default === '')) out.default = 0;
    if (p.type === 'string' && out.default === undefined) out.default = '';
    const dv = out.default;
    const ok = p.type === 'bool' ? typeof dv === 'boolean'
      : p.type === 'int' ? Number.isInteger(dv) && dv >= 0 && dv <= 1e9
        : typeof dv === 'string' && dv.length <= 1000 && !CTRL.test(dv) && (p.type !== 'enum' || out.options.includes(dv));
    if (!ok) throw new StoreError(`Parameter ${name}: default does not match the type`);
    if (p.required !== undefined && typeof p.required !== 'boolean') throw new StoreError(`Parameter ${name}: required must be true or false`);
    if (p.required) out.required = true;
    return out;
  });
}

// d: a full definition. builtin: the manifest entry when d edits a built-in.
function validate(d, builtin) {
  const text = (v, max) => typeof v === 'string' && v.trim() && v.length <= max && !CTRL.test(v);
  if (!text(d.name, 120)) throw new StoreError('Name is required (up to 120 characters)');
  if (typeof d.description !== 'string' || d.description.length > 1000 || CTRL.test(d.description)) throw new StoreError('Description is too long or has control characters');
  if (!text(d.category, 40)) throw new StoreError('Category is required (up to 40 characters)');
  if (!Array.isArray(d.os) || !d.os.length || d.os.some(o => !T.OS.includes(o))) throw new StoreError(`os must be a list from ${T.OS.join(', ')}`);
  if (!Array.isArray(d.kinds) || !d.kinds.length || d.kinds.some(k => !T.KINDS.includes(k))) throw new StoreError(`kinds must be a list from ${T.KINDS.join(', ')}`);
  if (!SHELLS.includes(d.shell)) throw new StoreError(`shell must be one of ${SHELLS.join(', ')}`);
  if (typeof d.script !== 'string' || !d.script.trim()) throw new StoreError('Script is required');
  if (Buffer.byteLength(d.script) > MAX_SCRIPT) throw new StoreError('Script is larger than 200 KB');
  if (d.script.includes('\u0000')) throw new StoreError('Script contains a NUL byte');
  if (typeof d.guard !== 'boolean' || typeof d.drain !== 'boolean') throw new StoreError('guard and drain must be true or false');
  if (builtin && builtin.guard && !d.guard) throw new StoreError('A guarded built-in template keeps its typed confirmation. The guard cannot be removed.');
  return { name: d.name.trim(), description: d.description, category: d.category.trim(), os: [...new Set(d.os)], kinds: [...new Set(d.kinds)],
    shell: d.shell, script: d.script.replace(/\r\n/g, '\n'), params: cleanParams(d.params), guard: d.guard, drain: d.drain };
}

// Syntax findings are warnings, never blocks. bash -n when bash exists; other shells are not checked.
function syntaxWarnings(shell, script) {
  if (shell !== 'bash') return [];
  const r = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (r.error || r.status === 0) return [];
  return String(r.stderr || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 10);
}

function createTemplateStore(db, base) {
  db.exec(`CREATE TABLE IF NOT EXISTS template_overrides (
      template_id TEXT PRIMARY KEY, action TEXT NOT NULL, fields TEXT NOT NULL DEFAULT '{}', updated_by TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS custom_templates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL, os TEXT NOT NULL,
      kinds TEXT NOT NULL, shell TEXT NOT NULL, script TEXT NOT NULL, params TEXT NOT NULL DEFAULT '[]', guard INTEGER NOT NULL DEFAULT 0,
      drain INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TEXT, updated_at TEXT)`);
  const now = () => new Date().toISOString();
  const catalogue = { ...base, templates: [], byId: new Map(), all: new Map() };

  function builtinView(b, o) {
    if (!o) return { ...b, source: 'builtin', editable: true, hidden: false };
    const f = o.fields || {};
    const edited = Object.keys(f).length > 0;
    const t = { ...b, source: edited ? 'edited' : 'builtin', editable: true, hidden: o.action === 'hide', updated_by: o.updated_by, updated_at: o.updated_at };
    if (!edited) return t;
    for (const k of ['name', 'description', 'category', 'os', 'kinds', 'drain']) if (f[k] !== undefined) t[k] = f[k];
    t.guard = b.guard || !!f.guard;
    t.params = withDrain(f.params || rawParams(b), t.drain);
    if (f.script !== undefined) t.text = f.script;
    return t;
  }
  const customView = r => {
    const drain = !!r.drain;
    return { id: r.id, name: r.name, description: r.description, category: r.category, os: parseJson(r.os, []), kinds: parseJson(r.kinds, []),
      shell: r.shell, params: withDrain(parseJson(r.params, []), drain), secrets: [], guard: !!r.guard, drain, admin: false, text: r.script,
      source: 'custom', editable: true, hidden: false, created_by: r.created_by, updated_at: r.updated_at };
  };

  function refresh() {
    const ov = new Map(db.prepare('SELECT * FROM template_overrides').all().map(r => [r.template_id, { ...r, fields: parseJson(r.fields, {}) }]));
    const all = [...base.templates.map(b => builtinView(b, ov.get(b.id))),
      ...db.prepare('SELECT * FROM custom_templates ORDER BY name COLLATE NOCASE').all().map(customView)];
    catalogue.all = new Map(all.map(t => [t.id, t]));
    catalogue.templates = all.filter(t => !t.hidden);
    catalogue.byId = new Map(catalogue.templates.map(t => [t.id, t]));
  }
  refresh();

  const find = id => { const t = catalogue.all.get(id); if (!t) throw new StoreError('Template not found', 404); return t; };
  // The definition the editor works on, script text included.
  // locked_guard: a guarded built-in, whose guard the editor shows locked.
  const definition = t => ({ ...T.describe(t), params: rawParams(t), script: T.body(catalogue, t), locked_guard: !!base.byId.get(t.id)?.guard });

  function create(input, actor) {
    const d = validate({ description: '', category: 'custom', params: [], guard: false, drain: false, ...input });
    const id = `custom-${randomUUID()}`;
    const at = now();
    db.prepare(`INSERT INTO custom_templates (id, name, description, category, os, kinds, shell, script, params, guard, drain, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, d.name, d.description, d.category, JSON.stringify(d.os), JSON.stringify(d.kinds), d.shell,
      d.script, JSON.stringify(d.params), d.guard ? 1 : 0, d.drain ? 1 : 0, actor || null, at, at);
    refresh();
    return { tpl: catalogue.all.get(id), warnings: syntaxWarnings(d.shell, d.script), fp: fingerprint(d.script) };
  }

  function update(id, input, actor) {
    const t = find(id);
    const b = base.byId.get(id);
    const d = validate({ ...definition(t), ...input, ...(b ? { shell: b.shell } : {}) }, b);
    if (b) {
      const fields = { name: d.name, description: d.description, category: d.category, os: d.os, kinds: d.kinds, params: d.params, guard: d.guard, drain: d.drain };
      if (d.script !== T.body(catalogue, b)) fields.script = d.script;
      db.prepare(`INSERT INTO template_overrides (template_id, action, fields, updated_by, updated_at) VALUES (?, 'edit', ?, ?, ?)
        ON CONFLICT(template_id) DO UPDATE SET fields = excluded.fields, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(id, JSON.stringify(fields), actor || null, now());
    } else {
      db.prepare(`UPDATE custom_templates SET name = ?, description = ?, category = ?, os = ?, kinds = ?, shell = ?, script = ?, params = ?, guard = ?, drain = ?,
        updated_at = ? WHERE id = ?`).run(d.name, d.description, d.category, JSON.stringify(d.os), JSON.stringify(d.kinds), d.shell, d.script,
        JSON.stringify(d.params), d.guard ? 1 : 0, d.drain ? 1 : 0, now(), id);
    }
    refresh();
    return { tpl: catalogue.all.get(id), warnings: syntaxWarnings(d.shell, d.script), fp: fingerprint(d.script), script_changed: d.script !== T.body(catalogue, t) };
  }

  const clone = (id, actor) => {
    const src = definition(find(id));
    return create({ ...src, name: `${src.name} (copy)`.slice(0, 120), category: src.category }, actor);
  };

  // Where an id is used: runbook steps, patch policies, schedules and enabled built-in schedules.
  function references(id) {
    const q = `"${id}"`;
    const rows = (sql, ...args) => { try { return db.prepare(sql).all(...args); } catch { return []; } };
    const patch = PATCH_TEMPLATES.has(id) ? 1 : 0;
    const out = [
      ...rows('SELECT id, name FROM runbooks WHERE instr(steps, ?) > 0', q).map(r => ({ kind: 'runbook', id: r.id, name: r.name })),
      ...rows('SELECT id, name FROM patch_policies WHERE ? = 1 OR instr(config, ?) > 0', patch, q).map(r => ({ kind: 'patch_policy', id: r.id, name: r.name })),
      ...rows('SELECT id, name FROM schedules WHERE type = ? OR instr(params, ?) > 0', `template:${id}`, q).map(r => ({ kind: 'schedule', id: r.id, name: r.name }))
    ];
    const enabled = new Set(rows('SELECT key FROM builtin_schedules WHERE enabled = 1').map(r => r.key));
    for (const s of BUILTIN_SCHEDULES) {
      if (enabled.has(s.key) && ((s.templates || []).includes(id) || (s.key === 'patch_weekly' && patch))) out.push({ kind: 'builtin_schedule', id: s.key, name: s.name });
    }
    return out;
  }

  // Custom: deleted for good, the name typed. Built-in: hidden, edits kept for a restore.
  function remove(id, { confirm, force_referenced } = {}, actor) {
    const t = find(id);
    const refs = references(id);
    if (refs.length && force_referenced !== true) throw new StoreError('This template is in use. Tick the box to remove it anyway.', 409, { references: refs });
    if (t.source === 'custom') {
      if (confirm !== t.name) throw new StoreError(`Type the template name ${t.name} to delete it`, 400, { confirm_required: true, confirm_word: t.name });
      db.prepare('DELETE FROM custom_templates WHERE id = ?').run(id);
    } else {
      db.prepare(`INSERT INTO template_overrides (template_id, action, fields, updated_by, updated_at) VALUES (?, 'hide', '{}', ?, ?)
        ON CONFLICT(template_id) DO UPDATE SET action = 'hide', updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(id, actor || null, now());
    }
    refresh();
    return { action: t.source === 'custom' ? 'delete' : 'hide', tpl: t, references: refs };
  }

  // Hidden built-in: shown again (edits kept). Edited built-in: back to the manifest.
  function restore(id) {
    const t = find(id);
    if (t.source === 'custom') throw new StoreError('A custom template has no default to restore');
    const o = db.prepare('SELECT * FROM template_overrides WHERE template_id = ?').get(id);
    if (!o) throw new StoreError('This template has no changes to restore');
    const keepEdits = o.action === 'hide' && Object.keys(parseJson(o.fields, {})).length > 0;
    if (keepEdits) db.prepare("UPDATE template_overrides SET action = 'edit' WHERE template_id = ?").run(id);
    else db.prepare('DELETE FROM template_overrides WHERE template_id = ?').run(id);
    refresh();
    return { action: o.action === 'hide' ? 'unhide' : 'reset', tpl: catalogue.all.get(id) };
  }

  return { catalogue, definition, create, update, clone, remove, restore, references, refresh };
}

module.exports = { createTemplateStore, StoreError, SHELLS, MAX_SCRIPT };
