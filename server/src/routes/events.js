// GET /api/events: v1 SSE state snapshot every 3 s (hosts and the 20 newest jobs). A6 replaces this with a live stream.
module.exports = (app, ctx) => {
  const { db, agents, jobs } = ctx;
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    const i = setInterval(() => {
      const hosts = db.prepare('SELECT * FROM hosts').all().map(agents.hostOut);
      const recent = jobs.list({ limit: 20 }).map(j => jobs.out(j));
      res.write(`data: ${JSON.stringify({ hosts, jobs: recent })}\n\n`);
    }, 3000);
    req.on('close', () => clearInterval(i));
  });
};
