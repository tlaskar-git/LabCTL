// Alerts, alert rules and alert settings (A10a). The engine lives in src/alerting/.
// GET /api/alerts?state=active|ack|silenced|pending|resolved|all&severity=&host=&rule=&limit=&offset=
// GET /api/alerts/history, POST /api/alerts/:id/ack, POST /api/alerts/:id/silence {minutes}
// GET/POST /api/alert-rules, PUT/DELETE /api/alert-rules/:id, POST /api/alert-rules/:id/(enable|disable|silence|test)
// POST /api/alert-rules/test (dry run of an unsaved rule), GET /api/alert-metrics, GET/PUT /api/alert-config
const { ensure } = require('../alerting/engine');
const { OPS, SEVERITIES } = require('../alerting/rules');

module.exports = (app, ctx) => {
  const alerting = ensure(ctx);
  const bad = (res, error, status = 400) => res.status(status).json({ error });
  const minutes = body => { const n = Number(body?.minutes); return Number.isFinite(n) && n >= 0 && n <= 43200 ? Math.round(n) : null; };

  app.get('/api/alerts', (req, res) => {
    const out = alerting.listAlerts(req.query);
    out.error ? bad(res, out.error) : res.json(out);
  });
  app.get('/api/alerts/history', (req, res) => res.json(alerting.listAlerts({ ...req.query, history: true })));
  app.get('/api/alerts/:id', (req, res) => {
    const a = alerting.getAlert(req.params.id);
    a ? res.json(a) : bad(res, 'Alert not found', 404);
  });
  app.post('/api/alerts/:id/ack', (req, res) => {
    const a = alerting.ack(req.params.id, req.user?.username);
    a ? res.json(a) : bad(res, 'Alert not found or already resolved', 404);
  });
  app.post('/api/alerts/:id/silence', (req, res) => {
    const m = minutes(req.body);
    if (m === null) return bad(res, 'minutes must be 0 to 43200 (0 clears the silence)');
    const a = alerting.silence(req.params.id, m);
    a ? res.json(a) : bad(res, 'Alert not found or already resolved', 404);
  });

  app.get('/api/alert-metrics', (req, res) => res.json({
    metrics: Object.entries(alerting.METRICS).map(([id, m]) => ({ id, label: m.label, unit: m.unit.trim(), scope: m.scope, flag: !!m.flag })),
    ops: Object.keys(OPS), severities: SEVERITIES
  }));
  app.get('/api/alert-config', (req, res) => res.json(alerting.config()));
  app.put('/api/alert-config', ctx.requireRole('admin'), (req, res) => {
    try { res.json(alerting.setConfig(req.body || {})); } catch (err) { bad(res, err.message); }
  });

  app.get('/api/alert-rules', (req, res) => res.json(alerting.listRules()));
  // Dry run of an unsaved rule. Declared before /:id so "test" is not read as an id.
  app.post('/api/alert-rules/test', (req, res) => {
    const v = alerting.validateRule(req.body || {});
    v.error ? bad(res, v.error) : res.json(alerting.dryRun(v.rule));
  });
  app.post('/api/alert-rules', (req, res) => {
    const v = alerting.validateRule(req.body || {});
    if (v.error) return bad(res, v.error);
    res.status(201).json(alerting.getRule(alerting.saveRule(v.rule)));
  });
  app.get('/api/alert-rules/:id', (req, res) => {
    const r = alerting.getRule(req.params.id);
    r ? res.json(r) : bad(res, 'Rule not found', 404);
  });
  app.put('/api/alert-rules/:id', (req, res) => {
    const old = alerting.getRule(req.params.id);
    if (!old) return bad(res, 'Rule not found', 404);
    const v = alerting.validateRule(req.body || {}, old);
    if (v.error) return bad(res, v.error);
    alerting.saveRule(v.rule, old.id);
    res.json(alerting.getRule(old.id));
  });
  app.delete('/api/alert-rules/:id', (req, res) => (alerting.deleteRule(req.params.id) ? res.json({ ok: true }) : bad(res, 'Rule not found', 404)));
  for (const [path, enabled] of [['enable', true], ['disable', false]]) {
    app.post(`/api/alert-rules/:id/${path}`, (req, res) => {
      const old = alerting.getRule(req.params.id);
      if (!old) return bad(res, 'Rule not found', 404);
      alerting.saveRule({ ...old, enabled }, old.id);
      res.json(alerting.getRule(old.id));
    });
  }
  app.post('/api/alert-rules/:id/silence', (req, res) => {
    const m = minutes(req.body);
    if (m === null) return bad(res, 'minutes must be 0 to 43200 (0 clears the silence)');
    const r = alerting.silenceRule(req.params.id, m);
    r ? res.json(r) : bad(res, 'Rule not found', 404);
  });
  app.post('/api/alert-rules/:id/test', (req, res) => {
    const r = alerting.getRule(req.params.id);
    r ? res.json(alerting.dryRun(r)) : bad(res, 'Rule not found', 404);
  });
};
