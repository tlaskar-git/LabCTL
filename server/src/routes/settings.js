// Settings: any signed-in user reads, admin writes. Retention and timezone changes apply at once.
module.exports = (app, ctx) => {
  app.get('/api/settings', (req, res) => res.json(ctx.settings.all()));
  app.put('/api/settings', ctx.requireRole('admin'), (req, res) => {
    const before = ctx.settings.get('timezone');
    const result = ctx.settings.update(req.body || {});
    if (result.error) return res.status(400).json({ error: result.error });
    if (ctx.settings.get('timezone') !== before) ctx.scheduler.recomputeAll();
    if (result.changed.some(k => k.endsWith('_days'))) ctx.retention.run();
    res.json(ctx.settings.all());
  });
};
