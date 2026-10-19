// /ws/agent: token check on upgrade (401), blocklist (close 4403), host registry, send(hostId, msg).
// Emits on ctx.events: 'host' (row), 'agent_message' ({ host_id, msg }) so feature modules can hook in.
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');
const { parseJson } = require('./db');
const { createMetrics } = require('./metrics');

function hostOut(row, online = false) {
  if (!row) return null;
  return { ...row, system_info: parseJson(row.system_info, {}), inventory: parseJson(row.inventory, null),
    heartbeat: parseJson(row.heartbeat, null), data: parseJson(row.data, {}), online };
}

function extractMetrics(host, info = {}, heartbeat = null) {
  const ramTotal = Number(info.ram_mb || 0);
  const ramAvail = Number(info.ram_available_mb || 0);
  const dockerDetails = Array.isArray(info.docker_details) ? info.docker_details : [];
  const problemContainers = dockerDetails.filter(c => {
    const status = String(c.status || '').toLowerCase();
    return status && (!status.startsWith('up') || status.includes('unhealthy') || status.includes('exited'));
  });
  return {
    host_id: host.id, hostname: host.hostname, os: host.os, ip: host.ip,
    uptime_hours: info.uptime_hours || (heartbeat?.uptime ? Math.round(heartbeat.uptime / 36) / 100 : null),
    ram_total_mb: ramTotal || null,
    ram_used_percent: ramTotal ? Math.round(((ramTotal - ramAvail) / ramTotal) * 100) : (heartbeat?.ram ?? null),
    cpu_percent: heartbeat?.cpu ?? null,
    load: heartbeat?.load ?? null,
    drives: Array.isArray(info.drives) ? info.drives.map(d => ({ device: d.device, mount: d.mount, total_gb: d.total_gb,
      used_gb: d.used_gb, free_gb: d.free_gb, percent: d.percent })) : [],
    docker_running: info.docker_running ?? null,
    docker_total: info.docker_total ?? dockerDetails.length,
    docker_problem_count: info.docker_problem_count ?? problemContainers.length,
    docker_problems: problemContainers.map(c => ({ name: c.name, image: c.image, status: c.status })).slice(0, 20),
    critical_services: Array.isArray(info.critical_services) ? info.critical_services.slice(0, 50) : [],
    services_count: Array.isArray(info.services) ? info.services.length : null
  };
}

