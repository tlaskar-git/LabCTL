// Host display name, icons (automatic pick, override, group icon), audit rows and the removal confirmation by either name.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, login, api } = require('./helpers');
const { inventory } = require('./inventory-fixture');
const { ICON_IDS, autoIcon } = require('../src/host-icon');
const { cleanDisplayName } = require('../src/host-display');

const PUBLIC = path.join(__dirname, '..', 'public');
const inv = os_info => JSON.stringify(inventory({ os_info: { ...inventory().os_info, ...os_info }, docker: undefined }));

test('autoIcon picks from OS, distro and role', () => {
  const cases = [
    [{ os: 'linux', inventory: inv({ name: 'Debian GNU/Linux' }) }, 'debian'],
    [{ os: 'linux', inventory: inv({ name: 'Ubuntu', version: '24.04' }) }, 'ubuntu'],
    [{ os: 'linux', kind: 'proxmox', inventory: inv({ name: 'Debian GNU/Linux' }) }, 'proxmox'],
    [{ os: 'linux', inventory: JSON.stringify(inventory({ proxmox: { version: '8.2' } })) }, 'proxmox'],
    [{ os: 'windows', os_version: 'Windows Server 2022' }, 'windows'],
    [{ os: 'windows', inventory: JSON.stringify({ windows: { domain_role: 5 } }) }, 'dc'],
    [{ os: 'windows' }, 'dc', ['domain-controller']],
    [{ os: 'darwin', os_version: '15.1' }, 'apple'],
    [{ os: 'linux', inventory: inv({ name: 'Debian GNU/Linux', model: 'Raspberry Pi 4 Model B Rev 1.4' }) }, 'raspberrypi'],
    [{ os: 'linux', kind: 'vps', inventory: inv({ name: 'Ubuntu' }) }, 'vps'],
    [{ os: 'linux', system_info: JSON.stringify({ platform: 'Linux', docker_total: 4 }) }, 'docker'],
    [{ os: 'linux' }, 'linux'],
    [{}, 'server']
  ];
  for (const [row, want, tags] of cases) assert.equal(autoIcon(row, tags), want, JSON.stringify(row).slice(0, 120));
});

test('display name validation', () => {
  assert.deepEqual(cleanDisplayName('  Web one '), { value: 'Web one' });
  assert.deepEqual(cleanDisplayName(''), { value: null });
  assert.deepEqual(cleanDisplayName(null), { value: null });
  assert.ok(cleanDisplayName('x'.repeat(65)).error);
  assert.ok(cleanDisplayName('bad\nname').error);
  assert.ok(cleanDisplayName(12).error);
  assert.equal(cleanDisplayName('x'.repeat(64)).value.length, 64);
});

