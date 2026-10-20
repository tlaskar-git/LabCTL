// Patch policies (/api/patch-policies) and their runs (/api/patch-runs). The engine is in src/patching.js.
// Writes need operator (app.js). A policy that can reboot runs guard templates: enabling it, and running it by hand,
// needs body.confirm to equal the policy name. A dry run changes nothing and needs no confirmation.
// Exports (app, ctx) => void.
const { createPatching } = require('../patching');

module.exports = (app, ctx) => {
  const patching = createPatching(ctx);
  ctx.patching = patching;
  patching.startTimer();
  const actor = req => req.user?.username;
  const needConfirm = (res, policy) => res.status(400).json({ error: 'Typed confirmation required', confirm_required: true, confirm_word: policy.name });
  const found = (res, p) => (p ? true : !res.status(404).json({ error: 'Policy not found' }));

  app.get('/api/patch-policies', (req, res) => res.json(patching.list()));
  app.get('/api/patch-policies/:id', (req, res) => { const p = patching.get(req.params.id); if (found(res, p)) res.json(p); });

  app.post('/api/patch-policies', (req, res) => {
    const n = patching.normalise(req.body);
    if (n.error) return res.status(400).json({ error: n.error });
    const draft = { ...n.value, guarded: patching.guarded(n.value) };
    if (n.value.enabled && draft.guarded && req.body?.confirm !== n.value.name) return needConfirm(res, n.value);
    res.json(patching.get(patching.save(n.value)));
  });

  app.put('/api/patch-policies/:id', (req, res) => {
    const cur = patching.get(req.params.id);
    if (!found(res, cur)) return;
    const n = patching.normalise(req.body, cur);
    if (n.error) return res.status(400).json({ error: n.error });
    const after = n.value.enabled && patching.guarded(n.value);
    if (after && !(cur.enabled && cur.guarded) && req.body?.confirm !== n.value.name) return needConfirm(res, n.value);
    patching.save(n.value, cur.id);
    res.json(patching.get(cur.id));
  });

  app.delete('/api/patch-policies/:id', (req, res) => {
    if (!patching.remove(req.params.id)) return res.status(404).json({ error: 'Policy not found' });
    res.json({ ok: true });
  });

  app.post('/api/patch-policies/:id/run', (req, res) => {
    const policy = patching.get(req.params.id);
    if (!found(res, policy)) return;
    const dry = !!req.body?.dry_run;
    if (!dry && policy.guarded && req.body?.confirm !== policy.name) return needConfirm(res, policy);
    let r;
    try { r = patching.start(policy, { dry_run: dry, trigger: 'manual', actor: actor(req) }); } catch (err) { return res.status(400).json({ error: err.message }); }
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json({ run_id: r.run.id, status: r.run.status, dry_run: dry });
  });

  app.get('/api/patch-policies/:id/runs', (req, res) => {
    if (!found(res, patching.get(req.params.id))) return;
    res.json(patching.listRuns({ policy_id: req.params.id, limit: Math.min(200, Number(req.query.limit) || 50) }));
  });
  app.get('/api/patch-runs', (req, res) => res.json(patching.listRuns({ limit: Math.min(200, Number(req.query.limit) || 50) })));
  app.get('/api/patch-runs/:id', (req, res) => {
    const run = patching.getRun(req.params.id);
    run ? res.json(run) : res.status(404).json({ error: 'Run not found' });
  });
};
