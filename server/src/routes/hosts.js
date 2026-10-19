// Hosts and groups (v1 routes). Host removal needs typed confirmation of the host name.
const { randomUUID } = require('crypto');
module.exports = (app, ctx) => {
  const { db, agents } = ctx;
  const hostRow = id => db.prepare('SELECT * FROM hosts WHERE id = ?').get(id);

  app.get('/api/hosts', (req, res) => {
    res.json(db.prepare('SELECT * FROM hosts ORDER BY hostname COLLATE NOCASE').all().map(agents.hostOut));
  });
  app.delete('/api/hosts/:id', ctx.requireConfirm(req => {
    const h = hostRow(req.params.id);
    return h ? (h.hostname || h.id) : null;
  }), (req, res) => {
    const id = req.params.id;
    db.transaction(() => {
      for (const t of ['host_tags', 'host_groups']) db.prepare(`DELETE FROM ${t} WHERE host_id = ?`).run(id);
      db.prepare('DELETE FROM hosts WHERE id = ?').run(id);
    })();
    res.json({ ok: true });
  });

  app.get('/api/groups', (req, res) => {
    res.json(db.prepare('SELECT id, name, color, ord AS "order", created_at FROM groups ORDER BY ord').all());
  });
  app.post('/api/groups', (req, res) => {
    const { name, color } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const g = { id: randomUUID(), name: String(name), color: color || '#3b82f6',
      order: db.prepare('SELECT COUNT(*) AS n FROM groups').get().n, created_at: new Date().toISOString() };
    db.prepare('INSERT INTO groups (id, name, color, ord, created_at) VALUES (?, ?, ?, ?, ?)').run(g.id, g.name, g.color, g.order, g.created_at);
    res.json(g);
  });
  app.put('/api/groups/:id', (req, res) => {
    const g = db.prepare('SELECT id, name, color, ord AS "order", created_at FROM groups WHERE id = ?').get(req.params.id);
    if (!g) return res.status(404).json({ error: 'Not found' });
    const { name, color, order } = req.body || {};
    if (name !== undefined) g.name = String(name);
    if (color !== undefined) g.color = color;
    if (order !== undefined) g.order = Number(order) || 0;
    db.prepare('UPDATE groups SET name = ?, color = ?, ord = ? WHERE id = ?').run(g.name, g.color, g.order, g.id);
    res.json(g);
  });
  app.delete('/api/groups/:id', (req, res) => {
    db.transaction(() => {
      db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id);
      db.prepare('DELETE FROM host_groups WHERE group_id = ?').run(req.params.id);
      db.prepare('UPDATE hosts SET group_id = NULL WHERE group_id = ?').run(req.params.id);
    })();
    res.json({ ok: true });
  });
  // hosts.group_id is the primary group shown by the v1 UI; host_groups mirrors it for many-to-many use.
  app.put('/api/hosts/:id/group', (req, res) => {
    if (!hostRow(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const groupId = req.body?.group_id || null;
    db.transaction(() => {
      db.prepare('UPDATE hosts SET group_id = ? WHERE id = ?').run(groupId, req.params.id);
      db.prepare('DELETE FROM host_groups WHERE host_id = ?').run(req.params.id);
      if (groupId) db.prepare('INSERT OR IGNORE INTO host_groups (host_id, group_id) VALUES (?, ?)').run(req.params.id, groupId);
    })();
    res.json({ ok: true });
  });
};
