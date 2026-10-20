// WinRM helper (src/deploy/winrm_helper.py) and its Node side (src/deploy/winrm.js).
// 1. Protocol tests run the real helper with a fake `winrm` package on PYTHONPATH, so no network is used.
// 2. A mock WinRM endpoint behaves like a domain controller: it offers only Negotiate (and Kerberos), answers
//    "Authorization: Negotiate <NTLM type 1>" with a type 2 challenge and gives a plain 401 to the NTLM scheme.
//    The real pywinrm test needs LABCTL_TEST_WINRM_PYTHON (a Python with server/src/deploy/winrm-requirements.txt).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const winrm = require('../src/deploy/winrm');
const windows = require('../src/deploy/windows');

const AGENT_DIR = path.join(__dirname, '..', '..', 'agent');
const PW = 'winrm-pw-throwaway';
const python = [process.env.LABCTL_TEST_PYTHON, 'python3', 'python'].filter(Boolean)
  .find(p => { const r = spawnSync(p, ['-c', 'import json'], { encoding: 'utf8', windowsHide: true }); return r.status === 0; });
const NO_PY = python ? false : 'needs python3 on PATH (or LABCTL_TEST_PYTHON)';

const FAKE = String.raw`
import base64, json, os, re, time
from winrm.exceptions import InvalidCredentialsError

class ReadTimeout(Exception):
    pass

class Protocol:
    def __init__(self, endpoint, transport, username, password, server_cert_validation, message_encryption, operation_timeout_sec, read_timeout_sec):
        self.args = dict(endpoint=endpoint, transport=transport, username=username, cert=server_cert_validation,
                         encryption=message_encryption, op=operation_timeout_sec, read=read_timeout_sec)
        self.password = password
        self.shells = 0
        self.out = {}
        self.polls = 0
    def open_shell(self):
        if self.password == 'wrong-password':
            raise InvalidCredentialsError('the specified credentials were rejected by the server')
        if self.password == 'slow-host':
            raise ReadTimeout('read timed out')
        if self.password == 'refuse':
            raise ConnectionRefusedError(111, 'Connection refused')
        self.shells += 1
        return 'SHELL-%d' % self.shells
    def run_command(self, shell, command):
        m = re.match(r'powershell\.exe -NoProfile -NonInteractive -EncodedCommand (\S+)$', command)
        script = base64.b64decode(m.group(1)).decode('utf-16-le')
        cid = 'C%d' % len(self.out)
        self.out[cid] = self.handle(script)
        return cid
    def handle(self, script):
        if script == 'whoami':
            return json.dumps(dict(self.args, shells=self.shells))
        if script == 'sleep':
            time.sleep(30)
        if script == 'fail':
            return ('', '#< CLIXML\n<Objs><S S="Error">Boom_x000D__x000A_</S></Objs>', 1)
        if script == 'raise':
            raise RuntimeError('pipe broke, password was ' + self.password)
        push = re.search(r"Join-Path \$d '([^']+)'\),'(Create|Append)'\);\$b=\[Convert\]::FromBase64String\('([^']*)'\)", script)
        if push:
            with open(os.path.join(os.environ['FAKE_WINRM_DIR'], push.group(1)), 'wb' if push.group(2) == 'Create' else 'ab') as f:
                f.write(base64.b64decode(push.group(3)))
            return ''
        if "'LINES='" in script:
            polls = json.loads(os.environ['FAKE_WINRM_POLLS'])
            self.polls += 1
            return polls[min(self.polls - 1, len(polls) - 1)]
        return 'ran: ' + script
    def get_command_output(self, shell, cid):
        r = self.out.pop(cid)
        so, se, rc = r if isinstance(r, tuple) else (r, '', 0)
        return so.encode(), se.encode(), rc
    def cleanup_command(self, shell, cid):
        pass
    def close_shell(self, shell):
        open(os.path.join(os.environ['FAKE_WINRM_DIR'], 'closed'), 'w').close()
`;

