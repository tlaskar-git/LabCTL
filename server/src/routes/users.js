// Local users. Admin only. Roles: admin, operator, viewer ('readonly' is accepted as viewer).
module.exports = (app, ctx) => {
  const { db, auth } = ctx;
  const admin = ctx.requireRole('admin');
  const ROLE_ERROR = { error: 'role must be admin, operator or viewer' };
  const byId = id => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

  app.get('/api/users', admin, (req, res) => {
    res.json(db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all().map(auth.publicUser));
  });
  app.post('/api/users', admin, (req, res) => {
    const { username, password, role = 'viewer' } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    if (!auth.normaliseRole(role)) return res.status(400).json(ROLE_ERROR);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(String(username))) return res.status(409).json({ error: 'username already exists' });
    res.json(auth.publicUser(auth.makeUser(String(username), password, role)));
  });
  app.put('/api/users/:id', admin, (req, res) => {
    const user = byId(req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    const { password, role } = req.body || {};
    if (role !== undefined) {
      const r = auth.normaliseRole(role);
      if (!r) return res.status(400).json(ROLE_ERROR);
      if (user.role === 'admin' && r !== 'admin' && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n < 2) {
        return res.status(400).json({ error: 'At least one admin user is required' });
      }
      user.role = r;
    }
    if (password) user.password_hash = auth.hashPassword(password);
    user.updated_at = new Date().toISOString();
    db.prepare('UPDATE users SET role = ?, password_hash = ?, updated_at = ? WHERE id = ?').run(user.role, user.password_hash, user.updated_at, user.id);
    if (password) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, ctx.crypto.sha256(req.sessionToken));
    res.json(auth.publicUser(user));
  });
  app.delete('/api/users/:id', admin, (req, res) => {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own user' });
    const user = byId(req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (!db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id != ?").get(user.id).n) {
      return res.status(400).json({ error: 'At least one admin user is required' });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    })();
    res.json({ ok: true });
  });
};
