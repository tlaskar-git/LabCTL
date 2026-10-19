// One-time import of the v1 JSON store (data/labctl-data.json) into SQLite.
// Steps: timestamped backup copy, import in one transaction, then rename the source to *.migrated-<stamp>.
// Idempotent: the _legacy_import_done setting stops a second import, and INSERT OR IGNORE skips existing rows.
const fs = require('fs');
const { sha256 } = require('./crypto');

function migrateLegacyJson(ctx, candidates) {
  const source = candidates.find(p => fs.existsSync(p));
  if (!source) return null;
  if (ctx.settings.get('_legacy_import_done')) {
    ctx.logger.warn(`Legacy data file found but an import already ran. Left untouched: ${source}`);
    return null;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${source}.bak-${stamp}`;
  fs.copyFileSync(source, backup);
  const old = JSON.parse(fs.readFileSync(source, 'utf8'));
  const { db, crypto, joblog } = ctx;
  const vals = o => Object.values(o && typeof o === 'object' ? o : {});
  const str = v => (v === undefined || v === null ? null : typeof v === 'string' ? v : JSON.stringify(v));
  const counts = {};
  const ins = (table, row) => {
    const keys = Object.keys(row);
    const r = db.prepare(`INSERT OR IGNORE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(k => '@' + k).join(', ')})`).run(row);
    counts[table] = (counts[table] || 0) + r.changes;
  };

  db.transaction(() => {
    for (const u of vals(old.users)) {
      ins('users', { id: u.id, username: u.username, role: u.role === 'admin' ? 'admin' : 'viewer',
        password_hash: u.password_hash, created_at: u.created_at || null, updated_at: u.updated_at || null });
    }
    for (const [token, s] of Object.entries(old.sessions || {})) {
      ins('sessions', { token_hash: sha256(s.token || token), user_id: s.user_id, created_at: s.created_at || null, last_seen: s.last_seen || null });
    }
    for (const g of vals(old.groups)) {
      ins('groups', { id: g.id, name: g.name, color: g.color || null, ord: Number(g.order) || 0, created_at: g.created_at || null });
    }
    for (const h of vals(old.hosts)) {
      ins('hosts', { id: h.id, hostname: h.hostname || null, os: h.os || null, ip: h.ip || null, kind: 'agent',
        status: 'offline', last_seen: h.last_seen || null, group_id: h.group_id || null,
        system_info: str(h.system_info || {}), created_at: h.created_at || null, updated_at: h.last_seen || null });
      if (h.group_id) ins('host_groups', { host_id: h.id, group_id: h.group_id });
    }
    for (const j of vals(old.jobs)) {
      // Unfinished v1 jobs cannot resume after the move, so they are closed as cancelled.
      const open = ['pending', 'sent', 'running', 'waiting'].includes(j.status);
      ins('jobs', { id: j.id, host_id: j.host_id || null, type: j.type || 'unknown', params: str(j.params) || '{}',
        status: open ? 'cancelled' : (j.status || 'completed'), error: String(j.error || ''), script_id: j.script_id || null,
        created_at: j.created_at || new Date(0).toISOString(), started_at: j.started_at || null,
        completed_at: j.completed_at || null });
      if (j.result) joblog.write(j.id, j.result);
    }
    for (const s of vals(old.schedules)) {
      let next = null;
      try { next = ctx.scheduler.nextRun(s.cron); } catch { /* invalid v1 cron stays unscheduled */ }
      ins('schedules', { id: s.id, name: s.name || 'Schedule', host_id: s.host_id || null, type: s.type || 'unknown',
        params: str(s.params) || '{}', cron: s.cron || '', enabled: s.enabled === false ? 0 : 1, last_run: s.last_run || null,
        next_run: next, created_at: s.created_at || null, updated_at: s.created_at || null });
    }
    for (const c of vals(old.credentials)) {
      ins('credentials', { id: c.id, host_id: c.host_id || null, username: c.username || null, purpose: c.purpose || 'autologin',
        kind: 'password', sealed: crypto.sealJson({ password: c.password || '' }), created_at: c.created_at || null, updated_at: c.created_at || null });
    }
    for (const s of vals(old.scripts)) {
      ins('scripts', { id: s.id, name: s.name, description: s.description || '', os: s.os || 'any', target: s.target || 'host',
        command: s.command || '', timeout: Number(s.timeout) || 300, builtin: s.builtin ? 1 : 0,
        created_at: s.created_at || null, updated_at: s.updated_at || null });
    }
    for (const m of Array.isArray(old.metrics) ? old.metrics : []) {
      if (!m || !m.host_id) continue;
      const { id, host_id, created_at, ...data } = m;
      ins('metrics', { id: id || `${host_id}-${created_at}`, host_id, created_at: created_at || new Date(0).toISOString(), data: JSON.stringify(data) });
    }
    const os = old.settings || {};
    const patch = {};
    for (const k of ['poll_interval_seconds', 'theme']) if (os[k] !== undefined) patch[k] = os[k];
    if (os.retention_days !== undefined) patch.metrics_days = os.retention_days;
    ctx.settings.update(patch);
    ctx.settings.set('_legacy_import_done', { at: new Date().toISOString(), from: 'labctl-data.json' });
  })();

  const migrated = `${source}.migrated-${stamp}`;
  fs.renameSync(source, migrated);
  ctx.audit('system', 'legacy.import', null, { counts });
  ctx.logger.info(`[migrate] Imported v1 JSON data (${JSON.stringify(counts)}). Backup: ${backup}`);
  return { counts, backup, migrated };
}

module.exports = { migrateLegacyJson };
