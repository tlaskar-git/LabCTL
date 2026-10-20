// Agentless hosts (kind: ssh): jobs over SSH exec and a 60 s state poll. Uses the ssh2 package.
// Output goes through ctx.jobs.output, so job logs and events match agent jobs. Credentials are opened only in
// memory, per connection. The host key fingerprint is recorded on first connect (TOFU) and compared after.
const { Client } = require('ssh2');
const { randomUUID } = require('crypto');
const { parseJson } = require('./db');
const ops = require('./hostops');
const { extractMetrics } = require('./agents');

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const shq = v => `'${String(v).replace(/'/g, `'\\''`)}'`;
const psq = v => `'${String(v).replace(/'/g, "''")}'`;
const fingerprint = hex => 'SHA256:' + Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '');
const isWindows = host => /windows/i.test(host.os || '');

const POLL_UNIX = `echo uptime=$(cut -d. -f1 /proc/uptime 2>/dev/null); echo load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null); ` +
  `free -m 2>/dev/null | awk '/^Mem:/{print "mem_total="$2; print "mem_avail="$7}'; ` +
  `df -Pk / 2>/dev/null | awk 'NR==2{print "disk_total_kb="$2; print "disk_used_kb="$3}'`;
const POLL_WIN = Buffer.from(
  '$o=Get-CimInstance Win32_OperatingSystem;$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'C:\'";' +
  '"uptime="+[int]((Get-Date)-$o.LastBootUpTime).TotalSeconds;"mem_total="+[int]($o.TotalVisibleMemorySize/1024);' +
  '"mem_avail="+[int]($o.FreePhysicalMemory/1024);"disk_total_kb="+[int64]($d.Size/1024);"disk_used_kb="+[int64](($d.Size-$d.FreeSpace)/1024)',
  'utf16le').toString('base64');

