// Hosts, groups, tags, blocklist and agentless ssh hosts. Removal is admin only and needs the typed confirmation.
const { randomUUID } = require('crypto');
const ops = require('../hostops');
const { createSsh } = require('../ssh');
const { buildView } = require('../host-view');

const ADDRESS = /^[A-Za-z0-9._:%\[\]-]{1,253}$/;
const str = (v, max) => String(v ?? '').trim().slice(0, max);

module.exports = (app, ctx) => {
  const { db, agents } = ctx;
  const admin = ctx.requireRole('admin');
  const hostRow = id => db.prepare('SELECT * FROM hosts WHERE id = ?').get(id);
  const isAdmin = req => ctx.auth.rank(req.user?.role) >= ctx.auth.rank('admin');
  // `view` is the normalised host data every display reads (src/host-view.js); the raw fields stay for compatibility.
  const withView = (row, latest, full) => {
    const h = ops.hostView(ctx, row, latest);
    return { ...h, view: buildView(row, { full, online: h.online }) };
  };
  const view = row => withView(row, ops.latestAgentVersion(db), false);

  // Agentless hosts: jobs go over ssh through the dispatcher hook, state is polled every 60 s.
  const ssh = ctx.ssh = createSsh(ctx);
  ctx.jobs.registerDispatcher('ssh', (job, host) => ssh.runJob(job, host));
  ssh.start();
  // ssh hosts have no socket: count them online by their polled status, and stop polling with the agents.
  const isOnline = agents.isOnline;
  agents.isOnline = id => isOnline(id) || ssh.sshOnline(id);
  ctx.onClose(() => ssh.stop());
  // An operator-set kind (vps, proxmox, runner) survives the agent re-registering as kind "agent".
  ctx.events.on('host', row => {
    const pref = row && ops.getData(db, row.id).kind_pref;
    if (pref && row.kind !== pref) db.prepare('UPDATE hosts SET kind = ? WHERE id = ?').run(pref, row.id);
  });

  // Stores an inline credential: sealed in the credentials table only when save_credential is true, else kept in memory.
  function applyCredential(host, s, { credential, save_credential }, req) {
    if (!credential || typeof credential !== 'object') return null;
    const secret = credential.private_key
      ? { private_key: String(credential.private_key), ...(credential.passphrase ? { passphrase: String(credential.passphrase) } : {}) }
      : { password: String(credential.password ?? '') };
    if (!secret.private_key && !secret.password) return 'credential needs a password or private_key';
    const username = str(credential.username || s.username, 100);
    if (!save_credential) { ssh.setCredential(host.id, { username, ...secret }); delete s.credential_id; return null; }
    if (!isAdmin(req)) return 'admin role required to save a credential';
    const sealed = ctx.crypto.sealJson(secret);
    const kind = secret.private_key ? 'key' : 'password';
    const stamp = ops.now();
    if (s.credential_id && db.prepare('SELECT 1 FROM credentials WHERE id = ? AND host_id = ?').get(s.credential_id, host.id)) {
      db.prepare('UPDATE credentials SET username = ?, kind = ?, sealed = ?, updated_at = ? WHERE id = ?').run(username, kind, sealed, stamp, s.credential_id);
    } else {
      s.credential_id = randomUUID();
      db.prepare('INSERT INTO credentials (id, host_id, name, username, purpose, kind, sealed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(s.credential_id, host.id, `${host.hostname} ssh`, username, 'ssh', kind, sealed, stamp, stamp);
    }
    ssh.forget(host.id);
    return null;
  }

  function sshSettings(b, s, cols) {
    if (b.address !== undefined) {
      if (!ADDRESS.test(String(b.address))) return 'invalid address';
      s.address = String(b.address);
      cols.ip = s.address;
    }
    if (b.port !== undefined) {
      const port = Number(b.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return 'invalid port';
      s.port = port;
    }
    if (b.username !== undefined) s.username = str(b.username, 100);
    if (b.credential_id !== undefined) {
      if (b.credential_id && !db.prepare('SELECT 1 FROM credentials WHERE id = ?').get(b.credential_id)) return 'unknown credential_id';
      s.credential_id = b.credential_id || undefined;
    }
    return null;
  }

  app.get('/api/hosts', (req, res) => {
    const latest = ops.latestAgentVersion(db);
    res.json(db.prepare('SELECT * FROM hosts ORDER BY hostname COLLATE NOCASE').all()
      .map(r => withView(r, latest, false)).filter(h => ops.matches(h, req.query)));
  });
  app.get('/api/hosts/:id', (req, res) => {
    const h = hostRow(req.params.id);
    if (!h) return res.status(404).json({ error: 'Not found' });
    res.json(withView(h, ops.latestAgentVersion(db), true));
  });

  // Add an agentless ssh host.
  app.post('/api/hosts', async (req, res, next) => {
    try {
      const b = req.body || {};
      if (b.kind !== 'ssh') return res.status(400).json({ error: 'Only kind "ssh" hosts are created here. Agents register themselves.' });
      const name = str(b.name, 100);
      if (!name) return res.status(400).json({ error: 'name required' });
      const os = b.os === undefined ? 'linux' : b.os;
      if (!['linux', 'windows', 'darwin'].includes(os)) return res.status(400).json({ error: 'os must be linux, windows or darwin' });
      const s = { port: 22, username: str(b.username, 100) };
      const cols = {};
      let err = b.address === undefined ? 'address required' : sshSettings({ address: b.address, port: b.port, credential_id: b.credential_id }, s, cols);
      if (err) return res.status(400).json({ error: err });
      if (!s.credential_id && !b.credential) return res.status(400).json({ error: 'credential_id or credential required' });
      if (b.save_credential && !isAdmin(req)) return res.status(403).json({ error: 'admin role required to save a credential' });
      const id = randomUUID();
      const stamp = ops.now();
      const data = { notes: str(b.notes, 2000), provider: str(b.provider, 100), region: str(b.region, 100), plan: str(b.plan, 100), ssh: s };
      db.prepare(`INSERT INTO hosts (id, hostname, os, ip, kind, status, system_info, data, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'ssh', 'offline', '{}', ?, ?, ?)`).run(id, name, os, s.address, JSON.stringify(data), stamp, stamp);
      err = applyCredential({ id, hostname: name }, s, b, req);
      if (err) { db.prepare('DELETE FROM hosts WHERE id = ?').run(id); return res.status(400).json({ error: err }); }
      ops.saveData(db, id, { ssh: s });
      const result = await ssh.poll(hostRow(id));
      res.json({ ...view(hostRow(id)), connect_error: result.ok ? null : result.error });
    } catch (e) { next(e); }
  });

  app.patch('/api/hosts/:id', (req, res) => {
    const h = hostRow(req.params.id);
    if (!h) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const isSsh = h.kind === 'ssh';
    const cols = {};
    const lists = ['tags', 'add_tags', 'groups', 'add_groups'];
    if (lists.some(k => b[k] !== undefined && (!Array.isArray(b[k]) || b[k].length > 100 || b[k].some(x => typeof x !== 'string')))) {
      return res.status(400).json({ error: 'tags and groups must be lists of strings' });
    }
    const data = ops.getData(db, h.id);
    for (const [k, max] of [['notes', 2000], ['provider', 100], ['region', 100], ['plan', 100]]) if (b[k] !== undefined) data[k] = str(b[k], max);
    if (b.kind !== undefined) {
      if (!ops.KINDS.includes(b.kind) || (b.kind === 'ssh') !== isSsh) return res.status(400).json({ error: 'invalid kind (ssh and agent kinds cannot be switched)' });
      cols.kind = b.kind;
      data.kind_pref = b.kind === 'agent' ? null : b.kind;
    }
    if (b.runner_folders !== undefined) {
      const f = b.runner_folders;
      if (!Array.isArray(f) || f.length > 50 || f.some(p => typeof p !== 'string' || !p.trim() || p.length > 500 || p.includes('\0'))) {
        return res.status(400).json({ error: 'runner_folders must be a list of up to 50 paths' });
      }
      data.runner_folders = f.map(p => p.trim());
    }
    if (isSsh) {
      if (b.name !== undefined) { if (!str(b.name, 100)) return res.status(400).json({ error: 'name required' }); cols.hostname = str(b.name, 100); }
      if (b.os !== undefined) { if (!['linux', 'windows', 'darwin'].includes(b.os)) return res.status(400).json({ error: 'invalid os' }); cols.os = b.os; }
      if (b.ssh) {
        const s = { ...(data.ssh || {}) };
        let err = sshSettings(b.ssh, s, cols);
        if (!err && b.ssh.reset_host_key) { if (isAdmin(req)) delete s.host_key; else err = 'admin role required to reset the host key'; }
        if (!err) err = applyCredential(h, s, b.ssh, req);
        if (err) return res.status(err.startsWith('admin') ? 403 : 400).json({ error: err });
        data.ssh = s;
      }
    } else if (b.ssh || b.name !== undefined || b.os !== undefined) {
      return res.status(400).json({ error: 'ssh settings, name and os apply to ssh hosts only' });
    }
    db.transaction(() => {
      const sets = Object.keys(cols).map(k => `${k} = @${k}`).concat('data = @data', 'updated_at = @updated_at');
      db.prepare(`UPDATE hosts SET ${sets.join(', ')} WHERE id = @id`).run({ ...cols, data: JSON.stringify(data), updated_at: ops.now(), id: h.id });
      if (b.tags !== undefined || b.add_tags !== undefined) {
        const names = [...(b.tags ?? db.prepare('SELECT t.name FROM tags t JOIN host_tags ht ON ht.tag_id = t.id WHERE ht.host_id = ?').all(h.id).map(t => t.name)), ...(b.add_tags || [])];
        ops.setTags(db, h.id, ops.tagIds(db, names));
      }
      if (b.groups !== undefined || b.add_groups !== undefined) {
        const existing = db.prepare('SELECT group_id FROM host_groups WHERE host_id = ?').all(h.id).map(g => g.group_id);
        ops.setGroups(db, h.id, [...(b.groups ?? existing), ...(b.add_groups || [])]);
      }
    })();
    res.json(view(hostRow(h.id)));
  });

  app.delete('/api/hosts/:id', admin, ctx.requireConfirm(req => {
    const h = hostRow(req.params.id);
    return h ? (h.hostname || h.id) : null;
  }), async (req, res, next) => {
    try {
      const mode = req.body?.mode ?? 'remove';
      if (!['remove', 'uninstall_and_remove'].includes(mode)) return res.status(400).json({ error: 'mode must be remove or uninstall_and_remove' });
      const r = await ops.removeHost(ctx, hostRow(req.params.id), mode, req.user.username);
      res.json({ ok: true, uninstall: r.uninstall });
    } catch (e) { next(e); }
  });

  // Bulk removal: confirm must be "REMOVE <n> HOSTS" where n is the number of ids sent.
  app.post('/api/hosts/bulk-remove', admin, ctx.requireConfirm(req => `REMOVE ${Array.isArray(req.body?.host_ids) ? req.body.host_ids.length : 0} HOSTS`), async (req, res, next) => {
    try {
      const { host_ids: ids, mode = 'remove' } = req.body;
      if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some(i => typeof i !== 'string')) return res.status(400).json({ error: 'host_ids must hold 1 to 200 ids' });
      if (!['remove', 'uninstall_and_remove'].includes(mode)) return res.status(400).json({ error: 'mode must be remove or uninstall_and_remove' });
      const results = await Promise.all([...new Set(ids)].map(async id => {
        const h = hostRow(id);
        return h ? ops.removeHost(ctx, h, mode, req.user.username).catch(e => ({ id, ok: false, error: e.message })) : { id, ok: false, error: 'Not found' };
      }));
      res.json({ ok: results.every(r => r.ok), results });
    } catch (e) { next(e); }
  });

  app.get('/api/blocklist', admin, (req, res) => {
    res.json(db.prepare('SELECT host_id AS id, host_id, hostname, reason, actor, created_at FROM blocklist ORDER BY created_at DESC').all());
  });
  app.delete('/api/blocklist/:id', admin, (req, res) => {
    const r = db.prepare('DELETE FROM blocklist WHERE host_id = ?').run(req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'Not found' });
    ctx.audit(req.user.username, 'host.unblock', req.params.id, {});
    res.json({ ok: true });
  });

  app.get('/api/tags', (req, res) => {
    res.json(db.prepare('SELECT t.id, t.name, t.color, t.created_at, (SELECT COUNT(*) FROM host_tags ht WHERE ht.tag_id = t.id) AS hosts FROM tags t ORDER BY t.name').all());
  });
  app.post('/api/tags', (req, res) => {
    const name = str(req.body?.name, 40);
    if (!name) return res.status(400).json({ error: 'name required' });
    if (db.prepare('SELECT 1 FROM tags WHERE name = ?').get(name)) return res.status(409).json({ error: 'Tag exists' });
    const tag = { id: randomUUID(), name, color: str(req.body.color, 20) || '#64748b', created_at: ops.now() };
    db.prepare('INSERT INTO tags (id, name, color, created_at) VALUES (@id, @name, @color, @created_at)').run(tag);
    res.json(tag);
  });
  app.put('/api/tags/:id', (req, res) => {
    const t = db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    const name = req.body?.name === undefined ? t.name : str(req.body.name, 40);
    const color = req.body?.color === undefined ? t.color : str(req.body.color, 20);
    if (!name) return res.status(400).json({ error: 'name required' });
    if (db.prepare('SELECT 1 FROM tags WHERE name = ? AND id != ?').get(name, t.id)) return res.status(409).json({ error: 'Tag exists' });
    db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').run(name, color, t.id);
    res.json({ ...t, name, color });
  });
  app.delete('/api/tags/:id', (req, res) => {
    db.transaction(() => {
      db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
      db.prepare('DELETE FROM host_tags WHERE tag_id = ?').run(req.params.id);
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
