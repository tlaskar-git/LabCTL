// Phase 8: host actions panel endpoint, guard and audit for VPS hosts, SSH secrets, result parsers, hosts page query.
// Hosts and addresses are placeholders (example.test, 127.0.0.1 for the local ssh2 test server).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { Server, utils } = require('ssh2');
const { startApp, login, api, waitFor } = require('./helpers');

const JS = path.join(__dirname, '../public/js/components');
const load = f => import(pathToFileURL(path.join(JS, f)).href);
const PW = 'pw-test-only';
const SECRET = 'registration-token-value-9876';

async function setup(t) {
  const s = await startApp();
  t.after(() => s.stop());
  const admin = api(s.base, await login(s.base));
  await admin('POST', '/api/users', { username: 'op1', password: 'pw-op', role: 'operator' });
  const op = api(s.base, await login(s.base, 'op1', 'pw-op'));
  const addHost = (id, hostname, os, kind, inventory) => s.ctx.db.prepare(
    "INSERT INTO hosts (id, hostname, os, kind, status, inventory) VALUES (?, ?, ?, ?, 'offline', ?)").run(id, hostname, os, kind, inventory ? JSON.stringify(inventory) : null);
  return { s, admin, op, addHost };
}

// ---- result parsers --------------------------------------------------------------------------------------------------
test('result-parse: LABCTL_RESULT lines, sections and tables', async () => {
  const p = await load('result-parse.js');
  const log = '\n== Reboot needed ==\nReboot required\nLABCTL_RESULT reboot_required=yes\nLABCTL_RESULT fail2ban_banned=7\n';
  assert.deepEqual(p.parseResults(log), { reboot_required: 'yes', fail2ban_banned: '7' });
  assert.deepEqual(p.sections(log)['Reboot needed'], ['Reboot required', 'LABCTL_RESULT reboot_required=yes', 'LABCTL_RESULT fail2ban_banned=7']);
  assert.deepEqual(p.table(['VMID NAME STATUS', '100 web running', '101 db stopped']), [
    { vmid: '100', name: 'web', status: 'running' }, { vmid: '101', name: 'db', status: 'stopped' }]);
});

test('result-parse: held-back packages, reboot flag, fail2ban, ports', async () => {
  const p = await load('result-parse.js');
  assert.deepEqual(p.heldBack('== Held back after the upgrade ==\n  linux-image-amd64 libc6\n\n== Reboot needed ==\nNo reboot required\n'), ['linux-image-amd64', 'libc6']);
  assert.deepEqual(p.heldBack('== Held back after the upgrade ==\nnone\n'), []);
  assert.deepEqual(p.jails('sshd: banned now 3, banned in total 40\nnginx: banned now 0, banned in total 2\n'), [
    { jail: 'sshd', now: 3, total: 40 }, { jail: 'nginx', now: 0, total: 2 }]);
  const log = '== Listening sockets ==\ntcp 0.0.0.0:22 users:(("sshd",pid=1))\nudp 0.0.0.0:51820 -\n== Reachable from outside (not bound to loopback) ==\nPorts: 22 51820\nLABCTL_RESULT unexpected_ports=1\n';
  const r = p.ports(log);
  assert.deepEqual(r.open, [22, 51820]);
  assert.equal(r.sockets.length, 2);
  assert.equal(r.sockets[0].local, '0.0.0.0:22');
});

test('result-parse: certificates, WireGuard peers, post-reboot check', async () => {
  const p = await load('result-parse.js');
  const now = new Date('2026-10-20T00:00:00Z');
  const c = p.certs('a.example.test: valid until Dec 20 12:00:00 2026 GMT\nWARNING: b.example.test:8443: expires within 21 days or is expired (Oct 25 12:00:00 2026 GMT)\nWARNING: c.example.test: no certificate returned\n', now);
  assert.deepEqual(c.map(x => [x.domain, x.ok, x.days]), [['a.example.test', true, 61], ['b.example.test:8443', false, 5], ['c.example.test', false, null]]);
  assert.deepEqual(p.wgPeers('wg0 AbCdEf12...: 42 s ago\nwg0 Zy98Xw76...: never\nLABCTL_RESULT wireguard_stale_peers=1\n'), [
    { iface: 'wg0', peer: 'AbCdEf12', age_s: 42 }, { iface: 'wg0', peer: 'Zy98Xw76', age_s: null }]);
  const post = p.postReboot('== Services ==\nwg-quick@wg0: active\nWARNING: traefik: not active\nAt least one peer completed a handshake\nLABCTL_RESULT post_reboot_failures=1\n');
  assert.deepEqual(post.services, [{ service: 'wg-quick@wg0', active: true }, { service: 'traefik', active: false }]);
  assert.equal(post.failures, 1);
  assert.equal(post.handshake, true);
  assert.deepEqual(p.unattended('enabled: enabled\nactive: active\n'), { enabled: 'enabled', active: 'active' });
});

