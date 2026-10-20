// GitHub Actions runner integration: sealed token, API client, 60 s poller, cache and the merged runner view.
// Only two kinds of external call: the GitHub API (runner lists, queued runs, repo visibility, registration and removal
// tokens) and the actions/runner release feed. The token is never returned, logged or audited.
// Cache lives in settings: github_runners (scopes + visibility), github_queued (number, A9 reads it),
// github_queued_repos ({ "owner/repo": { count, oldest_at } }), github_latest_runner.
const { parseJson } = require('./db');

const DEFAULT_BASE = 'https://api.github.com';
const TOKEN_KEY = '_github_token'; // underscore: hidden from GET /api/settings
const LATEST_TTL_MS = 6 * 3600 * 1000;
const MAX_PAGES = 10;
const GB = 1024 ** 3;
// shortcut: fixed size limits, make them settings if operators ask.
const SIZE_LIMITS = { work: 30 * GB, diag: 2 * GB, temp: 5 * GB, tool_cache: 30 * GB };
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const SERVICE_OK = ['active', 'running', 'started'];

const enc = encodeURIComponent;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// "https://host/owner/repo" -> repo scope, "https://host/org" -> org scope. Enterprise runners are not supported.
function parseRunnerUrl(url) {
  try {
    const u = new URL(String(url));
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length || parts.length > 2 || parts.some(p => !NAME_RE.test(p.replace(/\.git$/, ''))) || parts[0] === 'enterprises') return null;
    const owner = parts[0];
    if (parts.length === 1) return { kind: 'org', owner, scope: owner, origin: u.origin };
    const repo = parts[1].replace(/\.git$/, '');
    return { kind: 'repo', owner, repo, scope: `${owner}/${repo}`, origin: u.origin };
  } catch { return null; }
}

