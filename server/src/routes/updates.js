// LabCTL and agent updates (A11). All routes are admin only.
//   GET  /api/updates/check            GitHub release check, cached 15 minutes (?refresh=1 skips the cache). Always 200 with
//                                      state ok | no_release | github_unreachable | rate_limited (retry_after) and a message
//   POST /api/updates/apply            {confirm:"UPDATE", version?} sends the request to the labctl-updater sidecar
//   GET  /api/updates/status           sidecar progress
//   PUT  /api/updates/mode             {mode:"image"|"git", git_repo?, git_ref?} stored in update_mode, update_git_repo, update_git_ref
//   GET  /api/agent/version            bundled agent version
//   GET  /api/updates/agents           outdated agent count and hosts
//   POST /api/updates/agents/run       {ring:"ring0"|"ring1"|"ring2"|"all"} ring-by-ring agent self-update
//   GET  /api/updates/agents/run       progress of the last run
// Environment variable names: LABCTL_UPDATER_SECRET, LABCTL_UPDATER_URL. Tests set ctx.fetch and ctx.updatesOpts.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createUpdaterClient } = require('../updater-client');

// LABCTL_GITHUB_API_BASE points the release check at a local fake GitHub in tests; production uses api.github.com.
const RELEASES_PATH = '/repos/tlaskar-git/LabCTL/releases';
const githubBase = () => String(process.env.LABCTL_GITHUB_API_BASE || 'https://api.github.com').replace(/\/+$/, '');
const CACHE_MS = 15 * 60 * 1000;
const NO_RELEASE = 'No release has been published yet. Merge the pull request and push a version tag (for example v2.0.1) to build and publish the image. Until then, use Build from source (git).';
// Git mode allowlist (same rule as the updater, which checks again): https, host github.com, owner/name only.
const GIT_REPO_RE = /^https:\/\/github\.com\/[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const GIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const DEFAULT_GIT_REPO = 'https://github.com/tlaskar-git/LabCTL.git';
const DEFAULT_GIT_REF = 'main';
const validGitRepo = v => typeof v === 'string' && GIT_REPO_RE.test(v);
const validGitRef = v => typeof v === 'string' && GIT_REF_RE.test(v) && !v.includes('..');
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

  // Returns { state: 'ok'|'no_release'|'github_unreachable'|'rate_limited', message, release, retry_after? }.
  // A missing release, an unreachable GitHub and a rate limit are normal states, not errors. Only ok and no_release are cached.
  async function latestRelease(force) {
    if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
    const get = p => doFetch(githubBase() + RELEASES_PATH + p, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'labctl' }, signal: AbortSignal.timeout(10000) });
    const checked_at = new Date().toISOString();
    let r;
    try { r = await get('/latest'); } catch (err) {
      return { state: 'github_unreachable', message: `GitHub cannot be reached (${err.cause?.code || err.message}).`, release: null, checked_at };
    }
    const header = k => (r.headers && typeof r.headers.get === 'function' ? r.headers.get(k) : null);
    if ((r.status === 403 || r.status === 429) && header('x-ratelimit-remaining') === '0') {
      const reset = Number(header('x-ratelimit-reset'));
      const retry_after = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null;
      return { state: 'rate_limited', message: 'GitHub rate limit reached for this server.', release: null, retry_after, checked_at };
    }
    let data;
    if (r.status === 404) {
      // GitHub answers 404 on /latest when no full release exists. The list tells drafts and pre-releases apart.
      const list = await get('?per_page=5').then(x => (x.ok ? x.json() : []), () => []);
      data = { state: 'no_release', message: Array.isArray(list) && list.length ? 'Only drafts or pre-releases exist. No full release has been published yet.' : NO_RELEASE, release: null, checked_at };
    } else if (!r.ok) {
      return { state: 'github_unreachable', message: `GitHub returned HTTP ${r.status}.`, release: null, checked_at };
    } else {
      const j = await r.json();
      data = { state: 'ok', message: '', checked_at,
        release: { tag: String(j.tag_name || ''), notes: String(j.body || ''), url: j.html_url || null, published_at: j.published_at || null } };
    }
    cache = { at: Date.now(), data };
    return data;
  }

  app.get('/api/updates/check', admin, async (req, res) => {
    try {
      const rel = await latestRelease(req.query.refresh === '1');
      const tag = rel.release?.tag || null;
      res.json({ current: ctx.version, ...rel, latest: tag ? tag.replace(/^v/, '') : null, newer: !!tag && compareVersions(tag, ctx.version) > 0,
        update_mode: mode(), git_repo: gitRepo(), git_ref: gitRef(), updater_configured: client.configured() });
    } catch (err) { res.status(500).json({ error: `Update check failed: ${err.message}` }); }
  });

  app.get('/api/updates/status', admin, async (req, res) => {
    if (!client.configured()) return res.json({ configured: false, state: 'idle', steps: [] });
    try { res.json({ configured: true, ...(await client.status()) }); } catch (err) { res.status(502).json({ error: err.message }); }
  });

  // Settings update_git_repo (default tlaskar-git/LabCTL on GitHub) and update_git_ref (default main) feed git mode.
  const gitRepo = () => ctx.settings.get('update_git_repo') || DEFAULT_GIT_REPO;
  const gitRef = () => ctx.settings.get('update_git_ref') || DEFAULT_GIT_REF;

  app.put('/api/updates/mode', admin, (req, res) => {
    const { mode: m, git_repo: repo, git_ref: ref } = req.body || {};
    if (!['image', 'git'].includes(m)) return res.status(400).json({ error: 'mode must be image or git' });
    if (repo !== undefined && !validGitRepo(repo)) return res.status(400).json({ error: 'git_repo must be https://github.com/<owner>/<name>' });
    if (ref !== undefined && !validGitRef(ref)) return res.status(400).json({ error: 'git_ref contains characters that are not allowed' });
    ctx.settings.set('update_mode', m);
    if (repo !== undefined) ctx.settings.set('update_git_repo', repo);
    if (ref !== undefined) ctx.settings.set('update_git_ref', ref);
    res.json({ update_mode: mode(), git_repo: gitRepo(), git_ref: gitRef() });
  });

  app.post('/api/updates/apply', admin, ctx.requireConfirm('UPDATE'), async (req, res) => {
    if (!client.configured()) return res.status(503).json({ error: 'The updater sidecar is not configured (LABCTL_UPDATER_SECRET is empty)' });
    try {
      let out;
      if (mode() === 'git') {
        // The settings can be written through the generic settings route, so check them again here.
        if (!validGitRepo(gitRepo()) || !validGitRef(gitRef())) return res.status(400).json({ error: 'update_git_repo or update_git_ref is not allowed' });
        out = await client.updateGit(gitRepo(), gitRef());
      } else {
        let tag = req.body.version;
        if (!tag) {
          const rel = await latestRelease(false);
          if (rel.state === 'no_release') return res.status(409).json({ error: 'No release has been published yet, so there is no image to pull. Use Build from source (git), or publish a release first.' });
          if (rel.state !== 'ok') return res.status(503).json({ error: `The latest release is unknown. ${rel.message}` });
          tag = rel.release.tag;
        }
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
