// Enrolment tokens for agents. Only the SHA-256 hash is stored. The value is returned once, at create or rotate.
const { randomUUID } = require('crypto');
const { sha256, randomToken } = require('./crypto');

function createTokens(db) {
  const now = () => new Date().toISOString();
  const pub = r => r && ({ id: r.id, label: r.label, created_at: r.created_at, created_by: r.created_by,
    last_used: r.last_used, revoked: !!r.revoked, revoked_at: r.revoked_at });
  return {
    list() { return db.prepare('SELECT * FROM enrolment_tokens ORDER BY created_at').all().map(pub); },
    get(id) { return pub(db.prepare('SELECT * FROM enrolment_tokens WHERE id = ?').get(id)); },
    create(label, actor = 'system') {
      const id = randomUUID();
      const value = randomToken(32);
      db.prepare('INSERT INTO enrolment_tokens (id, label, hash, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(id, String(label || 'Enrolment token').slice(0, 100), sha256(value), now(), actor);
      return { ...this.get(id), value };
    },
    rotate(id) {
      const value = randomToken(32);
      const r = db.prepare('UPDATE enrolment_tokens SET hash = ?, revoked = 0, revoked_at = NULL WHERE id = ?').run(sha256(value), id);
      return r.changes ? { ...this.get(id), value } : null;
    },
    revoke(id) {
      return db.prepare('UPDATE enrolment_tokens SET revoked = 1, revoked_at = ? WHERE id = ? AND revoked = 0').run(now(), id).changes > 0;
    },
    // Returns the token id for a valid, unrevoked value, else null.
    verify(value) {
      if (!value || typeof value !== 'string' || value.length > 200) return null;
      const row = db.prepare('SELECT id FROM enrolment_tokens WHERE hash = ? AND revoked = 0').get(sha256(value));
      if (!row) return null;
      db.prepare('UPDATE enrolment_tokens SET last_used = ? WHERE id = ?').run(now(), row.id);
      return row.id;
    },
    count() { return db.prepare('SELECT COUNT(*) AS n FROM enrolment_tokens').get().n; }
  };
}

module.exports = { createTokens };
