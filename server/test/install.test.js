const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { startApp } = require('./helpers');

const AGENT_DIR = path.join(__dirname, '..', '..', 'agent');
const FILES = ['linux.sh', 'mac.sh', 'windows.ps1', 'agent.py'];

// Plain http.request so a test can send any Host header.
function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const count = (text, needle) => text.split(needle).length - 1;

test('install endpoints', async t => {
  const app = await startApp();
  t.after(() => app.stop());
  const live = app.ctx.tokens.create('install test', 'tester');
  const revoked = app.ctx.tokens.create('revoked', 'tester');
  app.ctx.tokens.revoke(revoked.id);
  const base = `http://127.0.0.1:${app.port}`;

  await t.test('401 without a valid token, with no body', async () => {
    for (const f of FILES) {
      for (const q of ['', '?token=', '?token=not-a-real-token-value-123456', `?token=${revoked.value}`, `?token=${live.value}'x`]) {
        const r = await get(app.port, `/install/${f}${q}`);
        assert.equal(r.status, 401, `${f}${q}`);
        assert.equal(r.body, '');
      }
      const bad = await get(app.port, `/install/${f}`, { authorization: `Bearer ${revoked.value}` });
      assert.equal(bad.status, 401);
    }
  });

  await t.test('renders the server URL and the token into quoted default lines only', async () => {
    const sh = [['linux.sh', `DEFAULT_SERVER='${base}'`, `DEFAULT_TOKEN='${live.value}'`],
      ['mac.sh', `DEFAULT_SERVER='${base}'`, `DEFAULT_TOKEN='${live.value}'`],
      ['windows.ps1', `$DefaultServer = '${base}'`, `$DefaultToken = '${live.value}'`]];
    for (const [f, server, token] of sh) {
      const r = await get(app.port, `/install/${f}?token=${live.value}`);
      assert.equal(r.status, 200, f);
      assert.match(r.headers['cache-control'], /no-store/);
      assert.equal(count(r.body, live.value), 1, `${f}: token appears once`);
      assert.equal(count(r.body, base), 1, `${f}: server URL appears once`);
      assert.ok(r.body.split('\n').includes(server), `${f}: server line`);
      assert.ok(r.body.split('\n').includes(token), `${f}: token line`);
    }
  });

  await t.test('Authorization: Bearer works like ?token=', async () => {
    const r = await get(app.port, '/install/linux.sh', { authorization: `Bearer ${live.value}` });
    assert.equal(r.status, 200);
    assert.ok(r.body.includes(`DEFAULT_TOKEN='${live.value}'`));
  });

  await t.test('agent.py is the agent file', async () => {
    const r = await get(app.port, `/install/agent.py?token=${live.value}`);
    assert.equal(r.status, 200);
    assert.equal(r.body, fs.readFileSync(path.join(AGENT_DIR, 'labctl-agent.py'), 'utf8'));
  });

  await t.test('an unknown script is not served', async () => {
    const r = await get(app.port, `/install/other.sh?token=${live.value}`);
    assert.notEqual(r.status, 200);
    assert.ok(!r.body.includes(live.value));
  });

  await t.test('injection through the Host header is rejected', async () => {
    for (const host of ["evil.test'; touch /tmp/x; echo '", 'evil.test$(id)', 'a b', 'evil.test"', 'x`id`', "e.test'\"; $x"]) {
      const r = await get(app.port, `/install/linux.sh?token=${live.value}`, { host });
      assert.equal(r.status, 400, host);
      assert.ok(!r.body.includes(live.value));
    }
  });

  await t.test('a valid public_url setting wins, an invalid one is ignored', async () => {
    app.ctx.settings.set('public_url', 'https://labctl.example.test');
    let r = await get(app.port, `/install/linux.sh?token=${live.value}`);
    assert.ok(r.body.includes("DEFAULT_SERVER='https://labctl.example.test'"));
    app.ctx.settings.set('public_url', "https://x.test'; id; '");
    r = await get(app.port, `/install/linux.sh?token=${live.value}`);
    assert.ok(r.body.includes(`DEFAULT_SERVER='${base}'`));
    app.ctx.settings.set('public_url', null);
  });

  await t.test('the token is never stored in the audit log', async () => {
    const rows = app.ctx.db.prepare('SELECT * FROM audit_log').all();
    assert.ok(rows.some(r => r.action === 'install.fetch'), 'fetches are audited');
    for (const r of rows) assert.ok(!JSON.stringify(r).includes(live.value), `audit row ${r.id}`);
  });
});

test('install endpoints are rate limited', async t => {
  const app = await startApp();
  t.after(() => app.stop());
  let last = 0;
  for (let i = 0; i < 70; i++) last = (await get(app.port, '/install/linux.sh?token=nope')).status;
  assert.equal(last, 429);
});

test('setup scripts are ASCII only and the scripts carry the render markers', () => {
  for (const f of ['setup-linux.sh', 'setup-mac.sh', 'setup-windows.ps1']) {
    const text = fs.readFileSync(path.join(AGENT_DIR, f), 'utf8');
    // eslint-disable-next-line no-control-regex
    assert.ok(/^[\x00-\x7F]*$/.test(text), `${f} must be ASCII`);
    const marker = f.endsWith('.ps1') ? [/^\$DefaultServer = ''$/m, /^\$DefaultToken = ''$/m] : [/^DEFAULT_SERVER=''$/m, /^DEFAULT_TOKEN=''$/m];
    for (const m of marker) assert.equal(text.split('\n').filter(l => m.test(l)).length, 1, `${f} ${m}`);
  }
});
