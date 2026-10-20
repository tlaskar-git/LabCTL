// GET /api/events: SSE of small change notices only. `host` {id, status, online} when a host goes online or offline
// and `job` {id, host_id, group_id, status} on every job status change. Clients re-fetch what they show (see api.js).
module.exports = (app, ctx) => {
  const { db, agents, events } = ctx;
  app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const key = h => `${h.status}|${agents.isOnline(h.id)}`;
    const seen = new Map(db.prepare('SELECT id, status FROM hosts').all().map(h => [h.id, key(h)]));
    const onHost = h => {
      if (!h || seen.get(h.id) === key(h)) return;
      seen.set(h.id, key(h));
      send('host', { id: h.id, status: h.status, online: agents.isOnline(h.id) });
    };
    const onJob = j => send('job', { id: j.id, host_id: j.host_id, group_id: j.group_id || null, status: j.status });
    events.on('host', onHost);
    events.on('job', onJob);
    const hb = setInterval(() => res.write(': hb\n\n'), ctx.sseHeartbeatMs || 15000);
    req.on('close', () => { clearInterval(hb); events.off('host', onHost); events.off('job', onJob); });
  });
};
