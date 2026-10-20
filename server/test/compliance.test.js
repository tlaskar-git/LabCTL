// Compliance: EOL table lookups, per-host numbers on seeded hosts, backup job detection, summary and CSV.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, login, api } = require('./helpers');
const eol = require('../src/compliance-eol');
const compliance = require('../src/compliance');

const NOW = new Date('2026-10-20T12:00:00Z');
const daysAgo = n => new Date(NOW.getTime() - n * 86400000).toISOString();

test('EOL lookups: supported, ending soon, ended, unknown', () => {
  const l = (name, version, build) => eol.lookup({ name, version, build }, NOW, 180);
  assert.equal(l('Ubuntu', '20.04').status, 'eol');
  assert.equal(l('Ubuntu', '22.04').status, 'supported');
  assert.equal(l('Ubuntu', '24.04').eol_date, '2029-04-30');
  assert.equal(l('Debian GNU/Linux', '11').status, 'eol');
  assert.equal(l('Debian GNU/Linux', '12').status, 'supported');
  assert.equal(l('Microsoft Windows Server 2016 Standard', '10.0.14393').status, 'eol_soon');
  assert.equal(l('Microsoft Windows Server 2019 Datacenter', '10.0.17763').status, 'supported');
  assert.equal(l('Microsoft Windows Server 2022 Standard', '10.0.20348').product, 'Windows Server 2022');
  assert.equal(l('Microsoft Windows Server 2025 Standard', '10.0.26100').product, 'Windows Server 2025');
  assert.equal(l('Microsoft Windows 10 Pro', '10.0.19045').status, 'eol');
  assert.equal(l('Microsoft Windows 11 Pro', '10.0.22631', '22631').status, 'eol');
  assert.equal(l('Microsoft Windows 11 Pro', '10.0.26100', '26100').product, 'Windows 11 24H2');
  assert.equal(l('macOS', '14.5').status, 'eol');
  assert.equal(l('macOS', '15.1').status, 'supported');
  assert.equal(l('Proxmox VE', '8.2.2').status, 'eol');
  assert.equal(l('Proxmox VE', '9.0.3').status, 'supported');
  assert.equal(l('Alpine Linux', '3.20').status, 'unknown');
  assert.equal(l('Alpine Linux', '3.20').eol_date, null);
});

function seed(db) {
  const insert = db.prepare(`INSERT INTO hosts (id, hostname, os, kind, status, last_seen, agent_version, os_version, inventory, inventory_at, created_at, updated_at)
    VALUES (?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?)`);
  const inv = (name, version, updates, extra = {}) => JSON.stringify({ os_info: { name, version }, updates, ...extra });
  const t = NOW.toISOString();
  insert.run('a', 'alpha.example.test', 'linux', 'online', t, '1.0.0', '20.04', inv('Ubuntu', '20.04', { pending: 5, security: 2, last_patch: daysAgo(60), reboot_required: false }, { security: { firewall: { enabled: false } } }), t, t, t);
  insert.run('b', 'bravo.example.test', 'linux', 'online', t, '2.0.0', '12', inv('Debian GNU/Linux', '12', { pending: 0, last_patch: daysAgo(2) }), t, t, t);
  insert.run('c', 'charlie.example.test', 'windows', 'offline', null, '2.0.0', '10.0.20348', inv('Microsoft Windows Server 2022 Standard', '10.0.20348',
    { pending: 0, reboot_required: true, reboot_pending_days: 10, last_patch: null }, { disks: [{ mount: 'C:', percent: 95 }] }), t, t, t);
  const job = db.prepare("INSERT INTO jobs (id, host_id, type, params, status, created_at, completed_at) VALUES (?, ?, ?, ?, 'completed', ?, ?)");
  job.run('j1', 'b', 'template:pve_backup_report', JSON.stringify({ template: 'pve_backup_report' }), daysAgo(1), daysAgo(1));
  job.run('j2', 'c', 'vzdump', '{}', daysAgo(20), daysAgo(20));
  job.run('j3', 'a', 'reboot', '{}', daysAgo(1), daysAgo(1)); // not a backup job
  db.prepare("INSERT INTO jobs (id, host_id, type, params, status, created_at, completed_at) VALUES ('j4', 'a', 'backup', '{}', 'failed', ?, ?)").run(daysAgo(1), daysAgo(1));
}

