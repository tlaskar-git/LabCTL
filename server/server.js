const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/agent' });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// JSON File Database
const DB_PATH = path.join(__dirname, 'labctl-data.json');
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); }
  catch { return { hosts: {}, jobs: {}, schedules: {}, credentials: {} }; }
}
function saveDB(data) { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); }
let db = loadDB();
let saveTimer = null;
function deferSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveDB(db), 500);
}

const agents = new Map();
function ts() { return new Date().toISOString(); }

function parseCronToNextRun(cronExpr) {
  const now = new Date();
  const parts = cronExpr.split(' ');
  if (parts.length !== 5) return new Date(now.getTime() + 3600000).toISOString();
  const [min, hour] = parts;
  const next = new Date(now);
  if (min !== '*') next.setMinutes(parseInt(min));
  if (hour !== '*') next.setHours(parseInt(hour));
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

// WebSocket
wss.on('connection', (ws) => {
  let hostId = null;
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'register': {
          hostId = msg.host_id;
          agents.set(hostId, ws);
          db.hosts[hostId] = {
            ...(db.hosts[hostId] || {}), id: hostId, hostname: msg.hostname,
            os: msg.os, ip: msg.ip, status: 'online', last_seen: ts(),
            system_info: msg.system_info || {}, created_at: db.hosts[hostId]?.created_at || ts()
          };
          deferSave();
          console.log(`[WS] Registered: ${msg.hostname} (${hostId})`);
          Object.values(db.jobs)
            .filter(j => j.host_id === hostId && j.status === 'pending')
            .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
            .forEach(job => { ws.send(JSON.stringify({ type: 'job', job })); job.status = 'sent'; });
          deferSave();
          break;
        }
        case 'heartbeat': {
          if (hostId && db.hosts[hostId]) {
            db.hosts[hostId].status = 'online';
            db.hosts[hostId].last_seen = ts();
            db.hosts[hostId].system_info = msg.system_info || db.hosts[hostId].system_info;
            deferSave();
          }
          break;
        }
        case 'job_started': {
          if (db.jobs[msg.job_id]) { db.jobs[msg.job_id].status = 'running'; db.jobs[msg.job_id].started_at = ts(); deferSave(); }
          break;
        }
        case 'job_complete': {
          const job = db.jobs[msg.job_id];
          if (job) {
            job.status = 'completed'; job.result = msg.output || ''; job.completed_at = ts();
            // Chain: waiting jobs
            Object.values(db.jobs).filter(j => j.host_id === job.host_id && j.status === 'waiting').forEach(wj => {
              const p = typeof wj.params === 'string' ? JSON.parse(wj.params) : wj.params;
              if (p._wait_for === msg.job_id) {
                wj.status = 'pending';
                const aw = agents.get(wj.host_id);
                if (aw && aw.readyState === 1) { aw.send(JSON.stringify({ type: 'job', job: wj })); wj.status = 'sent'; }
              }
            });
            // Chain: autologin after reboot
            const jp = typeof job.params === 'string' ? JSON.parse(job.params) : job.params;
            if (jp._chain_autologin && job.type === 'reboot') {
              const cred = Object.values(db.credentials).find(c => c.host_id === job.host_id && c.purpose === 'autologin');
              if (cred) {
                const cid = uuidv4();
                db.jobs[cid] = { id: cid, host_id: job.host_id, type: 'autologin',
                  params: JSON.stringify({ username: cred.username, password: cred.password }),
                  status: 'pending', result: '', error: '', created_at: ts() };
              }
            }
            deferSave();
          }
          break;
        }
        case 'job_failed': {
          if (db.jobs[msg.job_id]) {
            db.jobs[msg.job_id].status = 'failed'; db.jobs[msg.job_id].error = msg.error || 'Unknown';
            db.jobs[msg.job_id].completed_at = ts(); deferSave();
          }
          break;
        }
      }
    } catch (err) { console.error('[WS] Error:', err.message); }
  });
  ws.on('close', () => {
    if (hostId) { agents.delete(hostId); if (db.hosts[hostId]) db.hosts[hostId].status = 'offline'; deferSave(); }
  });
});