// "owner/repo", "org" or a full URL.
function parseScope(text) {
  const s = String(text || '').trim();
  if (/^https?:\/\//i.test(s)) return parseRunnerUrl(s);
  return parseRunnerUrl(`https://github.invalid/${s}`);
}

const settingsUrl = sc => (sc.kind === 'repo' ? `${sc.origin}/${sc.owner}/${sc.repo}/settings/actions` : `${sc.origin}/organizations/${sc.owner}/settings/actions`);

const versionParts = v => String(v || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
function versionBehind(local, latest) {
  if (!local || !latest) return false;
  const a = versionParts(local), b = versionParts(latest);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  }
  return false;
}

const nextLink = link => (/<([^>]+)>;\s*rel="next"/.exec(link || '') || [])[1] || null;

function createGithub(ctx) {
  const { db, settings } = ctx;
  const cache = new Map(); // request path -> { etag, json, link } for conditional requests
  const busySince = new Map(); // "host/runner" -> ms, in memory only
  const state = { last_poll_at: null, last_poll_ok: null, errors: [], rate: null, backoff_until: 0 };
  let inflight = null;
  let timer = null;

  const base = () => String(settings.get('github_api_base') || process.env.LABCTL_GITHUB_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const num = (key, fallback) => { const n = Number(settings.get(key)); return Number.isFinite(n) && n > 0 ? n : fallback; };
  const pollMs = () => Math.max(30, num('github_poll_s', 60)) * 1000;

  // ---- token (sealed) -------------------------------------------------------------------------------------------------
  const token = () => {
    const sealed = settings.get(TOKEN_KEY);
    if (!sealed) return null;
    try { return ctx.crypto.open(sealed); } catch { return null; }
  };
  const configured = () => !!token();
  const setToken = t => settings.set(TOKEN_KEY, ctx.crypto.seal(String(t).trim()));
  const clearToken = () => db.prepare('DELETE FROM settings WHERE key = ?').run(TOKEN_KEY);

  // ---- API client -----------------------------------------------------------------------------------------------------
  const fail = (message, extra = {}) => Object.assign(new Error(message), { gh: true, ...extra });

  function noteRate(headers) {
    const remaining = headers.get('x-ratelimit-remaining');
    if (remaining === null) return;
    state.rate = { limit: Number(headers.get('x-ratelimit-limit')) || null, remaining: Number(remaining), reset: Number(headers.get('x-ratelimit-reset')) || null };
  }

  async function request(method, path, { body, etag } = {}) {
    if (Date.now() < state.backoff_until) throw fail(`GitHub rate limit reached, retrying after ${new Date(state.backoff_until).toISOString()}`, { rate_limited: true });
    const tok = token();
    const url = path.startsWith('http') ? path : base() + path;
    const res = await fetch(url, {
      method,
      signal: AbortSignal.timeout(num('github_timeout_s', 15) * 1000),
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'labctl',
        ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(etag ? { 'if-none-match': etag } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    noteRate(res.headers);
    const limited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
    if (limited) {
      const retry = Number(res.headers.get('retry-after'));
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const until = retry ? Date.now() + retry * 1000 : (reset ? reset * 1000 : Date.now() + 60000);
      state.backoff_until = Math.min(until, Date.now() + 3600000);
      throw fail('GitHub rate limit reached', { status: res.status, rate_limited: true });
    }
    let json = null;
    if (res.status !== 304) { try { json = await res.json(); } catch { /* empty body */ } }
    return { status: res.status, json, headers: res.headers };
  }

  // GET with ETag. A 304 returns the cached body and costs no rate limit.
  async function getCached(path) {
    const hit = cache.get(path);
    const r = await request('GET', path, { etag: hit && hit.etag });
    if (r.status === 304 && hit) return { status: 200, json: hit.json, link: hit.link };
    const link = r.headers.get('link');
    if (r.status === 200) {
      const etag = r.headers.get('etag');
      if (etag) cache.set(path, { etag, json: r.json, link });
    }
    return { status: r.status, json: r.json, link };
  }

  const httpError = (r, what) => fail(`${what}: GitHub answered ${r.status}${r.json && r.json.message ? ` (${String(r.json.message).slice(0, 120)})` : ''}`, { status: r.status });

  // All pages of a list endpoint. Next links are followed only when they stay on the configured API host.
  async function list(path, key, what) {
    let items = [], total = null, next = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    for (let i = 0; next && i < MAX_PAGES; i++) {
      const r = await getCached(next);
      if (r.status !== 200) throw httpError(r, what);
      items = items.concat((r.json && r.json[key]) || []);
      if (total === null) total = r.json && Number.isFinite(r.json.total_count) ? r.json.total_count : null;
      const link = nextLink(r.link);
      next = link && link.startsWith(base() + '/') ? link : null;
    }
    return { items, total: total === null ? items.length : total };
  }

  const runnersPath = sc => (sc.kind === 'repo' ? `/repos/${enc(sc.owner)}/${enc(sc.repo)}/actions/runners` : `/orgs/${enc(sc.owner)}/actions/runners`);

  async function fetchScope(sc) {
    const { items } = await list(runnersPath(sc), 'runners', `Runner list for ${sc.scope}`);
    return items.map(r => ({ id: r.id, name: r.name, os: r.os, status: r.status, busy: !!r.busy, labels: (r.labels || []).map(l => l.name) }));
  }

  // One-shot tokens. The value goes straight to the caller and nowhere else.
  async function actionToken(sc, kind) {
    if (!configured()) throw fail('GitHub token is not configured');
    const r = await request('POST', `${runnersPath(sc)}/${kind}-token`);
    if (r.status !== 201 || !r.json || !r.json.token) throw httpError(r, `${kind} token for ${sc.scope}`);
    return r.json.token;
  }

  // ---- hosts and scopes -----------------------------------------------------------------------------------------------
  function hostRunners() {
    const out = [];
    for (const h of db.prepare('SELECT id, hostname, os, status, inventory FROM hosts WHERE inventory IS NOT NULL').all()) {
      const inv = parseJson(h.inventory, {});
      for (const r of Array.isArray(inv && inv.runners) ? inv.runners : []) out.push({ host: h, r, sc: parseRunnerUrl(r.url) });
    }
    return out;
  }

  const extraRepos = () => (Array.isArray(settings.get('github_repos')) ? settings.get('github_repos') : [])
    .map(parseScope).filter(sc => sc && sc.kind === 'repo');

  const scopeFor = (host, name) => {
    const hit = hostRunners().find(x => x.host.id === (host && host.id) && x.r.name === name && x.sc);
    return hit ? hit.sc : null;
  };

  // ---- release feed ---------------------------------------------------------------------------------------------------
  const latestRunner = () => settings.get('github_latest_runner') || null;

  async function refreshLatest(force = false) {
    const cur = latestRunner();
    if (!force && cur && Date.now() - Date.parse(cur.fetched_at) < LATEST_TTL_MS) return cur;
    const r = await request('GET', '/repos/actions/runner/releases/latest');
    if (r.status !== 200 || !r.json) throw httpError(r, 'Latest runner release');
    const shas = {};
    for (const m of String(r.json.body || '').matchAll(/<!--\s*BEGIN SHA ([\w.-]+)\s*-->\s*([0-9a-f]{64})\s*<!--\s*END SHA/gi)) shas[m[1]] = m[2];
    const value = { version: String(r.json.tag_name || '').replace(/^v/, ''), published_at: r.json.published_at || null, shas, fetched_at: new Date().toISOString() };
    settings.set('github_latest_runner', value);
    return value;
  }

  // ---- poller ---------------------------------------------------------------------------------------------------------
  async function pollOnce() {
    const errors = [];
    const note = (what, err) => errors.push(`${what}: ${err.message}`);
    const prev = settings.get('github_runners') || {};
    const scopes = new Map();
    for (const { sc } of hostRunners()) if (sc) scopes.set(sc.scope, sc);
    const result = {};
    let halted = false;

    for (const sc of scopes.values()) {
      if (halted) { result[sc.scope] = { ...(prev.scopes || {})[sc.scope], ok: false }; continue; }
      try { result[sc.scope] = { kind: sc.kind, ok: true, runners: await fetchScope(sc), at: new Date().toISOString() }; } catch (err) {
        note(sc.scope, err);
        result[sc.scope] = { ...(prev.scopes || {})[sc.scope], kind: sc.kind, ok: false, error: err.message };
        if (err.rate_limited) halted = true;
      }
    }

    // Repositories to inspect: every repo runner scope, plus the optional github_repos list (organisation runners).
    const repos = new Map();
    for (const sc of scopes.values()) if (sc.kind === 'repo') repos.set(sc.scope, sc);
    for (const sc of extraRepos()) repos.set(sc.scope, sc);
    const visibility = { ...(prev.visibility || {}) };
    const queuedRepos = {};
    for (const sc of repos.values()) {
      if (halted) break;
      try {
        const r = await getCached(`/repos/${enc(sc.owner)}/${enc(sc.repo)}`);
        if (r.status === 200) visibility[sc.scope] = { private: !!r.json.private };
        else throw httpError(r, 'Repository');
      } catch (err) { note(`${sc.scope} visibility`, err); if (err.rate_limited) halted = true; }
      if (halted) break;
      try {
        const { items, total } = await list(`/repos/${enc(sc.owner)}/${enc(sc.repo)}/actions/runs?status=queued`, 'workflow_runs', `Queued runs for ${sc.scope}`);
        const times = items.map(x => Date.parse(x.created_at)).filter(Number.isFinite);
        queuedRepos[sc.scope] = { count: total, oldest_at: times.length ? new Date(Math.min(...times)).toISOString() : null };
      } catch (err) { note(`${sc.scope} queued`, err); if (err.rate_limited) halted = true; }
    }
    if (!halted) { try { await refreshLatest(); } catch (err) { note('latest runner release', err); } }

    settings.set('github_runners', { updated_at: new Date().toISOString(), scopes: result, visibility });
    settings.set('github_queued_repos', queuedRepos);
    settings.set('github_queued', Object.values(queuedRepos).reduce((n, q) => n + q.count, 0));

    // Busy-since tracker for the busy_too_long flag (resets when the server restarts).
    const seen = new Set();
    for (const { host, r, sc } of hostRunners()) {
      const gh = sc && result[sc.scope] && (result[sc.scope].runners || []).find(x => x.name === r.name);
      const key = `${host.id}/${r.name}`;
      seen.add(key);
      if (gh ? gh.busy : r.busy) { if (!busySince.has(key)) busySince.set(key, Date.now()); } else busySince.delete(key);
    }
    for (const k of busySince.keys()) if (!seen.has(k)) busySince.delete(k);

    state.errors = errors.slice(0, 20);
    state.last_poll_ok = !errors.length;
  }

  function poll() {
    if (inflight) return inflight;
    if (!configured()) return Promise.resolve(status());
    inflight = (async () => {
      try { await pollOnce(); } catch (err) { state.errors = [err.message]; state.last_poll_ok = false; } finally {
        state.last_poll_at = new Date().toISOString();
        inflight = null;
      }
      return status();
    })();
    return inflight;
  }

  function start() {
    if (timer) return;
    const tick = async () => {
      if (!db.open) return;
      try { await poll(); } catch { /* recorded in state */ }
      if (db.open) timer = setTimeout(tick, pollMs()).unref();
    };
    timer = setTimeout(tick, 5000).unref();
  }
  function stop() { clearTimeout(timer); timer = null; }

  // ---- reads ----------------------------------------------------------------------------------------------------------
  function status() {
    const cached = settings.get('github_runners') || {};
    return { configured: configured(), last_poll_at: state.last_poll_at, last_poll_ok: state.last_poll_ok, errors: state.errors,
      rate_limit: state.rate, backoff_until: state.backoff_until ? new Date(state.backoff_until).toISOString() : null,
      poll_s: pollMs() / 1000, scopes: Object.keys(cached.scopes || {}).length, cache_updated_at: cached.updated_at || null,
      repos: Array.isArray(settings.get('github_repos')) ? settings.get('github_repos') : [] };
  }

  function queued() {
    const repos = {};
    let total = 0;
    for (const [repo, q] of Object.entries(settings.get('github_queued_repos') || {})) {
      repos[repo] = { count: q.count, oldest_at: q.oldest_at, oldest_age_s: q.oldest_at ? Math.max(0, Math.round((Date.now() - Date.parse(q.oldest_at)) / 1000)) : null };
      total += q.count;
    }
    return { total, repos };
  }

  // Polls the GitHub API until the named runner shows online. Resolves true or false, never leaves a timer behind.
  async function runnerOnline(host, name, timeoutMs = 180000, opts = {}) {
    const sc = opts.scope ? parseScope(opts.scope) : scopeFor(host, name);
    if (!sc) throw new Error(`No GitHub repository or organisation is known for runner ${name}`);
    if (!configured()) throw new Error('GitHub token is not configured');
    const end = Date.now() + timeoutMs;
    const every = num('github_verify_interval_s', 10) * 1000;
    for (;;) {
      try {
        const hit = (await fetchScope(sc)).find(x => x.name === name);
        if (hit && hit.status === 'online') return true;
      } catch (err) { if (err.status === 401) throw err; /* transient: keep polling until the deadline */ }
      const left = end - Date.now();
      if (left <= 0) return false;
      await sleep(Math.min(every, left));
    }
  }

  // The merged view: every runner on every host with its GitHub state and flags.
  function fleet() {
    const cached = settings.get('github_runners') || {};
    const scopes = cached.scopes || {};
    const vis = cached.visibility || {};
    const latest = latestRunner();
    const q = queued().repos;
    const prefs = settings.get('github_runner_prefs') || {};
    const busyMs = num('github_busy_hours', 6) * 3600000;
    return hostRunners().map(({ host, r, sc }) => {
      const s = sc && scopes[sc.scope];
      const gh = s ? (s.runners || []).find(x => x.name === r.name) || null : null;
      const serviceOk = SERVICE_OK.includes(String(r.service_state || '').toLowerCase());
      let mismatch = null;
      if (gh && serviceOk && gh.status === 'offline') mismatch = 'GitHub shows the runner offline but its service is running';
      if (gh && !serviceOk && gh.status === 'online') mismatch = 'GitHub shows the runner online but its service is not running';
      const publicRepo = !!sc && (sc.kind === 'repo' ? vis[sc.scope] && vis[sc.scope].private === false
        : Object.entries(vis).some(([k, v]) => k.startsWith(`${sc.owner}/`) && v.private === false));
      const since = busySince.get(`${host.id}/${r.name}`);
      const sizeWarnings = Object.entries(SIZE_LIMITS).filter(([k, lim]) => Number(r.sizes && r.sizes[k]) > lim)
        .map(([k, lim]) => `${k.replace('_', ' ')} over ${Math.round(lim / GB)} GB`);
      const queue = !sc ? null : (sc.kind === 'repo' ? q[sc.scope] : Object.entries(q).filter(([k]) => k.startsWith(`${sc.owner}/`))
        .reduce((a, [, v]) => ({ count: a.count + v.count, oldest_age_s: Math.max(a.oldest_age_s || 0, v.oldest_age_s || 0) || null }), { count: 0, oldest_age_s: null }));
      return {
        host_id: host.id, hostname: host.hostname || host.id, host_status: host.status, os: host.os,
        name: r.name || r.path, path: r.path, url: r.url || null, scope: sc ? sc.scope : null, scope_kind: sc ? sc.kind : null,
        settings_url: sc ? settingsUrl(sc) : null,
        local: { service_state: r.service_state || null, service_ok: serviceOk, version: r.version || null, busy: !!r.busy, job: r.job || null,
          labels: r.labels || [], sizes: r.sizes || null, run_as: r.run_as || null },
        github: gh ? { id: gh.id, status: gh.status, busy: gh.busy, labels: gh.labels, stale: s.ok === false } : null,
        github_error: s && s.ok === false ? s.error || 'Last poll failed' : null,
        queued: queue || null,
        latest_version: latest ? latest.version : null,
        disable_update: !!(prefs[`${host.id}/${r.name}`] && prefs[`${host.id}/${r.name}`].disable_update),
        flags: {
          mismatch, public_repo: publicRepo, behind_latest: versionBehind(r.version, latest && latest.version),
          missing_in_github: !!(s && s.ok !== false && !gh), busy_too_long: !!since && Date.now() - since > busyMs, size_warnings: sizeWarnings
        }
      };
    });
  }

  // ---- permission probe -----------------------------------------------------------------------------------------------
  // Read checks use GET endpoints only. The write check POSTs to the registration-token endpoint and discards the token,
  // and runs only when the caller sends write_check:true.
  async function checkPermissions({ write_check = false } = {}) {
    if (!configured()) return { configured: false, checks: [] };
    const checks = [];
    const add = (scope, name, ok, missing, detail) => checks.push({ scope, name, ok, missing: ok ? [] : [].concat(missing || []), detail: detail || null });
    const probe = async (scope, name, missing, fn) => {
      try { const d = await fn(); add(scope, name, true, [], d); } catch (err) {
        add(scope, name, false, err.status === 401 ? 'A valid token' : missing, err.message);
        if (err.rate_limited) throw err;
      }
    };
    const user = await request('GET', '/user').catch(err => ({ status: 0, err }));
    if (user.status === 401) { add('token', 'Token accepted', false, 'A valid token', 'GitHub rejected the token (401)'); return { configured: true, checks }; }
    add('token', 'Token accepted', user.status === 200 || user.status === 403, [], user.status === 200 ? `Signed in as ${user.json && user.json.login}` : user.status === 403 ? 'Token works, GET /user is not allowed for this token type' : user.err ? user.err.message : `GET /user answered ${user.status}`);
    const seen = new Map();
    for (const { sc } of hostRunners()) if (sc) seen.set(sc.scope, sc);
    for (const sc of extraRepos()) seen.set(sc.scope, sc);
    for (const sc of seen.values()) {
      const readName = 'Read self-hosted runners';
      const readMissing = sc.kind === 'repo' ? 'Administration (read)' : 'Self-hosted runners (read)';
      try {
        await probe(sc.scope, readName, readMissing, async () => { const { total } = await list(runnersPath(sc), 'runners', 'Runner list'); return `${total} runner(s)`; });
        if (sc.kind === 'repo') {
          await probe(sc.scope, 'Read queued workflow runs', 'Actions (read)', async () => { const { total } = await list(`/repos/${enc(sc.owner)}/${enc(sc.repo)}/actions/runs?status=queued`, 'workflow_runs', 'Queued runs'); return `${total} queued`; });
          await probe(sc.scope, 'Read repository visibility', 'Metadata (read)', async () => { const r = await request('GET', `/repos/${enc(sc.owner)}/${enc(sc.repo)}`); if (r.status !== 200) throw httpError(r, 'Repository'); return r.json.private ? 'private' : 'public'; });
        }
        if (write_check) {
          await probe(sc.scope, 'Create registration tokens', sc.kind === 'repo' ? 'Administration (write)' : 'Self-hosted runners (write)',
            async () => { await actionToken(sc, 'registration'); return 'token created and discarded'; });
        } else add(sc.scope, 'Create registration tokens', null, [], 'Not tested. Send write_check:true to test it.');
      } catch (err) { if (!err.rate_limited) throw err; add(sc.scope, 'Rate limit', false, [], err.message); break; }
    }
    return { configured: true, write_check: !!write_check, checks };
  }

  return { configured, setToken, clearToken, status, poll, start, stop, queued, latestRunner, refreshLatest, fleet,
    // Absent without a token, so a runbook step reports 'GitHub integration not configured' instead of failing per host.
    get runnerOnline() { return configured() ? runnerOnline : undefined; },
    checkPermissions, registrationToken: sc => actionToken(sc, 'registration'), removeToken: sc => actionToken(sc, 'remove'), parseScope, parseRunnerUrl };
}

module.exports = { createGithub, parseRunnerUrl, parseScope, versionBehind, nextLink };
