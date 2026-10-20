// Audit log: who did what, to which host, when. Detail is redacted before it is stored.
const SECRET_KEY = /pass(word|wd|phrase)?|secret|token|api[_-]?key|private|authorization|cookie|credential|sealed|^key$|_key$/i;

function redactString(s) {
  return String(s)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/([?&](token|key|password|secret)=)[^&\s]+/gi, '$1[redacted]');
}

function redact(value, depth = 0) {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // ids name a record, they are not secrets (token_id, credential_id)
      out[k] = SECRET_KEY.test(k) && !/(^|_)id$/i.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function createAudit(db) {
  const insert = db.prepare('INSERT INTO audit_log (ts, actor, action, host_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?)');
  function audit(actor, action, hostId = null, detail = null, ip = null) {
    const text = detail === null || detail === undefined ? null : JSON.stringify(redact(detail)).slice(0, 8000);
    insert.run(new Date().toISOString(), String(actor || 'system'), String(action), hostId || null, text, ip || null);
  }
  audit.redact = redact;
  audit.query = ({ actor, action, host_id, since, until, limit = 100, offset = 0 } = {}) => {
    const where = [];
    const args = [];
    if (actor) { where.push('actor = ?'); args.push(actor); }
    if (action) { where.push('action LIKE ?'); args.push(`%${action}%`); }
    if (host_id) { where.push('host_id = ?'); args.push(host_id); }
    if (since) { where.push('ts >= ?'); args.push(since); }
    if (until) { where.push('ts <= ?'); args.push(until); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const lim = Math.max(1, Math.min(500, Number(limit) || 100));
    const off = Math.max(0, Number(offset) || 0);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`).get(...args).n;
    const rows = db.prepare(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, lim, off)
      .map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
    return { total, limit: lim, offset: off, rows };
  };
  // Express middleware: records every state-changing /api request once the response is sent.
  audit.middleware = (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    res.on('finish', () => {
      try {
        const routePath = req.route ? req.baseUrl + req.route.path : req.originalUrl.split('?')[0];
        const params = req.params || {};
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const hostId = (routePath.startsWith('/api/hosts/') && params.id) || body.host_id || null;
        audit(req.user?.username || body.username || 'anonymous', `${req.method} ${routePath}`, hostId,
          { status: res.statusCode, params, body }, req.ip);
      } catch (err) { console.error('[audit] write failed:', err.message); }
    });
    next();
  };
  return audit;
}

module.exports = { createAudit, redact };