// Schedule checker
setInterval(() => {
  const t = ts();
  for (const s of Object.values(db.schedules)) {
    if (!s.enabled || !s.next_run || s.next_run > t) continue;
    const id = uuidv4();
    db.jobs[id] = { id, host_id: s.host_id, type: s.type, params: s.params || '{}', status: 'pending', result: '', error: '', created_at: t };
    const aw = agents.get(s.host_id);
    if (aw && aw.readyState === 1) { aw.send(JSON.stringify({ type: 'job', job: db.jobs[id] })); db.jobs[id].status = 'sent'; }
    s.last_run = t; s.next_run = parseCronToNextRun(s.cron);
  }
  deferSave();
}, 60000);

// Stale heartbeat
setInterval(() => {
  const cutoff = new Date(Date.now() - 120000).toISOString();
  for (const h of Object.values(db.hosts)) { if (h.status === 'online' && h.last_seen < cutoff) h.status = 'offline'; }
  deferSave();
}, 30000);

// REST API
app.get('/api/hosts', (req, res) => {
  res.json(Object.values(db.hosts).map(h => ({ ...h, online: agents.has(h.id) })).sort((a,b) => (a.hostname||'').localeCompare(b.hostname||'')));
});
app.delete('/api/hosts/:id', (req, res) => { delete db.hosts[req.params.id]; deferSave(); res.json({ ok: true }); });

app.get('/api/jobs', (req, res) => {
  const { host_id, status, limit = 200 } = req.query;
  let jobs = Object.values(db.jobs).sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  if (host_id) jobs = jobs.filter(j => j.host_id === host_id);
  if (status) jobs = jobs.filter(j => j.status === status);
  res.json(jobs.slice(0, parseInt(limit)).map(j => ({ ...j, hostname: db.hosts[j.host_id]?.hostname || j.host_id })));
});
app.get('/api/jobs/:id', (req, res) => {
  const j = db.jobs[req.params.id]; if (!j) return res.status(404).json({ error: 'Not found' });
  res.json({ ...j, hostname: db.hosts[j.host_id]?.hostname });
});
app.post('/api/jobs', (req, res) => {
  const { host_id, type, params = {} } = req.body;
  if (!host_id || !type) return res.status(400).json({ error: 'host_id and type required' });
  const id = uuidv4();
  db.jobs[id] = { id, host_id, type, params: JSON.stringify(params), status: 'pending', result: '', error: '', created_at: ts() };
  const aw = agents.get(host_id); if (aw && aw.readyState === 1) { aw.send(JSON.stringify({ type: 'job', job: db.jobs[id] })); db.jobs[id].status = 'sent'; }
  deferSave(); res.json({ id, status: db.jobs[id].status });
});
app.post('/api/jobs/batch', (req, res) => {
  const { host_ids, type, params = {} } = req.body;
  if (!host_ids || !type) return res.status(400).json({ error: 'host_ids and type required' });
  const results = [];
  for (const hid of host_ids) {
    const id = uuidv4();
    db.jobs[id] = { id, host_id: hid, type, params: JSON.stringify(params), status: 'pending', result: '', error: '', created_at: ts() };
    const aw = agents.get(hid); if (aw && aw.readyState === 1) { aw.send(JSON.stringify({ type: 'job', job: db.jobs[id] })); db.jobs[id].status = 'sent'; }
    results.push({ id, host_id: hid });
  }
  deferSave(); res.json(results);
});
app.post('/api/jobs/:id/cancel', (req, res) => {
  const j = db.jobs[req.params.id]; if (!j) return res.status(404).json({ error: 'Not found' });
  if (['pending','sent'].includes(j.status)) {
    j.status = 'cancelled';
    const aw = agents.get(j.host_id); if (aw && aw.readyState === 1) aw.send(JSON.stringify({ type: 'cancel_job', job_id: req.params.id }));
    deferSave();
  }
  res.json({ ok: true });
});

// Schedules
app.get('/api/schedules', (req, res) => { res.json(Object.values(db.schedules).map(s => ({ ...s, hostname: db.hosts[s.host_id]?.hostname || s.host_id }))); });
app.post('/api/schedules', (req, res) => {
  const { name, host_id, type, params = {}, cron } = req.body;
  if (!name || !host_id || !type || !cron) return res.status(400).json({ error: 'name, host_id, type, cron required' });
  const id = uuidv4();
  db.schedules[id] = { id, name, host_id, type, params: JSON.stringify(params), cron, enabled: true, last_run: null, next_run: parseCronToNextRun(cron), created_at: ts() };
  deferSave(); res.json({ id, next_run: db.schedules[id].next_run });
});
app.put('/api/schedules/:id', (req, res) => {
  const s = db.schedules[req.params.id]; if (!s) return res.status(404).json({ error: 'Not found' });
  const { name, cron, params, enabled } = req.body;
  if (name !== undefined) s.name = name;
  if (cron !== undefined) { s.cron = cron; s.next_run = parseCronToNextRun(cron); }
  if (params !== undefined) s.params = JSON.stringify(params);
  if (enabled !== undefined) s.enabled = !!enabled;
  deferSave(); res.json({ ok: true });
});
app.delete('/api/schedules/:id', (req, res) => { delete db.schedules[req.params.id]; deferSave(); res.json({ ok: true }); });