test('compliance numbers on seeded hosts', async (t) => {
  const s = await startApp({ listen: false });
  t.after(() => s.stop());
  seed(s.ctx.db);
  const r = compliance.build(s.ctx, NOW);
  const by = Object.fromEntries(r.hosts.map(h => [h.host_id, h]));
  assert.deepEqual(r.summary, { hosts: 3, compliant: 1, with_issues: 2, eol: 1, eol_soon: 0, patch_old: 1, pending_updates: 1, reboot_pending: 1,
    agent_outdated: 1, no_backup: 2, offline: 1, by_os: { linux: 2, windows: 1 } });
  assert.equal(by.a.patch_age_days, 60);
  assert.equal(by.a.eol_status, 'eol');
  assert.ok(by.a.issues.includes('firewall_off'));
  assert.ok(by.a.agent_outdated && by.a.agent_latest === '2.0.0');
  assert.equal(by.a.last_backup_at, null, 'a failed backup job and a reboot job are not backups');
  assert.equal(by.b.compliant, true);
  assert.equal(by.b.last_backup_at, daysAgo(1));
  assert.equal(by.c.no_recent_backup, true, 'a 20 day old backup is older than the 8 day limit');
  assert.equal(by.c.reboot_pending_days, 10);
  assert.ok(by.c.issues.includes('reboot_overdue') && by.c.issues.includes('disk_over_90') && by.c.issues.includes('offline'));

  // The pattern is a setting.
  s.ctx.settings.update({ backup_job_pattern: 'reboot' });
  assert.equal(compliance.build(s.ctx, NOW).hosts.find(h => h.host_id === 'a').no_recent_backup, false);
  s.ctx.settings.update({ backup_job_pattern: 'backup|vzdump|restic|borg', compliance_backup_days: 30 });
  assert.equal(compliance.build(s.ctx, NOW).hosts.find(h => h.host_id === 'c').no_recent_backup, false);
});

test('compliance API, CSV export and formula-safe cells', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  seed(s.ctx.db);
  const token = await login(s.base);
  const admin = api(s.base, token);
  const json = await admin('GET', '/api/compliance');
  assert.equal(json.status, 200);
  assert.equal(json.data.hosts.length, 3);
  const res = await fetch(`${s.base}/api/compliance.csv`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const lines = (await res.text()).trim().split('\r\n');
  assert.equal(lines.length, 4);
  assert.ok(lines[0].startsWith('hostname,os,kind'));
  assert.ok(lines.some(l => l.startsWith('alpha.example.test,linux,agent') && l.includes('eol')));
  const csv = compliance.toCsv({ hosts: [{ hostname: '=HYPERLINK("x")', issues: ['a', 'b'] }, { hostname: 'plain, with comma' }] }).split('\r\n');
  assert.ok(csv[1].startsWith(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv[2].startsWith('"plain, with comma"'));
  assert.equal((await fetch(`${s.base}/api/compliance`)).status, 401);
});

test('settings accept the new keys and refuse bad values', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const admin = api(s.base, await login(s.base));
  const ok = await admin('PUT', '/api/settings', { backup_job_pattern: 'bak', cert_domains: 'a.example.test, b.example.test:8443', public_url: 'https://labctl.example.test/', patch_concurrency: 5, health_report_channels: ['c1'] });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.cert_domains, 'a.example.test,b.example.test:8443');
  assert.equal(ok.data.public_url, 'https://labctl.example.test');
  assert.equal(ok.data.patch_concurrency, 5);
  assert.equal((await admin('PUT', '/api/settings', { backup_job_pattern: '(' })).status, 400);
  assert.equal((await admin('PUT', '/api/settings', { cert_domains: 'bad;domain' })).status, 400);
  assert.equal((await admin('PUT', '/api/settings', { public_url: 'ftp://x' })).status, 400);
  assert.equal((await admin('PUT', '/api/settings', { health_report_channels: 'c1' })).status, 400);
});