function fakeEnv(polls = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labctl-test-winrm-'));
  fs.mkdirSync(path.join(root, 'winrm'));
  fs.writeFileSync(path.join(root, 'winrm', '__init__.py'), '');
  fs.writeFileSync(path.join(root, 'winrm', 'exceptions.py'), 'class InvalidCredentialsError(Exception):\n    pass\n');
  fs.writeFileSync(path.join(root, 'winrm', 'protocol.py'), FAKE);
  const dir = path.join(root, 'remote');
  fs.mkdirSync(dir);
  const env = { ...process.env, PYTHONPATH: root, FAKE_WINRM_DIR: dir, FAKE_WINRM_POLLS: JSON.stringify(polls) };
  return { env, dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const target = (extra = {}) => ({ os: 'windows', address: '192.0.2.80', port: 5985, user: 'EXAMPLE\\tester', password: PW, ...extra });

test('winrm helper: user name as typed, ntlm with message encryption, one shell, encoded scripts, clean close', { skip: NO_PY }, async (t) => {
  const f = fakeEnv();
  t.after(f.cleanup);
  const s = await winrm.open(target(), { python, env: f.env });
  assert.equal(s.engine, 'pywinrm');
  const who = JSON.parse(await s.run('whoami'));
  assert.equal(who.username, 'EXAMPLE\\tester', 'passed exactly as typed');
  assert.equal(who.transport, 'ntlm');
  assert.equal(who.encryption, 'auto');
  assert.equal(who.cert, 'ignore');
  assert.equal(who.endpoint, 'http://192.0.2.80:5985/wsman');
  assert.ok(who.read > who.op && who.op >= 5, 'pywinrm needs read timeout > operation timeout');
  assert.equal(await s.run("'quote' \"double\" ünïcode"), "ran: 'quote' \"double\" ünïcode");
  assert.equal(JSON.parse(await s.run('whoami')).shells, 1, 'one shell for the whole session');
  assert.equal(await s.run('fail'), 'Boom', 'CLIXML error text is cleaned');
  await assert.rejects(s.run('raise'), err => !err.message.includes(PW) && /pipe broke/.test(err.message));
  await s.close();
  assert.ok(fs.existsSync(path.join(f.dir, 'closed')), 'remote shell closed on end of stdin');
  const https = await winrm.open(target({ port: 5986, user: 'tester@example.test' }), { python, env: f.env });
  const w2 = JSON.parse(await https.run('whoami'));
  assert.equal(w2.endpoint, 'https://192.0.2.80:5986/wsman');
  assert.equal(w2.username, 'tester@example.test');
  await https.close();
});

test('winrm helper: plain errors for bad credentials, timeouts and refused connections, never the password', { skip: NO_PY }, async (t) => {
  const f = fakeEnv();
  t.after(f.cleanup);
  const bad = await winrm.open(target({ password: 'wrong-password' }), { python, env: f.env }).catch(e => e);
  assert.match(bad.message, /^WinRM rejected the sign-in for EXAMPLE\\tester\. Use DOMAIN\\name for domain accounts, check the password, and the account must be a local administrator or a member of Remote Management Users\.$/);
  assert.ok(!bad.message.includes('wrong-password'));
  await assert.rejects(winrm.open(target({ password: 'slow-host' }), { python, env: f.env }), /^Error: Timed out talking to WinRM on 192\.0\.2\.80:5985\.$/);
  await assert.rejects(winrm.open(target({ password: 'refuse' }), { python, env: f.env }), /Could not connect to WinRM on 192\.0\.2\.80:5985\. Is WinRM enabled \(winrm quickconfig\)/);

  const s = await winrm.open(target(), { python, env: f.env, requestMs: 1500 });
  const started = Date.now();
  await assert.rejects(s.run('sleep'), /Timed out after 2 s waiting for WinRM on 192\.0\.2\.80:5985/);
  assert.ok(Date.now() - started < 10000, 'the overall timeout kills the helper');
  await assert.rejects(s.run('whoami'), /not running|stopped/);
  await s.close();
});

test('winrm: strict input checks before anything is spawned', async () => {
  await assert.rejects(winrm.open(target({ address: '-oProxyCommand=x' }), { python: 'labctl-no-such-python' }), /address/);
  await assert.rejects(winrm.open(target({ port: 0 }), { python: 'labctl-no-such-python' }), /port/);
  await assert.rejects(winrm.open(target({ user: 'a\nb' }), { python: 'labctl-no-such-python' }), /control characters/);
  await assert.rejects(winrm.open(target({ user: 'x'.repeat(101) }), { python: 'labctl-no-such-python' }), /1 to 100/);
  await assert.rejects(winrm.open(target({ password: '' }), { python: 'labctl-no-such-python' }), /password is required/);
});

test('winrm: falls back to the built-in client when the helper cannot run, and says pywinrm is missing', async () => {
  const net = require('net');
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  const port = srv.address().port;
  srv.close();
  const err = await winrm.open(target({ address: '127.0.0.1', port }), { python: 'labctl-no-such-python' }).catch(e => e);
  assert.match(err.message, /pywinrm is not installed \(labctl-no-such-python: ENOENT\)/);
  assert.ok(!err.message.includes(PW));
});

test('windows install over the helper: chunked file push, live log lines, exit code', { skip: NO_PY }, async (t) => {
  const f = fakeEnv(['LINES=0', 'LINES=2\nStep one\nStep two', 'LINES=3\nAgent installed\nEXITCODE=0']);
  t.after(f.cleanup);
  const logs = [];
  const h = { id: 'abc123', mode: 'install', server: 'https://labctl.example.test', token: 'TOKEN-VALUE-0123456789', phase: () => {}, log: l => logs.push(l),
    out: c => logs.push(...c.split('\n').filter(Boolean)), lastLine: () => logs.at(-1), file: name => fs.readFileSync(path.join(AGENT_DIR, name)) };
  const res = await windows.install(target(), h, { pollMs: 1, open: tt => winrm.open(tt, { python, env: f.env }).then(s => ({ ...s, chunk: 1800, transport: 'winrm' })) });
  assert.equal(res.transport, 'winrm');
  for (const name of ['labctl-agent.py', 'setup-windows.ps1']) {
    assert.ok(fs.readFileSync(path.join(f.dir, name)).equals(fs.readFileSync(path.join(AGENT_DIR, name))), `${name} arrives intact`);
  }
  assert.ok(fs.readFileSync(path.join(AGENT_DIR, 'labctl-agent.py')).length > 1800 * 3, 'the agent needs several chunks');
  assert.match(fs.readFileSync(path.join(f.dir, 'run.ps1'), 'utf8'), /-ServerUrl 'https:\/\/labctl\.example\.test' -Token 'TOKEN-VALUE-0123456789'/);
  assert.deepEqual(logs.filter(l => /Step|Agent installed/.test(l)), ['Step one', 'Step two', 'Agent installed']);
  assert.ok(fs.existsSync(path.join(f.dir, 'closed')));
});

// ── a mock WinRM endpoint that behaves like a domain controller ─────────────

function type2(clientFlags) {
  const u = s => Buffer.from(s, 'utf16le');
  const av = (id, buf) => { const h = Buffer.alloc(4); h.writeUInt16LE(id, 0); h.writeUInt16LE(buf.length, 2); return Buffer.concat([h, buf]); };
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64LE((BigInt(Date.now()) + 11644473600000n) * 10000n);
  const name = u('EXAMPLE');
  const info = Buffer.concat([av(2, name), av(1, u('DC01')), av(4, u('example.test')), av(3, u('dc01.example.test')), av(7, ts), av(0, Buffer.alloc(0))]);
  const head = Buffer.alloc(56);
  head.write('NTLMSSP\0', 0, 'latin1');
  head.writeUInt32LE(2, 8);
  head.writeUInt16LE(name.length, 12); head.writeUInt16LE(name.length, 14); head.writeUInt32LE(56, 16);
  head.writeUInt32LE((clientFlags | 0x00800000 | 0x00010000) >>> 0, 20); // + TARGET_INFO, TARGET_TYPE_DOMAIN
  crypto.randomBytes(8).copy(head, 24);
  head.writeUInt16LE(info.length, 40); head.writeUInt16LE(info.length, 42); head.writeUInt32LE(56 + name.length, 44);
  Buffer.from([10, 0, 0x63, 0x45, 0, 0, 0, 15]).copy(head, 48);
  return Buffer.concat([head, name, info]);
}

function mockDc() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let size = 0;
    req.on('data', c => { size += c.length; });
    req.on('end', () => {
      const [scheme, tok] = String(req.headers.authorization || '').split(' ');
      const msg = tok ? Buffer.from(tok, 'base64') : Buffer.alloc(0);
      const type = msg.subarray(0, 8).toString('latin1') === 'NTLMSSP\0' ? msg.readUInt32LE(8) : 0;
      seen.push(`${scheme || 'none'}:${type}`);
      if (size && /soap\+xml/.test(req.headers['content-type'] || '')) seen.push('plain-soap');
      if (scheme === 'Negotiate' && type === 1) {
        res.writeHead(401, { 'WWW-Authenticate': `Negotiate ${type2(msg.readUInt32LE(12)).toString('base64')}`, 'Content-Length': 0 });
      } else if (!scheme) {
        res.writeHead(401, [['WWW-Authenticate', 'Negotiate'], ['WWW-Authenticate', 'Kerberos'], ['Content-Length', '0']]);
      } else {
        res.writeHead(401, { 'Content-Length': 0 }); // the NTLM scheme and a wrong type 3 get a plain 401, no challenge
      }
      res.end();
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen, close: () => server.close() })));
}

