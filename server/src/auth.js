// Session auth, roles (viewer < operator < admin) and the typed-confirmation guard.
const crypto = require('crypto');
const { sha256 } = require('./crypto');

const ROLES = ['viewer', 'operator', 'admin'];
const rank = role => ROLES.indexOf(role === 'readonly' ? 'viewer' : role);

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = Buffer.from(hashPassword(password, salt).split(':')[1]);
  const expected = Buffer.from(hash);
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}
function normaliseRole(role) {
  if (role === 'readonly') return 'viewer';
  return ROLES.includes(role) ? role : null;
}
function publicUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, role: user.role, created_at: user.created_at, updated_at: user.updated_at };
}
function parseCookie(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim().split('=')).filter(p => p.length === 2));
}
function getSessionToken(req) {
  const auth = req.get('authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return parseCookie(req.get('cookie')).labctl_session || '';
}

function createAuth(db) {
  const now = () => new Date().toISOString();
  return {
    ROLES, rank, hashPassword, verifyPassword, normaliseRole, publicUser, getSessionToken,
    makeUser(username, password, role = 'viewer') {
      const user = { id: crypto.randomUUID(), username, role: normaliseRole(role) || 'viewer',
        password_hash: hashPassword(password), created_at: now(), updated_at: now() };
      db.prepare('INSERT INTO users (id, username, role, password_hash, created_at, updated_at) VALUES (@id, @username, @role, @password_hash, @created_at, @updated_at)').run(user);
      return user;
    },
    createSession(userId) {
      const token = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)').run(sha256(token), userId, now(), now());
      return token;
    },
    deleteSession(token) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token)); },
    userForToken(token) {
      if (!token) return null;
      const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
      if (!s) return null;
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
      if (user) db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now(), s.token_hash);
      return user || null;
    },
    middleware(req, res, next) {
      const token = getSessionToken(req);
      const user = this.userForToken(token);
      if (!user) return res.status(401).json({ error: 'Authentication required' });
      req.user = user;
      req.sessionToken = token;
      next();
    },
    // requireRole('operator') allows operator and admin.
    requireRole(min) {
      return (req, res, next) => {
        if (!req.user || rank(req.user.role) < rank(min)) return res.status(403).json({ error: `${min} role required` });
        next();
      };
    }
  };
}

// requireConfirm(expected): body.confirm must equal expected. expected is a string or (req) => string.
function requireConfirm(expected) {
  return (req, res, next) => {
    let want;
    try { want = typeof expected === 'function' ? expected(req) : expected; } catch (err) { return next(err); }
    if (want === null || want === undefined) return res.status(404).json({ error: 'Not found' });
    if (String(req.body?.confirm ?? '') !== String(want)) {
      return res.status(400).json({ error: 'Typed confirmation required', confirm_required: true });
    }
    next();
  };
}

module.exports = { createAuth, requireConfirm, hashPassword, verifyPassword, ROLES };
