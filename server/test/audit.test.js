const test = require('node:test');
const assert = require('node:assert/strict');
const { redact } = require('../src/audit');

test('redaction strips passwords, tokens, keys and Authorization', () => {
  const out = redact({
    username: 'user1', password: 'p', new_password: 'p2', token: 't', token_id: 'abc', api_key: 'k', ssh_key: 'k2',
    headers: { Authorization: 'Bearer abc.def', cookie: 'labctl_session=1' },
    note: 'call with Bearer abcdef123 now',
    url: 'wss://example.test/ws/agent?token=abc123&x=1',
    pem: '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----',
    nested: [{ secret: 's', ok: 1 }]
  });
  assert.equal(out.username, 'user1');
  for (const k of ['password', 'new_password', 'token', 'api_key', 'ssh_key']) assert.equal(out[k], '[redacted]', k);
  assert.equal(out.token_id, 'abc');
  assert.equal(out.headers.Authorization, '[redacted]');
  assert.equal(out.headers.cookie, '[redacted]');
  assert.equal(out.note, 'call with Bearer [redacted] now');
  assert.equal(out.url, 'wss://example.test/ws/agent?token=[redacted]&x=1');
  assert.equal(out.pem, '[redacted private key]');
  assert.deepEqual(out.nested, [{ secret: '[redacted]', ok: 1 }]);
});