test('result-parse: Proxmox status, guests and backups', async () => {
  const p = await load('result-parse.js');
  const status = ['== Version ==', 'pve-manager/8.2.4/abcdef (running kernel: 6.8.4-2-pve)', '== Pending updates ==', 'pve-firmware/stable 3.1 all [upgradable from: 3.0]',
    'LABCTL_RESULT pve_updates_pending=1', '== ZFS pools ==', 'NAME SIZE ALLOC FREE CKPOINT EXPANDSZ FRAG CAP DEDUP HEALTH ALTROOT', 'rpool 232G 40G 192G - - 1% 17% 1.00x ONLINE -',
    'all pools are healthy', '== ZFS ARC ==', 'ARC size: 3.2 GiB', 'ARC max:  8.0 GiB', '== Storage usage ==', 'Name Type Status Total Used Available %', 'local dir active 100 20 80 20.00%'].join('\n');
  const s = p.pveStatus(status);
  assert.match(s.version, /^pve-manager\/8\.2\.4/);
  assert.equal(s.pending, 1);
  assert.deepEqual(s.pending_items, ['pve-firmware']);
  assert.equal(s.pools.length, 1);
  assert.equal(s.pools[0].health, 'ONLINE');
  assert.deepEqual(s.arc, { size: '3.2 GiB', max: '8.0 GiB' });
  assert.equal(s.storage[0].name, 'local');
  const g = p.pveGuests('== Virtual machines (qm list) ==\nVMID NAME STATUS MEM(MB) BOOTDISK(GB) PID\n100 web running 2048 32.00 1234\n== Containers (pct list) ==\nVMID Status Lock Name\n200 stopped  dns\nLABCTL_RESULT guests_down_with_onboot=1\n');
  assert.equal(g.vms[0].status, 'running');
  assert.equal(g.containers.length, 1);
  assert.equal(g.containers[0].name, 'dns');
  assert.equal(g.down_onboot, 1);
  const b = p.pveBackups('2026-10-19 02:00  OK  100\n2026-10-18 02:00  ERROR  101\nLABCTL_RESULT recent_backup_failures=1\n');
  assert.deepEqual(b.rows.map(r => r.status), ['OK', 'ERROR']);
  assert.equal(b.failures, 1);
});

test('host-query: URL hash query to filters and fleet lists', async () => {
  const q = await load('host-query.js');
  const empty = { q: '', os: '', status: '', group: '', tag: '', kind: '', outdated_agent: '' };
  const r = q.filtersFromQuery({ status: 'offline', os: 'linux', kind: 'vps', tag: 'edge', group: 'g1', outdated: '1', reboot: '1', disk: 'high', runners: 'offline', bogus: 'x' }, empty);
  assert.deepEqual(r.filters, { q: '', os: 'linux', status: 'offline', group: 'g1', tag: 'edge', kind: 'vps', outdated_agent: 'true' });
  assert.deepEqual(r.fleet, ['reboot', 'disk', 'runners']);
  assert.deepEqual(q.filtersFromQuery({}, empty), { filters: empty, fleet: [] });
  assert.equal(q.fleetHostIds([], {}), null);
  const ids = q.fleetHostIds(['reboot', 'disk'], { pending_reboots: [{ host_id: 'a' }, { host_id: 'b' }], disks_over_80: [{ host_id: 'b' }, { host_id: 'c' }] });
  assert.deepEqual([...ids], ['b']);
});

// ---- actions endpoint ------------------------------------------------------------------------------------------------
const idsOf = r => r.data.groups.flatMap(g => g.actions.map(a => a.id));

