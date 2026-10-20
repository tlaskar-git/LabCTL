// Maintenance windows and host scope matching. Windows are one-off (starts_at/ends_at) or weekly (cron + duration_min,
// evaluated in the timezone setting). Alerts keep recording during a window but send no notification.
const { randomUUID } = require('crypto');
const { CronExpressionParser } = require('cron-parser');
const { parseJson } = require('../db');

const SCOPE_TYPES = ['all', 'hosts', 'group', 'tag'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Scope shapes: {type:'all'} | {type:'hosts', ids:[...]} | {type:'group', value:'id or name'} | {type:'tag', value:'id or name'}
function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object') return { scope: { type: 'all' } };
  const type = scope.type || 'all';
  if (!SCOPE_TYPES.includes(type)) return { error: `scope.type must be one of ${SCOPE_TYPES.join(', ')}` };
  if (type === 'all') return { scope: { type } };
  if (type === 'hosts') {
    const ids = Array.isArray(scope.ids) ? scope.ids.map(String).filter(Boolean) : [];
    return ids.length ? { scope: { type, ids } } : { error: 'scope.ids must list at least one host' };
  }
  const value = String(scope.value || '').trim();
  return value ? { scope: { type, value } } : { error: `scope.value is required for ${type}` };
}

function matchesScope(db, scope, hostId) {
  if (!scope || scope.type === 'all' || !scope.type) return true;
  if (scope.type === 'hosts') return (scope.ids || []).includes(hostId);
  if (scope.type === 'group') {
    return !!db.prepare(`SELECT 1 FROM groups g WHERE (g.id = @v OR g.name = @v COLLATE NOCASE) AND
      (EXISTS (SELECT 1 FROM host_groups hg WHERE hg.group_id = g.id AND hg.host_id = @h)
       OR EXISTS (SELECT 1 FROM hosts x WHERE x.id = @h AND x.group_id = g.id))`).get({ v: scope.value, h: hostId });
  }
  if (scope.type === 'tag') {
    return !!db.prepare(`SELECT 1 FROM tags t JOIN host_tags ht ON ht.tag_id = t.id
      WHERE (t.id = @v OR t.name = @v COLLATE NOCASE) AND ht.host_id = @h`).get({ v: scope.value, h: hostId });
  }
  return false;
}

// Weekly recurrence <-> cron. days are 0 (Sunday) to 6, time is HH:MM.
function toCron(days, time) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(time || ''));
  if (!m) return { error: 'time must be HH:MM' };
  const list = [...new Set((Array.isArray(days) ? days : []).map(d => (typeof d === 'string' && isNaN(d) ? DAY_NAMES.indexOf(d.slice(0, 3).toLowerCase()) : Number(d))))];
  if (!list.length || list.some(d => !Number.isInteger(d) || d < 0 || d > 6)) return { error: 'days must list weekdays 0 (Sunday) to 6 (Saturday)' };
  return { cron: `${Number(m[2])} ${Number(m[1])} * * ${list.sort().join(',')}` };
}

function fromCron(cron) {
  const f = String(cron || '').split(/\s+/);
  if (f.length !== 5) return null;
  return { days: f[4].split(',').map(Number), time: `${String(f[1]).padStart(2, '0')}:${String(f[0]).padStart(2, '0')}` };
}

function createMaintenance(ctx) {
  const { db } = ctx;
  const tz = () => ctx.settings.get('timezone') || 'Europe/Dublin';

  const view = row => ({
    id: row.id, name: row.name, scope: parseJson(row.scope, { type: 'all' }), kind: row.cron ? 'recurring' : 'one-off',
    starts_at: row.starts_at || null, ends_at: row.ends_at || null,
    recurrence: row.cron ? { ...fromCron(row.cron), duration_min: row.duration_min } : null,
    created_at: row.created_at, updated_at: row.updated_at
  });

  const list = () => db.prepare('SELECT * FROM maintenance_windows ORDER BY created_at DESC').all().map(view);

  function active(row, at) {
    const t = at.getTime();
    if (!row.cron) return !!row.starts_at && new Date(row.starts_at).getTime() <= t && t < new Date(row.ends_at).getTime();
    try {
      // The latest occurrence at or before `at` (one second added because prev() is strictly before).
      const prev = CronExpressionParser.parse(row.cron, { currentDate: new Date(t + 1000), tz: tz() }).prev().toDate().getTime();
      return t < prev + (row.duration_min || 0) * 60000;
    } catch { return false; }
  }

  // First window that covers the host at `at`, or null.
  function windowFor(hostId, at = new Date()) {
    for (const row of db.prepare('SELECT * FROM maintenance_windows').all()) {
      if (matchesScope(db, parseJson(row.scope, { type: 'all' }), hostId) && active(row, at)) return view(row);
    }
    return null;
  }

  // Parse and validate a request body. Returns { error } or { value } ready for the table.
  function parse(body, existing) {
    const b = { ...(existing ? view(existing) : {}), ...body };
    const name = String(b.name || '').trim();
    if (!name) return { error: 'name is required' };
    const sc = normalizeScope(b.scope);
    if (sc.error) return sc;
    if (b.recurrence) {
      const c = toCron(b.recurrence.days, b.recurrence.time);
      if (c.error) return c;
      const dur = Number(b.recurrence.duration_min);
      if (!Number.isInteger(dur) || dur < 1 || dur > 10080) return { error: 'recurrence.duration_min must be 1 to 10080' };
      return { value: { name, scope: JSON.stringify(sc.scope), starts_at: null, ends_at: null, cron: c.cron, duration_min: dur } };
    }
    const s = new Date(b.starts_at);
    const e = new Date(b.ends_at);
    if (isNaN(s) || isNaN(e)) return { error: 'starts_at and ends_at (or recurrence) are required' };
    if (e <= s) return { error: 'ends_at must be after starts_at' };
    return { value: { name, scope: JSON.stringify(sc.scope), starts_at: s.toISOString(), ends_at: e.toISOString(), cron: null, duration_min: null } };
  }

  return {
    list, windowFor, view, parse,
    isInMaintenance: (hostId, at = new Date()) => !!windowFor(hostId, at),
    get: id => { const r = db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(id); return r ? view(r) : null; },
    create(body) {
      const p = parse(body);
      if (p.error) return p;
      const now = new Date().toISOString();
      const id = randomUUID();
      db.prepare(`INSERT INTO maintenance_windows (id, name, scope, starts_at, ends_at, cron, duration_min, created_at, updated_at)
        VALUES (@id, @name, @scope, @starts_at, @ends_at, @cron, @duration_min, @now, @now)`).run({ ...p.value, id, now });
      return { window: db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(id) };
    },
    update(id, body) {
      const row = db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(id);
      if (!row) return { status: 404, error: 'Window not found' };
      // Switching kind: a body with recurrence drops the one-off fields and the other way round.
      const base = body.recurrence ? { ...body, starts_at: undefined, ends_at: undefined } : body;
      const p = parse(body.starts_at ? { ...base, recurrence: null } : base, row);
      if (p.error) return p;
      db.prepare(`UPDATE maintenance_windows SET name = @name, scope = @scope, starts_at = @starts_at, ends_at = @ends_at,
        cron = @cron, duration_min = @duration_min, updated_at = @now WHERE id = @id`).run({ ...p.value, id, now: new Date().toISOString() });
      return { window: db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(id) };
    },
    remove: id => db.prepare('DELETE FROM maintenance_windows WHERE id = ?').run(id).changes > 0
  };
}

module.exports = { createMaintenance, matchesScope, normalizeScope, toCron, fromCron };