function tokenFromRequest(req) {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams.get('token');
  if (q) return q;
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

function createAgents(ctx) {
  const { db } = ctx;
  const metrics = ctx.metrics = createMetrics(ctx); // chart storage, see metrics.js
  const sockets = new Map(); // host_id -> ws
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const now = () => new Date().toISOString();
  const host = id => db.prepare('SELECT * FROM hosts WHERE id = ?').get(id);

  function recordMetrics(hostId, force = false) {
    const h = host(hostId);
    if (!h) return;
    const intervalMs = Math.max(60, Number(ctx.settings.get('poll_interval_seconds') || 300)) * 1000;
    const last = db.prepare('SELECT created_at FROM metrics WHERE host_id = ? ORDER BY created_at DESC LIMIT 1').get(hostId);
    if (!force && last && Date.now() - new Date(last.created_at).getTime() < intervalMs) return;
    const data = extractMetrics(h, parseJson(h.system_info, {}), parseJson(h.heartbeat, null));
    db.prepare('INSERT INTO metrics (id, host_id, created_at, data) VALUES (?, ?, ?, ?)').run(randomUUID(), hostId, now(), JSON.stringify(data));
  }

  function touch(hostId, fields = {}) {
    const all = { status: 'online', last_seen: now(), updated_at: now(), ...fields };
    const sets = Object.keys(all).map(k => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE hosts SET ${sets} WHERE id = @id`).run({ ...all, id: hostId });
    ctx.events.emit('host', host(hostId));
  }

  // Job frames are accepted only for jobs that belong to the sending host.
  const ownJob = (hostId, jobId) => {
    const job = jobId && ctx.jobs.get(jobId);
    return job && job.host_id === hostId ? job : null;
  };

  function onMessage(ws, msg) {
    const hostId = ws.hostId;
    if (msg.type === 'register') {
      const id = String(msg.host_id || '').slice(0, 200);
      if (!id) return ws.close(4400, 'host_id required');
      if (db.prepare('SELECT 1 FROM blocklist WHERE host_id = ?').get(id)) {
        ctx.logger.warn(`Blocked host tried to register: ${id}`);
        return ws.close(4403, 'blocked');
      }
      const prev = sockets.get(id);
      if (prev && prev !== ws) prev.close(4409, 'replaced');
      ws.hostId = id;
      sockets.set(id, ws);
      const info = msg.system_info || msg.info || {};
      const existing = host(id);
      const row = { id, hostname: msg.hostname || existing?.hostname || id, os: msg.os || null, ip: msg.ip || ws.remoteIp || null,
        kind: msg.kind || existing?.kind || 'agent', status: 'online', last_seen: now(), token_id: ws.tokenId,
        agent_version: msg.agent_version || null, os_version: msg.os_version || null, arch: msg.arch || null,
        system_info: JSON.stringify(info), created_at: existing?.created_at || now(), updated_at: now() };
      db.prepare(`INSERT INTO hosts (id, hostname, os, ip, kind, status, last_seen, token_id, agent_version, os_version, arch, system_info, created_at, updated_at)
        VALUES (@id, @hostname, @os, @ip, @kind, @status, @last_seen, @token_id, @agent_version, @os_version, @arch, @system_info, @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET hostname = excluded.hostname, os = excluded.os, ip = excluded.ip, kind = excluded.kind,
        status = excluded.status, last_seen = excluded.last_seen, token_id = excluded.token_id, agent_version = excluded.agent_version,
        os_version = excluded.os_version, arch = excluded.arch, system_info = excluded.system_info, updated_at = excluded.updated_at`).run(row);
      recordMetrics(id, true);
      ctx.logger.info(`[WS] Registered: ${row.hostname} (${id})`);
      ctx.events.emit('host', host(id));
      ctx.jobs.dispatchPending(id);
      return;
    }
    if (!hostId) return; // everything else needs a registered host
    switch (msg.type) {
      case 'heartbeat': {
        const fields = {};
        if (msg.system_info) fields.system_info = JSON.stringify(msg.system_info);
        if (msg.cpu !== undefined || msg.ram !== undefined) {
          fields.heartbeat = JSON.stringify({ cpu: msg.cpu, ram: msg.ram, load: msg.load, uptime: msg.uptime, ts: msg.ts || now() });
        }
        if (msg.agent_version) fields.agent_version = msg.agent_version;
        touch(hostId, fields);
        recordMetrics(hostId);
        metrics.ingest(hostId, msg);
        break;
      }
      case 'inventory':
        touch(hostId, { inventory: JSON.stringify(msg.data || {}), inventory_at: now() });
        metrics.ingest(hostId, msg);
        break;
      case 'job_started':
        if (ownJob(hostId, msg.job_id)) ctx.jobs.markRunning(msg.job_id);
        break;
      case 'job_output': {
        const job = ownJob(hostId, msg.job_id);
        if (job) {
          if (job.status === 'sent') ctx.jobs.markRunning(job.id);
          ctx.jobs.output(job.id, msg.chunk, msg.stream, msg.seq);
        }
        break;
      }
      case 'job_complete':
        if (ownJob(hostId, msg.job_id)) {
          if (msg.output) ctx.jobs.output(msg.job_id, msg.output); // v1 agents send all output at the end
          ctx.jobs.complete(msg.job_id, msg.status || 'completed', { exit_code: msg.exit_code ?? null, duration_ms: msg.duration_ms ?? null });
        }
        break;
      case 'job_failed':
        if (ownJob(hostId, msg.job_id)) {
          if (msg.output) ctx.jobs.output(msg.job_id, msg.output);
          ctx.jobs.complete(msg.job_id, 'failed', { error: msg.error || 'Unknown' });
        }
        break;
      case 'agent_gone':
        touch(hostId, { status: 'gone' });
        break;
      case 'pong':
      default:
        break;
    }
    ctx.events.emit('agent_message', { host_id: hostId, msg });
  }

  wss.on('connection', (ws, req) => {
    ws.remoteIp = req.socket.remoteAddress;
    ws.on('message', data => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      try { onMessage(ws, msg); } catch (err) { ctx.logger.error('[WS] Error:', err.message); }
    });
    ws.on('close', () => {
      if (ws.hostId && sockets.get(ws.hostId) === ws) {
        sockets.delete(ws.hostId);
        db.prepare("UPDATE hosts SET status = 'offline' WHERE id = ? AND status = 'online'").run(ws.hostId);
        ctx.events.emit('host', host(ws.hostId));
      }
    });
  });

  return {
    wss,
    // http 'upgrade' handler. Missing, invalid or revoked token: HTTP 401, no WebSocket.
    handleUpgrade(req, socket, head) {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname !== '/ws/agent') { socket.destroy(); return; }
      const tokenId = ctx.tokens.verify(tokenFromRequest(req));
      if (!tokenId) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 12\r\n\r\nUnauthorized');
        return;
      }
      wss.handleUpgrade(req, socket, head, ws => { ws.tokenId = tokenId; wss.emit('connection', ws, req); });
    },
    send(hostId, msg) {
      const ws = sockets.get(hostId);
      if (!ws || ws.readyState !== 1) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    isOnline: hostId => sockets.has(hostId),
    onlineIds: () => [...sockets.keys()],
    disconnect(hostId, code = 4403, reason = 'blocked') { sockets.get(hostId)?.close(code, reason); },
    disconnectToken(tokenId) { for (const ws of sockets.values()) if (ws.tokenId === tokenId) ws.close(4401, 'token revoked'); },
    hostOut: (row) => hostOut(row, !!row && sockets.has(row.id)),
    close() { for (const ws of sockets.values()) ws.terminate(); wss.close(); }
  };
}

module.exports = { createAgents, extractMetrics, hostOut };
