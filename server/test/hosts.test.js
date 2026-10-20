// Hosts: filters, tags and groups, removal modes, blocklist, bulk confirm, agentless ssh hosts (local ssh2 test server).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Server } = require('ssh2');
const { startApp, login, api, wsOpen, waitFor, sshHostKey } = require('./helpers');
const ops = require('../src/hostops');

const PW = 'pw-test-only'; // password of the local test ssh server, a throwaway value

async function setup(t) {
  const s = await startApp();
  t.after(() => s.stop());
  const admin = api(s.base, await login(s.base));
  await admin('POST', '/api/users', { username: 'op1', password: 'pw-op', role: 'operator' });
  const op = api(s.base, await login(s.base, 'op1', 'pw-op'));
  const tok = await admin('POST', '/api/tokens', { label: 'hosts-test' });
  return { s, admin, op, token: tok.data.value };
}

const register = (ws, id, name, extra = {}) => ws.send(JSON.stringify({ type: 'register', host_id: id, hostname: name,
  os: 'linux', kind: 'agent', agent_version: '2.0.0', info: {}, ...extra }));
const closed = ws => new Promise(resolve => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
// Closes a client socket and waits, so the server's close handler runs before the database closes.
const shut = async ws => { const c = closed(ws); ws.close(); await c; await new Promise(r => setTimeout(r, 50)); };

test('GET /api/hosts filters, PATCH tags, groups, VPS fields and kind that survives re-register', async (t) => {
  const { s, admin, token } = await setup(t);
  const ws = await wsOpen(s.port, token);
  register(ws, 'h-new', 'alpha.example.test', { agent_version: '2.0.1', os: 'linux' });
  await waitFor(() => s.ctx.db.prepare("SELECT 1 FROM hosts WHERE id = 'h-new'").get());
  s.ctx.db.prepare("INSERT INTO hosts (id, hostname, os, ip, kind, status, agent_version) VALUES ('h-old', 'beta.example.test', 'windows', '192.0.2.10', 'agent', 'offline', '2.0.0')").run();

  const group = (await admin('POST', '/api/groups', { name: 'Lab' })).data;
  const p = await admin('PATCH', '/api/hosts/h-old', { tags: ['edge', 'dns'], groups: [group.id], notes: 'rack 2',
    provider: 'ExampleCloud', region: 'eu-west', plan: 'small', runner_folders: ['/srv/runner-a'] });
  assert.equal(p.status, 200);
  assert.deepEqual(p.data.tags.map(x => x.name), ['dns', 'edge']);
  assert.equal(p.data.groups[0].id, group.id);
  assert.equal(p.data.group_id, group.id);
  assert.equal(p.data.provider, 'ExampleCloud');
  assert.deepEqual(p.data.runner_folders, ['/srv/runner-a']);
  assert.equal((await admin('PATCH', '/api/hosts/h-old', { add_tags: ['extra'] })).data.tags.length, 3);
  assert.equal((await admin('PATCH', '/api/hosts/h-old', { runner_folders: 'nope' })).status, 400);
  assert.equal((await admin('PATCH', '/api/hosts/h-old', { tags: [1] })).status, 400);
  assert.equal((await admin('PATCH', '/api/hosts/h-old', { kind: 'ssh' })).status, 400);

  const list = async q => (await admin('GET', `/api/hosts${q}`)).data.map(h => h.id).sort();
  assert.deepEqual(await list(''), ['h-new', 'h-old']);
  assert.deepEqual(await list('?os=windows'), ['h-old']);
  assert.deepEqual(await list('?status=online'), ['h-new']);
  assert.deepEqual(await list('?status=offline'), ['h-old']);
  assert.deepEqual(await list(`?group=${group.id}`), ['h-old']);
  assert.deepEqual(await list('?tag=EDGE'), ['h-old']);
  assert.deepEqual(await list('?kind=agent'), ['h-new', 'h-old']);
  assert.deepEqual(await list('?q=exampleCloud'), ['h-old']);
  assert.deepEqual(await list('?q=192.0.2.10'), ['h-old']);
  assert.deepEqual(await list('?outdated_agent=true'), ['h-old']);
  assert.deepEqual(await list('?outdated_agent=false'), ['h-new']);
  const row = (await admin('GET', '/api/hosts')).data.find(h => h.id === 'h-old');
  assert.equal(row.agent_version, '2.0.0');
  assert.equal(row.latest_agent_version, '2.0.1');
  assert.ok(ops.compareVersions('2.0.10', '2.0.9') > 0);

  // An operator-set kind survives the agent registering again as kind "agent".
  assert.equal((await admin('PATCH', '/api/hosts/h-new', { kind: 'vps' })).data.kind, 'vps');
  register(ws, 'h-new', 'alpha.example.test');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(s.ctx.db.prepare("SELECT kind FROM hosts WHERE id = 'h-new'").get().kind, 'vps');

  const tags = (await admin('GET', '/api/tags')).data;
  assert.ok(tags.find(x => x.name === 'edge').hosts === 1);
  assert.equal((await admin('DELETE', `/api/tags/${tags[0].id}`)).status, 200);
  await shut(ws);
});

test('remove: admin only, typed confirm, blocklist, closed socket, reconnect refused (4403), unblock re-registers', async (t) => {
  const { s, admin, op, token } = await setup(t);
  const ws = await wsOpen(s.port, token);
  register(ws, 'h-r1', 'gamma.example.test');
  await waitFor(() => s.ctx.db.prepare("SELECT 1 FROM hosts WHERE id = 'h-r1'").get());

  assert.equal((await op('DELETE', '/api/hosts/h-r1', { mode: 'remove', confirm: 'gamma.example.test' })).status, 403);
  assert.equal((await admin('DELETE', '/api/hosts/h-r1', { mode: 'remove', confirm: 'wrong' })).status, 400);
  assert.equal((await admin('DELETE', '/api/hosts/h-r1', { mode: 'bogus', confirm: 'gamma.example.test' })).status, 400);
  const gone = closed(ws);
  const r = await admin('DELETE', '/api/hosts/h-r1', { mode: 'remove', confirm: 'gamma.example.test' });
  assert.equal(r.status, 200);
  assert.deepEqual(await gone, { code: 4403, reason: 'blocked' });
  assert.equal(s.ctx.db.prepare("SELECT 1 FROM hosts WHERE id = 'h-r1'").get(), undefined);

  const blocked = (await admin('GET', '/api/blocklist')).data;
  assert.equal(blocked[0].host_id, 'h-r1');
  assert.equal(blocked[0].hostname, 'gamma.example.test');
  assert.equal((await op('GET', '/api/blocklist')).status, 403);

  // The same agent reconnects and is refused.
  const ws2 = await wsOpen(s.port, token);
  const refused = closed(ws2);
  register(ws2, 'h-r1', 'gamma.example.test');
  assert.deepEqual(await refused, { code: 4403, reason: 'blocked' });
  assert.equal(s.ctx.db.prepare("SELECT 1 FROM hosts WHERE id = 'h-r1'").get(), undefined);

  assert.equal((await op('DELETE', '/api/blocklist/h-r1')).status, 403);
  assert.equal((await admin('DELETE', '/api/blocklist/h-r1')).status, 200);
  assert.equal((await admin('DELETE', '/api/blocklist/h-r1')).status, 404);
  const ws3 = await wsOpen(s.port, token);
  register(ws3, 'h-r1', 'gamma.example.test');
  await waitFor(() => s.ctx.db.prepare("SELECT 1 FROM hosts WHERE id = 'h-r1'").get());
  await shut(ws3);

  const audit = (await admin('GET', '/api/audit?action=host.')).data.rows.map(x => x.action);
  assert.ok(audit.includes('host.remove') && audit.includes('host.unblock'));
});

test('remove with uninstall: agent gets the uninstall frame, agent_gone is awaited, a silent agent times out', async (t) => {
  const { s, admin, token } = await setup(t);
  ops.config.uninstallWaitMs = 300;
  t.after(() => { ops.config.uninstallWaitMs = 30000; });

  const ws = await wsOpen(s.port, token);
  register(ws, 'h-u1', 'delta.example.test');
  await waitFor(() => s.ctx.db.prepare("SELECT 1 FROM hosts WHERE id = 'h-u1'").get());
  ws.on('message', d => { if (JSON.parse(d.toString()).type === 'uninstall') ws.send(JSON.stringify({ type: 'agent_gone', host_id: 'h-u1' })); });
  const a = await admin('DELETE', '/api/hosts/h-u1', { mode: 'uninstall_and_remove', confirm: 'delta.example.test' });
  assert.equal(a.data.uninstall, 'confirmed');
  assert.ok(s.ctx.db.prepare("SELECT 1 FROM blocklist WHERE host_id = 'h-u1'").get());

  const ws2 = await wsOpen(s.port, token);
  register(ws2, 'h-u2', 'epsilon.example.test');
  await waitFor(() => s.ctx.db.prepare("SELECT 1 FROM hosts WHERE id = 'h-u2'").get());
  const b = await admin('DELETE', '/api/hosts/h-u2', { mode: 'uninstall_and_remove', confirm: 'epsilon.example.test' });
  assert.equal(b.data.uninstall, 'timeout');
  assert.equal(s.ctx.db.prepare("SELECT 1 FROM hosts WHERE id = 'h-u2'").get(), undefined);

  s.ctx.db.prepare("INSERT INTO hosts (id, hostname, kind, status) VALUES ('h-u3', 'zeta.example.test', 'agent', 'offline')").run();
  const c = await admin('DELETE', '/api/hosts/h-u3', { mode: 'uninstall_and_remove', confirm: 'zeta.example.test' });
  assert.equal(c.data.uninstall, 'agent_offline');
});

test('bulk remove needs the text REMOVE n HOSTS', async (t) => {
  const { s, admin, op } = await setup(t);
  for (const id of ['b1', 'b2']) s.ctx.db.prepare('INSERT INTO hosts (id, hostname, kind, status) VALUES (?, ?, ?, ?)').run(id, `${id}.example.test`, 'agent', 'offline');
  const body = (confirm, ids = ['b1', 'b2', 'nope']) => ({ host_ids: ids, mode: 'remove', confirm });
  assert.equal((await admin('POST', '/api/hosts/bulk-remove', body('REMOVE 2 HOSTS'))).status, 400);
  assert.equal((await admin('POST', '/api/hosts/bulk-remove', body('remove 3 hosts'))).status, 400);
  assert.equal((await op('POST', '/api/hosts/bulk-remove', body('REMOVE 3 HOSTS'))).status, 403);
  assert.equal((await admin('POST', '/api/hosts/bulk-remove', { host_ids: 'b1', confirm: 'REMOVE 0 HOSTS' })).status, 400);
  const r = await admin('POST', '/api/hosts/bulk-remove', body('REMOVE 3 HOSTS'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.results.map(x => x.ok), [true, true, false]);
  assert.equal(s.ctx.db.prepare('SELECT COUNT(*) AS n FROM hosts').get().n, 0);
  assert.equal(s.ctx.db.prepare('SELECT COUNT(*) AS n FROM blocklist').get().n, 2);
});

// ── ssh hosts against a local ssh2 server ─────────────────────────────────
function startSshServer() {
  const seen = { closedChannels: 0, commands: [] };
  const hostKey = sshHostKey();
  const server = new Server({ hostKeys: [hostKey] }, client => {
    client.on('authentication', c => (c.method === 'password' && c.username === 'tester' && c.password === PW ? c.accept() : c.reject(['password'])));
    client.on('error', () => {});
    client.on('ready', () => client.on('session', accept => accept().on('exec', (acceptExec, _reject, info) => {
      const stream = acceptExec();
      seen.commands.push(info.command);
      let script = '';
      stream.on('data', d => { script += d; });
      stream.on('close', () => { seen.closedChannels++; });
      stream.on('end', () => {
        if (info.command.includes('uptime=')) {
          stream.write('uptime=3600\nload=0.10 0.20 0.30\nmem_total=1000\nmem_avail=400\ndisk_total_kb=1048576\ndisk_used_kb=524288\n');
          return stream.exit(0), stream.end();
        }
        if (script.includes('sleep 60')) return stream.write('started\n'); // stays open until the client closes it
        stream.write(script.includes('exit 3') ? 'before\n' : 'hi\n');
        stream.stderr.write('warn\n');
        stream.exit(script.includes('exit 3') ? 3 : 0);
        stream.end();
      });
    })));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

test('ssh host: create with inline credential, poll state, job output, exit codes, cancel', async (t) => {
  const { s, admin } = await setup(t);
  const srv = await startSshServer();
  t.after(() => srv.server.close());

  const created = await admin('POST', '/api/hosts', { kind: 'ssh', name: 'vps-a.example.test', address: '127.0.0.1', port: srv.port,
    os: 'linux', credential: { username: 'tester', password: PW }, provider: 'ExampleCloud', plan: 'tiny' });
  assert.equal(created.status, 200);
  assert.equal(created.data.connect_error, null);
  assert.equal(created.data.kind, 'ssh');
  assert.equal(created.data.status, 'online');
  assert.equal(created.data.online, true);
  assert.equal(created.data.provider, 'ExampleCloud');
  assert.match(created.data.ssh.host_key, /^SHA256:/);
  assert.equal(created.data.ssh.saved_credential, false);
  assert.equal(s.ctx.db.prepare('SELECT COUNT(*) AS n FROM credentials').get().n, 0);
  assert.equal(created.data.heartbeat.ram, 60);
  assert.equal(created.data.system_info.drives[0].percent, 50);
  assert.ok(s.ctx.agents.isOnline(created.data.id));
  const id = created.data.id;

  const ok = s.ctx.jobs.create({ host_id: id, type: 'custom_command', script: 'echo hi', shell: 'bash', params: { env: { LABCTL_P_X: "a'b" } } });
  await waitFor(() => s.ctx.jobs.get(ok.id).status === 'completed');
  assert.equal(s.ctx.jobs.get(ok.id).exit_code, 0);
  const log = s.ctx.joblog.read(ok.id);
  assert.match(log, /hi/);
  assert.match(log, /warn/);
  assert.ok(srv.seen.commands.includes('bash -s'));

  const bad = s.ctx.jobs.create({ host_id: id, type: 'custom_command', script: 'exit 3', shell: 'bash' });
  await waitFor(() => s.ctx.jobs.get(bad.id).status === 'failed');
  assert.equal(s.ctx.jobs.get(bad.id).exit_code, 3);

  const noScript = s.ctx.jobs.create({ host_id: id, type: 'reboot' });
  await waitFor(() => s.ctx.jobs.get(noScript.id).status === 'failed');

  const events = [];
  s.ctx.events.on('job_output', e => events.push(e));
  const slow = s.ctx.jobs.create({ host_id: id, type: 'custom_command', script: 'sleep 60', shell: 'bash' });
  await waitFor(() => s.ctx.jobs.get(slow.id).status === 'running' && events.some(e => e.job_id === slow.id && e.chunk.includes('started')));
  const before = srv.seen.closedChannels;
  s.ctx.jobs.cancel(slow.id);
  await waitFor(() => srv.seen.closedChannels > before);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(s.ctx.jobs.get(slow.id).status, 'cancelled');

  // Removing the host: no blocklist row for an agentless host, no sockets involved.
  const rm = await admin('DELETE', `/api/hosts/${id}`, { mode: 'remove', confirm: 'vps-a.example.test' });
  assert.equal(rm.status, 200);
  assert.equal(s.ctx.db.prepare('SELECT COUNT(*) AS n FROM blocklist').get().n, 0);
});

test('ssh host: TOFU rejects a changed host key until an admin resets it; saved credential is sealed and never leaks', async (t) => {
  const { s, admin, op } = await setup(t);
  const one = await startSshServer();
  const two = await startSshServer();
  t.after(() => { one.server.close(); two.server.close(); });

  assert.equal((await op('POST', '/api/hosts', { kind: 'ssh', name: 'x', address: '127.0.0.1', port: one.port,
    credential: { username: 'tester', password: PW }, save_credential: true })).status, 403);
  assert.equal((await admin('POST', '/api/hosts', { kind: 'ssh', name: 'x', address: 'bad host!', credential: { password: 'x' } })).status, 400);
  assert.equal((await admin('POST', '/api/hosts', { kind: 'agent', name: 'x' })).status, 400);

  const created = await admin('POST', '/api/hosts', { kind: 'ssh', name: 'vps-b.example.test', address: '127.0.0.1', port: one.port,
    credential: { username: 'tester', password: PW }, save_credential: true });
  assert.equal(created.data.connect_error, null);
  assert.equal(created.data.ssh.saved_credential, true);
  const id = created.data.id;
  const key1 = created.data.ssh.host_key;
  const row = s.ctx.db.prepare('SELECT * FROM credentials WHERE host_id = ?').get(id);
  assert.ok(!row.sealed.includes(PW));
  assert.equal(s.ctx.crypto.openJson(row.sealed).password, PW);
  assert.ok(!JSON.stringify((await admin('GET', '/api/credentials')).data).includes(PW));
  assert.ok(!JSON.stringify((await admin('GET', '/api/hosts')).data).includes(PW));

  // Same host, different key (second server): refused.
  await admin('PATCH', `/api/hosts/${id}`, { ssh: { port: two.port } });
  const bad = await s.ctx.ssh.poll(s.ctx.db.prepare('SELECT * FROM hosts WHERE id = ?').get(id));
  assert.deepEqual(bad, { ok: false, error: 'Host key mismatch' });
  let h = (await admin('GET', '/api/hosts')).data[0];
  assert.equal(h.status, 'offline');
  assert.equal(h.ssh.host_key, key1);
  assert.equal(h.ssh.error, 'Host key mismatch');
  const job = s.ctx.jobs.create({ host_id: id, type: 'custom_command', script: 'echo hi', shell: 'bash' });
  await waitFor(() => s.ctx.jobs.get(job.id).status === 'failed');
  assert.equal(s.ctx.jobs.get(job.id).error, 'Host key mismatch');

  assert.equal((await op('PATCH', `/api/hosts/${id}`, { ssh: { reset_host_key: true } })).status, 403);
  await admin('PATCH', `/api/hosts/${id}`, { ssh: { reset_host_key: true } });
  assert.deepEqual(await s.ctx.ssh.poll(s.ctx.db.prepare('SELECT * FROM hosts WHERE id = ?').get(id)), { ok: true });
  h = (await admin('GET', '/api/hosts')).data[0];
  assert.notEqual(h.ssh.host_key, key1);

  // No secret in any audit row.
  const rows = s.ctx.db.prepare('SELECT detail FROM audit_log').all().map(r => r.detail || '').join('\n');
  assert.ok(!rows.includes(PW));

  // Removing the host also removes its saved credential.
  await admin('DELETE', `/api/hosts/${id}`, { confirm: 'vps-b.example.test' });
  assert.equal(s.ctx.db.prepare('SELECT COUNT(*) AS n FROM credentials').get().n, 0);
});
