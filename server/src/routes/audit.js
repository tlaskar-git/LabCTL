// GET /api/audit?actor=&action=&host_id=&since=&until=&limit=&offset=  -> { total, limit, offset, rows }
module.exports = (app, ctx) => {
  app.get('/api/audit', (req, res) => res.json(ctx.audit.query(req.query)));
};
