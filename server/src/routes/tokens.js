// Enrolment tokens. Admin only. The value is in the response once (create, rotate) and never again.
module.exports = (app, ctx) => {
  const admin = ctx.requireRole('admin');
  app.get('/api/tokens', admin, (req, res) => res.json(ctx.tokens.list()));
  app.post('/api/tokens', admin, (req, res) => {
    res.json(ctx.tokens.create(req.body?.label, req.user.username));
  });
  app.post('/api/tokens/:id/rotate', admin, (req, res) => {
    const t = ctx.tokens.rotate(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    ctx.agents.disconnectToken(req.params.id);
    res.json(t);
  });
  app.post('/api/tokens/:id/revoke', admin, (req, res) => {
    if (!ctx.tokens.get(req.params.id)) return res.status(404).json({ error: 'Not found' });
    ctx.tokens.revoke(req.params.id);
    ctx.agents.disconnectToken(req.params.id);
    res.json({ ok: true });
  });
};
