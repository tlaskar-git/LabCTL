// Job action templates: list them, and run one on hosts chosen by id, group or tag.
// A run creates one job per host through the normal job path. Secrets come from stored credentials, are put into the
// job environment only when the job is sent to the agent, and are never written to the jobs table, the log or the audit.
// Admins also create, edit, clone, hide, delete and restore templates here (template-store.js keeps the built-in files untouched).
const catalogue = require('../templates');
const { guardMiddleware } = require('../guards');
const { createTemplateStore, StoreError } = require('../template-store');

const SECRET_TTL_MS = 6 * 3600 * 1000;

module.exports = (app, ctx) => {
  const { db, jobs } = ctx;
  const store = createTemplateStore(db, catalogue.load());
  const cat = store.catalogue; // live: rebuilt in place after every edit
  ctx.templates = { catalogue: cat, run: startRun, resolveHosts, store };

  // ---- secrets: held in memory until the run_job frame is sent -------------------------------------------------
  const pending = new Map(); // job_id -> { env, at }
  const send = ctx.agents.send.bind(ctx.agents);
  ctx.agents.send = (hostId, msg) => {
    const held = msg && msg.type === 'run_job' ? pending.get(msg.job_id) : null;
    if (!held) return send(hostId, msg);
    const ok = send(hostId, { ...msg, env: { ...(msg.env || {}), ...held.env } });
    if (ok) pending.delete(msg.job_id);
    return ok;
  };
  // For dispatchers of other host kinds (ssh, proxmox): take(jobId) returns the secret environment once.
  ctx.templateSecrets = { take(jobId) { const h = pending.get(jobId); pending.delete(jobId); return h ? h.env : {}; } };
  ctx.events.on('job', job => { if (job && !jobs.OPEN_STATES.includes(job.status)) pending.delete(job.id); });
  const prune = () => { const cut = Date.now() - SECRET_TTL_MS; for (const [k, v] of pending) if (v.at < cut) pending.delete(k); };

  // ---- helpers -----------------------------------------------------------------------------------------------------
  const fail = (status, error) => Object.assign(new Error(error), { status });

  function resolveHosts({ host_ids, group, tag } = {}) {
    const found = new Map();
    const unknown = [];
    const add = rows => rows.forEach(h => found.set(h.id, h));
    for (const id of [].concat(host_ids || [])) {
      const h = db.prepare('SELECT * FROM hosts WHERE id = ?').get(String(id));
      if (h) found.set(h.id, h); else unknown.push(String(id));
    }
    if (group) {
      const g = db.prepare('SELECT id FROM groups WHERE id = ? OR name = ? COLLATE NOCASE').get(String(group), String(group));
      if (!g) unknown.push(`group ${group}`);
      else add(db.prepare('SELECT * FROM hosts WHERE group_id = ? OR id IN (SELECT host_id FROM host_groups WHERE group_id = ?)').all(g.id, g.id));
    }
    if (tag) {
      const t = db.prepare('SELECT id FROM tags WHERE id = ? OR name = ? COLLATE NOCASE').get(String(tag), String(tag));
      if (!t) unknown.push(`tag ${tag}`);
      else add(db.prepare('SELECT * FROM hosts WHERE id IN (SELECT host_id FROM host_tags WHERE tag_id = ?)').all(t.id));
    }
    return { hosts: [...found.values()], unknown };
  }

  // Secret values come from stored credentials only; the request carries credential ids, never values.
  function secretEnv(tpl, input, host) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'secrets must be an object of credential ids');
    const declared = new Map(tpl.secrets.map(s => [s.name, s]));
    const env = {};
    for (const [rawName, credId] of Object.entries(input)) {
      const name = rawName.toUpperCase();
      if (!declared.has(name)) throw fail(400, `Unknown secret ${rawName}`);
      const cred = db.prepare('SELECT * FROM credentials WHERE id = ?').get(String(credId));
      if (!cred) throw fail(404, `Credential for ${name} not found`);
      if (cred.host_id && cred.host_id !== host.id) throw fail(400, `Credential for ${name} belongs to another host`);
      const data = ctx.crypto.openJson(cred.sealed) || {};
      const value = data.password ?? data.token ?? data.value ?? data.secret;
      if (!value) throw fail(400, `Credential for ${name} holds no secret value`);
      env[`LABCTL_SECRET_${name}`] = String(value);
    }
    for (const s of tpl.secrets) if (s.required && !env[`LABCTL_SECRET_${s.name}`]) throw fail(400, `Secret ${s.name} is required`);
    return env;
  }

  function startRun({ tpl, hosts, params, secrets, drain, force, actor }) {
    if ((drain || force) && !tpl.drain) throw fail(400, 'This template has no drain option');
    let env;
    try { env = catalogue.buildEnv(tpl, params || {}); } catch (err) {
      if (err instanceof catalogue.ParamError) throw fail(400, err.message);
      throw err;
    }
    if (drain) env.LABCTL_P_DRAIN = '1';
    if (force) env.LABCTL_P_FORCE = '1';
    const drainMin = Number(env.LABCTL_P_DRAIN_TIMEOUT_MIN || 120);
    const timeout = Math.max(tpl.timeout_s || 1800, drain ? drainMin * 60 + 1800 : 0);
    const text = catalogue.script(cat, tpl);
    // Resolve every secret before creating any job, so a bad credential id leaves no half-started run.
    const held = hosts.map(h => secretEnv(tpl, secrets || {}, h));
    prune();
    return hosts.map((host, n) => {
      const job = jobs.create({ host_id: host.id, type: `template:${tpl.id}`, shell: tpl.shell, script: text, timeout_s: timeout,
        params: { template: tpl.id, env, drain: !!drain, force: !!force }, actor, dispatchNow: false });
      if (Object.keys(held[n]).length) pending.set(job.id, { env: held[n], at: Date.now() });
      ctx.audit(actor, 'template.run', host.id, { template: tpl.id, job_id: job.id, params: env, drain: !!drain, force: !!force,
        guard: tpl.guard, with_credentials: Object.keys(held[n]).map(k => k.replace('LABCTL_SECRET_', '')) });
      const sent = jobs.dispatch(job);
      return { job_id: job.id, host_id: host.id, hostname: host.hostname || host.id, status: sent.status };
    });
  }

  // ---- routes ------------------------------------------------------------------------------------------------------
  app.get('/api/templates', (req, res) => {
    let { os, kind, category } = req.query;
    if (req.query.host_id) {
      const h = db.prepare('SELECT os FROM hosts WHERE id = ?').get(String(req.query.host_id));
      if (!h) return res.status(404).json({ error: 'Host not found' });
      os = h.os || os;
    }
    const list = req.query.hidden === '1' ? [...cat.all.values()] : cat.templates;
    res.json(list
      .filter(t => (!os || t.os.includes(os)) && (!kind || t.kinds.includes(kind)) && (!category || t.category === category))
      .map(catalogue.describe));
  });
  app.get('/api/templates/runbooks', (req, res) => res.json(cat.runbooks));
  // The script text (without the prelude) is for admins only: the run path never needs it on the client.
  app.get('/api/templates/:id', (req, res) => {
    const tpl = cat.all.get(req.params.id);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });
    const out = req.user?.role === 'admin' ? store.definition(tpl) : catalogue.describe(tpl);
    res.json({ ...out, references: store.references(tpl.id) });
  });

  // ---- editing (admin) ---------------------------------------------------------------------------------------------
  const admin = ctx.requireRole('admin');
  // The audit middleware stores the request body: swap the script for its size before the response is sent.
  const input = req => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : {};
    if (typeof req.body?.script === 'string') req.body.script = `[${Buffer.byteLength(req.body.script)} bytes]`;
    return body;
  };
  const write = (action, fn) => (req, res) => {
    try {
      const r = fn(input(req), req);
      const id = r.tpl.id;
      ctx.audit(req.user?.username, `template.${typeof action === 'function' ? action(r) : action}`, null,
        { template: id, name: r.tpl.name, source: r.tpl.source, ...(r.fp || {}), ...(r.script_changed ? { script_changed: true } : {}),
          ...(r.references?.length ? { references: r.references.length } : {}) });
      res.json({ template: catalogue.describe(cat.all.get(id) || r.tpl), warnings: r.warnings || [], action: r.action });
    } catch (err) {
      if (!(err instanceof StoreError)) throw err;
      res.status(err.status).json({ error: err.message, ...err.extra });
    }
  };
  app.post('/api/templates', admin, write('create', (body, req) => store.create(body, req.user?.username)));
  app.put('/api/templates/:id', admin, write('edit', (body, req) => store.update(req.params.id, body, req.user?.username)));
  app.post('/api/templates/:id/clone', admin, write('clone', (body, req) => store.clone(req.params.id, req.user?.username)));
  app.delete('/api/templates/:id', admin, write(r => r.action, (body, req) => store.remove(req.params.id, body, req.user?.username)));
  app.post('/api/templates/:id/restore', admin, write(r => r.action, (body, req) => store.restore(req.params.id)));

  const prepare = (req, res, next) => {
    const tpl = cat.byId.get(req.params.id);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });
    if (tpl.admin && req.user?.role !== 'admin') return res.status(403).json({ error: 'admin role required' });
    const { hosts, unknown } = resolveHosts(req.body || {});
    if (unknown.length) return res.status(404).json({ error: `Not found: ${unknown.join(', ')}` });
    const usable = hosts.filter(h => !h.os || tpl.os.includes(h.os));
    const skipped = hosts.filter(h => !usable.includes(h)).map(h => ({ host_id: h.id, reason: `Template is for ${tpl.os.join(', ')}, host is ${h.os}` }));
    if (!usable.length) return res.status(400).json({ error: 'No target host. Give host_ids, group or tag for a host this template supports.', skipped });
    req.run = { tpl, hosts: usable, skipped };
    next();
  };
  app.post('/api/templates/:id/run', prepare, guardMiddleware(ctx), (req, res) => {
    const { tpl, hosts, skipped } = req.run;
    const { params, secrets, drain, force } = req.body || {};
    try {
      const started = startRun({ tpl, hosts, params, secrets, drain: !!drain, force: !!force, actor: req.user?.username });
      res.json({ template: tpl.id, jobs: started, skipped });
    } catch (err) {
      if (!err.status) throw err;
      res.status(err.status).json({ error: err.message });
    }
  });
};
