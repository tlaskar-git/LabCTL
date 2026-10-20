// Jobs and v1 chains. Output is read from data/job-logs, never from the database.
const { randomUUID } = require('crypto');
module.exports = (app, ctx) => {
  const { jobs } = ctx;
  const actor = req => req.user?.username;

  // Seals an auto-login password into the host's credential and returns its id (credentials are admin only).
  function saveAutologin(host_id, username, password) {
    const { db, crypto } = ctx;
    const now = new Date().toISOString();
    const sealed = crypto.sealJson({ password });
    const ex = db.prepare("SELECT id FROM credentials WHERE host_id = ? AND purpose = 'autologin'").get(host_id);
    if (ex) { db.prepare('UPDATE credentials SET username = ?, sealed = ?, updated_at = ? WHERE id = ?').run(username, sealed, now, ex.id); return ex.id; }
    const id = randomUUID();
    db.prepare("INSERT INTO credentials (id, host_id, username, purpose, kind, sealed, created_at, updated_at) VALUES (?, ?, ?, 'autologin', 'password', ?, ?, ?)")
      .run(id, host_id, username, sealed, now, now);
    return id;
  }
  // A typed autologin job never stores its password: it is sealed into a credential and the job keeps credential_id.
  // Returns the params to store, or null after a 403.
  function jobParams(req, res, type, params, host_id) {
    if (type !== 'autologin' || !params || params.password === undefined) return params;
    if (req.user?.role !== 'admin') { res.status(403).json({ error: 'Saving an auto-login password needs the admin role' }); return null; }
    const { password, ...rest } = params;
    return { ...rest, credential_id: saveAutologin(host_id, rest.username || '', String(password)) };
  }

  app.get('/api/jobs', (req, res) => {
    const { host_id, status, type, actor: by, group_id, from, to, limit = 200, offset = 0 } = req.query;
    res.json(jobs.list({ host_id, status, type, actor: by, group_id, from, to, limit, offset }).map(j => jobs.out(j)));
  });
  app.get('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    res.json(jobs.out(job, { full: true, log: req.query.log !== '0' })); // ?log=0 skips the output (the drawer streams it)
  });
  app.get('/api/jobs/:id/log', (req, res) => {
    if (!jobs.get(req.params.id)) return res.status(404).json({ error: 'Not found' });
    // ?from=&to= returns a byte range; a start inside a line moves forward to the next line start (X-Log-Start says where).
    if (req.query.from !== undefined || req.query.to !== undefined) {
      const buf = ctx.joblog.readBuffer(req.params.id);
      const to = Math.min(buf.length, Number(req.query.to ?? buf.length) || 0);
      let from = Math.max(0, Number(req.query.from) || 0);
      if (from > 0 && buf[from - 1] !== 10) { const nl = buf.indexOf(10, from); if (nl >= 0 && nl + 1 < to) from = nl + 1; }
      res.set({ 'X-Log-Start': String(from), 'X-Log-Total': String(buf.length) });
      return res.type('text/plain').send(buf.subarray(from, Math.max(from, to)));
    }
    res.type('text/plain').send(ctx.joblog.read(req.params.id));
  });
  // New job with the same host, type, params and script.
  app.post('/api/jobs/:id/retry', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    if (jobs.OPEN_STATES.includes(job.status)) return res.status(409).json({ error: 'Job is still open' });
    const copy = jobs.copyJob(job, { actor: actor(req) });
    res.json({ id: copy.id, status: copy.status });
  });
  app.post('/api/jobs', (req, res) => {
    const { host_id, type, params = {} } = req.body || {};
    if (!host_id || !type) return res.status(400).json({ error: 'host_id and type required' });
    const stored = jobParams(req, res, type, params, host_id);
    if (!stored) return;
    const job = jobs.create({ host_id, type, params: stored, actor: actor(req) });
    res.json({ id: job.id, status: job.status });
  });
  app.post('/api/jobs/batch', (req, res) => {
    const { host_ids, type, params = {} } = req.body || {};
    if (!Array.isArray(host_ids) || !type) return res.status(400).json({ error: 'host_ids and type required' });
    if (type === 'autologin' && params.password !== undefined && req.user?.role !== 'admin') return jobParams(req, res, type, params);
    // One group per batch; each entry carries group_id so the UI can open the host grid.
    const group = jobs.createGroup({ label: type, type, actor: actor(req) });
    res.json(host_ids.map(hid => ({ id: jobs.create({ host_id: hid, type, params: jobParams(req, res, type, params, hid), actor: actor(req), group_id: group.id }).id, host_id: hid, group_id: group.id })));
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
    saveAutologin(host_id, username, password);
    const backup = jobs.create({ host_id, type: 'backup', params: { script: backup_script || '/root/proxmox-vm-backup.sh' }, actor: actor(req) });
    const reboot = jobs.create({ host_id, type: 'reboot', params: { _wait_for: backup.id, _chain_autologin: true }, status: 'waiting', actor: actor(req) });
    res.json({ backup_job: backup.id, reboot_job: reboot.id });
  });
};
