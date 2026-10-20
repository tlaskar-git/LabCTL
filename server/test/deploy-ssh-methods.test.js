// SSH sign-in against hosts that allow only some methods: a Mac with password login off (publickey only),
// and a host that allows only keyboard-interactive. The failure text must say what the host accepts.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Server } = require('ssh2');
const conn = require('../src/deploy/conn');

const hostKey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' });
function start(onAuth) {
  const server = new Server({ hostKeys: [hostKey()] }, client => {
    client.on('authentication', onAuth);
    client.on('error', () => {});
    client.on('ready', () => {});
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}
const target = (port, extra = {}) => ({ address: '127.0.0.1', port, user: 'tester', password: 'pw', ...extra });

test('publickey-only host: the error says password sign-in is not allowed and what to do', async (t) => {
  const { server, port } = await start(ctx => ctx.reject(['publickey']));
  t.after(() => server.close());
  await assert.rejects(conn.connect(target(port)), /does not allow password sign-in \(it accepts: publickey\)[\s\S]*authorized_keys/);
});

test('keyboard-interactive-only host: the password is answered at the prompt', async (t) => {
  const { server, port } = await start(ctx => {
    if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive']);
    return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => (answers[0] === 'pw' ? ctx.accept() : ctx.reject(['keyboard-interactive'])));
  });
  t.after(() => server.close());
  const { client } = await conn.connect(target(port));
  client.end();
});

test('wrong password on a password host keeps the plain message and lists what the host accepts', async (t) => {
  const { server, port } = await start(ctx => (ctx.method === 'password' && ctx.password === 'right' ? ctx.accept() : ctx.reject(['password'])));
  t.after(() => server.close());
  await assert.rejects(conn.connect(target(port)), /Authentication failed for tester on 127\.0\.0\.1 \(the host accepts: password\)/);
});
