// Stored credentials. Admin only. Secrets are sealed with AES-256-GCM and never returned by the API.
const { randomUUID } = require('crypto');
module.exports = (app, ctx) => {
  const { db, crypto } = ctx;
  const admin = ctx.requireRole('admin');
  app.get('/api/credentials', admin, (req, res) => {
    res.json(db.prepare(`SELECT c.id, c.host_id, c.name, c.username, c.purpose, c.kind, c.created_at, c.updated_at,
      COALESCE(h.hostname, c.host_id) AS hostname FROM credentials c LEFT JOIN hosts h ON h.id = c.host_id`).all());
  });
  app.post('/api/credentials', admin, (req, res) => {
    const { host_id, username, password, purpose = 'autologin' } = req.body || {};
    if (!host_id || !username || !password) return res.status(400).json({ error: 'All fields required' });
    const now = new Date().toISOString();
    const sealed = crypto.sealJson({ password });
    const existing = db.prepare('SELECT id FROM credentials WHERE host_id = ? AND purpose = ?').get(host_id, purpose);
    if (existing) {
      db.prepare('UPDATE credentials SET username = ?, sealed = ?, updated_at = ? WHERE id = ?').run(username, sealed, now, existing.id);
      return res.json({ id: existing.id, updated: true });
    }
    const id = randomUUID();
    db.prepare('INSERT INTO credentials (id, host_id, username, purpose, kind, sealed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, host_id, username, purpose, 'password', sealed, now, now);
    res.json({ id, created: true });
  });
  app.delete('/api/credentials/:id', admin, (req, res) => {
    db.prepare('DELETE FROM credentials WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });
};
