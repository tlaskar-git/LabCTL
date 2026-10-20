// Credential library. Shared credentials (purpose 'shared', no host) are named logins such as 'root' or 'domain admin'.
// Host-bound rows (autologin, deploy, ssh) stay as before. Admin only, except GET /api/credentials/names (names for pickers).
// Secrets are sealed with AES-256-GCM, never returned and never written to the audit log. Other modules open a credential
// with ctx.credentials.use(id, purposeText), which also stamps last_used.
const { randomUUID } = require('crypto');
const { migrate, createCredentials } = require('../credentials');

const CTRL = /[\u0000-\u001f\u007f]/;
const NOTE_CTRL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+-----END [A-Z0-9 ]*PRIVATE KEY-----/;
const bad = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });

function str(v, label, max, { req = false, ctrl = CTRL } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw bad(`${label} must be text`);
  const s = v.trim();
  if (req && !s) throw bad(`${label} is required`);
  if (s.length > max) throw bad(`${label} is too long (max ${max} characters)`);
  if (ctrl.test(s)) throw bad(`${label} contains control characters`);
  return s;
}
const secretText = (v, label, max) => {
  if (typeof v !== 'string') throw bad(`${label} must be text`);
  if (v.length > max || v.includes('\u0000')) throw bad(`${label} is too long or invalid`);
  return v;
};

// Returns {kind, secret} for the password or private key in the body, or null when neither is given.
function secretOf(b) {
  const pw = b.password !== undefined && b.password !== '';
  const key = b.private_key !== undefined && b.private_key !== '';
  if (pw && key) throw bad('Give a password or a private key, not both');
  let out = null;
  if (pw) out = { kind: 'password', secret: { password: secretText(b.password, 'Password', 4096) } };
  if (key) {
    const pem = secretText(b.private_key, 'Private key', 16384).trim();
    if (!PEM.test(pem)) throw bad('Private key must be a PEM block (-----BEGIN ... PRIVATE KEY-----)');
    out = { kind: 'ssh_key', secret: { private_key: pem + '\n' } };
    if (b.passphrase) out.secret.passphrase = secretText(b.passphrase, 'Passphrase', 1024);
  }
  if (out && b.kind && b.kind !== out.kind) throw bad('kind does not match the secret supplied');
  return out;
}

