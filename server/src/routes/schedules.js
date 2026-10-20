// Cron schedules. next_run is computed with cron-parser in the timezone setting.
// Also the built-in schedules (/api/builtin-schedules, see src/builtin-schedules.js) and the maintenance guard: a job the
// scheduler creates for a host in a maintenance window is stored as skipped ("skipped: maintenance").
const { randomUUID } = require('crypto');
const { createBuiltins, installMaintenanceGuard } = require('../builtin-schedules');
module.exports = (app, ctx) => {
  const { db, scheduler } = ctx;
  installMaintenanceGuard(ctx);
  const builtins = createBuiltins(ctx);
  ctx.builtins = builtins;
  builtins.startTimer();
  ctx.onClose(() => builtins.stopTimer());
  const reply = (res, r) => (r.view ? res.json(r.result ? { ...r.view, result: r.result } : r.view) : res.status(r.status).json({ error: r.error }));
  app.get('/api/builtin-schedules', (req, res) => res.json(builtins.list()));
  app.post('/api/builtin-schedules/:key/enable', (req, res) => {
    // The weekly patching schedule reboots hosts, so it needs its key typed.
    if (req.params.key === 'patch_weekly' && req.body?.confirm !== 'patch_weekly') {
      return res.status(400).json({ error: 'Typed confirmation required', confirm_required: true, confirm_word: 'patch_weekly' });
    }
    reply(res, builtins.enable(req.params.key, { cron: req.body?.cron }));
  });
  app.post('/api/builtin-schedules/:key/disable', (req, res) => reply(res, builtins.disable(req.params.key)));
  app.put('/api/builtin-schedules/:key', (req, res) => reply(res, builtins.update(req.params.key, { cron: req.body?.cron })));
  app.post('/api/builtin-schedules/:key/run', async (req, res, next) => {
    try { reply(res, await builtins.runNow(req.params.key, req.user?.username)); } catch (err) { next(err); }
  });
  app.get('/api/schedules', (req, res) => {
    res.json(db.prepare(`SELECT s.*, COALESCE(h.hostname, s.host_id) AS hostname FROM schedules s
      LEFT JOIN hosts h ON h.id = s.host_id ORDER BY s.created_at`).all().map(s => ({ ...s, enabled: !!s.enabled })));
  });
  app.post('/api/schedules', (req, res) => {
    const { name, host_id, type, params = {}, cron } = req.body || {};
    if (!name || !host_id || !type || !cron) return res.status(400).json({ error: 'name, host_id, type, cron required' });
    const bad = scheduler.validate(cron);
    if (bad) return res.status(400).json({ error: `Invalid cron: ${bad}` });
    const now = new Date().toISOString();
    const s = { id: randomUUID(), name, host_id, type, params: JSON.stringify(params), cron: cron.trim(), next_run: scheduler.nextRun(cron), created_at: now };
    db.prepare(`INSERT INTO schedules (id, name, host_id, type, params, cron, enabled, next_run, created_at, updated_at)
      VALUES (@id, @name, @host_id, @type, @params, @cron, 1, @next_run, @created_at, @created_at)`).run(s);
    res.json({ id: s.id, next_run: s.next_run });
  });
  app.put('/api/schedules/:id', (req, res) => {
    const s = db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    const { name, cron, params, enabled } = req.body || {};
    if (name !== undefined) s.name = name;
    if (cron !== undefined) {
      const bad = scheduler.validate(cron);
      if (bad) return res.status(400).json({ error: `Invalid cron: ${bad}` });
      s.cron = cron.trim();
      s.next_run = scheduler.nextRun(s.cron);
    }
    if (params !== undefined) s.params = JSON.stringify(params);
    if (enabled !== undefined) {
      s.enabled = enabled ? 1 : 0;
      if (s.enabled) s.next_run = scheduler.nextRun(s.cron); // a pause does not count as missed runs
    }
    db.prepare('UPDATE schedules SET name = ?, cron = ?, params = ?, enabled = ?, next_run = ?, updated_at = ? WHERE id = ?')
      .run(s.name, s.cron, s.params, s.enabled, s.next_run, new Date().toISOString(), s.id);
    res.json({ ok: true, next_run: s.next_run });
  });
  app.delete('/api/schedules/:id', (req, res) => {
    db.prepare('DELETE FROM schedules WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });
};
