// Backups, config export and config import (A10c). All routes are admin only, except POST /api/backup/run,
// which the updater sidecar also calls with the header X-Updater-Secret (constant time compare against LABCTL_UPDATER_SECRET).
const fs = require('fs');
const { createBackups, validateSettings, secretMatches } = require('../backup');
const { createConfigIo } = require('../configio');

module.exports = (app, ctx) => {
  const admin = ctx.requireRole('admin');
  const backups = ctx.backups = createBackups(ctx);
  const io = createConfigIo(ctx);
  backups.start();
  const closeAgents = ctx.agents.close; // same hook the ssh poller uses: stop timers before the db closes
  ctx.agents.close = () => { backups.stop(); closeAgents(); };

  const status = () => {
    const files = backups.list();
    return { ...backups.settings(), timezone: ctx.settings.get('timezone'), last: backups.last(), next: backups.next(),
      count: files.length, total_size: files.reduce((n, f) => n + f.size, 0), directory: 'data/backups' };
  };
  const validFile = (req, res, next) => (backups.resolve(req.params.file) ? next() : res.status(400).json({ error: 'Invalid backup file name' }));

  app.get('/api/backup/status', admin, (req, res) => res.json(status()));

  app.put('/api/backup/settings', admin, (req, res) => {
    const r = validateSettings(req.body || {});
    if (r.error) return res.status(400).json({ error: r.error });
    for (const [k, v] of Object.entries(r.values)) ctx.settings.set(k, v);
    backups.reschedule();
    if (r.values.backup_keep_days !== undefined) backups.prune();
    res.json(status());
  });

  app.get('/api/backups', admin, (req, res) => res.json(backups.list()));

  // Public to the session gate so the sidecar needs no session. The handler checks the secret or an admin session itself.
  ctx.allowPublic('/backup/run');
  app.post('/api/backup/run', async (req, res, next) => {
    try {
      const given = req.get('x-updater-secret');
      if (given !== undefined) {
        if (!secretMatches(given, process.env.LABCTL_UPDATER_SECRET)) return res.status(401).json({ error: 'Invalid updater secret' });
        req.user = { username: 'updater', role: 'admin' };
      } else {
        const user = ctx.auth.userForToken(ctx.auth.getSessionToken(req));
        if (!user) return res.status(401).json({ error: 'Authentication required' });
        if (ctx.auth.rank(user.role) < ctx.auth.rank('admin')) return res.status(403).json({ error: 'admin role required' });
        req.user = user;
      }
      const r = await backups.run();
      if (!r.ok) return res.status(500).json({ error: `Backup failed: ${r.error}` });
      res.json({ ok: true, file: r.file, size: r.size, at: r.at });
    } catch (err) { next(err); }
  });

  app.get('/api/backups/:file/download', admin, validFile, (req, res) => {
    const p = backups.resolve(req.params.file);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'Backup not found' });
    res.download(p, req.params.file);
  });

  app.delete('/api/backups/:file', admin, validFile, ctx.requireConfirm(req => req.params.file), (req, res) => {
    if (!backups.remove(req.params.file)) return res.status(404).json({ error: 'Backup not found' });
    res.json({ deleted: req.params.file });
  });

  // ---- config export and import ----
  app.get('/api/config/export', admin, (req, res) => {
    const out = io.exportConfig();
    ctx.audit(req.user.username, 'config.export', null, Object.fromEntries(Object.entries(out.data).map(([k, v]) => [k, Array.isArray(v) ? v.length : Object.keys(v).length])));
    res.set('Content-Disposition', `attachment; filename="labctl-config-${out.exported_at.slice(0, 10)}.json"`);
    res.json(out);
  });

  // A real import needs the typed word IMPORT. A dry run (the default when dry_run is missing) changes nothing.
  app.post('/api/config/import', admin, (req, res, next) => (req.body?.dry_run === false ? ctx.requireConfirm('IMPORT')(req, res, next) : next()), (req, res, next) => {
    const body = req.body || {};
    req.body = { mode: body.mode, sections: body.sections, dry_run: body.dry_run }; // keep the audit row small: counts only
    try { res.json(io.importConfig(body, req.user.username)); } catch (err) {
      if (err.expose) return res.status(err.status || 400).json({ error: err.message, plan: err.plan, counts: err.counts });
      next(err);
    }
  });
};