module.exports = (app, ctx) => {
  const { db, crypto, audit } = ctx;
  migrate(db);
  ctx.credentials = createCredentials(ctx);
  const admin = ctx.requireRole('admin');
  const actor = req => req.user?.username || 'system';
  const get = id => db.prepare('SELECT * FROM credentials WHERE id = ?').get(id);
  const dupe = (name, exceptId) => db.prepare("SELECT id FROM credentials WHERE purpose = 'shared' AND name = ? COLLATE NOCASE AND id != ?").get(name, exceptId || '');
  const usedBy = id => db.prepare(`SELECT hostname FROM hosts WHERE CASE WHEN json_valid(data) THEN
    json_extract(data, '$.ssh.credential_id') = ? OR json_extract(data, '$.deploy.credential_id') = ? END`)
    .all(id, id).map(h => h.hostname);

  app.get('/api/credentials', admin, (req, res) => {
    res.json(db.prepare(`SELECT c.id, c.host_id, c.name, c.username, c.domain, c.purpose, c.kind, c.note,
      CASE WHEN c.purpose = 'shared' THEN 'shared' ELSE 'host' END AS scope,
      c.created_at, c.updated_at, c.last_used, c.last_purpose, h.hostname AS hostname
      FROM credentials c LEFT JOIN hosts h ON h.id = c.host_id WHERE c.purpose != 'runner-token'
      ORDER BY c.purpose != 'shared', c.name COLLATE NOCASE, h.hostname COLLATE NOCASE`).all());
  });

  // Names only, for the credential picker. Operators need it to choose a login without seeing any detail.
  app.get('/api/credentials/names', ctx.requireRole('operator'), (req, res) => {
    res.json(db.prepare("SELECT id, name, kind, domain FROM credentials WHERE purpose = 'shared' ORDER BY name COLLATE NOCASE").all());
  });

  app.post('/api/credentials', admin, (req, res) => {
    const b = req.body || {};
    const now = new Date().toISOString();
    if (b.host_id) { // host-bound login: one row per host and purpose, as before
      const username = str(b.username, 'Username', 128, { req: true });
      const purpose = str(b.purpose || 'autologin', 'Purpose', 32);
      if (!/^[a-z0-9_-]+$/.test(purpose) || purpose === 'shared') throw bad('Invalid purpose');
      const s = secretOf(b);
      if (!s) throw bad('All fields required');
      const sealed = crypto.sealJson(s.secret);
      const existing = db.prepare('SELECT id FROM credentials WHERE host_id = ? AND purpose = ?').get(String(b.host_id), purpose);
      if (existing) {
        db.prepare('UPDATE credentials SET username = ?, kind = ?, sealed = ?, updated_at = ? WHERE id = ?').run(username, s.kind, sealed, now, existing.id);
        return res.json({ id: existing.id, updated: true });
      }
      const id = randomUUID();
      db.prepare('INSERT INTO credentials (id, host_id, username, purpose, kind, sealed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, String(b.host_id), username, purpose, s.kind, sealed, now, now);
      return res.json({ id, created: true });
    }
    const name = str(b.name, 'Name', 64, { req: true });
    const username = str(b.username, 'Username', 128, { req: true });
    const domain = str(b.domain, 'Domain', 255);
    if (domain && !/^[A-Za-z0-9._-]+$/.test(domain)) throw bad('Domain has invalid characters');
    const note = str(b.note, 'Note', 500, { ctrl: NOTE_CTRL });
    const s = secretOf(b);
    if (!s) throw bad('A password or a private key is required');
    if (b.sudo_password) s.secret.sudo_password = secretText(b.sudo_password, 'Sudo password', 4096);
    if (dupe(name)) throw bad('A shared credential with this name already exists', 409);
    const id = randomUUID();
    db.prepare(`INSERT INTO credentials (id, host_id, name, username, domain, note, purpose, kind, sealed, created_at, updated_at)
      VALUES (?, NULL, ?, ?, ?, ?, 'shared', ?, ?, ?, ?)`).run(id, name, username, domain || null, note || null, s.kind, crypto.sealJson(s.secret), now, now);
    audit(actor(req), 'credential.create', null, { id, name });
    res.json({ id, created: true });
  });

  // Shared credentials only. Omitted fields stay as they are. The secret changes only when a password or key is sent.
  app.put('/api/credentials/:id', admin, (req, res) => {
    const row = get(req.params.id);
    if (!row || row.purpose !== 'shared') throw bad('Shared credential not found', 404);
    const b = req.body || {};
    const name = b.name === undefined ? row.name : str(b.name, 'Name', 64, { req: true });
    const username = b.username === undefined ? row.username : str(b.username, 'Username', 128, { req: true });
    const domain = b.domain === undefined ? row.domain : str(b.domain, 'Domain', 255);
    if (domain && !/^[A-Za-z0-9._-]+$/.test(domain)) throw bad('Domain has invalid characters');
    const note = b.note === undefined ? row.note : str(b.note, 'Note', 500, { ctrl: NOTE_CTRL });
    if (dupe(name, row.id)) throw bad('A shared credential with this name already exists', 409);
    const old = crypto.openJson(row.sealed) || {};
    const s = secretOf(b);
    const secret = s ? s.secret : { ...old };
    if (s && old.sudo_password) secret.sudo_password = old.sudo_password;
    if (b.sudo_password !== undefined) {
      if (b.sudo_password === '') delete secret.sudo_password;
      else secret.sudo_password = secretText(b.sudo_password, 'Sudo password', 4096);
    }
    db.prepare('UPDATE credentials SET name = ?, username = ?, domain = ?, note = ?, kind = ?, sealed = ?, updated_at = ? WHERE id = ?')
      .run(name, username, domain || null, note || null, s ? s.kind : row.kind, crypto.sealJson(secret), new Date().toISOString(), row.id);
    audit(actor(req), 'credential.update', null, { id: row.id, name, login_replaced: !!s });
    res.json({ ok: true });
  });

  // Shared credentials need the typed name. A credential that a host still uses is refused.
  app.delete('/api/credentials/:id', admin, (req, res) => {
    const row = get(req.params.id);
    if (!row) return res.json({ ok: true });
    if (row.purpose === 'shared') {
      if (String(req.body?.confirm ?? '') !== row.name) throw bad('Typed confirmation required (type the credential name)');
      const hosts = usedBy(row.id);
      if (hosts.length) throw bad(`In use by ${hosts.length} host(s): ${hosts.slice(0, 5).join(', ')}. Change those hosts first.`, 409);
    }
    db.prepare('DELETE FROM credentials WHERE id = ?').run(row.id);
    audit(actor(req), 'credential.delete', row.host_id, { id: row.id, name: row.name || row.purpose });
    res.json({ ok: true });
  });
};