test('GET /api/hosts/:id/actions filters by os, kind and role and groups the actions', async t => {
  const { op, addHost } = await setup(t);
  addHost('lin', 'vps-a.example.test', 'linux', 'vps');
  addHost('win', 'vps-b.example.test', 'windows', 'vps');
  addHost('dc', 'dc-a.example.test', 'windows', 'vps', { windows: { domain_controller: true } });
  addHost('pve', 'pve-a.example.test', 'linux', 'agent', { proxmox: { version: '8.2' } });
  addHost('plain', 'node-a.example.test', 'linux', 'agent', { runners: [{ name: 'r1' }] });
  addHost('mac', 'mac-a.example.test', 'darwin', 'agent');

  const lin = await op('GET', '/api/hosts/lin/actions');
  assert.equal(lin.status, 200);
  assert.deepEqual(lin.data.roles, ['vps']);
  const linIds = idsOf(lin);
  for (const id of ['vps_apt_upgrade', 'vps_fail2ban_status', 'vps_wireguard_restart', 'vps_scheduled_reboot', 'traefik_restart']) assert.ok(linIds.includes(id), id);
  for (const id of ['win_update', 'pve_status', 'runner_update', 'mac_update']) assert.ok(!linIds.includes(id), `${id} must not be offered to a Linux VPS`);
  const names = lin.data.groups.map(g => g.group);
  assert.deepEqual(names, [...names].sort((a, b) => ['Patch', 'Security', 'Network', 'Cleanup', 'Health', 'Danger'].indexOf(a) - ['Patch', 'Security', 'Network', 'Cleanup', 'Health', 'Danger'].indexOf(b)));
  const group = id => lin.data.groups.find(g => g.actions.some(a => a.id === id)).group;
  assert.equal(group('vps_apt_upgrade'), 'Patch');
  assert.equal(group('vps_fail2ban_status'), 'Security');
  assert.equal(group('vps_wireguard_restart'), 'Network');
  assert.equal(group('vps_cleanup'), 'Cleanup');
  assert.equal(group('vps_post_reboot_check'), 'Health');
  assert.equal(group('vps_scheduled_reboot'), 'Danger');
  const reboot = lin.data.groups.flatMap(g => g.actions).find(a => a.id === 'vps_scheduled_reboot');
  assert.equal(reboot.guard, true);
  assert.equal(reboot.confirm_word, 'vps-a.example.test');
  assert.ok(reboot.params.some(p => p.name === 'DELAY_MIN'));

  const win = idsOf(await op('GET', '/api/hosts/win/actions'));
  assert.ok(win.includes('win_update') && win.includes('win_wireguard_state'));
  assert.ok(!win.includes('win_dc_health') && !win.includes('win_dns_check') && !win.includes('vps_apt_upgrade'));

  const dc = await op('GET', '/api/hosts/dc/actions');
  assert.ok(dc.data.roles.includes('domain_controller'));
  assert.ok(['win_dc_health', 'win_dns_check', 'win_dns_restart'].every(id => idsOf(dc).includes(id)));
  assert.ok(dc.data.groups.flatMap(g => g.actions).every(a => a.guard), 'every action on a domain controller needs the typed confirmation');
  assert.equal(dc.data.groups.flatMap(g => g.actions).find(a => a.id === 'win_update').guard_reason, 'domain_controller');

  const pve = await op('GET', '/api/hosts/pve/actions');
  assert.ok(pve.data.roles.includes('proxmox'));
  assert.ok(['pve_status', 'pve_guests', 'pve_backup_report', 'pve_snapshot'].every(id => idsOf(pve).includes(id)));
  assert.ok(!idsOf(await op('GET', '/api/hosts/plain/actions')).includes('pve_status'));
  const plain = await op('GET', '/api/hosts/plain/actions');
  assert.ok(plain.data.roles.includes('runner') && idsOf(plain).includes('runner_update'));
  assert.deepEqual(idsOf(await op('GET', '/api/hosts/mac/actions')).filter(id => !id.startsWith('mac_') && id !== 'brew_update' && id !== 'xcode_cleanup'), []);
  assert.equal((await op('GET', '/api/hosts/missing/actions')).status, 404);
});

