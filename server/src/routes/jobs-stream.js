// Phase 6 streaming: per-job SSE (GET /api/jobs/:id/stream), job groups (one child job per host) and log search.
// Job stream events: meta {total, start, status}, chunk {seq, stream, ts, chunk} (id = byte offset after the chunk),
// status {status}, then done {status, exit_code, duration_ms, error}. Last-Event-ID resumes from that offset.
const fs = require('fs');
const readline = require('readline');

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const SLICE = 200000; // characters per chunk event when replaying a large log

module.exports = (app, ctx) => {
  const { db, jobs, joblog, events } = ctx;
  const actor = req => req.user?.username;
  const closed = s => !jobs.OPEN_STATES.includes(s);

  function openSse(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const send = (event, data, id) => res.write(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const hb = setInterval(() => res.write(': hb\n\n'), ctx.sseHeartbeatMs || 15000);
    const cleanups = [() => clearInterval(hb)];
    const run = () => { while (cleanups.length) cleanups.pop()(); };
    req.on('close', run);
    return { send, onClose: fn => cleanups.push(fn), close() { run(); res.end(); } };
  }

  app.get('/api/jobs/:id/stream', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    const sse = openSse(req, res);
    const buf = joblog.readBuffer(job.id);
    const lastId = req.get('last-event-id');
    let start = Number(lastId || req.query.from) || 0;
    const tail = Number(req.query.tail) || 0;
    if (!lastId && req.query.from === undefined && tail && buf.length > tail) {
      start = buf.length - tail;
      const nl = buf.indexOf(10, start - 1); // begin at a line start so the first line is whole
      if (nl >= 0) start = nl + 1;
    }
    start = Math.max(0, Math.min(start, buf.length));
    sse.send('meta', { total: buf.length, start, status: job.status });

    const sendChunk = (stream, ts, text, id) => {
      for (let i = 0; i < text.length; i += SLICE) {
        const last = i + SLICE >= text.length;
        sse.send('chunk', { seq: null, stream, ts, chunk: text.slice(i, i + SLICE) }, last ? id : undefined);
      }
    };
    for (const e of joblog.replay(job.id, start, buf)) sendChunk(e.stream, e.ts, e.chunk, e.end);

    const finish = j => {
      const ms = j.duration_ms ?? (j.started_at && j.completed_at ? new Date(j.completed_at) - new Date(j.started_at) : null);
      sse.send('done', { status: j.status, exit_code: j.exit_code, duration_ms: ms, error: j.error || '' });
      sse.close();
    };
    if (closed(job.status)) return finish(job);

    let pos = buf.length;
    const onOut = e => {
      if (e.job_id !== job.id) return;
      pos += Buffer.byteLength(e.chunk);
      sendChunk(e.stream, e.ts, e.chunk, pos);
    };
    const onJob = j => {
      if (j.id !== job.id) return;
      if (closed(j.status)) finish(j); else sse.send('status', { status: j.status });
    };
    events.on('job_output', onOut);
    events.on('job', onJob);
    sse.onClose(() => { events.off('job_output', onOut); events.off('job', onJob); });
  });

  // ── Job groups ──────────────────────────────────────────
  app.get('/api/job-groups', (req, res) => {
    const rows = db.prepare('SELECT id FROM job_groups ORDER BY created_at DESC LIMIT ?').all(Math.min(200, Number(req.query.limit) || 50));
    res.json(rows.map(r => { const { hosts, ...s } = jobs.groupSummary(r.id); return s; }));
  });
  app.get('/api/job-groups/:id', (req, res) => {
    const s = jobs.groupSummary(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
  });
  app.post('/api/job-groups/:id/retry-failed', (req, res) => {
    const r = jobs.retryFailed(req.params.id, actor(req));
    if (!r) return res.status(404).json({ error: 'Not found' });
    if (!r.group) return res.status(400).json({ error: 'No failed hosts in this group' });
    ctx.audit(actor(req), 'jobs.retry_failed', null, { group_id: req.params.id, new_group_id: r.group.id, hosts: r.jobs.length });
    res.json({ group_id: r.group.id, jobs: r.jobs.map(j => ({ id: j.id, host_id: j.host_id })) });
  });
  // Status changes only: a full summary on every child job change, plus throttled `tile` notices (last output line).
  app.get('/api/job-groups/:id/stream', (req, res) => {
    const id = req.params.id;
    if (!jobs.getGroup(id)) return res.status(404).json({ error: 'Not found' });
    const sse = openSse(req, res);
    const members = new Set(db.prepare('SELECT id FROM jobs WHERE group_id = ?').all(id).map(r => r.id));
    const sendSummary = () => {
      const s = jobs.groupSummary(id);
      sse.send('status', s);
      if (s.finished) sse.close();
    };
    sendSummary();
    const lastTile = new Map();
    const onJob = j => { if (j.group_id === id) { members.add(j.id); sendSummary(); } };
    const onOut = e => {
      if (!members.has(e.job_id) || Date.now() - (lastTile.get(e.job_id) || 0) < 1000) return;
      const line = jobs.lastLine(e.chunk);
      if (!line) return;
      lastTile.set(e.job_id, Date.now());
      sse.send('tile', { job_id: e.job_id, last_line: line, bytes_received: db.prepare('SELECT bytes_received FROM jobs WHERE id = ?').get(e.job_id)?.bytes_received });
    };
    events.on('job', onJob);
    events.on('job_output', onOut);
    sse.onClose(() => { events.off('job', onJob); events.off('job_output', onOut); });
  });

  // ── Search across job logs ──────────────────────────────
  // Case-insensitive substring over the newest 500 matching jobs, reading each log as a stream.
  async function scan(job, hostname, needle, out, limit) {
    let n = 0, prev = '', pending = null, found = 0;
    for (const p of joblog.files(job.id)) {
      const rl = readline.createInterface({ input: fs.createReadStream(p, 'utf8'), crlfDelay: Infinity });
      for await (const raw of rl) {
        n++;
        const text = raw.replace(ANSI, '').slice(0, 400);
        if (pending) { pending.after = [text]; pending = null; }
        if (found >= 20 || out.length >= limit) { if (!pending) { rl.close(); return; } continue; }
        if (text.toLowerCase().includes(needle)) {
          pending = { job_id: job.id, host_id: job.host_id, hostname, status: job.status, type: job.type, created_at: job.created_at, line: n, text, before: prev ? [prev] : [], after: [] };
          out.push(pending);
          found++;
        }
        prev = text;
      }
    }
  }

  app.get('/api/logs/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.status(400).json({ error: 'q must be at least 2 characters' });
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const where = [];
    const args = [];
    if (req.query.host) { where.push('(j.host_id = ? OR h.hostname = ?)'); args.push(req.query.host, req.query.host); }
    if (req.query.status) { where.push('j.status = ?'); args.push(req.query.status); }
    if (req.query.from) { where.push('j.created_at >= ?'); args.push(req.query.from); }
    if (req.query.to) { where.push('j.created_at <= ?'); args.push(req.query.to); }
    const rows = db.prepare(`SELECT j.*, h.hostname AS hostname FROM jobs j LEFT JOIN hosts h ON h.id = j.host_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY j.created_at DESC LIMIT 500`).all(...args);
    const matches = [];
    let scanned = 0;
    try {
      for (const j of rows) {
        if (matches.length >= limit) break;
        scanned++;
        await scan(j, j.hostname || j.host_id, q.toLowerCase(), matches, limit);
      }
    } catch (err) {
      ctx.logger.error('[logs/search]', err.message);
      return res.status(500).json({ error: 'Search failed' });
    }
    res.json({ q, scanned, truncated: matches.length >= limit, matches });
  });
};
