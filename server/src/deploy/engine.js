// Deploy engine: target validation, pre-flight, the install run (phases, live log, dedicated token, wait for the agent),
// credential saving and the manual one-liners. State lives in memory (a deploy is a short job), the audit log keeps the record.
// Secrets (passwords, the private key, the deploy token) live in the deploy object only for the run and are redacted from every log line.
const fs = require('fs');
const path = require('path');
const { randomBytes, randomUUID } = require('crypto');
const ops = require('../hostops');
const unix = require('./unix');
const windows = require('./windows');
const relay = require('./relay');

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const ADDR_RE = /^(?!-)[A-Za-z0-9._:-]{1,253}$/;
const USER_RE = /^(?!-)[A-Za-z0-9._@\\ -]{1,100}$/;
const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;
const PUBLIC_URL_RE = /^(https?):\/\/([^/?#\s]+)$/;
const OS_NAMES = { linux: 'linux', mac: 'darwin', darwin: 'darwin', windows: 'windows' };
const MAX_LINES = 3000;

const bad = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });

function createDeploy(ctx, cfg = {}) {
  const { db } = ctx;
  const config = { waitMs: 120000, ...cfg }; // tests shorten waitMs
  const deploys = new Map();

  const agentFile = name => {
    const f = [path.join(ctx.paths.serverDir, 'agent', name), path.join(ctx.paths.serverDir, '..', 'agent', name)].find(p => fs.existsSync(p));
    if (!f) throw new Error(`${name} is missing from this installation`);
    return fs.readFileSync(f);
  };

  // The public base URL the target must use: the public_url setting, else the origin of the request.
  function serverBase(req) {
    const pub = ctx.settings.get('public_url');
    const m = typeof pub === 'string' && PUBLIC_URL_RE.exec(pub.trim());
    if (m && HOST_RE.test(m[2])) return `${m[1]}://${m[2]}`;
    const host = req.get('host');
    if (!host || !HOST_RE.test(host)) throw bad('Cannot work out the public URL. Set public_url in the settings.');
    return `${req.protocol === 'https' ? 'https' : 'http'}://${host}`;
  }

  // Validates the request body and merges a saved credential. Returns the target object used by the drivers.
  function target(b, defaults = {}) {
    const raw = { ...defaults, ...b };
    const os = OS_NAMES[raw.os];
    if (!os) throw bad('os must be linux, mac or windows');
    const address = String(raw.address || '').trim();
    if (!ADDR_RE.test(address)) throw bad('address must be a host name or IP address');
    const port = raw.port ? Number(raw.port) : (os === 'windows' ? 0 : 22);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw bad('port must be 1 to 65535');
    const auth = { ...(defaults.auth || {}), ...(b.auth || {}) };
    let saved = {};
    if (auth.credential_id) {
      const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get(auth.credential_id);
      if (!row) throw bad('Unknown credential_id');
      saved = { username: row.username, ...ctx.crypto.openJson(row.sealed) };
    }
    const user = String(auth.user || saved.username || '').trim();
    if (!USER_RE.test(user)) throw bad('A user name is required');
    const t = { os, address, port, user, relay_host_id: raw.relay_host_id || null, no_service: !!raw.no_service, credential_id: auth.credential_id || null,
      password: auth.password || saved.password || '', private_key: auth.private_key || saved.private_key || '',
      passphrase: auth.passphrase || saved.passphrase || '', sudo_password: auth.sudo_password || saved.sudo_password || '', hostKey: raw.host_key || '' };
    if (!t.password && !t.private_key) throw bad('A password or private key is required');
    if (t.relay_host_id && os === 'windows') throw bad('A relay supports Linux and Mac targets only');
    if (t.relay_host_id && !/^[A-Za-z0-9._:-]{1,200}$/.test(t.relay_host_id)) throw bad('invalid relay_host_id');
    return t;
  }

  const driver = t => (t.os === 'windows' ? windows : (t.relay_host_id ? relay : unix));
  const secretsOf = (t, token) => [t.password, t.sudo_password, t.passphrase, token,
    ...String(t.private_key || '').split(/\r?\n/).filter(l => l.length >= 16 && !l.startsWith('-----'))].filter(s => s && s.length >= 4);

  function create(t, { actor, mode, hostId, name }) {
    let id;
    do id = randomBytes(6).toString('hex'); while (deploys.has(id));
    const d = { id, state: 'running', phase: 'preflight', mode, actor, address: t.address, os: t.os, name: name || t.address, host_id: hostId || null,
      token_id: null, error: null, checks: [], lines: [], subs: new Set(), partial: '', last: '', secrets: secretsOf(t), started_at: new Date().toISOString(), finished_at: null };
    deploys.set(id, d);
    if (deploys.size > 50) for (const [k, v] of deploys) { if (v.state !== 'running' && deploys.size > 50) deploys.delete(k); }
    return d;
  }

  const emit = (d, event, data) => { for (const fn of d.subs) fn(event, data); };
  const redact = (d, s) => ctx.audit.redact(d.secrets.reduce((acc, secret) => acc.split(secret).join('[redacted]'), String(s)));
  function log(d, text) {
    for (const raw of String(text).split(/\r?\n/)) {
      const line = redact(d, raw.replace(ANSI, '').split('\r').pop());
      if (!line.trim()) continue;
      d.last = line;
      const entry = { ts: Date.now(), phase: d.phase, line };
      d.lines.push(entry);
      if (d.lines.length > MAX_LINES) d.lines.shift();
      emit(d, 'log', entry);
    }
  }
  function phase(d, p) {
    if (d.phase === p) return;
    d.phase = p;
    emit(d, 'phase', { phase: p });
    ctx.audit(d.actor, `deploy.${p}`, d.host_id, { deploy_id: d.id, address: d.address, os: d.os });
  }

  // Helper object handed to the drivers.
  const helper = (d, server, extra = {}) => ({ ctx, id: d.id, mode: d.mode, server, actor: d.actor, token: '', ...extra,
    log: line => log(d, line),
    out(chunk) {
      d.partial += String(chunk);
      const parts = d.partial.split(/\r?\n/);
      d.partial = parts.pop();
      if (parts.length) log(d, parts.join('\n'));
    },
    lastLine: () => d.last,
    phase: p => phase(d, p),
    file: agentFile });
  const flush = d => { if (d.partial) { log(d, d.partial); d.partial = ''; } };

  // Pre-flight only: checks and nothing else on the target.
  async function preflight(t, server, actor) {
    const d = create(t, { actor, mode: 'preflight' });
    try {
      const r = await driver(t).inspect(t, helper(d, server));
      ctx.audit(actor, 'deploy.preflight', null, { address: t.address, os: t.os, ok: r.checks.every(c => c.ok) });
      return { checks: r.checks, ok: r.checks.length > 0 && r.checks.every(c => c.ok), transport: r.transport || null, port: r.port || t.port || null, host_key: r.hostKey || null };
    } catch (e) {
      return { checks: [{ name: 'Pre-flight', ok: false, detail: redact(d, e.message) }], ok: false, transport: null, port: null, host_key: null };
    } finally { deploys.delete(d.id); }
  }

  // Resolves with the host row when an agent registers with this token, else null after ms.
  function waitForAgent(tokenId, ms) {
    return new Promise(resolve => {
      const done = v => { clearTimeout(timer); ctx.events.off('host', on); resolve(v); };
      const on = row => { if (row && row.token_id === tokenId && row.status === 'online') done(row); };
      const timer = setTimeout(() => done(null), ms);
      ctx.events.on('host', on);
      const now = db.prepare("SELECT * FROM hosts WHERE token_id = ? AND status = 'online'").get(tokenId);
      if (now) done(now);
    });
  }

  function saveCredential(t, hostId) {
    const secret = Object.fromEntries(['password', 'private_key', 'passphrase', 'sudo_password'].filter(k => t[k]).map(k => [k, t[k]]));
    const stamp = new Date().toISOString();
    const existing = db.prepare("SELECT id FROM credentials WHERE host_id = ? AND purpose = 'deploy'").get(hostId);
    const sealed = ctx.crypto.sealJson(secret);
    const kind = t.private_key ? 'key' : 'password';
    if (existing) {
      db.prepare('UPDATE credentials SET username = ?, kind = ?, sealed = ?, updated_at = ? WHERE id = ?').run(t.user, kind, sealed, stamp, existing.id);
      return existing.id;
    }
    const id = randomUUID();
    db.prepare('INSERT INTO credentials (id, host_id, name, username, purpose, kind, sealed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, hostId, `${t.address} deploy`, t.user, 'deploy', kind, sealed, stamp, stamp);
    return id;
  }

  async function execute(d, t, server, { save, hostId }) {
    const h = helper(d, server);
    let token = null;
    try {
      const install = d.mode !== 'uninstall';
      if (install) {
        log(d, `Pre-flight checks for ${t.address} (${t.os})`);
        const pre = await driver(t).inspect(t, h);
        d.checks = pre.checks;
        for (const c of pre.checks) log(d, `${c.ok ? (c.warn ? '[WARN]' : '[PASS]') : '[FAIL]'} ${c.name}: ${c.detail}`);
        const failed = pre.checks.find(c => !c.ok);
        if (failed || !pre.checks.length) throw new Error(`Pre-flight failed. ${failed ? `${failed.name}: ${failed.detail}` : 'No checks ran.'}`);
        Object.assign(h, { uid: pre.uid });
        if (pre.port && t.os === 'windows') t = { ...t, port: pre.port };
        if (!t.hostKey && pre.hostKey) t = { ...t, hostKey: pre.hostKey }; // pin what pre-flight saw
        token = ctx.tokens.create(`deploy ${t.address} ${new Date().toISOString().slice(0, 10)}`, d.actor);
        d.token_id = token.id;
        d.secrets.push(token.value);
        h.token = token.value;
      }
      const res = await driver(t).install(t, h);
      flush(d);
      let row = null;
      if (install) {
        phase(d, 'wait_for_agent');
        log(d, `Setup finished. Waiting up to ${Math.round(config.waitMs / 1000)} s for the agent to register`);
        row = await waitForAgent(token.id, config.waitMs);
        if (!row) throw new Error(`The installer finished but no agent registered within ${Math.round(config.waitMs / 1000)} s. Check the agent log on the target.`);
        if (hostId && row.id !== hostId) log(d, `Note: the agent registered as ${row.id}, not ${hostId}`);
        d.host_id = row.id;
        log(d, `Agent registered as ${row.hostname || row.id}`);
        const data = { address: t.address, port: res.port || t.port || undefined, os: t.os, user: t.user, relay_host_id: t.relay_host_id || undefined,
          no_service: t.no_service || undefined, host_key: res.hostKey || t.hostKey || undefined, transport: res.transport, at: new Date().toISOString() };
        if (save) data.credential_id = saveCredential(t, row.id);
        else if (t.credential_id) data.credential_id = t.credential_id;
        ops.saveData(db, row.id, { deploy: { ...(ops.getData(db, row.id).deploy || {}), ...data } });
      } else if (hostId) {
        db.prepare("UPDATE hosts SET status = 'gone', updated_at = ? WHERE id = ? AND status != 'online'").run(ops.now(), hostId);
        ctx.events.emit('host', db.prepare('SELECT * FROM hosts WHERE id = ?').get(hostId));
      }
      d.state = 'done';
      log(d, d.mode === 'uninstall' ? 'The agent was removed.' : 'Done.');
    } catch (err) {
      flush(d);
      d.state = 'failed';
      d.error = redact(d, err.message);
      log(d, `FAILED: ${d.error}`);
      if (token) {
        ctx.tokens.revoke(token.id);
        ctx.agents.disconnectToken(token.id);
        log(d, 'The dedicated deploy token was revoked.');
      }
    }
    d.finished_at = new Date().toISOString();
    ctx.audit(d.actor, d.state === 'done' ? 'deploy.done' : 'deploy.failed', d.host_id, { deploy_id: d.id, address: d.address, os: d.os, mode: d.mode, error: d.error });
    emit(d, 'done', { state: d.state, error: d.error, host_id: d.host_id });
    d.secrets = []; // nothing secret stays in memory after the run
  }

  // Starts a run and returns the deploy object at once. The run goes on in the background.
  function start(t, { actor, server, name, hostId = null, mode = 'install', save = false }) {
    const d = create(t, { actor, mode, hostId, name });
    ctx.audit(actor, 'deploy.start', hostId, { deploy_id: d.id, address: t.address, os: t.os, mode, relay_host_id: t.relay_host_id, save_credential: !!save });
    setImmediate(() => execute(d, t, server, { save, hostId }));
    return d;
  }

  const view = d => ({ id: d.id, state: d.state, phase: d.phase, mode: d.mode, address: d.address, os: d.os, name: d.name, host_id: d.host_id,
    token_id: d.token_id, error: d.error, checks: d.checks, started_at: d.started_at, finished_at: d.finished_at, lines: d.lines.map(l => l.line) });

  // SSE: replays the lines so far, follows new ones, ends with a done event.
  function stream(d, req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('phase', { phase: d.phase });
    for (const e of d.lines) send('log', e);
    if (d.state !== 'running') { send('done', { state: d.state, error: d.error, host_id: d.host_id }); return res.end(); }
    const fn = (event, data) => { send(event, data); if (event === 'done') res.end(); };
    const hb = setInterval(() => res.write(': hb\n\n'), ctx.sseHeartbeatMs || 15000);
    d.subs.add(fn);
    req.on('close', () => { clearInterval(hb); d.subs.delete(fn); });
  }

  // Fresh token, one-line installers. The token value is returned once and never stored.
  function manualCommands(server, actor) {
    const tok = ctx.tokens.create(`manual install ${new Date().toISOString().slice(0, 10)}`, actor);
    const url = f => `${server}/install/${f}?token=${tok.value}`;
    ctx.audit(actor, 'deploy.manual', null, { token_id: tok.id });
    return { token_id: tok.id, server, commands: { linux: `curl -fsSL "${url('linux.sh')}" | sudo bash`, mac: `curl -fsSL "${url('mac.sh')}" | sudo bash`,
      windows: `irm "${url('windows.ps1')}" | iex` } };
  }

  return { config, target, serverBase, preflight, start, view, stream, manualCommands, get: id => deploys.get(id), bad };
}

module.exports = { createDeploy };