// ---- guard and audit ------------------------------------------------------------------------------------------------
test('guard: every guarded template on a VPS host rejects a missing or wrong confirm, accepts the host name, and audits it', async t => {
  const { s, op, addHost } = await setup(t);
  addHost('lin', 'vps-a.example.test', 'linux', 'vps');
  addHost('win', 'vps-b.example.test', 'windows', 'vps');
  const guarded = s.ctx.templates.catalogue.templates.filter(x => x.guard && x.kinds.includes('vps') && !x.admin);
  assert.ok(guarded.length >= 6, 'expected the six guarded VPS templates');
  for (const tpl of guarded) {
    const host = tpl.os.includes('windows') ? { id: 'win', name: 'vps-b.example.test' } : { id: 'lin', name: 'vps-a.example.test' };
    const url = `/api/templates/${tpl.id}/run`;
    const params = tpl.params.some(p => p.name === 'DRY_RUN') ? { DRY_RUN: true } : {};
    const before = s.ctx.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
    const missing = await op('POST', url, { host_ids: [host.id], params });
    assert.equal(missing.status, 400, `${tpl.id}: no confirm`);
    assert.equal(missing.data.confirm_required, true);
    assert.equal((await op('POST', url, { host_ids: [host.id], confirm: 'wrong.example.test' })).status, 400, `${tpl.id}: wrong confirm`);
    assert.equal(s.ctx.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, before, `${tpl.id}: a rejected run must create no job`);
    const ok = await op('POST', url, { host_ids: [host.id], confirm: host.name, params });
    assert.equal(ok.status, 200, `${tpl.id}: ${JSON.stringify(ok.data)}`);
    await waitFor(() => s.ctx.audit.query({ action: 'template.guard_confirmed', host_id: host.id }).rows.some(r => r.detail.template === tpl.id));
    const row = s.ctx.audit.query({ action: 'template.guard_confirmed', host_id: host.id }).rows.find(r => r.detail.template === tpl.id);
    assert.equal(row.actor, 'op1');
    assert.equal(row.detail.confirm, true);
    assert.equal(row.detail.reason, 'template');
  }
});

test('guard: a domain controller needs the typed confirmation even for a template without guard:true', async t => {
  const { s, op, addHost } = await setup(t);
  addHost('dc', 'dc-a.example.test', 'windows', 'vps', { windows: { domain_role: 5 } });
  addHost('win', 'vps-b.example.test', 'windows', 'vps');
  assert.equal(s.ctx.templates.catalogue.byId.get('win_service_health').guard, false);
  assert.equal((await op('POST', '/api/templates/win_service_health/run', { host_ids: ['dc'] })).status, 400);
  assert.equal((await op('POST', '/api/templates/win_service_health/run', { host_ids: ['dc'], confirm: 'nope' })).status, 400);
  assert.equal((await op('POST', '/api/templates/win_service_health/run', { host_ids: ['dc'], confirm: 'dc-a.example.test' })).status, 200);
  assert.equal(s.ctx.audit.query({ action: 'template.guard_confirmed', host_id: 'dc' }).rows[0].detail.reason, 'domain_controller');
  assert.equal((await op('POST', '/api/templates/win_service_health/run', { host_ids: ['win'] })).status, 200); // not a DC: no confirm
  assert.equal(s.ctx.audit.query({ action: 'template.guard_confirmed', host_id: 'win' }).total, 0);
});

