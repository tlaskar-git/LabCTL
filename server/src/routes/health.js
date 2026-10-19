// GET /api/health: public liveness for Docker and monitors. No host data here (see /api/health/hosts).
module.exports = (app, ctx) => {
  app.get('/api/health', (req, res) => {
    let dbStatus = 'ok';
    try { ctx.db.prepare('SELECT 1').get(); } catch { dbStatus = 'error'; }
    res.status(dbStatus === 'ok' ? 200 : 503).json({
      status: dbStatus === 'ok' ? 'ok' : 'degraded',
      version: ctx.version,
      uptime_s: Math.round((Date.now() - ctx.startedAt) / 1000),
      db: dbStatus
    });
  });
};
