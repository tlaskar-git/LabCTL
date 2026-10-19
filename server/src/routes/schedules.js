// Cron schedules. next_run is computed with cron-parser in the timezone setting.
const { randomUUID } = require('crypto');
module.exports = (app, ctx) => {
  const { db, scheduler } = ctx;
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
