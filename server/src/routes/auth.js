// Session sign-in. /api/auth/login and /api/auth/me are public; logout needs a session.
module.exports = (app, ctx) => {
  const { db, auth } = ctx;
  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    const user = username && db.prepare('SELECT * FROM users WHERE username = ?').get(String(username));
    if (!user || !auth.verifyPassword(password || '', user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const token = auth.createSession(user.id);
    res.cookie('labctl_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 86400000 });
    res.json({ token, user: auth.publicUser(user) });
  });
  app.post('/api/auth/logout', (req, res) => {
    auth.deleteSession(req.sessionToken);
    res.clearCookie('labctl_session');
    res.json({ ok: true });
  });
  app.get('/api/auth/me', (req, res) => {
    res.json({ user: auth.publicUser(auth.userForToken(auth.getSessionToken(req))) });
  });
};