test('every icon id has an SVG, a CSS rule and a UI label, and the SVGs fetch nothing', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'css', 'icons.css'), 'utf8');
  const ui = fs.readFileSync(path.join(PUBLIC, 'js', 'components', 'os-icon.js'), 'utf8');
  for (const id of ICON_IDS) {
    const svg = fs.readFileSync(path.join(PUBLIC, 'vendor', 'icons', `${id}.svg`), 'utf8');
    for (const u of svg.match(/https?:\/\/[^"'\s)]+/g) || []) assert.equal(u, 'http://www.w3.org/2000/svg', `${id}.svg references ${u}`);
    assert.ok(!/<script|href=/i.test(svg), `${id}.svg must be a plain shape`);
    assert.ok(css.includes(`[data-icon="${id}"]`), `icons.css misses ${id}`);
    assert.ok(ui.includes(`['${id}',`), `os-icon.js misses ${id}`);
  }
});

test('PATCH display_name and icon: persistence, name precedence, sort, search, audit, group icon, removal by either name', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const admin = api(s.base, await login(s.base));
  await admin('POST', '/api/users', { username: 'view1', password: 'pw-view', role: 'viewer' });
  const viewer = api(s.base, await login(s.base, 'view1', 'pw-view'));
  const db = s.ctx.db;
  const ins = db.prepare("INSERT INTO hosts (id, hostname, os, kind, status, inventory) VALUES (?, ?, ?, 'agent', 'offline', ?)");
  ins.run('h-a', 'alpha.example.test', 'linux', inv({ name: 'Ubuntu' }));
  ins.run('h-b', 'beta.example.test', 'windows', null);

  let list = (await admin('GET', '/api/hosts')).data;
  const a0 = list.find(h => h.id === 'h-a');
  assert.equal(a0.name, 'alpha.example.test');
  assert.equal(a0.display_name, null);
  assert.equal(a0.icon, null);
  assert.equal(a0.icon_auto, 'ubuntu');
  assert.equal(list.find(h => h.id === 'h-b').icon_auto, 'windows');

  assert.equal((await admin('PATCH', '/api/hosts/h-a', { display_name: 'x'.repeat(65) })).status, 400);
  assert.equal((await admin('PATCH', '/api/hosts/h-a', { display_name: 'tab\there' })).status, 400);
  assert.equal((await admin('PATCH', '/api/hosts/h-a', { icon: 'not-an-icon' })).status, 400);
  assert.equal((await viewer('PATCH', '/api/hosts/h-a', { display_name: 'Nope' })).status, 403);

  const p = await admin('PATCH', '/api/hosts/h-a', { display_name: '  Zulu web  ', icon: 'nginx' });
  assert.equal(p.status, 200);
  assert.equal(p.data.display_name, 'Zulu web');
  assert.equal(p.data.name, 'Zulu web');
  assert.equal(p.data.hostname, 'alpha.example.test');
  assert.equal(p.data.icon, 'nginx');
  assert.equal(p.data.icon_auto, 'ubuntu');
  const one = (await admin('GET', '/api/hosts/h-a')).data;
  assert.equal(one.name, 'Zulu web');
  assert.equal(one.icon, 'nginx');

  // Sorted by the shown name: beta.example.test before Zulu web. Search finds the display name and still the hostname.
  list = (await admin('GET', '/api/hosts')).data;
  assert.deepEqual(list.map(h => h.id), ['h-b', 'h-a']);
  assert.deepEqual((await admin('GET', '/api/hosts?q=zulu')).data.map(h => h.id), ['h-a']);
  assert.deepEqual((await admin('GET', '/api/hosts?q=alpha.example')).data.map(h => h.id), ['h-a']);
  assert.deepEqual((await admin('GET', '/api/hosts?q=zulu&os=windows')).data, []);

  const audit = db.prepare("SELECT action, host_id, detail FROM audit_log WHERE action IN ('host.rename', 'host.icon') ORDER BY id").all();
  assert.deepEqual(audit.map(r => [r.action, r.host_id]), [['host.rename', 'h-a'], ['host.icon', 'h-a']]);
  assert.match(audit[0].detail, /Zulu web/);

  // Clearing goes back to the hostname and the automatic icon. An unchanged value writes no audit row.
  await admin('PATCH', '/api/hosts/h-a', { display_name: 'Zulu web' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'host.rename'").get().n, 1);
  const c = (await admin('PATCH', '/api/hosts/h-a', { display_name: '', icon: null })).data;
  assert.equal(c.name, 'alpha.example.test');
  assert.equal(c.icon, null);

  // Group icon over POST, PATCH and PUT.
  const g = (await admin('POST', '/api/groups', { name: 'Linux', icon: 'linux' })).data;
  assert.equal(g.icon, 'linux');
  assert.equal((await admin('PATCH', `/api/groups/${g.id}`, { icon: 'nope' })).status, 400);
  assert.equal((await admin('PATCH', `/api/groups/${g.id}`, { icon: 'debian' })).data.icon, 'debian');
  assert.equal((await admin('PUT', `/api/groups/${g.id}`, { name: 'Linux hosts' })).data.icon, 'debian');
  assert.equal((await admin('GET', '/api/groups')).data[0].icon, 'debian');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'group.icon'").get().n, 1);

  // Removal: the confirmation may be the display name or the real hostname, nothing else.
  await admin('PATCH', '/api/hosts/h-a', { display_name: 'Zulu web' });
  assert.equal((await admin('DELETE', '/api/hosts/h-a', { confirm: 'zulu web' })).status, 400);
  assert.equal((await admin('DELETE', '/api/hosts/h-a', { confirm: 'Zulu web' })).status, 200);
  assert.equal((await admin('DELETE', '/api/hosts/h-b', { confirm: 'beta.example.test' })).status, 200);
  assert.equal((await admin('GET', '/api/hosts')).data.length, 0);
});
