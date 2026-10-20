// LabCTL server: builds ctx, the express app and the http server, then loads every file in src/routes/.
// Each route file exports (app, ctx) => void. Every /api route needs a session unless ctx.allowPublic(prefix) says so.
// Non-GET /api requests need the operator role (except /api/auth/*); routes add ctx.requireRole('admin') where needed.
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const { createCrypto } = require('./crypto');
const { openDb } = require('./db');
const { createSettings } = require('./settings');
const { createAudit } = require('./audit');
const { createJobLog } = require('./joblog');
const { createTokens } = require('./tokens');
const { createAuth, requireConfirm } = require('./auth');
const { createJobs } = require('./jobs');
const { createAgents } = require('./agents');
const { createScheduler } = require('./scheduler');
const { createRetention } = require('./retention');
const { migrateLegacyJson } = require('./migrate');
const BUILTIN_SCRIPTS = require('./builtin-scripts');

const SERVER_DIR = path.join(__dirname, '..');

function readVersion() {
  for (const p of [path.join(SERVER_DIR, 'VERSION'), path.join(SERVER_DIR, '..', 'VERSION')]) {
    try { return fs.readFileSync(p, 'utf8').trim(); } catch { /* next */ }
  }
  return '0.0.0';
}

function makeLogger(quiet) {
  const out = (fn) => (...a) => { if (!quiet) fn('[LabCTL]', ...a); };
  return { info: out(console.log), warn: out(console.warn), error: (...a) => console.error('[LabCTL]', ...a) };
}

function createApp({ dataDir = process.env.DATA_DIR || path.join(SERVER_DIR, 'data'), masterKey = process.env.LABCTL_MASTER_KEY, quiet = false } = {}) {
  const crypto = createCrypto(masterKey); // throws a clear error when the key is missing or wrong
  const db = openDb(dataDir);
  const settings = createSettings(db);
  const auth = createAuth(db);
  const publicPrefixes = [];
  const closers = []; // stop functions for timers and in-flight work; close() awaits them before the db closes
  const ctx = {
    db, crypto, settings, auth,
    events: new EventEmitter(),
    logger: makeLogger(quiet),
    audit: createAudit(db),
    joblog: createJobLog(path.join(dataDir, 'job-logs'), () => settings.get('job_log_max_bytes')),
    tokens: createTokens(db),
    requireRole: role => auth.requireRole(role),
    requireConfirm,
    allowPublic: prefix => publicPrefixes.push(prefix),
    onClose: fn => closers.push(fn),
    version: readVersion(),
    startedAt: Date.now(),
    paths: { serverDir: SERVER_DIR, dataDir, publicDir: path.join(SERVER_DIR, 'public') }
  };
  ctx.events.setMaxListeners(0);
  ctx.jobs = createJobs(ctx);
  ctx.agents = createAgents(ctx);
  ctx.scheduler = createScheduler(ctx);
  ctx.retention = createRetention(ctx);

  // Data bootstrap: v1 import, built-in scripts, default admin, default enrolment token.
  migrateLegacyJson(ctx, [path.join(dataDir, 'labctl-data.json'), path.join(SERVER_DIR, 'labctl-data.json')]);
  const now = new Date().toISOString();
  for (const s of BUILTIN_SCRIPTS) {
    db.prepare(`INSERT OR IGNORE INTO scripts (id, name, description, os, target, command, timeout, builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(s.id, s.name, s.description, s.os, s.target, s.command, s.timeout, now, now);
  }
  if (!db.prepare('SELECT COUNT(*) AS n FROM users').get().n) {
    auth.makeUser('LabCTLAdmin', 'LabCTL', 'admin');
    ctx.logger.warn('Created the default admin user. Change its password after the first sign-in.');
  }
  if (!ctx.tokens.count()) {
    const t = ctx.tokens.create('Default enrolment token', 'system');
    ctx.logger.info(`Created default enrolment token ${t.id}. Its value is not shown. Rotate it under Settings > Enrolment tokens (POST /api/tokens/${t.id}/rotate) to read a value once.`);
  }

  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(ctx.paths.publicDir));

  const PUBLIC_EXACT = new Set(['/auth/login', '/auth/me', '/health']);
  const isPublic = p => PUBLIC_EXACT.has(p) || publicPrefixes.some(prefix => p.startsWith(prefix));
  app.use('/api', ctx.audit.middleware);
  app.use('/api', (req, res, next) => (isPublic(req.path) ? next() : auth.middleware(req, res, next)));
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || isPublic(req.path) || req.path.startsWith('/auth/')) return next();
    return auth.requireRole('operator')(req, res, next);
  });

  const routesDir = path.join(__dirname, 'routes');
  for (const file of fs.readdirSync(routesDir).filter(f => f.endsWith('.js')).sort()) {
    require(path.join(routesDir, file))(app, ctx);
  }

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.get('*', (req, res) => res.sendFile(path.join(ctx.paths.publicDir, 'index.html')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    ctx.logger.error(err.message);
    res.status(err.status || 500).json({ error: err.expose ? err.message : 'Internal error' });
  });

  const server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => ctx.agents.handleUpgrade(req, socket, head));

  let staleTimer = null;
  return {
    app, server, ctx,
    listen(port = process.env.PORT || 7700, host = '0.0.0.0') {
      ctx.scheduler.start();
      ctx.retention.start();
      // Hosts with no heartbeat for 2 minutes are offline.
      staleTimer = setInterval(() => {
        db.prepare("UPDATE hosts SET status = 'offline' WHERE status = 'online' AND last_seen < ?").run(new Date(Date.now() - 120000).toISOString());
      }, 30000);
      staleTimer.unref();
      return new Promise(resolve => server.listen(port, host, () => resolve(server.address().port)));
    },
    async close() {
      ctx.scheduler.stop();
      ctx.retention.stop();
      clearInterval(staleTimer);
      for (const fn of [...closers].reverse()) {
        try { await fn(); } catch (err) { ctx.logger.error('[close]', err.message); }
      }
      ctx.agents.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(() => resolve()));
      db.close();
    }
  };
}

async function start() {
  let instance;
  try {
    instance = createApp();
  } catch (err) {
    console.error(`[LabCTL] Cannot start: ${err.message}`);
    process.exit(1);
  }
  const port = await instance.listen();
  instance.ctx.logger.info(`LabCTL ${instance.ctx.version} on http://0.0.0.0:${port} (agents: /ws/agent)`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => instance.close().finally(() => process.exit(0)));
}

module.exports = { createApp, start, readVersion };
