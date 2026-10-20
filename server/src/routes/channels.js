// Notification channels (A10a): smtp, webhook, telegram. Config is sealed; secrets leave the API only as a mask.
// Writes and tests are admin only. A PUT that sends the mask (or omits a secret) keeps the stored secret, null clears it.
const { randomUUID } = require('crypto');
const { ensure } = require('../alerting/engine');
const { validate, merge, mask, KINDS } = require('../alerting/notify');

module.exports = (app, ctx) => {
  const { db } = ctx;
  const { notifier } = ensure(ctx);
  const admin = ctx.requireRole('admin');
  const bad = (res, error, status = 400) => res.status(status).json({ error });
  const get = id => db.prepare('SELECT * FROM channels WHERE id = ?').get(id);

  const view = (row, full) => {
    const base = { id: row.id, name: row.name, kind: row.kind, enabled: !!row.enabled };
    if (!full) return base;
    let config = null;
    try { config = mask(row.kind, notifier.config(row)); } catch { /* sealed with another key */ }
    return { ...base, config, last_error: row.last_error || null, last_error_at: row.last_error_at || null, last_ok_at: row.last_ok_at || null, created_at: row.created_at };
  };
  // The audit middleware reads req.body after the response, so the stored copy must not hold secrets.
  const redactBody = (req, kind) => { if (req.body?.config && typeof req.body.config === 'object') req.body = { ...req.body, config: mask(kind, req.body.config) }; };

  app.get('/api/channels', (req, res) => {
    const full = req.user?.role === 'admin';
    res.json(db.prepare('SELECT * FROM channels ORDER BY created_at').all().map(r => view(r, full)));
  });

  app.post('/api/channels', admin, (req, res) => {
    const { name, kind, enabled = true, config = {} } = req.body || {};
    redactBody(req, kind);
    if (!String(name || '').trim()) return bad(res, 'name is required');
    if (!KINDS.includes(kind)) return bad(res, `kind must be one of ${KINDS.join(', ')}`);
    const v = validate(kind, config);
    if (v.error) return bad(res, v.error);
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO channels (id, name, kind, enabled, config_sealed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, String(name).trim(), kind, enabled ? 1 : 0, ctx.crypto.sealJson(v.config), now, now);
    res.status(201).json(view(get(id), true));
  });

  app.put('/api/channels/:id', admin, (req, res) => {
    const row = get(req.params.id);
    if (!row) return bad(res, 'Channel not found', 404);
    const body = req.body || {};
    redactBody(req, row.kind);
    let config;
    try { config = merge(row.kind, notifier.config(row), body.config || {}); } catch { config = merge(row.kind, {}, body.config || {}); }
    const v = validate(row.kind, config);
    if (v.error) return bad(res, v.error);
    const name = body.name === undefined ? row.name : String(body.name).trim();
    if (!name) return bad(res, 'name is required');
    db.prepare('UPDATE channels SET name = ?, enabled = ?, config_sealed = ?, updated_at = ? WHERE id = ?')
      .run(name, (body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0), ctx.crypto.sealJson(v.config), new Date().toISOString(), row.id);
    res.json(view(get(row.id), true));
  });

  app.delete('/api/channels/:id', admin, (req, res) => {
    if (!db.prepare('DELETE FROM channels WHERE id = ?').run(req.params.id).changes) return bad(res, 'Channel not found', 404);
    db.prepare('DELETE FROM channel_errors WHERE channel_id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // One attempt. 200 with { ok: true } or { ok: false, error } so the UI shows the exact reason.
  app.post('/api/channels/:id/test', admin, async (req, res) => {
    const row = get(req.params.id);
    if (!row) return bad(res, 'Channel not found', 404);
    try { res.json(await notifier.test(row)); } catch (err) { res.json({ ok: false, error: 'Channel config cannot be read (was the master key changed?)' }); }
  });

  app.get('/api/channels/:id/errors', admin, (req, res) => {
    res.json(db.prepare('SELECT ts, error, context FROM channel_errors WHERE channel_id = ? ORDER BY id DESC LIMIT 50').all(req.params.id));
  });
};
