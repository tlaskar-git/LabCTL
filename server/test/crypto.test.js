const test = require('node:test');
const assert = require('node:assert/strict');
const { createCrypto, generateKey } = require('../src/crypto');

test('seal and open round trip, with a fresh IV each time', () => {
  const c = createCrypto(generateKey());
  const a = c.seal('s3cret value');
  assert.notEqual(a, c.seal('s3cret value'));
  assert.equal(c.open(a), 's3cret value');
  assert.deepEqual(c.openJson(c.sealJson({ password: 'x' })), { password: 'x' });
});

test('tampered blob or wrong key fails to open', () => {
  const c = createCrypto(generateKey());
  const buf = Buffer.from(c.seal('hello'), 'base64');
  buf[buf.length - 1] ^= 1;
  assert.throws(() => c.open(buf.toString('base64')));
  assert.throws(() => createCrypto(generateKey()).open(c.seal('hello')));
});

test('key must be 32 bytes as base64 or hex', () => {
  assert.throws(() => createCrypto(''), /not set/);
  assert.throws(() => createCrypto(undefined), /not set/);
  assert.throws(() => createCrypto(Buffer.alloc(16).toString('base64')), /wrong length/);
  assert.throws(() => createCrypto('zz'.repeat(32)), /wrong length/);
  const hex = createCrypto('ab'.repeat(32));
  assert.equal(hex.open(hex.seal('ok')), 'ok');
});
