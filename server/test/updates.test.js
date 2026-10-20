const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, login, api, wsOpen, waitFor } = require('./helpers');
const { compareVersions } = require('../src/routes/updates');

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

async function setup(t, fetchImpl) {
  process.env.LABCTL_UPDATER_SECRET = 'test-secret';
  const s = await startApp();
  t.after(async () => { delete process.env.LABCTL_UPDATER_SECRET; await s.stop(); });
  s.ctx.fetch = fetchImpl;
  s.ctx.updatesOpts = { timeoutMs: 600, pollMs: 20 };
  const admin = api(s.base, await login(s.base));
  await admin('POST', '/api/users', { username: 'viewer1', password: 'pw-viewer-1', role: 'viewer' });
  await admin('POST', '/api/users', { username: 'op1', password: 'pw-operator-1', role: 'operator' });
  return { s, admin, operator: api(s.base, await login(s.base, 'op1', 'pw-operator-1')) };
}

test('version compare orders releases and pre-releases', () => {
  assert.equal(compareVersions('v2.1.0', '2.0.9'), 1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('2.0.0-rc.1', '2.0.0'), -1);
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
});

test('check: reads the GitHub release, caches for 15 minutes and flags newer', async (t) => {
  let calls = 0;
  const { s, admin, operator } = await setup(t, async (url) => {
    assert.match(url, /^https:\/\/api\.github\.com\/repos\/tlaskar-git\/LabCTL\/releases\/latest$/);
    calls++;
    return json(200, { tag_name: 'v9.9.9', body: 'Notes <b>text</b>', html_url: 'https://example.test/r', published_at: '2026-01-01T00:00:00Z' });
  });
  const r = await admin('GET', '/api/updates/check');
  assert.equal(r.status, 200);
  assert.equal(r.data.current, s.ctx.version);
  assert.equal(r.data.latest, '9.9.9');
  assert.equal(r.data.newer, true);
  assert.equal(r.data.notes, 'Notes <b>text</b>');
  assert.equal(r.data.update_mode, 'image');
  await admin('GET', '/api/updates/check');
  assert.equal(calls, 1);
  await admin('GET', '/api/updates/check?refresh=1');
  assert.equal(calls, 2);
  assert.equal((await operator('GET', '/api/updates/check')).status, 403);
});

test('check: a GitHub failure is a 502, not a crash', async (t) => {
  const { admin } = await setup(t, async () => json(500, {}));
  const r = await admin('GET', '/api/updates/check');
  assert.equal(r.status, 502);
});

test('apply: admin only, typed confirmation required, then proxied with the shared secret', async (t) => {
  const seen = [];
  const { admin, operator } = await setup(t, async (url, opts = {}) => {
    if (url.includes('api.github.com')) return json(200, { tag_name: 'v9.9.9', body: '' });
    seen.push({ url, method: opts.method, secret: opts.headers['X-Updater-Secret'], body: opts.body });
    return json(202, { state: 'running', target: 'v9.9.9', steps: [] });
  });
  assert.equal((await operator('POST', '/api/updates/apply', { confirm: 'UPDATE' })).status, 403);
  const no = await admin('POST', '/api/updates/apply', {});
  assert.equal(no.status, 400);
  assert.equal(no.data.confirm_required, true);
  assert.equal((await admin('POST', '/api/updates/apply', { confirm: 'update' })).status, 400);
  assert.equal(seen.length, 0);
  const bad = await admin('POST', '/api/updates/apply', { confirm: 'UPDATE', version: 'latest; x' });
  assert.equal(bad.status, 400);
  const ok = await admin('POST', '/api/updates/apply', { confirm: 'UPDATE' });
  assert.equal(ok.status, 202);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://labctl-updater:8080/update');
  assert.equal(seen[0].secret, 'test-secret');
  assert.deepEqual(JSON.parse(seen[0].body), { image_tag: 'v9.9.9' });
  const st = await admin('GET', '/api/updates/status');
  assert.equal(st.status, 200);
});

test('apply in git mode calls /update-git; mode is validated', async (t) => {
  const urls = [], bodies = [];
  const { admin } = await setup(t, async (url, opts) => { urls.push(url); bodies.push(JSON.parse(opts.body)); return json(202, { state: 'running', steps: [] }); });
  assert.equal((await admin('PUT', '/api/updates/mode', { mode: 'svn' })).status, 400);
  const m = await admin('PUT', '/api/updates/mode', { mode: 'git' });
  assert.equal(m.data.update_mode, 'git');
  assert.deepEqual([m.data.git_repo, m.data.git_ref], ['https://github.com/tlaskar-git/LabCTL.git', 'main']);
  assert.equal((await admin('POST', '/api/updates/apply', { confirm: 'UPDATE' })).status, 202);
  assert.deepEqual(urls, ['http://labctl-updater:8080/update-git']);
  assert.deepEqual(bodies[0], { repo: 'https://github.com/tlaskar-git/LabCTL.git', ref: 'main' });
});

test('git repo and ref are stored, validated against the allowlist, and sent to the updater', async (t) => {
  const bodies = [];
  const { admin } = await setup(t, async (url, opts) => { bodies.push(JSON.parse(opts.body)); return json(202, { state: 'running', steps: [] }); });
  for (const bad of [{ git_repo: 'http://github.com/a/b' }, { git_repo: 'https://example.test/a/b' }, { git_repo: 'https://github.com@example.test/a/b' },
    { git_repo: 'git@github.com:a/b.git' }, { git_ref: '--upload-pack=x' }, { git_ref: 'a..b' }, { git_ref: 'a#b' }, { git_ref: 'a:b' }]) {
    assert.equal((await admin('PUT', '/api/updates/mode', { mode: 'git', ...bad })).status, 400, JSON.stringify(bad));
  }
  const ok = await admin('PUT', '/api/updates/mode', { mode: 'git', git_repo: 'https://github.com/example-org/labctl', git_ref: 'release/2.1' });
  assert.equal(ok.status, 200);
  assert.equal((await admin('POST', '/api/updates/apply', { confirm: 'UPDATE' })).status, 202);
  assert.deepEqual(bodies, [{ repo: 'https://github.com/example-org/labctl', ref: 'release/2.1' }]);
});

