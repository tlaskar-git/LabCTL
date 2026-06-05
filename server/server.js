const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/agent' });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Persistent local database
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'labctl-data.json');
const LEGACY_DB_PATH = path.join(__dirname, 'labctl-data.json');
const DEFAULT_SETTINGS = { retention_days: 30, poll_interval_seconds: 300, theme: 'dark' };

function loadDB() {
  const source = fs.existsSync(DB_PATH) ? DB_PATH : LEGACY_DB_PATH;
  try { return JSON.parse(fs.readFileSync(source, 'utf-8')); }
  catch { return {}; }
}
function defaultDB() {
  return {
    hosts: {}, jobs: {}, schedules: {}, credentials: {}, groups: {},
    users: {}, sessions: {}, metrics: [], scripts: {}, settings: { ...DEFAULT_SETTINGS }
  };
}
function normalizeDB(data) {
  const next = { ...defaultDB(), ...data };
  next.hosts = next.hosts || {};
  next.jobs = next.jobs || {};
  next.schedules = next.schedules || {};
  next.credentials = next.credentials || {};
  next.groups = next.groups || {};
  next.users = next.users || {};
  next.sessions = next.sessions || {};
  next.metrics = Array.isArray(next.metrics) ? next.metrics : [];
  next.scripts = next.scripts || {};
  next.settings = { ...DEFAULT_SETTINGS, ...(next.settings || {}) };
  if (!Object.keys(next.users).length) {
    const admin = makeUser('LabCTLAdmin', 'LabCTL', 'admin');
    next.users[admin.id] = admin;
  }
  return next;
}
function saveDB(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}
let db = normalizeDB(loadDB());
let saveTimer = null;
function deferSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveDB(db), 500);
}
saveDB(db);

const agents = new Map();
function ts() { return new Date().toISOString(); }

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hashPassword(password, salt).split(':')[1]));
}
function makeUser(username, password, role = 'readonly') {
  const id = uuidv4();
  return { id, username, role, password_hash: hashPassword(password), created_at: ts(), updated_at: ts() };
}
function publicUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, role: user.role, created_at: user.created_at, updated_at: user.updated_at };
}
function parseCookie(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim().split('=')).filter(p => p.length === 2));
}
function getToken(req) {
  const auth = req.get('authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return parseCookie(req.get('cookie')).labctl_session || '';
}
function authMiddleware(req, res, next) {
  const token = getToken(req);
  const session = token && db.sessions[token];
  const user = session && db.users[session.user_id];
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  session.last_seen = ts();
  req.user = user;
  req.sessionToken = token;
  next();
}
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });
  next();
}
function protectWrites(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Readonly users cannot change LabCTL state' });
  }
  next();
}

function extractMetrics(host, info = {}) {
  const ramTotal = Number(info.ram_mb || 0);
  const ramAvail = Number(info.ram_available_mb || 0);
  const dockerDetails = Array.isArray(info.docker_details) ? info.docker_details : [];
  const problemContainers = dockerDetails.filter(c => {
    const status = String(c.status || '').toLowerCase();
    return status && (!status.startsWith('up') || status.includes('unhealthy') || status.includes('exited'));
  });
  return {
    id: uuidv4(),
    host_id: host.id,
    hostname: host.hostname,
    os: host.os,
    ip: host.ip,
    created_at: ts(),
    uptime_hours: info.uptime_hours || null,
    ram_total_mb: ramTotal || null,
    ram_used_percent: ramTotal ? Math.round(((ramTotal - ramAvail) / ramTotal) * 100) : null,
    drives: Array.isArray(info.drives) ? info.drives.map(d => ({
      device: d.device, mount: d.mount, total_gb: d.total_gb, used_gb: d.used_gb,
      free_gb: d.free_gb, percent: d.percent
    })) : [],
    docker_running: info.docker_running ?? null,
    docker_total: info.docker_total ?? dockerDetails.length,
    docker_problem_count: info.docker_problem_count ?? problemContainers.length,
    docker_problems: problemContainers.map(c => ({ name: c.name, image: c.image, status: c.status })).slice(0, 20),
    critical_services: Array.isArray(info.critical_services) ? info.critical_services.slice(0, 50) : [],
    services_count: Array.isArray(info.services) ? info.services.length : null
  };
}
function maybeRecordMetrics(hostId, force = false) {
  const host = db.hosts[hostId];
  if (!host || !host.system_info) return;
  const intervalMs = Math.max(60, Number(db.settings.poll_interval_seconds || 300)) * 1000;
  const last = [...db.metrics].reverse().find(m => m.host_id === hostId);
  if (!force && last && (Date.now() - new Date(last.created_at).getTime()) < intervalMs) return;
  db.metrics.push(extractMetrics(host, host.system_info));
  pruneMetrics();
}
function pruneMetrics() {
  const days = Math.max(1, Number(db.settings.retention_days || 30));
  const cutoff = Date.now() - days * 86400000;
  db.metrics = db.metrics.filter(m => new Date(m.created_at).getTime() >= cutoff);
}
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

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
          maybeRecordMetrics(hostId, true);
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
            maybeRecordMetrics(hostId);
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

