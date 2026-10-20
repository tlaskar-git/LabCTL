// A browser that lost the session cookie (it expires after 7 days, the stored token does not) gets it back on the
// next request that carries the Bearer token, so EventSource streams (which cannot send headers) keep working.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, login } = require('./helpers');

test('a Bearer request without the cookie sets it, a request that already has it does not', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const token = await login(s.base);
  const bare = await fetch(`${s.base}/api/hosts`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(bare.status, 200);
  const set = bare.headers.get('set-cookie') || '';
  assert.match(set, new RegExp(`labctl_session=${token}`));
  assert.match(set, /HttpOnly/i);
  const withCookie = await fetch(`${s.base}/api/hosts`, { headers: { Authorization: `Bearer ${token}`, Cookie: `labctl_session=${token}` } });
  assert.equal(withCookie.headers.get('set-cookie'), null);
});
