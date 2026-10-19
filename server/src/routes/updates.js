// LabCTL and agent updates (A11). All routes are admin only.
//   GET  /api/updates/check            GitHub releases check, cached 15 minutes (?refresh=1 skips the cache)
//   POST /api/updates/apply            {confirm:"UPDATE", version?} sends the request to the labctl-updater sidecar
//   GET  /api/updates/status           sidecar progress
//   PUT  /api/updates/mode             {mode:"image"|"git"} stored in the update_mode setting
//   GET  /api/agent/version            bundled agent version
//   GET  /api/updates/agents           outdated agent count and hosts
//   POST /api/updates/agents/run       {ring:"ring0"|"ring1"|"ring2"|"all"} ring-by-ring agent self-update
//   GET  /api/updates/agents/run       progress of the last run
// Environment variable names: LABCTL_UPDATER_SECRET, LABCTL_UPDATER_URL. Tests set ctx.fetch and ctx.updatesOpts.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createUpdaterClient } = require('../updater-client');

const RELEASES_URL = 'https://api.github.com/repos/tlaskar-git/LabCTL/releases/latest';
const CACHE_MS = 15 * 60 * 1000;
const RINGS = ['ring0', 'ring1', 'ring2'];

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?/.exec(String(v || '').trim());
  return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] || '' } : null;
}
// -1, 0 or 1. A pre-release sorts below its release. Unparseable versions sort lowest.
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  return !x.pre ? 1 : !y.pre ? -1 : (x.pre < y.pre ? -1 : 1);
}

