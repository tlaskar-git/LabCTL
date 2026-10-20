// AES-256-GCM sealing for secrets at rest. Blob format: base64(iv[12] | tag[16] | ciphertext).
const nodeCrypto = require('crypto');

const KEY_HELP = 'LABCTL_MASTER_KEY must be 32 bytes, given as base64 or 64 hex characters. Generate one with: npm run genkey';

function parseKey(raw) {
  if (!raw || !String(raw).trim()) throw new Error(`LABCTL_MASTER_KEY is not set. ${KEY_HELP}`);
  const value = String(raw).trim();
  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) key = Buffer.from(value, 'hex');
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) key = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (!key || key.length !== 32) throw new Error(`LABCTL_MASTER_KEY has the wrong length or format. ${KEY_HELP}`);
  return key;
}

function createCrypto(raw = process.env.LABCTL_MASTER_KEY) {
  const key = parseKey(raw);
  return {
    seal(plain) {
      const iv = nodeCrypto.randomBytes(12);
      const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
    },
    open(blob) {
      const buf = Buffer.from(String(blob), 'base64');
      if (buf.length < 28) throw new Error('Sealed value is too short');
      const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    },
    sealJson(obj) { return this.seal(JSON.stringify(obj)); },
    openJson(blob) { return JSON.parse(this.open(blob)); },
    sha256,
    randomToken
  };
}

function sha256(value) { return nodeCrypto.createHash('sha256').update(String(value)).digest('hex'); }
function randomToken(bytes = 32) { return nodeCrypto.randomBytes(bytes).toString('base64url'); }
function generateKey() { return nodeCrypto.randomBytes(32).toString('base64'); }

module.exports = { createCrypto, parseKey, generateKey, sha256, randomToken };

// npm run genkey: print a fresh key to stdout only.
if (require.main === module) process.stdout.write(generateKey() + '\n');
