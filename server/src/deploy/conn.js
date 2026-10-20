// ssh2 helpers for the deploy wizard: TCP probe, connect with plain-language errors and a recorded host key, exec, SFTP upload.
const net = require('net');
const { Client } = require('ssh2');
const { fingerprint } = require('../ssh');

function explain(err, t) {
  const m = String(err.message || err);
  const where = `${t.address}:${t.port}`;
  if (/authentication methods failed|Permission denied/i.test(m)) return `Authentication failed for ${t.user} on ${t.address}. Check the user name and the password or key.`;
  if (/passphrase/i.test(m)) return 'The private key needs a passphrase, or the passphrase is wrong.';
  if (/Cannot parse privateKey|Unsupported key format|no start line/i.test(m)) return 'The private key could not be read. Paste the whole key including the BEGIN and END lines.';
  if (err.code === 'ECONNREFUSED') return `Connection refused on ${where}. Is the SSH service running?`;
  if (err.code === 'ENOTFOUND') return `Cannot resolve ${t.address}.`;
  if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') return `No route to ${t.address}. Use a relay host or check the network.`;
  if (err.code === 'ETIMEDOUT' || /Timed out/i.test(m)) return `Timed out connecting to ${where}.`;
  return m;
}

// Resolves true when a TCP connection opens within ms.
const tcpOpen = (host, port, ms = 5000) => new Promise(resolve => {
  const s = net.connect({ host, port });
  const done = ok => { s.destroy(); resolve(ok); };
  s.setTimeout(ms, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});

// Resolves { client, hostKey }. t.hostKey (a SHA256: fingerprint) is compared when set: a mismatch refuses the connection.
function connect(t, { readyTimeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let seen = null;
    let mismatch = false;
    client.on('error', err => reject(new Error(mismatch
      ? `Host key mismatch for ${t.address}: expected ${t.hostKey}, got ${seen}. Refusing to continue.` : explain(err, t))));
    client.on('ready', () => resolve({ client, hostKey: seen }));
    client.connect({
      host: t.address, port: t.port, username: t.user, password: t.password || undefined,
      privateKey: t.private_key || undefined, passphrase: t.passphrase || undefined,
      readyTimeout, hostHash: 'sha256',
      hostVerifier: hash => { seen = fingerprint(hash); mismatch = !!t.hostKey && t.hostKey !== seen; return !mismatch; }
    });
  });
}

// Runs a command, streams output through onOut(text, stream), resolves with the exit code. stdin is written, then closed.
function exec(client, command, { stdin = '', onOut = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      stream.setEncoding('utf8');
      stream.stderr.setEncoding('utf8');
      stream.on('data', d => onOut(d, 'stdout'));
      stream.stderr.on('data', d => onOut(d, 'stderr'));
      stream.on('close', code => resolve(code));
      stream.end(stdin);
    });
  });
}

// Uploads files [{ name, content, mode }] into dir (created with mode 0700) over SFTP.
async function put(client, dir, files) {
  const sftp = await new Promise((resolve, reject) => client.sftp((e, s) => (e ? reject(new Error(`SFTP is not available on the target: ${e.message}`)) : resolve(s))));
  const call = (fn, ...args) => new Promise((resolve, reject) => sftp[fn](...args, e => (e ? reject(new Error(`SFTP ${fn} failed: ${e.message}`)) : resolve())));
  try {
    await call('mkdir', dir, { mode: 0o700 });
    for (const f of files) await call('writeFile', `${dir}/${f.name}`, f.content, { mode: f.mode || 0o600 });
  } finally { sftp.end(); }
}

module.exports = { tcpOpen, connect, exec, put, explain };