module.exports = (app, ctx) => {
  const admin = ctx.requireRole('admin');
  const doFetch = (...a) => (ctx.fetch || fetch)(...a);
  const client = createUpdaterClient({ fetchFn: doFetch });
  let cache = null;
  let agentRun = null;

  const mode = () => (ctx.settings.get('update_mode') === 'git' ? 'git' : 'image');

  async function latestRelease(force) {
    if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
    const r = await doFetch(RELEASES_URL, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'labctl' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
    const j = await r.json();
    const data = { tag: String(j.tag_name || ''), notes: String(j.body || ''), url: j.html_url || null, published_at: j.published_at || null, checked_at: new Date().toISOString() };
    cache = { at: Date.now(), data };
    return data;
  }

  app.get('/api/updates/check', admin, async (req, res) => {
    try {
      const rel = await latestRelease(req.query.refresh === '1');
      res.json({ current: ctx.version, latest: rel.tag.replace(/^v/, ''), tag: rel.tag, notes: rel.notes, url: rel.url,
        published_at: rel.published_at, checked_at: rel.checked_at, newer: compareVersions(rel.tag, ctx.version) > 0,
        update_mode: mode(), updater_configured: client.configured() });
    } catch (err) { res.status(502).json({ error: `Update check failed: ${err.message}` }); }
  });

  app.get('/api/updates/status', admin, async (req, res) => {
    if (!client.configured()) return res.json({ configured: false, state: 'idle', steps: [] });
    try { res.json({ configured: true, ...(await client.status()) }); } catch (err) { res.status(502).json({ error: `Updater unreachable: ${err.message}` }); }
  });

  app.put('/api/updates/mode', admin, (req, res) => {
    if (!['image', 'git'].includes(req.body?.mode)) return res.status(400).json({ error: 'mode must be image or git' });
    ctx.settings.set('update_mode', req.body.mode);
    res.json({ update_mode: mode() });
  });

  app.post('/api/updates/apply', admin, ctx.requireConfirm('UPDATE'), async (req, res) => {
    if (!client.configured()) return res.status(503).json({ error: 'The updater sidecar is not configured (LABCTL_UPDATER_SECRET is empty)' });
    try {
      let out;
      if (mode() === 'git') out = await client.updateGit();
      else {
        const tag = req.body.version || (await latestRelease(false)).tag;
        if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(tag)) return res.status(400).json({ error: 'version must look like v1.2.3' });
        out = await client.update(tag);
      }
      ctx.audit(req.user.username, 'updates.apply', null, { mode: mode(), target: out.target });
      res.status(202).json(out);
    } catch (err) { res.status(err.status === 409 || err.status === 400 ? err.status : 502).json({ error: err.message }); }
  });

  // ---- agents ----
  function bundledAgent() {
    for (const dir of [path.join(ctx.paths.serverDir, 'agent'), path.join(ctx.paths.serverDir, '..', 'agent')]) {
      try {
        const buf = fs.readFileSync(path.join(dir, 'labctl-agent.py'));
        const m = /^VERSION\s*=\s*["']([^"']+)["']/m.exec(buf.toString('utf8'));
        if (m) return { version: m[1], source: buf.toString('utf8'), sha256: crypto.createHash('sha256').update(buf).digest('hex') };
      } catch { /* next */ }
    }
    return null;
  }
  const ringOf = hostId => {
    const tags = ctx.db.prepare('SELECT t.name FROM host_tags ht JOIN tags t ON t.id = ht.tag_id WHERE ht.host_id = ?').all(hostId).map(t => t.name.toLowerCase());
    return RINGS.find(r => tags.includes(r)) || 'ring2'; // untagged hosts update last
  };
  function outdatedHosts(version) {
    return ctx.db.prepare("SELECT id, hostname, agent_version FROM hosts WHERE kind = 'agent' AND status != 'gone'").all()
      .filter(h => !h.agent_version || compareVersions(h.agent_version, version) < 0)
      .map(h => ({ ...h, ring: ringOf(h.id), online: ctx.agents.isOnline(h.id) }));
  }

  app.get('/api/agent/version', (req, res) => {
    const a = bundledAgent();
    if (!a) return res.status(404).json({ error: 'Bundled agent not found' });
    res.json({ version: a.version, sha256: a.sha256 });
  });

  app.get('/api/updates/agents', admin, (req, res) => {
    const a = bundledAgent();
    if (!a) return res.status(404).json({ error: 'Bundled agent not found' });
    const hosts = outdatedHosts(a.version);
    res.json({ bundled: a.version, outdated: hosts.length, online_outdated: hosts.filter(h => h.online).length, hosts });
  });

  app.get('/api/updates/agents/run', admin, (req, res) => res.json(agentRun || { status: 'idle', rings: [] }));

  app.post('/api/updates/agents/run', admin, (req, res) => {
    const ring = String(req.body?.ring || 'all').toLowerCase();
    if (ring !== 'all' && !RINGS.includes(ring)) return res.status(400).json({ error: 'ring must be ring0, ring1, ring2 or all' });
    if (agentRun?.status === 'running') return res.status(409).json({ error: 'An agent update run is already in progress' });
    const a = bundledAgent();
    if (!a) return res.status(404).json({ error: 'Bundled agent not found' });
    const opts = { timeoutMs: 120000, pollMs: 1000, ...(ctx.updatesOpts || {}) };
    const run = { status: 'running', version: a.version, ring, started: new Date().toISOString(), finished: null, rings: [], stopped_at: null };
    agentRun = run;
    ctx.audit(req.user.username, 'updates.agents.run', null, { ring, version: a.version });
    (async () => {
      for (const r of ring === 'all' ? RINGS : [ring]) {
        const entry = { ring: r, status: 'running', hosts: [] };
        run.rings.push(entry);
        const hosts = outdatedHosts(a.version).filter(h => h.ring === r);
        const waiting = [];
        for (const h of hosts) {
          const rec = { id: h.id, hostname: h.hostname, from: h.agent_version, result: 'pending' };
          entry.hosts.push(rec);
          if (!h.online) { rec.result = 'skipped_offline'; continue; }
          const sent = ctx.agents.send(h.id, { type: 'update_agent', version: a.version, source: a.source, sha256: a.sha256 });
          if (!sent) { rec.result = 'send_failed'; continue; }
          waiting.push(rec);
        }
        // Each host must re-register (or heartbeat) with the new version while online.
        const end = Date.now() + opts.timeoutMs;
        while (waiting.some(w => w.result === 'pending') && Date.now() < end) {
          await new Promise(r2 => setTimeout(r2, opts.pollMs));
          for (const w of waiting.filter(x => x.result === 'pending')) {
            const row = ctx.db.prepare('SELECT agent_version FROM hosts WHERE id = ?').get(w.id);
            if (row && compareVersions(row.agent_version, a.version) >= 0 && ctx.agents.isOnline(w.id)) w.result = 'updated';
          }
        }
        for (const w of waiting) if (w.result === 'pending') w.result = 'timeout';
        const failed = entry.hosts.filter(h => h.result === 'timeout' || h.result === 'send_failed');
        entry.status = failed.length ? 'failed' : 'done';
        if (failed.length) { run.status = 'failed'; run.stopped_at = r; break; }
      }
      if (run.status === 'running') run.status = 'done';
      run.finished = new Date().toISOString();
      ctx.audit('system', 'updates.agents.finished', null, { status: run.status, stopped_at: run.stopped_at });
    })().catch(err => { run.status = 'failed'; run.error = err.message; run.finished = new Date().toISOString(); });
    res.status(202).json(run);
  });
};

module.exports.compareVersions = compareVersions;
