// Smoke test: boot the whole app with a temp data dir, sign in as the bootstrap admin, GET every safe list route
// (200 and JSON), then shut down. Routes that call the network (GitHub latest, the updater sidecar) or stream (SSE)
// are left out.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, login } = require('./helpers');

const ROUTES = [
  '/api/health', '/api/health/hosts', '/api/auth/me', '/api/hosts', '/api/groups', '/api/tags', '/api/jobs', '/api/job-groups',
  '/api/schedules', '/api/builtin-schedules', '/api/scripts', '/api/templates', '/api/templates/runbooks', '/api/runbooks',
  '/api/runbook-runs', '/api/alerts', '/api/alerts/history', '/api/alert-rules', '/api/alert-config', '/api/alert-metrics',
  '/api/channels', '/api/maintenance', '/api/patch-policies', '/api/patch-runs', '/api/compliance', '/api/compliance/eol',
  '/api/tokens', '/api/audit', '/api/blocklist', '/api/runners', '/api/github/status', '/api/github/queued', '/api/fleet/summary',
  '/api/credentials', '/api/users', '/api/settings', '/api/agents/info', '/api/agent/version', '/api/deploy/relays',
  '/api/backups', '/api/backup/status'
];

test('smoke: every safe list route answers 200 with JSON for the bootstrap admin, then the app shuts down', async () => {
  const s = await startApp();
  try {
    const token = await login(s.base);
    assert.ok(token, 'bootstrap admin can sign in');
    const failures = [];
    for (const p of ROUTES) {
      const r = await fetch(s.base + p, { headers: { authorization: `Bearer ${token}` } });
      const type = r.headers.get('content-type') || '';
      const body = await r.text();
      let json = true;
      try { JSON.parse(body); } catch { json = false; }
      if (r.status !== 200 || !type.includes('application/json') || !json) failures.push(`${p}: ${r.status} ${type} ${body.slice(0, 120)}`);
    }
    assert.deepEqual(failures, []);
  } finally {
    await s.stop();
  }
});