// Measured: winrm-client answers Negotiate, but it puts the SOAP body on the wire in plain text. A Windows host with
// AllowUnencrypted=false (the default) refuses that over HTTP 5985 whatever the password. This is why pywinrm is the default.
test('mock domain controller: the built-in client sends plain SOAP over HTTP', async (t) => {
  const dc = await mockDc();
  t.after(dc.close);
  const err = await winrm.open(target({ address: '127.0.0.1', port: dc.port }), { lib: require('winrm-client') }).catch(e => e);
  assert.ok(err instanceof Error);
  assert.ok(dc.seen.includes('plain-soap'), dc.seen.join(','));
});

const REAL = process.env.LABCTL_TEST_WINRM_PYTHON;
test('real pywinrm against the mock domain controller: Negotiate scheme, type 2 challenge, plain sign-in error', { skip: REAL ? false : 'set LABCTL_TEST_WINRM_PYTHON to a Python with winrm-requirements.txt' }, async (t) => {
  const dc = await mockDc();
  t.after(dc.close);
  const err = await winrm.open(target({ address: '127.0.0.1', port: dc.port }), { python: REAL }).catch(e => e);
  assert.match(err.message, /^WinRM rejected the sign-in for EXAMPLE\\tester\. Use DOMAIN\\name/);
  assert.ok(!err.message.includes(PW));
  assert.ok(dc.seen.includes('Negotiate:1'), `type 1 under the Negotiate scheme: ${dc.seen.join(',')}`);
  assert.ok(dc.seen.includes('Negotiate:3'), `the type 2 challenge was answered: ${dc.seen.join(',')}`);
  assert.ok(!dc.seen.some(s => s.startsWith('NTLM')), 'never the NTLM scheme');
  assert.ok(!dc.seen.includes('plain-soap'), 'no SOAP in plain text before the encrypted session exists');
  dc.close();
  await assert.rejects(winrm.open(target({ address: '127.0.0.1', port: dc.port }), { python: REAL }), /Could not connect to WinRM on 127\.0\.0\.1:\d+/);
});