function createSsh(ctx, { pollMs = 60000, readyTimeout = 15000 } = {}) {
  const { db } = ctx;
  const memCreds = new Map(); // host id -> inline credential that was not saved. Lost at restart.
  const active = new Map();   // job id -> cancel function
  let timer = null;
  let stopped = false;

  // Opens the credential for this connection only.
  function credentialFor(hostId, s) {
    if (s.credential_id) {
      const row = db.prepare('SELECT username, sealed FROM credentials WHERE id = ?').get(s.credential_id);
      return row ? { username: row.username, ...ctx.crypto.openJson(row.sealed) } : null;
    }
    return memCreds.get(hostId) || null;
  }

  function connect(host) {
    const s = ops.getData(db, host.id).ssh || {};
    return new Promise((resolve, reject) => {
      const cred = credentialFor(host.id, s);
      if (!s.address) return reject(new Error('No address set'));
      if (!cred) return reject(new Error('No credential available'));
      const client = new Client();
      let seen = null;
      let mismatch = false;
      client.on('error', err => reject(new Error(mismatch ? 'Host key mismatch' : err.message)));
      client.on('ready', () => {
        if (!s.host_key) ops.saveData(db, host.id, { ssh: { ...(ops.getData(db, host.id).ssh || {}), host_key: seen } });
        resolve(client);
      });
      client.connect({
        host: s.address, port: s.port || 22, username: s.username || cred.username,
        password: cred.password, privateKey: cred.private_key, passphrase: cred.passphrase, readyTimeout,
        hostHash: 'sha256',
        hostVerifier: hash => { seen = fingerprint(hash); mismatch = !!s.host_key && s.host_key !== seen; return !mismatch; }
      });
    });
  }

  function exec(client, command, { stdin = '', onOut = () => {}, onStart = () => {} } = {}) {
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) return reject(err);
        onStart(stream);
        stream.setEncoding('utf8');
        stream.stderr.setEncoding('utf8');
        stream.on('data', d => onOut(d, 'stdout'));
        stream.stderr.on('data', d => onOut(d, 'stderr'));
        stream.on('close', code => resolve(code));
        stream.end(stdin);
      });
    });
  }

  // Secrets (LABCTL_SECRET_*) travel in the stdin prelude only, never on the command line.
  function jobCommand(host, job, secrets = {}) {
    const env = Object.entries(parseJson(job.params, {}).env || {}).filter(([k]) => ENV_NAME.test(k));
    const sec = Object.entries(secrets).filter(([k]) => ENV_NAME.test(k));
    const shell = job.shell || (isWindows(host) ? 'powershell' : 'bash');
    if (shell === 'powershell') {
      return { command: 'powershell -NoProfile -NonInteractive -Command -',
        stdin: [...env, ...sec].map(([k, v]) => `$env:${k}=${psq(v)}`).join('\n') + '\n' + job.script };
    }
    if (shell === 'python') {
      const prelude = sec.length ? `import os\n${sec.map(([k, v]) => `os.environ[${JSON.stringify(k)}] = ${JSON.stringify(v)}`).join('\n')}\n` : '';
      return { command: `${env.map(([k, v]) => `${k}=${shq(v)}`).join(' ')} python3 -`.trim(), stdin: prelude + job.script };
    }
    return { command: 'bash -s', stdin: [...env, ...sec].map(([k, v]) => `export ${k}=${shq(v)}`).join('\n') + '\n' + job.script };
  }

  async function run(job, host, secrets = {}) {
    if (!job.script) throw new Error('SSH hosts run script jobs only');
    const started = Date.now();
    const client = await connect(host);
    let cancelled = false;
    let timedOut = false;
    let killer = null;
    try {
      if (ctx.jobs.get(job.id).status === 'cancelled') cancelled = true;
      else {
        const { command, stdin } = jobCommand(host, job, secrets);
        const code = await exec(client, command, {
          stdin,
          onStart: stream => {
            ctx.jobs.markRunning(job.id);
            const stop = () => { stream.close(); client.end(); };
            active.set(job.id, () => { cancelled = true; stop(); });
            killer = setTimeout(() => { timedOut = true; stop(); }, (job.timeout_s || 3600) * 1000);
          },
          onOut: (chunk, stream) => ctx.jobs.output(job.id, chunk, stream)
        });
        const status = cancelled ? 'cancelled' : (code === 0 && !timedOut ? 'completed' : 'failed');
        active.delete(job.id);
        return ctx.jobs.complete(job.id, status, { exit_code: code, duration_ms: Date.now() - started,
          error: timedOut ? 'Timed out' : '' });
      }
      active.delete(job.id);
      return ctx.jobs.complete(job.id, 'cancelled', { duration_ms: Date.now() - started });
    } finally {
      clearTimeout(killer);
      active.delete(job.id);
      client.end();
    }
  }

  // jobs.registerDispatcher hook: hand off now, the job finishes asynchronously.
  function runJob(job, host) {
    const secrets = ctx.templateSecrets ? ctx.templateSecrets.take(job.id) : {}; // taken at dispatch, held in this closure only
    setImmediate(() => run(job, host, secrets).catch(err => {
      try { ctx.jobs.complete(job.id, 'failed', { error: err.message }); } catch { /* server is closing */ }
    }));
    return true;
  }

  async function poll(host) {
    try {
      const client = await connect(host);
      let out = '';
      try {
        await exec(client, isWindows(host) ? `powershell -NoProfile -NonInteractive -EncodedCommand ${POLL_WIN}` : POLL_UNIX,
          { onOut: (c, s) => { if (s === 'stdout') out += c; } });
      } finally { client.end(); }
      const kv = Object.fromEntries(out.split(/\r?\n/).map(l => l.trim().split('=')).filter(p => p.length === 2));
      const num = k => (kv[k] !== undefined && kv[k] !== '' && Number.isFinite(Number(kv[k])) ? Number(kv[k]) : null);
      const total = num('mem_total');
      const avail = num('mem_avail');
      const gb = kb => Math.round((kb / 1048576) * 10) / 10;
      const diskTotal = num('disk_total_kb');
      const diskUsed = num('disk_used_kb');
      const ts = ops.now();
      const heartbeat = { cpu: null, ram: total ? Math.round(((total - (avail || 0)) / total) * 100) : null,
        load: kv.load ? kv.load.split(' ').map(Number) : null, uptime: num('uptime'), ts };
      const prev = parseJson(db.prepare('SELECT system_info FROM hosts WHERE id = ?').get(host.id)?.system_info, {});
      const info = { ...prev, ram_mb: total, ram_available_mb: avail,
        uptime_hours: heartbeat.uptime !== null ? Math.round((heartbeat.uptime / 3600) * 10) / 10 : null,
        drives: diskTotal ? [{ device: isWindows(host) ? 'C:' : '/', mount: isWindows(host) ? 'C:' : '/', total_gb: gb(diskTotal),
          used_gb: gb(diskUsed), free_gb: gb(diskTotal - diskUsed), percent: Math.round((diskUsed / diskTotal) * 100) }] : [] };
      db.prepare("UPDATE hosts SET status = 'online', last_seen = ?, heartbeat = ?, system_info = ? WHERE id = ?")
        .run(ts, JSON.stringify(heartbeat), JSON.stringify(info), host.id);
      ops.saveData(db, host.id, { ssh: { ...(ops.getData(db, host.id).ssh || {}), error: null, last_poll: ts } });
      recordMetrics(host.id);
      ctx.events.emit('host', db.prepare('SELECT * FROM hosts WHERE id = ?').get(host.id));
      return { ok: true };
    } catch (err) {
      db.prepare("UPDATE hosts SET status = 'offline' WHERE id = ?").run(host.id);
      ops.saveData(db, host.id, { ssh: { ...(ops.getData(db, host.id).ssh || {}), error: err.message, last_poll: ops.now() } });
      ctx.events.emit('host', db.prepare('SELECT * FROM hosts WHERE id = ?').get(host.id));
      return { ok: false, error: err.message };
    }
  }

  // One metrics row per poll_interval_seconds, same shape the agent path writes.
  function recordMetrics(hostId) {
    const intervalMs = Math.max(60, Number(ctx.settings.get('poll_interval_seconds') || 300)) * 1000;
    const last = db.prepare('SELECT created_at FROM metrics WHERE host_id = ? ORDER BY created_at DESC LIMIT 1').get(hostId);
    if (last && Date.now() - new Date(last.created_at).getTime() < intervalMs) return;
    const h = db.prepare('SELECT * FROM hosts WHERE id = ?').get(hostId);
    db.prepare('INSERT INTO metrics (id, host_id, created_at, data) VALUES (?, ?, ?, ?)').run(randomUUID(), hostId, ops.now(),
      JSON.stringify(extractMetrics(h, parseJson(h.system_info, {}), parseJson(h.heartbeat, null))));
  }

  const pollAll = () => Promise.allSettled(db.prepare("SELECT * FROM hosts WHERE kind = 'ssh'").all().map(poll));

  // Cancel closes the channel of a running job.
  ctx.events.on('job', j => { if (j && j.status === 'cancelled') active.get(j.id)?.(); });

  return {
    runJob, poll, pollAll,
    setCredential: (hostId, cred) => memCreds.set(hostId, cred),
    forget: hostId => memCreds.delete(hostId),
    sshOnline: hostId => db.prepare("SELECT 1 FROM hosts WHERE id = ? AND kind = 'ssh' AND status = 'online'").get(hostId) !== undefined,
    start() { if (!timer) { timer = setInterval(() => { if (!stopped) pollAll().catch(() => {}); }, pollMs); timer.unref(); } },
    stop() { stopped = true; clearInterval(timer); timer = null; for (const cancel of active.values()) cancel(); }
  };
}

module.exports = { createSsh, fingerprint };
