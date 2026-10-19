'use strict';
// labctl-updater: tiny sidecar that updates the labctl container. No dependencies.
// Internal network only (no published ports). Every request except GET /healthz needs the header
// X-Updater-Secret equal to the environment variable LABCTL_UPDATER_SECRET.
// Endpoints: POST /update {image_tag}, POST /update-git, POST /rollback, GET /status, GET /healthz.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const TAG_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = () => new Date().toISOString();

function secretOk(given, expected) {
  if (!expected || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Minimal Docker Engine API client over the unix socket.
function createDocker(socketPath = '/var/run/docker.sock') {
  function request(method, p, body) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ socketPath, method, path: p,
        headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* streamed or empty */ }
          if (res.statusCode >= 400) return reject(new Error(`docker ${method} ${p.split('?')[0]} -> ${res.statusCode}: ${(json && json.message) || text.slice(0, 200)}`));
          resolve({ status: res.statusCode, json, text });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }
  const q = encodeURIComponent;
  return {
    inspect: async name => (await request('GET', `/containers/${q(name)}/json`)).json,
    async pull(image, tag) {
      const { text } = await request('POST', `/images/create?fromImage=${q(image)}&tag=${q(tag)}`);
      for (const line of text.split('\n')) { // pull progress is JSON lines; an error line means failure
        try { const o = JSON.parse(line); if (o.error) throw new Error(`pull failed: ${o.error}`); } catch (e) { if (e.message.startsWith('pull failed')) throw e; }
      }
    },
    async stop(name) { try { await request('POST', `/containers/${q(name)}/stop?t=20`); } catch (e) { if (!/-> 304/.test(e.message)) throw e; } },
    async remove(name) { try { await request('DELETE', `/containers/${q(name)}?force=true`); } catch (e) { if (!/-> 404/.test(e.message)) throw e; } },
    async create(name, body) { return (await request('POST', `/containers/create?name=${q(name)}`, body)).json; },
    async start(name) { await request('POST', `/containers/${q(name)}/start`); }
  };
}

// Container create body that repeats the inspected container's config on another image.
function createBody(inspect, image) {
  const nets = inspect.NetworkSettings?.Networks || {};
  const endpoints = {};
  for (const [name, n] of Object.entries(nets)) {
    endpoints[name] = { Aliases: (n.Aliases || []).filter(a => !inspect.Id.startsWith(a)), IPAMConfig: n.IPAMConfig || undefined };
  }
  return { ...inspect.Config, Hostname: undefined, Image: image, HostConfig: inspect.HostConfig, NetworkingConfig: { EndpointsConfig: endpoints } };
}

