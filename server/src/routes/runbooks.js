// Runbooks: definitions (CRUD) and runs. The engine is in src/runbooks.js.
// A run needs `confirm` (the runbook name) when any step uses a guard:true template. Writes need operator, which
// app.js already enforces for every non-GET /api route.
const { randomUUID } = require('crypto');
const { createRunbooks } = require('../runbooks');

module.exports = (app, ctx) => {
  const { db } = ctx;
  const engine = createRunbooks(ctx);
  ctx.runbooks = engine;
  engine.seed();
  const actor = req => req.user?.username;
  const find = id => engine.rbOut(db.prepare('SELECT * FROM runbooks WHERE id = ?').get(id));

  // Name, description, steps and params from a request body. Returns { value } or { error }.
  function parse(body = {}, current = null) {
    const name = String(body.name ?? current?.name ?? '').trim();
    if (!name || name.length > 120) return { error: 'name is required (up to 120 characters)' };
    const n = engine.normaliseSteps(body.steps ?? current?.steps);
    if (n.error) return { error: n.error };
    const params = body.params ?? current?.params ?? [];
    if (!Array.isArray(params) || params.some(p => !p || !/^[A-Za-z][A-Za-z0-9_]*$/.test(p.name || ''))) return { error: 'params must be a list of {name, default, label}' };
    return { value: { name, description: String(body.description ?? current?.description ?? '').slice(0, 2000), steps: n.steps, params } };
  }

  app.get('/api/runbooks', (req, res) => {
    res.json(db.prepare('SELECT * FROM runbooks ORDER BY name COLLATE NOCASE').all().map(engine.rbOut));
  });
  app.get('/api/runbooks/:id', (req, res) => {
    const rb = find(req.params.id);
    if (!rb) return res.status(404).json({ error: 'Not found' });
    res.json(rb);
  });
  app.post('/api/runbooks', (req, res) => {
    const p = parse(req.body);
    if (p.error) return res.status(400).json({ error: p.error });
    const t = new Date().toISOString();
    const id = randomUUID();
    db.prepare('INSERT INTO runbooks (id, name, description, steps, params, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, p.value.name, p.value.description, JSON.stringify(p.value.steps), JSON.stringify(p.value.params), t, t);
    res.json(find(id));
  });
  app.put('/api/runbooks/:id', (req, res) => {
    const cur = find(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Not found' });
    const p = parse(req.body, cur);
    if (p.error) return res.status(400).json({ error: p.error });
    db.prepare('UPDATE runbooks SET name = ?, description = ?, steps = ?, params = ?, updated_at = ? WHERE id = ?')
      .run(p.value.name, p.value.description, JSON.stringify(p.value.steps), JSON.stringify(p.value.params), new Date().toISOString(), cur.id);
    res.json(find(cur.id));
  });
  app.delete('/api/runbooks/:id', (req, res) => {
    if (!db.prepare('DELETE FROM runbooks WHERE id = ?').run(req.params.id).changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  const reply = (res, r) => (r.run ? res.json({ id: r.run.id, status: r.run.status })
    : res.status(r.status).json({ error: r.error, confirm_required: r.confirm_required, confirm_word: r.confirm_word }));

  app.post('/api/runbooks/:id/run', (req, res) => {
    const rb = db.prepare('SELECT * FROM runbooks WHERE id = ?').get(req.params.id);
    if (!rb) return res.status(404).json({ error: 'Not found' });
    reply(res, engine.start(rb, req.body || {}, actor(req)));
  });

  app.get('/api/runbook-runs', (req, res) => {
    const where = req.query.runbook_id ? 'WHERE runbook_id = ?' : '';
    const rows = db.prepare(`SELECT id FROM runbook_runs ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...(req.query.runbook_id ? [req.query.runbook_id] : []), Math.min(200, Number(req.query.limit) || 50));
    res.json(rows.map(r => engine.getRun(r.id)).map(({ steps, results, ...run }) => ({ ...run, steps: steps.length, failed: results.filter(x => x.status === 'failed').length })));
  });
  app.get('/api/runbook-runs/:id', (req, res) => {
    const run = engine.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Not found' });
    res.json(run);
  });
  app.post('/api/runbook-runs/:id/rerun', (req, res) => {
    const run = engine.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Not found' });
    reply(res, engine.rerun(run, req.body || {}, actor(req)));
  });
};