test('apply without a configured sidecar secret is refused', async (t) => {
  const { admin } = await setup(t, async () => json(200, {}));
  delete process.env.LABCTL_UPDATER_SECRET;
  assert.equal((await admin('POST', '/api/updates/apply', { confirm: 'UPDATE' })).status, 503);
  assert.equal((await admin('GET', '/api/updates/status')).data.configured, false);
});

test('GET /api/agent/version returns the bundled agent version', async (t) => {
  const { admin } = await setup(t, async () => json(200, {}));
  const r = await admin('GET', '/api/agent/version');
  assert.equal(r.status, 200);
  assert.match(r.data.version, /^\d+\.\d+\.\d+/);
  assert.match(r.data.sha256, /^[0-9a-f]{64}$/);
});

// Fake agents: real WebSocket clients. They register, and on update_agent they re-register with the new version (or not).
async function fakeAgent(s, admin, tokenValue, id, ring, { updates = true, version = '1.0.0' } = {}) {
  const ws = await wsOpen(s.port, tokenValue);
  const received = [];
  const register = v => ws.send(JSON.stringify({ type: 'register', host_id: id, hostname: `${id}.example.test`, os: 'linux', kind: 'agent', agent_version: v, info: {} }));
  ws.on('message', d => {
    const m = JSON.parse(d.toString());
    if (m.type !== 'update_agent') return;
    received.push(m);
    if (updates) register(m.version);
  });
  register(version);
  await waitFor(() => s.ctx.db.prepare('SELECT 1 FROM hosts WHERE id = ?').get(id));
  if (ring) {
    const tagId = `tag-${ring}`;
    s.ctx.db.prepare('INSERT OR IGNORE INTO tags (id, name, created_at) VALUES (?, ?, ?)').run(tagId, ring, new Date().toISOString());
    s.ctx.db.prepare('INSERT OR IGNORE INTO host_tags (host_id, tag_id) VALUES (?, ?)').run(id, tagId);
  }
  return { ws, received };
}

// Close the fake agents and let the server see it before the app stops (its close handler writes to the db).
const closeAgents = async agents => {
  await Promise.all(agents.map(a => new Promise(r => { a.ws.once('close', r); a.ws.close(); })));
  await new Promise(r => setTimeout(r, 50));
};

async function runState(admin) {
  let state;
  const end = Date.now() + 5000;
  do { await new Promise(r => setTimeout(r, 30)); state = (await admin('GET', '/api/updates/agents/run')).data; } while (state.status === 'running' && Date.now() < end);
  return state;
}

test('agent update: counts outdated, runs ring by ring and sends version, source and sha256', async (t) => {
  const { s, admin } = await setup(t, async () => json(200, {}));
  const token = (await admin('POST', '/api/tokens', { label: 'fake' })).data.value;
  const bundled = (await admin('GET', '/api/agent/version')).data;
  const a0 = await fakeAgent(s, admin, token, 'h-ring0', 'ring0');
  const a1 = await fakeAgent(s, admin, token, 'h-ring1', 'ring1');
  const a2 = await fakeAgent(s, admin, token, 'h-untagged', null);

  const info = await admin('GET', '/api/updates/agents');
  assert.equal(info.data.outdated, 3);
  assert.equal(info.data.online_outdated, 3);
  assert.equal(info.data.hosts.find(h => h.id === 'h-untagged').ring, 'ring2');

  assert.equal((await admin('POST', '/api/updates/agents/run', { ring: 'ring9' })).status, 400);
  assert.equal((await admin('POST', '/api/updates/agents/run', { ring: 'all' })).status, 202);
  const state = await runState(admin);
  assert.equal(state.status, 'done');
  assert.deepEqual(state.rings.map(r => r.ring), ['ring0', 'ring1', 'ring2']);
  assert.ok(state.rings.every(r => r.hosts.every(h => h.result === 'updated')));
  const msg = a0.received[0];
  assert.equal(msg.version, bundled.version);
  assert.equal(msg.sha256, bundled.sha256);
  assert.ok(msg.source.length > 1000);
  assert.equal((await admin('GET', '/api/updates/agents')).data.outdated, 0);
  await closeAgents([a0, a1, a2]);
});

test('agent update stops on the first failing ring and does not touch later rings', async (t) => {
  const { s, admin } = await setup(t, async () => json(200, {}));
  const token = (await admin('POST', '/api/tokens', { label: 'fake' })).data.value;
  const bad = await fakeAgent(s, admin, token, 'h-bad', 'ring0', { updates: false });
  const later = await fakeAgent(s, admin, token, 'h-later', 'ring1');
  await admin('POST', '/api/updates/agents/run', { ring: 'all' });
  const state = await runState(admin);
  assert.equal(state.status, 'failed');
  assert.equal(state.stopped_at, 'ring0');
  assert.equal(state.rings.length, 1);
  assert.equal(state.rings[0].hosts[0].result, 'timeout');
  assert.equal(later.received.length, 0);
  await closeAgents([bad, later]);
});