// Copy the SQLite file with its -wal and -shm side files. Used when the labctl API cannot run a backup.
function copyDbFiles(dataDir, now = new Date()) {
  const dest = path.join(dataDir, 'backups', `pre-update-${now.toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const f of ['labctl.db', 'labctl.db-wal', 'labctl.db-shm']) {
    const src = path.join(dataDir, f);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dest, f)); copied++; }
  }
  if (!copied) throw new Error('no database file found to copy');
  return dest;
}

// The update state machine. deps: docker, backup(), health() -> version|null, run(cmd, args, opts), env, sleep.
function createUpdater(deps) {
  const { docker, backup, health, run } = deps;
  const env = deps.env || {};
  const name = env.container || 'labctl';
  const image = env.image || 'ghcr.io/tlaskar-git/labctl';
  const healthMs = env.healthTimeoutMs ?? 90000;
  const pollMs = env.pollMs ?? 2000;
  const nap = deps.sleep || sleep;
  const status = { state: 'idle', target: null, from: null, mode: null, steps: [], started: null, finished: null, error: null };
  let previous = null; // { imageId, tag, inspect, sha } of the last run, used by rollback

  function step(stepName, st = 'running', detail) {
    const cur = status.steps.find(s => s.name === stepName);
    if (cur) { cur.status = st; cur.at = iso(); if (detail !== undefined) cur.detail = detail; return; }
    status.steps.push({ name: stepName, status: st, at: iso(), detail });
  }
  async function stage(stepName, fn) {
    step(stepName);
    try { const r = await fn(); step(stepName, 'ok'); return r; } catch (err) { step(stepName, 'failed', String(err.message || err).slice(0, 300)); throw err; }
  }
  async function waitHealthy(version) {
    const end = Date.now() + healthMs;
    for (;;) {
      let v = null;
      try { v = await health(); } catch { /* still down */ }
      if (v && (!version || v === version)) return v;
      if (Date.now() >= end) throw new Error(`health check did not report ${version || 'a version'} within ${Math.round(healthMs / 1000)} s`);
      await nap(pollMs);
    }
  }
  async function recreate(inspect, ref) {
    await docker.stop(name);
    await docker.remove(name);
    await docker.create(name, createBody(inspect, ref));
    await docker.start(name);
  }
  async function rollBack() {
    await stage('rollback', async () => { await recreate(previous.inspect, previous.imageId); });
    await stage('rollback_health', () => waitHealthy(previous.version));
  }
  function begin(mode, target) {
    if (status.state === 'running') { const e = new Error('an update is already running'); e.code = 409; throw e; }
    Object.assign(status, { state: 'running', target, mode, from: null, steps: [], started: iso(), finished: null, error: null });
  }
  function end(state, error) { status.state = state; status.finished = iso(); status.error = error ? String(error.message || error).slice(0, 300) : null; }

  async function update(tag) {
    if (!TAG_RE.test(tag || '')) { const e = new Error('image_tag must look like v1.2.3'); e.code = 400; throw e; }
    begin('image', tag);
    previous = null;
    const version = tag.replace(/^v/, '');
    try {
      const inspect = await stage('inspect', () => docker.inspect(name));
      previous = { imageId: inspect.Image, tag: inspect.Config?.Image, inspect, version: null };
      status.from = inspect.Config?.Image || inspect.Image;
      previous.version = await health().catch(() => null);
      await stage('pull', () => docker.pull(image, tag));
      await stage('backup', backup);
      await stage('recreate', () => recreate(inspect, `${image}:${tag}`));
      await stage('health', () => waitHealthy(version));
      end('succeeded');
    } catch (err) {
      const failedStep = status.steps.find(s => s.status === 'failed');
      if (previous && failedStep && ['recreate', 'health'].includes(failedStep.name)) {
        try { await rollBack(); end('rolled_back', err); } catch (e2) { end('failed', e2); }
      } else end('failed', err);
    }
    return status;
  }

  // Source installs: git pull, compose build and up. Rolls back to the previous commit when health fails.
  async function updateGit() {
    const dir = env.repoDir;
    if (!dir) { const e = new Error('LABCTL_REPO_DIR is not set'); e.code = 400; throw e; }
    begin('git', 'git pull');
    const git = (...a) => run('git', ['-C', dir, ...a]);
    const compose = (...a) => run('docker', ['compose', '-f', path.join(dir, 'server', 'docker-compose.yml'), ...a]);
    try {
      const sha = (await stage('inspect', () => git('rev-parse', 'HEAD'))).trim();
      previous = { sha, inspect: null, version: await health().catch(() => null) };
      await stage('backup', backup);
      await stage('pull', () => git('pull', '--ff-only'));
      await stage('recreate', async () => { await compose('build', name); await compose('up', '-d', name); });
      const target = fs.existsSync(path.join(dir, 'VERSION')) ? fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim() : null;
      status.target = target || 'git pull';
      await stage('health', () => waitHealthy(target));
      end('succeeded');
    } catch (err) {
      const failedStep = status.steps.find(s => s.status === 'failed');
      if (previous?.sha && failedStep && ['recreate', 'health'].includes(failedStep.name)) {
        try {
          await stage('rollback', async () => { await git('reset', '--hard', previous.sha); await compose('build', name); await compose('up', '-d', name); });
          await stage('rollback_health', () => waitHealthy(previous.version));
          end('rolled_back', err);
        } catch (e2) { end('failed', e2); }
      } else end('failed', err);
    }
    return status;
  }

  async function rollback() {
    if (!previous?.inspect) { const e = new Error('no previous image recorded'); e.code = 409; throw e; }
    begin('image', 'rollback');
    try { await rollBack(); end('rolled_back'); } catch (err) { end('failed', err); }
    return status;
  }

  return { update, updateGit, rollback, status: () => JSON.parse(JSON.stringify(status)) };
}

// HTTP front end. Long jobs run in the background: POST returns 202 and the caller polls GET /status.
function createServer(updater, secret) {
  return http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && req.url === '/healthz') return send(200, { ok: true });
    if (!secretOk(req.headers['x-updater-secret'], secret)) return send(401, { error: 'unauthorised' });
    if (req.method === 'GET' && req.url === '/status') return send(200, updater.status());
    if (req.method !== 'POST') return send(404, { error: 'not found' });
    const chunks = [];
    req.on('data', c => { chunks.push(c); if (Buffer.concat(chunks).length > 8192) req.destroy(); });
    req.on('end', async () => {
      let body = {};
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return send(400, { error: 'invalid JSON' }); }
      const routes = { '/update': () => updater.update(body.image_tag), '/update-git': () => updater.updateGit(), '/rollback': () => updater.rollback() };
      const fn = routes[req.url];
      if (!fn) return send(404, { error: 'not found' });
      // Start the job, then answer. Validation errors surface through the rejected promise before the first await.
      const job = fn();
      const early = await Promise.race([job.then(() => null, e => e), sleep(50).then(() => null)]);
      if (early) return send(early.code || 500, { error: early.message });
      send(202, updater.status());
    });
  });
}

function main() {
  const secret = process.env.LABCTL_UPDATER_SECRET;
  if (!secret) { console.error('LABCTL_UPDATER_SECRET is required'); process.exit(1); }
  const labctlUrl = process.env.LABCTL_URL || 'http://labctl:7700';
  const dataDir = process.env.LABCTL_DATA_DIR || '/data';
  const docker = createDocker(process.env.DOCKER_SOCKET);
  const health = async () => {
    const r = await fetch(`${labctlUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? (await r.json()).version : null;
  };
  const backup = async () => {
    try {
      const r = await fetch(`${labctlUrl}/api/backup/run`, { method: 'POST', headers: { 'X-Updater-Secret': secret, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(120000) });
      if (r.ok) return;
    } catch { /* fall through to the file copy */ }
    copyDbFiles(dataDir);
  };
  const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 600000, maxBuffer: 8 * 1024 * 1024 },
    (err, out, errOut) => (err ? reject(new Error(`${cmd} ${args[0]} failed: ${String(errOut || err.message).slice(0, 300)}`)) : resolve(out))));
  const updater = createUpdater({ docker, backup, health, run,
    env: { container: process.env.LABCTL_CONTAINER, image: process.env.LABCTL_IMAGE, repoDir: process.env.LABCTL_REPO_DIR } });
  createServer(updater, secret).listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('labctl-updater listening'));
}

if (require.main === module) main();

module.exports = { createUpdater, createServer, createDocker, createBody, copyDbFiles, secretOk, TAG_RE };
