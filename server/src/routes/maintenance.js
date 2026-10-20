// Maintenance windows (A10a). ctx.maintenance.isInMaintenance(hostId, at) is for schedulers and patch policies.
// One-off: { name, scope, starts_at, ends_at }. Weekly: { name, scope, recurrence: { days: [0-6], time: "HH:MM", duration_min } }
// in the timezone setting. scope: { type: all | hosts | group | tag, ids | value }.
const { ensure } = require('../alerting/engine');

module.exports = (app, ctx) => {
  const { maintenance } = ensure(ctx);
  const bad = (res, error, status = 400) => res.status(status).json({ error });

  app.get('/api/maintenance', (req, res) => res.json(maintenance.list()));
  app.get('/api/maintenance/check', (req, res) => {
    const at = req.query.at ? new Date(req.query.at) : new Date();
    if (!req.query.host_id || isNaN(at)) return bad(res, 'host_id and a valid at (optional) are required');
    const w = maintenance.windowFor(req.query.host_id, at);
    res.json({ in_maintenance: !!w, window: w });
  });
  app.post('/api/maintenance', (req, res) => {
    const out = maintenance.create(req.body || {});
    out.error ? bad(res, out.error) : res.status(201).json(maintenance.get(out.window.id));
  });
  app.put('/api/maintenance/:id', (req, res) => {
    const out = maintenance.update(req.params.id, req.body || {});
    out.error ? bad(res, out.error, out.status || 400) : res.json(maintenance.get(out.window.id));
  });
  app.delete('/api/maintenance/:id', (req, res) => (maintenance.remove(req.params.id) ? res.json({ ok: true }) : bad(res, 'Window not found', 404)));
};