test('audit: a guarded run with a secret stores no secret anywhere', async t => {
  const { s, admin, addHost } = await setup(t);
  addHost('lin', 'vps-a.example.test', 'linux', 'vps');
  s.ctx.db.prepare("INSERT INTO credentials (id, host_id, name, purpose, kind, sealed) VALUES ('c1', NULL, 'remove token', 'runner', 'token', ?)")
    .run(s.ctx.crypto.sealJson({ token: SECRET }));
  const r = await admin('POST', '/api/templates/runner_remove/run', { host_ids: ['lin'], confirm: 'vps-a.example.test', params: { RUNNER_DIR: '/opt/actions-runner-demo' }, secrets: { REMOVE_TOKEN: 'c1' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await waitFor(() => s.ctx.audit.query({ action: 'template.guard_confirmed' }).total === 1);
  const rows = s.ctx.audit.query({ limit: 100 }).rows;
  assert.ok(rows.some(a => a.action === 'template.run' && a.actor === 'LabCTLAdmin' && a.host_id === 'lin' && a.detail.template === 'runner_remove'));
  assert.ok(rows.some(a => a.action === 'template.guard_confirmed' && a.detail.confirm === true));
  assert.ok(!JSON.stringify([rows, s.ctx.db.prepare('SELECT * FROM jobs').all()]).includes(SECRET));
});

// ---- SSH secrets -------------------------------------------------------------------------------------------------------
function startSshServer() {
  const seen = { commands: [], stdin: [] };
  const handler = client => {
    client.on('authentication', c => (c.method === 'password' && c.username === 'tester' && c.password === PW ? c.accept() : c.reject(['password'])));
    client.on('error', () => {});
    client.on('ready', () => client.on('session', accept => accept().on('exec', (acceptExec, _reject, info) => {
      const stream = acceptExec();
      let script = '';
      stream.on('data', d => { script += d; });
      stream.on('end', () => {
        if (info.command.includes('uptime=')) { stream.write('uptime=3600\nmem_total=1000\nmem_avail=400\ndisk_total_kb=1048576\ndisk_used_kb=524288\n'); return stream.exit(0), stream.end(); }
        seen.commands.push(info.command);
        seen.stdin.push(script);
        stream.write('done\n');
        stream.exit(0);
        stream.end();
      });
    })));
  };
  // ssh2 sometimes generates an ed25519 key that it then refuses to parse (about 1 in 600), so retry.
  let server;
  for (let i = 0; !server; i++) {
    try { server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, handler); } catch (err) { if (i > 5) throw err; }
  }
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

test('ssh run: LABCTL_P_ and LABCTL_SECRET_ reach the remote shell by stdin only and are never stored', async t => {
  const { s, admin } = await setup(t);
  const srv = await startSshServer();
  t.after(() => srv.server.close());
  const created = await admin('POST', '/api/hosts', { kind: 'ssh', name: 'vps-c.example.test', address: '127.0.0.1', port: srv.port, os: 'linux', credential: { username: 'tester', password: PW } });
  assert.equal(created.status, 200);
  assert.equal(created.data.status, 'online');
  s.ctx.db.prepare("INSERT INTO credentials (id, host_id, name, purpose, kind, sealed) VALUES ('c1', NULL, 'reg token', 'runner', 'token', ?)")
    .run(s.ctx.crypto.sealJson({ token: SECRET }));

  const r = await admin('POST', '/api/templates/runner_reregister/run', { host_ids: [created.data.id], secrets: { REG_TOKEN: 'c1' }, params: { LABELS: 'self-hosted,linux', DRY_RUN: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const jobId = r.data.jobs[0].job_id;
  await waitFor(() => s.ctx.jobs.get(jobId).status === 'completed');

  assert.deepEqual(srv.seen.commands, ['bash -s']);
  const stdin = srv.seen.stdin[0];
  assert.match(stdin, /^export LABCTL_P_LABELS='self-hosted,linux'$/m);
  assert.match(stdin, /^export LABCTL_P_DRY_RUN='1'$/m);
  assert.ok(stdin.includes(`export LABCTL_SECRET_REG_TOKEN='${SECRET}'`), 'the secret must be in the stdin prelude');
  assert.ok(!srv.seen.commands.join('\n').includes(SECRET), 'the secret must not be on the command line');
  assert.deepEqual(s.ctx.templateSecrets.take(jobId), {}); // taken at dispatch, nothing left to take
  const everything = JSON.stringify([s.ctx.db.prepare('SELECT * FROM jobs').all(), s.ctx.db.prepare('SELECT * FROM audit_log').all(), s.ctx.joblog.read(jobId)]);
  assert.ok(!everything.includes(SECRET), 'the secret leaked into the database, audit log or job log');
});

// ---- latest results --------------------------------------------------------------------------------------------------
test('GET /api/hosts/:id/action-results returns the latest finished job per template with its log', async t => {
  const { s, op, addHost } = await setup(t);
  addHost('lin', 'vps-a.example.test', 'linux', 'vps');
  const finish = (type, log, status) => {
    const j = s.ctx.jobs.create({ host_id: 'lin', type, status: 'pending', dispatchNow: false });
    s.ctx.joblog.write(j.id, log);
    s.ctx.jobs.complete(j.id, status, { exit_code: status === 'completed' ? 0 : 1 });
    return j.id;
  };
  finish('template:vps_fail2ban_status', 'old\n', 'completed');
  await new Promise(r => setTimeout(r, 5));
  const newest = finish('template:vps_fail2ban_status', 'sshd: banned now 3, banned in total 9\nLABCTL_RESULT fail2ban_banned=3\n', 'completed');
  finish('custom_command', 'ignored\n', 'completed');
  const r = await op('GET', '/api/hosts/lin/action-results');
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].template, 'vps_fail2ban_status');
  assert.equal(r.data[0].job_id, newest);
  assert.match(r.data[0].log, /fail2ban_banned=3/);
  assert.equal((await op('GET', '/api/hosts/missing/action-results')).status, 404);
});
