// Shared credential library: schema migration and the one function other modules call to open a credential.
// The credentials table never had NOT NULL on host_id, so no rebuild is needed: shared rows are purpose 'shared' with host_id NULL.
const { ensureColumn } = require('./db');

// Idempotent. Runs at route load, safe on a database of any older shape.
function migrate(db) {
  for (const [col, decl] of [['domain', 'TEXT'], ['note', 'TEXT'], ['last_used', 'TEXT'], ['last_purpose', 'TEXT']]) {
    ensureColumn(db, 'credentials', col, decl);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS credentials_shared_name ON credentials(name COLLATE NOCASE) WHERE purpose = 'shared'");
}

function createCredentials({ db, crypto }) {
  // Opens a credential in memory and stamps last_used. Returns {id, name, username, domain, kind, ...secret} or null.
  // The secret object must not be logged, stored or sent to a browser by the caller.
  function use(id, purposeText = '') {
    const row = db.prepare('SELECT id, name, username, domain, kind, sealed FROM credentials WHERE id = ?').get(String(id));
    if (!row) return null;
    const secret = crypto.openJson(row.sealed) || {};
    db.prepare('UPDATE credentials SET last_used = ?, last_purpose = ? WHERE id = ?')
      .run(new Date().toISOString(), String(purposeText).slice(0, 200), row.id);
    return { ...secret, id: row.id, name: row.name, username: row.username, domain: row.domain, kind: row.kind };
  }
  return { use };
}

module.exports = { migrate, createCredentials };