// Credentials
app.get('/api/credentials', (req, res) => {
  res.json(Object.values(db.credentials).map(c => ({ id: c.id, host_id: c.host_id, username: c.username, purpose: c.purpose, hostname: db.hosts[c.host_id]?.hostname || c.host_id })));
});
app.post('/api/credentials', (req, res) => {
  const { host_id, username, password, purpose = 'autologin' } = req.body;
  if (!host_id || !username || !password) return res.status(400).json({ error: 'All fields required' });
  const existing = Object.values(db.credentials).find(c => c.host_id === host_id && c.purpose === purpose);
  if (existing) { existing.username = username; existing.password = password; deferSave(); return res.json({ id: existing.id, updated: true }); }
  const id = uuidv4(); db.credentials[id] = { id, host_id, username, password, purpose, created_at: ts() }; deferSave(); res.json({ id, created: true });
});
app.delete('/api/credentials/:id', (req, res) => { delete db.credentials[req.params.id]; deferSave(); res.json({ ok: true }); });

// Chains
app.post('/api/chains/proxmox-backup-all', (req, res) => {
  const { host_ids, script = '/root/proxmox-vm-backup.sh', reboot_after = false } = req.body;
  const results = [];
  for (const hid of host_ids) {
    const id = uuidv4();
    db.jobs[id] = { id, host_id: hid, type: 'backup', params: JSON.stringify({ script, reboot_after }), status: 'pending', result: '', error: '', created_at: ts() };
    const aw = agents.get(hid); if (aw && aw.readyState === 1) { aw.send(JSON.stringify({ type: 'job', job: db.jobs[id] })); db.jobs[id].status = 'sent'; }
    results.push({ host_id: hid, job_id: id });
  }
  deferSave(); res.json(results);
});

app.post('/api/chains/backup-reboot-autologin', (req, res) => {
  const { host_id, backup_script, username, password } = req.body;
  const ex = Object.values(db.credentials).find(c => c.host_id === host_id && c.purpose === 'autologin');
  if (ex) { ex.username = username; ex.password = password; }
  else { const cid = uuidv4(); db.credentials[cid] = { id: cid, host_id, username, password, purpose: 'autologin', created_at: ts() }; }
  const backupId = uuidv4();
  db.jobs[backupId] = { id: backupId, host_id, type: 'backup', params: JSON.stringify({ script: backup_script || '/root/proxmox-vm-backup.sh' }), status: 'pending', result: '', error: '', created_at: ts() };
  const rebootId = uuidv4();
  db.jobs[rebootId] = { id: rebootId, host_id, type: 'reboot', params: JSON.stringify({ _wait_for: backupId, _chain_autologin: true }), status: 'waiting', result: '', error: '', created_at: ts() };
  const aw = agents.get(host_id); if (aw && aw.readyState === 1) { aw.send(JSON.stringify({ type: 'job', job: db.jobs[backupId] })); db.jobs[backupId].status = 'sent'; }
  deferSave(); res.json({ backup_job: backupId, reboot_job: rebootId });
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache');
  const i = setInterval(() => {
    const hosts = Object.values(db.hosts).map(h => ({ ...h, online: agents.has(h.id) }));
    const jobs = Object.values(db.jobs).sort((a,b) => (b.created_at||'').localeCompare(a.created_at||'')).slice(0,20).map(j => ({ ...j, hostname: db.hosts[j.host_id]?.hostname }));
    res.write(`data: ${JSON.stringify({ hosts, jobs })}\n\n`);
  }, 3000);
  req.on('close', () => clearInterval(i));
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const PORT = process.env.PORT || 7700;
server.listen(PORT, '0.0.0.0', () => { console.log(`[LabCTL] http://0.0.0.0:${PORT}`); console.log(`[LabCTL] ws://0.0.0.0:${PORT}/ws/agent`); });
