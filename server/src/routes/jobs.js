// Jobs and v1 chains. Output is read from data/job-logs, never from the database.
const { randomUUID } = require('crypto');
module.exports = (app, ctx) => {
  const { jobs } = ctx;
  const actor = req => req.user?.username;

  app.get('/api/jobs', (req, res) => {
    const { host_id, status, limit = 200, offset = 0 } = req.query;
    res.json(jobs.list({ host_id, status, limit, offset }).map(j => jobs.out(j)));
  });
  app.get('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    res.json(jobs.out(job, { full: true }));
  });
  app.get('/api/jobs/:id/log', (req, res) => {
    if (!jobs.get(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.type('text/plain').send(ctx.joblog.read(req.params.id));
  });
  app.post('/api/jobs', (req, res) => {
    const { host_id, type, params = {} } = req.body || {};
    if (!host_id || !type) return res.status(400).json({ error: 'host_id and type required' });
    const job = jobs.create({ host_id, type, params, actor: actor(req) });
    res.json({ id: job.id, status: job.status });
  });
  app.post('/api/jobs/batch', (req, res) => {
    const { host_ids, type, params = {} } = req.body || {};
    if (!Array.isArray(host_ids) || !type) return res.status(400).json({ error: 'host_ids and type required' });
    res.json(host_ids.map(hid => ({ id: jobs.create({ host_id: hid, type, params, actor: actor(req) }).id, host_id: hid })));
  });
  app.post('/api/jobs/:id/cancel', (req, res) => {
    if (!jobs.cancel(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  app.post('/api/chains/proxmox-backup-all', (req, res) => {
    const { host_ids, script = '/root/proxmox-vm-backup.sh', reboot_after = false } = req.body || {};
    if (!Array.isArray(host_ids)) return res.status(400).json({ error: 'host_ids required' });
    res.json(host_ids.map(hid => ({ host_id: hid,
      job_id: jobs.create({ host_id: hid, type: 'backup', params: { script, reboot_after }, actor: actor(req) }).id })));
  });
  // Stores an autologin credential, so admin only (credentials are admin only).
  app.post('/api/chains/backup-reboot-autologin', ctx.requireRole('admin'), (req, res) => {
    const { host_id, backup_script, username, password } = req.body || {};
    if (!host_id || !username || !password) return res.status(400).json({ error: 'host_id, username and password required' });
    const { db, crypto } = ctx;
    const now = new Date().toISOString();
    const sealed = crypto.sealJson({ password });
    const ex = db.prepare("SELECT id FROM credentials WHERE host_id = ? AND purpose = 'autologin'").get(host_id);
    if (ex) db.prepare('UPDATE credentials SET username = ?, sealed = ?, updated_at = ? WHERE id = ?').run(username, sealed, now, ex.id);
    else db.prepare("INSERT INTO credentials (id, host_id, username, purpose, kind, sealed, created_at, updated_at) VALUES (?, ?, ?, 'autologin', 'password', ?, ?, ?)")
      .run(randomUUID(), host_id, username, sealed, now, now);
    const backup = jobs.create({ host_id, type: 'backup', params: { script: backup_script || '/root/proxmox-vm-backup.sh' }, actor: actor(req) });
    const reboot = jobs.create({ host_id, type: 'reboot', params: { _wait_for: backup.id, _chain_autologin: true }, status: 'waiting', actor: actor(req) });
    res.json({ backup_job: backup.id, reboot_job: reboot.id });
  });
};