// Auth
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = Object.values(db.users).find(u => u.username === username);
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { token, user_id: user.id, created_at: ts(), last_seen: ts() };
  deferSave();
  res.cookie('labctl_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 86400000 });
  res.json({ token, user: publicUser(user) });
});
app.post('/api/auth/logout', authMiddleware, (req, res) => {
  delete db.sessions[req.sessionToken];
  deferSave();
  res.clearCookie('labctl_session');
  res.json({ ok: true });
});
app.get('/api/auth/me', (req, res) => {
  const token = getToken(req);
  const session = token && db.sessions[token];
  const user = session && db.users[session.user_id];
  res.json({ user: publicUser(user) });
});

app.use('/api', authMiddleware, protectWrites);

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

// Users
app.get('/api/users', adminOnly, (req, res) => {
  res.json(Object.values(db.users).map(publicUser).sort((a,b) => a.username.localeCompare(b.username)));
});
app.post('/api/users', adminOnly, (req, res) => {
  const { username, password, role = 'readonly' } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (!['admin', 'readonly'].includes(role)) return res.status(400).json({ error: 'role must be admin or readonly' });
  if (Object.values(db.users).some(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: 'username already exists' });
  }
  const user = makeUser(username, password, role);
  db.users[user.id] = user;
  deferSave();
  res.json(publicUser(user));
});
app.put('/api/users/:id', adminOnly, (req, res) => {
  const user = db.users[req.params.id];
  if (!user) return res.status(404).json({ error: 'Not found' });
  const { password, role } = req.body || {};
  if (role !== undefined) {
    if (!['admin', 'readonly'].includes(role)) return res.status(400).json({ error: 'role must be admin or readonly' });
    user.role = role;
  }
  if (password) user.password_hash = hashPassword(password);
  user.updated_at = ts();
  deferSave();
  res.json(publicUser(user));
});
app.delete('/api/users/:id', adminOnly, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own user' });
  const user = db.users[req.params.id];
  if (!user) return res.status(404).json({ error: 'Not found' });
  const admins = Object.values(db.users).filter(u => u.role === 'admin' && u.id !== req.params.id);
  if (!admins.length) return res.status(400).json({ error: 'At least one admin user is required' });
  delete db.users[req.params.id];
  Object.keys(db.sessions).forEach(token => { if (db.sessions[token].user_id === req.params.id) delete db.sessions[token]; });
  deferSave();
  res.json({ ok: true });
});

