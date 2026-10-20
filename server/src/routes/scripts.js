// Saved scripts (v1). Running a script creates a custom_command job per host.
const { randomUUID } = require('crypto');
const OS = ['any', 'linux', 'windows', 'darwin'];
const TARGETS = ['host', 'container'];
const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

module.exports = (app, ctx) => {
  const { db } = ctx;
  const out = s => s && { ...s, builtin: !!s.builtin };
  const byId = id => db.prepare('SELECT * FROM scripts WHERE id = ?').get(id);

  app.get('/api/scripts', (req, res) => {
    res.json(db.prepare('SELECT * FROM scripts ORDER BY updated_at DESC').all().map(out));
  });
  app.post('/api/scripts', (req, res) => {
    const { name, description = '', os = 'any', target = 'host', command, timeout = 300 } = req.body || {};
    if (!name || !command) return res.status(400).json({ error: 'name and command required' });
    if (!OS.includes(os)) return res.status(400).json({ error: `os must be one of ${OS.join(', ')}` });
    if (!TARGETS.includes(target)) return res.status(400).json({ error: 'target must be host or container' });
    const now = new Date().toISOString();
    const s = { id: randomUUID(), name, description, os, target, command, timeout: Number(timeout) || 300, created_at: now, updated_at: now };
    db.prepare(`INSERT INTO scripts (id, name, description, os, target, command, timeout, builtin, created_at, updated_at)
      VALUES (@id, @name, @description, @os, @target, @command, @timeout, 0, @created_at, @updated_at)`).run(s);
    res.json(out(byId(s.id)));
  });
  app.put('/api/scripts/:id', (req, res) => {
    const s = byId(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    const { name, description, os, target, command, timeout } = req.body || {};
    if (name !== undefined) s.name = name;
    if (description !== undefined) s.description = description;
    if (os !== undefined && OS.includes(os)) s.os = os;
    if (target !== undefined && TARGETS.includes(target)) s.target = target;
    if (command !== undefined) s.command = command;
    if (timeout !== undefined) s.timeout = Number(timeout) || s.timeout;
    s.updated_at = new Date().toISOString();
    db.prepare('UPDATE scripts SET name = @name, description = @description, os = @os, target = @target, command = @command, timeout = @timeout, updated_at = @updated_at WHERE id = @id').run(s);
    res.json(out(s));
  });
  app.delete('/api/scripts/:id', (req, res) => {
    db.prepare('DELETE FROM scripts WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/scripts/:id/run', (req, res) => {
    const script = byId(req.params.id);
    if (!script) return res.status(404).json({ error: 'Not found' });
    const { host_ids = [], container = '' } = req.body || {};
    if (!Array.isArray(host_ids) || !host_ids.length) return res.status(400).json({ error: 'host_ids required' });
    const results = [];
    for (const hid of host_ids) {
      const host = db.prepare('SELECT * FROM hosts WHERE id = ?').get(hid);
      if (!host) continue;
      if (script.os !== 'any' && !String(host.os || '').toLowerCase().includes(script.os)) {
        results.push({ host_id: hid, skipped: true, reason: `Script is ${script.os}-only` });
        continue;
      }
      let command = script.command;
      if (script.target === 'container') {
        if (!container) { results.push({ host_id: hid, skipped: true, reason: 'Container name required' }); continue; }
        command = `docker exec ${shellQuote(container)} sh -lc ${shellQuote(script.command)}`;
      }
      const job = ctx.jobs.create({ host_id: hid, type: 'custom_command', params: { command, timeout: script.timeout },
        script_id: script.id, actor: req.user?.username });
      results.push({ host_id: hid, job_id: job.id, status: job.status });
    }
    res.json(results);
  });
};