// Settings and telemetry history
app.get('/api/settings', (req, res) => { res.json(db.settings); });
app.put('/api/settings', adminOnly, (req, res) => {
  const { retention_days, poll_interval_seconds, theme } = req.body || {};
  if (retention_days !== undefined) db.settings.retention_days = Math.max(1, Math.min(3650, Number(retention_days) || 30));
  if (poll_interval_seconds !== undefined) db.settings.poll_interval_seconds = Math.max(60, Math.min(86400, Number(poll_interval_seconds) || 300));
  if (theme && ['dark', 'light'].includes(theme)) db.settings.theme = theme;
  pruneMetrics();
  deferSave();
  res.json(db.settings);
});
app.get('/api/metrics', (req, res) => {
  const { host_id, limit = 500 } = req.query;
  let rows = db.metrics;
  if (host_id) rows = rows.filter(m => m.host_id === host_id);
  rows = rows.sort((a,b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, Math.min(5000, Number(limit) || 500));
  res.json(rows);
});
app.get('/api/health', (req, res) => {
  const latest = new Map();
  db.metrics.forEach(m => latest.set(m.host_id, m));
  const rows = Object.values(db.hosts).map(h => {
    const m = latest.get(h.id);
    const drives = Array.isArray(m?.drives) ? m.drives : [];
    const maxDisk = drives.reduce((max, d) => Math.max(max, Number(d.percent || 0)), 0);
    const criticals = [];
    if (maxDisk >= 90) criticals.push(`Disk at ${maxDisk}%`);
    if (m?.ram_used_percent >= 90) criticals.push(`RAM at ${m.ram_used_percent}%`);
    if (m?.docker_problem_count > 0) criticals.push(`${m.docker_problem_count} Docker issue(s)`);
    if (m?.critical_services?.length) criticals.push(`${m.critical_services.length} service issue(s)`);
    return { host_id: h.id, hostname: h.hostname, online: agents.has(h.id), last_seen: h.last_seen, latest: m || null, criticals };
  });
  res.json(rows);
});

// Groups
if (!db.groups) db.groups = {};
app.get('/api/groups', (req, res) => {
  res.json(Object.values(db.groups).sort((a,b) => (a.order||0) - (b.order||0)));
});
app.post('/api/groups', (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uuidv4();
  const order = Object.keys(db.groups).length;
  db.groups[id] = { id, name, color: color || '#3b82f6', order, created_at: ts() };
  deferSave(); res.json(db.groups[id]);
});
app.put('/api/groups/:id', (req, res) => {
  const g = db.groups[req.params.id]; if (!g) return res.status(404).json({ error: 'Not found' });
  const { name, color, order } = req.body;
  if (name !== undefined) g.name = name;
  if (color !== undefined) g.color = color;
  if (order !== undefined) g.order = order;
  deferSave(); res.json(g);
});
app.delete('/api/groups/:id', (req, res) => {
  delete db.groups[req.params.id];
  // Unassign hosts from this group
  Object.values(db.hosts).forEach(h => { if (h.group_id === req.params.id) h.group_id = null; });
  deferSave(); res.json({ ok: true });
});
app.put('/api/hosts/:id/group', (req, res) => {
  const host = db.hosts[req.params.id]; if (!host) return res.status(404).json({ error: 'Not found' });
  host.group_id = req.body.group_id || null;
  deferSave(); res.json({ ok: true });
});

// Custom scripts/jobs
app.get('/api/scripts', (req, res) => {
  res.json(Object.values(db.scripts).sort((a,b) => (b.updated_at || '').localeCompare(a.updated_at || '')));
});
app.post('/api/scripts', (req, res) => {
  const { name, description = '', os = 'any', target = 'host', command, timeout = 300 } = req.body || {};
  if (!name || !command) return res.status(400).json({ error: 'name and command required' });
  if (!['any', 'linux', 'windows'].includes(os)) return res.status(400).json({ error: 'os must be any, linux, or windows' });
  if (!['host', 'container'].includes(target)) return res.status(400).json({ error: 'target must be host or container' });
  const id = uuidv4();
  db.scripts[id] = { id, name, description, os, target, command, timeout: Number(timeout) || 300, created_at: ts(), updated_at: ts() };
  deferSave();
  res.json(db.scripts[id]);
});
app.put('/api/scripts/:id', (req, res) => {
  const script = db.scripts[req.params.id];
  if (!script) return res.status(404).json({ error: 'Not found' });
  const { name, description, os, target, command, timeout } = req.body || {};
  if (name !== undefined) script.name = name;
  if (description !== undefined) script.description = description;
  if (os !== undefined && ['any', 'linux', 'windows'].includes(os)) script.os = os;
  if (target !== undefined && ['host', 'container'].includes(target)) script.target = target;
  if (command !== undefined) script.command = command;
  if (timeout !== undefined) script.timeout = Number(timeout) || script.timeout;
  script.updated_at = ts();
  deferSave();
  res.json(script);
});
app.delete('/api/scripts/:id', (req, res) => { delete db.scripts[req.params.id]; deferSave(); res.json({ ok: true }); });
app.post('/api/scripts/:id/run', (req, res) => {
  const script = db.scripts[req.params.id];
  if (!script) return res.status(404).json({ error: 'Not found' });
  const { host_ids = [], container = '' } = req.body || {};
  if (!Array.isArray(host_ids) || !host_ids.length) return res.status(400).json({ error: 'host_ids required' });
  const results = [];
  for (const hid of host_ids) {
    const host = db.hosts[hid];
    if (!host) continue;
    const hostOs = String(host.os || '').toLowerCase();
    if (script.os !== 'any' && !hostOs.includes(script.os)) {
      results.push({ host_id: hid, skipped: true, reason: `Script is ${script.os}-only` });
      continue;
    }
    let command = script.command;
    if (script.target === 'container') {
      if (!container) { results.push({ host_id: hid, skipped: true, reason: 'Container name required' }); continue; }
      command = `docker exec ${shellQuote(container)} sh -lc ${shellQuote(script.command)}`;
    }
    const id = uuidv4();
    db.jobs[id] = { id, host_id: hid, type: 'custom_command', params: JSON.stringify({ command, timeout: script.timeout }), status: 'pending', result: '', error: '', created_at: ts(), script_id: script.id };
    const aw = agents.get(hid); if (aw && aw.readyState === 1) { aw.send(JSON.stringify({ type: 'job', job: db.jobs[id] })); db.jobs[id].status = 'sent'; }
    results.push({ host_id: hid, job_id: id, status: db.jobs[id].status });
  }
  deferSave();
  res.json(results);
});

// Agent bundles and install help
app.get('/api/agents/info', (req, res) => {
  const wsProto = req.protocol === 'https' ? 'wss' : 'ws';
  const server_url = `${wsProto}://${req.get('host')}/ws/agent`;
  res.json({
    server_url,
    files: [
      { id: 'linux', label: 'Linux setup script', path: '/api/agents/download/setup-linux.sh' },
      { id: 'windows', label: 'Windows setup script', path: '/api/agents/download/setup-windows.ps1' },
      { id: 'agent', label: 'Agent source', path: '/api/agents/download/labctl-agent.py' }
    ]
  });
});
app.get('/api/agents/download/:file', (req, res) => {
  const allowed = new Set(['setup-linux.sh', 'setup-windows.ps1', 'labctl-agent.py']);
  const file = req.params.file;
  if (!allowed.has(file)) return res.status(404).json({ error: 'Not found' });
  const candidates = [path.join(__dirname, 'agent', file), path.join(__dirname, '..', 'agent', file)];
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) return res.status(404).json({ error: 'Agent file not found in image' });
  res.download(found, file);
});

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
