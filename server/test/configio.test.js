const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { startApp, login, api } = require('./helpers');
const { stripSecrets } = require('../src/configio');

const SECRETS = ['TG-SECRET-VALUE-123', 'HMAC-SECRET-VALUE-456', 'HDR-SECRET-VALUE-789', 'SMTP-PASS-VALUE-012', 'GH-TOKEN-VALUE-345', 'CRED-PASSWORD-VALUE-678'];
const stamp = '2026-01-01T00:00:00.000Z';

async function setup(t) {
  const s = await startApp();
  t.after(() => s.stop());
  return { s, admin: api(s.base, await login(s.base)) };
}

// Fills an instance with one row in each section, plus secrets that must never reach the export.
async function seed(s, admin) {
  const { db } = s.ctx;
  const ins = (table, row) => db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(k => `@${k}`).join(', ')})`).run(row);
  const tg = await admin('POST', '/api/channels', { name: 'Ops Telegram', kind: 'telegram', config: { bot_token: SECRETS[0], chat_id: '42' } });
  assert.equal(tg.status, 201);
  const wh = await admin('POST', '/api/channels', { name: 'Ops Webhook', kind: 'webhook', config: { url: 'https://example.test/hook', hmac_secret: SECRETS[1], headers: { Authorization: `Bearer ${SECRETS[2]}` } } });
  assert.equal(wh.status, 201);
  const sm = await admin('POST', '/api/channels', { name: 'Ops Mail', kind: 'smtp', config: { host: 'smtp.example.test', port: 587, from: 'labctl@example.test', to: ['ops@example.test'], user: 'mailer', password: SECRETS[3] } });
  assert.equal(sm.status, 201);
  s.ctx.settings.set('_github_token', SECRETS[4]);
  ins('credentials', { id: randomUUID(), name: 'lab cred', username: 'root', sealed: s.ctx.crypto.sealJson({ password: SECRETS[5] }), created_at: stamp, updated_at: stamp });
  const group = randomUUID();
  const tag = randomUUID();
  ins('groups', { id: group, name: 'Lab', color: '#112233', ord: 2, created_at: stamp });
  ins('tags', { id: tag, name: 'ring0', color: '#445566', created_at: stamp });
  const host = randomUUID();
  ins('hosts', { id: host, hostname: 'vps-one', display_name: 'Edge VPS', icon: 'vps', os: 'linux', ip: '192.0.2.10', kind: 'vps', status: 'offline', created_at: stamp, updated_at: stamp,
    data: JSON.stringify({ provider: 'ExampleCloud', region: 'eu-1', plan: 'small', notes: 'first host', ssh: { address: '192.0.2.10', port: 2222, username: 'root', credential_id: 'cred-x' } }) });
  ins('host_tags', { host_id: host, tag_id: tag });
  ins('host_groups', { host_id: host, group_id: group });
  ins('scripts', { id: randomUUID(), name: 'Disk report', description: 'df', os: 'linux', target: 'host', command: 'df -h', timeout: 60, builtin: 0, created_at: stamp, updated_at: stamp });
  ins('schedules', { id: randomUUID(), name: 'Nightly disk', host_id: host, type: 'script', params: '{"script":"disk"}', cron: '0 3 * * *', enabled: 1, created_at: stamp, updated_at: stamp });
  ins('runbooks', { id: randomUUID(), name: 'Reboot check', description: 'd', steps: '[{"kind":"note","text":"hi"}]', created_at: stamp, updated_at: stamp });
  ins('alert_rules', { id: randomUUID(), name: 'Custom disk rule', kind: 'metric', enabled: 1, created_at: stamp, updated_at: stamp,
    config: JSON.stringify({ severity: 'critical', condition: 'disk>90', channels: [tg.data.id], silenced_until: '2999-01-01T00:00:00Z' }) });
  ins('maintenance_windows', { id: randomUUID(), name: 'Sunday window', scope: '{"type":"all"}', cron: '0 2 * * 0', duration_min: 60, created_at: stamp, updated_at: stamp });
  ins('patch_policies', { id: randomUUID(), name: 'Custom policy', ring: 1, config: '{"reboot":"never"}', created_at: stamp, updated_at: stamp });
  await admin('POST', '/api/users', { username: 'bob', password: 'pw-bob-12345', role: 'operator' });
  await admin('PUT', '/api/settings', { timezone: 'Europe/London', jobs_days: 45 });
  await admin('PUT', '/api/backup/settings', { backup_time: '04:10', backup_keep_days: 21 });
  const bs = await admin('POST', '/api/builtin-schedules/cert_expiry/enable', {});
  return { tg: tg.data, host, bs };
}

const envelope = (exp, over = {}) => ({ format: exp.format, version: exp.version, data: exp.data, ...over });
const importer = admin => (exp, over = {}) => admin('POST', '/api/config/import', envelope(exp, over));

test('stripSecrets removes secret-looking properties at any depth', () => {
  const out = stripSecrets({ a: 1, password: 'x', nested: { bot_token: 'y', keep: 2, list: [{ api_key: 'z', ok: true }] }, reject_unauthorized: false, headers: { A: 'b' } });
  assert.deepEqual(out, { a: 1, nested: { keep: 2, list: [{ ok: true }] }, reject_unauthorized: false });
});

test('export has the documented shape and no secrets or hashes anywhere', async (t) => {
  const { s, admin } = await setup(t);
  const seeded = await seed(s, admin);
  const token = s.ctx.tokens.create('agent token', 'test');
  const r = await admin('GET', '/api/config/export');
  assert.equal(r.status, 200);
  assert.equal(r.data.format, 'labctl-config');
  assert.equal(r.data.version, 1);
  assert.equal(r.data.labctl_version, s.ctx.version);
  assert.ok(Date.parse(r.data.exported_at));
  for (const k of ['settings', 'groups', 'tags', 'scripts', 'schedules', 'runbooks', 'alert_rules', 'channels', 'maintenance_windows', 'patch_policies', 'users', 'hosts', 'builtin_schedules']) {
    assert.ok(k in r.data.data, `section ${k}`);
  }
  const text = JSON.stringify(r.data.data);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `leaked ${secret}`);
  const hashes = s.ctx.db.prepare('SELECT password_hash FROM users').all().map(u => u.password_hash);
  const sealed = s.ctx.db.prepare('SELECT sealed FROM credentials').all().map(c => c.sealed);
  for (const h of [...hashes, ...sealed, token.token, token.value, s.ctx.crypto.sha256(token.token || '')].filter(Boolean)) assert.ok(!text.includes(h), 'leaked a hash, sealed blob or token');
  assert.ok(!/password_hash|bot_token|hmac_secret|_github_token|credential_id|\bsealed\b/.test(text));
  const d = r.data.data;
  assert.ok(!d.settings._github_token);
  assert.ok(!Object.keys(d.settings).some(k => k.startsWith('_')));

  const byName = (sec, n) => d[sec].find(x => x.name === n);
  assert.deepEqual(d.users.find(u => u.username === 'bob'), { username: 'bob', role: 'operator' });
  const tgOut = byName('channels', 'Ops Telegram');
  assert.equal(tgOut.needs_secret, true);
  assert.equal(tgOut.config.chat_id, '42');
  assert.equal(byName('channels', 'Ops Webhook').needs_secret, true);
  assert.equal(byName('channels', 'Ops Webhook').config.url, 'https://example.test/hook');
  assert.equal(byName('channels', 'Ops Mail').config.user, 'mailer');
  const host = byName('hosts', 'vps-one');
  assert.deepEqual({ ...host }, { name: 'vps-one', display_name: 'Edge VPS', icon: 'vps', kind: 'vps', os: 'linux', address: '192.0.2.10', port: 2222, provider: 'ExampleCloud', region: 'eu-1', plan: 'small', notes: 'first host', tags: ['ring0'], groups: ['Lab'] });
  assert.equal(byName('schedules', 'Nightly disk').host, 'vps-one');
  assert.deepEqual(byName('alert_rules', 'Custom disk rule').config.channels, ['Ops Telegram']);
  assert.equal(byName('alert_rules', 'Custom disk rule').config.silenced_until, undefined);
  assert.equal(d.settings.timezone, 'Europe/London');
  assert.equal(d.settings.backup_time, '04:10');
  assert.equal(d.settings.backup_keep_days, 21);
  assert.deepEqual(d.builtin_schedules.map(b => b.key), ['cert_expiry']);
});

test('dry run returns a plan and changes nothing, a real import needs the typed word IMPORT', async (t) => {
  const a = await setup(t);
  const b = await setup(t);
  await seed(a.s, a.admin);
  const exp = (await a.admin('GET', '/api/config/export')).data;
  const imp = importer(b.admin);
  const before = JSON.stringify((await b.admin('GET', '/api/config/export')).data.data.groups);

  const dry = await imp(exp, { dry_run: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.data.dry_run, true);
  assert.ok(dry.data.counts.create >= 9);
  assert.equal(dry.data.counts.conflicts, 0, JSON.stringify(dry.data.plan.conflicts));
  assert.ok(dry.data.plan.create.some(r => r.section === 'groups' && r.name === 'Lab'));
  assert.ok(dry.data.plan.skip.some(r => r.section === 'hosts' && r.name === 'vps-one'), 'unknown host is skipped, never created');
  assert.ok(dry.data.plan.skip.some(r => r.section === 'users' && r.name === 'bob'), 'users are skipped by default');
  assert.equal(JSON.stringify((await b.admin('GET', '/api/config/export')).data.data.groups), before, 'dry run wrote nothing');
  const noDryFlag = await imp(exp);
  assert.equal(noDryFlag.data.dry_run, true, 'dry_run missing means dry run');

  const noConfirm = await imp(exp, { dry_run: false });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.data.confirm_required, true);
  const wrong = await imp(exp, { dry_run: false, confirm: 'import' });
  assert.equal(wrong.status, 400);
  assert.equal(JSON.stringify((await b.admin('GET', '/api/config/export')).data.data.groups), before);

  const applied = await imp(exp, { dry_run: false, confirm: 'IMPORT' });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.dry_run, false);
  const got = (await b.admin('GET', '/api/config/export')).data.data;
  for (const sec of ['groups', 'tags', 'scripts', 'runbooks', 'maintenance_windows', 'patch_policies']) assert.deepEqual(got[sec], exp.data[sec], sec);
  assert.deepEqual(got.settings.timezone, 'Europe/London');
  assert.equal(got.settings.jobs_days, 45);
  assert.equal(got.settings.backup_time, '04:10');
  assert.equal(b.s.ctx.backups.settings().keep_days, 21);
  assert.equal(got.schedules.length, 0, 'schedule needs host vps-one, which does not exist on this server');
  assert.ok(applied.data.plan.conflicts.length === 0);
  // The audit row holds counts, not the file.
  const audit = (await b.admin('GET', '/api/audit?action=config.import')).data.rows[0];
  assert.deepEqual(Object.keys(audit.detail).sort(), ['counts', 'mode', 'sections']);
});

test('re-import is idempotent and keeps secrets already set on a channel', async (t) => {
  const a = await setup(t);
  const b = await setup(t);
  await seed(a.s, a.admin);
  // Same host name on B, so host metadata, tags, groups and the schedule can be matched.
  const hostB = randomUUID();
  b.s.ctx.db.prepare("INSERT INTO hosts (id, hostname, os, kind, status, data, created_at, updated_at) VALUES (?, 'vps-one', 'linux', 'vps', 'offline', '{}', ?, ?)").run(hostB, stamp, stamp);
  // B already has a channel of the same name with a real secret.
  const existing = await b.admin('POST', '/api/channels', { name: 'Ops Telegram', kind: 'telegram', config: { bot_token: 'B-OWN-TOKEN-999', chat_id: '7' } });
  const exp = (await a.admin('GET', '/api/config/export')).data;
  const imp = importer(b.admin);

  const first = await imp(exp, { dry_run: false, confirm: 'IMPORT', include_users: true });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.ok(first.data.counts.create > 0 && first.data.counts.update > 0);
  const after = (await b.admin('GET', '/api/config/export')).data.data;
  const hostOut = after.hosts.find(h => h.name === 'vps-one');
  assert.deepEqual([hostOut.provider, hostOut.region, hostOut.plan, hostOut.notes, hostOut.tags, hostOut.groups], ['ExampleCloud', 'eu-1', 'small', 'first host', ['ring0'], ['Lab']]);
  assert.equal(hostOut.kind, 'vps');
  assert.deepEqual([hostOut.display_name, hostOut.icon], ['Edge VPS', 'vps'], 'display name and icon travel with the host');
  assert.equal(after.schedules.find(x => x.name === 'Nightly disk').host, 'vps-one');
  assert.equal(b.s.ctx.db.prepare("SELECT enabled FROM channels WHERE name = 'Ops Webhook'").get().enabled, 0, 'new channel without secrets is created disabled');
  const tgRow = b.s.ctx.db.prepare('SELECT * FROM channels WHERE id = ?').get(existing.data.id);
  assert.equal(b.s.ctx.crypto.openJson(tgRow.config_sealed).bot_token, 'B-OWN-TOKEN-999', 'existing secret survives');
  assert.equal(b.s.ctx.crypto.openJson(tgRow.config_sealed).chat_id, '42', 'non-secret field is updated');
  const rule = after.alert_rules.find(x => x.name === 'Custom disk rule');
  assert.deepEqual(rule.config.channels, ['Ops Telegram']);

  // Second run: nothing to create or update.
  const second = await imp(exp, { dry_run: true, include_users: true });
  assert.equal(second.data.counts.create, 0, JSON.stringify(second.data.plan.create));
  assert.equal(second.data.counts.update, 0, JSON.stringify(second.data.plan.update));
  assert.equal(second.data.counts.conflicts, 0);
  assert.ok(second.data.counts.skip > 0);
  const real = await imp(exp, { dry_run: false, confirm: 'IMPORT', include_users: true });
  assert.equal(real.data.counts.create + real.data.counts.update, 0);
  assert.equal(b.s.ctx.db.prepare('SELECT COUNT(*) AS n FROM groups').get().n, 1);
});

test('users: skipped by default, created disabled with include_users, never changed when they exist', async (t) => {
  const a = await setup(t);
  const b = await setup(t);
  await a.admin('POST', '/api/users', { username: 'carol', password: 'pw-carol-12', role: 'admin' });
  const exp = (await a.admin('GET', '/api/config/export')).data;
  const imp = importer(b.admin);
  const plain = await imp(exp, { dry_run: false, confirm: 'IMPORT', sections: ['users'] });
  assert.equal(plain.data.counts.create, 0);
  assert.equal(b.s.ctx.db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'carol'").get().n, 0);
  const withUsers = await imp(exp, { dry_run: false, confirm: 'IMPORT', sections: ['users'], include_users: true });
  assert.equal(withUsers.data.counts.create, 1);
  const row = b.s.ctx.db.prepare("SELECT * FROM users WHERE username = 'carol'").get();
  assert.equal(row.role, 'admin');
  assert.ok(!row.password_hash.includes(':'), 'no verifiable hash');
  for (const pw of ['', '!disabled', 'pw-carol-12', 'LabCTL']) {
    const r = await fetch(`${b.s.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'carol', password: pw }) });
    assert.equal(r.status, 401);
  }
  // The built-in admin exists on both sides and stays untouched.
  assert.ok(withUsers.data.plan.skip.some(x => x.name === 'LabCTLAdmin'));
});

test('replace_sections deletes rows missing from the file, merge does not', async (t) => {
  const { s, admin } = await setup(t);
  const { db } = s.ctx;
  for (const n of ['keep', 'extra']) db.prepare('INSERT INTO groups (id, name, color, ord, created_at) VALUES (?, ?, ?, 0, ?)').run(randomUUID(), n, '#000', stamp);
  const extra = db.prepare("SELECT id FROM groups WHERE name = 'extra'").get().id;
  const host = randomUUID();
  db.prepare("INSERT INTO hosts (id, hostname, kind, status, group_id, created_at, updated_at) VALUES (?, 'h1', 'agent', 'offline', ?, ?, ?)").run(host, extra, stamp, stamp);
  db.prepare('INSERT INTO host_groups (host_id, group_id) VALUES (?, ?)').run(host, extra);
  const file = { format: 'labctl-config', version: 1, data: { groups: [{ name: 'keep', color: '#000', ord: 0 }], users: [] } };

  const merge = await admin('POST', '/api/config/import', { ...file, mode: 'merge', dry_run: false, confirm: 'IMPORT' });
  assert.equal(merge.data.counts.delete, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM groups').get().n, 2);
  const dry = await admin('POST', '/api/config/import', { ...file, mode: 'replace_sections', dry_run: true });
  assert.deepEqual(dry.data.plan.delete, [{ section: 'groups', name: 'extra' }]);
  const real = await admin('POST', '/api/config/import', { ...file, mode: 'replace_sections', dry_run: false, confirm: 'IMPORT' });
  assert.equal(real.data.counts.delete, 1);
  assert.deepEqual(db.prepare('SELECT name FROM groups').all(), [{ name: 'keep' }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM host_groups').get().n, 0);
  assert.equal(db.prepare('SELECT group_id FROM hosts WHERE id = ?').get(host).group_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1, 'users are never deleted, whatever the mode');
  // A section missing from the file is never wiped.
  const other = await admin('POST', '/api/config/import', { format: 'labctl-config', version: 1, data: { tags: [] }, mode: 'replace_sections', dry_run: true });
  assert.equal(other.data.counts.delete, 0);
});

test('schema is checked strictly', async (t) => {
  const { s, admin } = await setup(t);
  const post = body => admin('POST', '/api/config/import', body);
  const ok = { format: 'labctl-config', version: 1, data: {} };
  assert.equal((await post({ ...ok, format: 'other' })).status, 400);
  assert.equal((await post({ ...ok, format: undefined })).status, 400);
  assert.equal((await post({ ...ok, version: 2 })).status, 400);
  assert.equal((await post({ ...ok, version: '1' })).status, 400);
  assert.equal((await post({ ...ok, data: [] })).status, 400);
  assert.equal((await post({ ...ok, data: { bogus: [] } })).status, 400);
  assert.equal((await post({ ...ok, data: { groups: {} } })).status, 400);
  assert.equal((await post({ ...ok, data: { settings: [] } })).status, 400);
  assert.equal((await post({ ...ok, mode: 'wipe' })).status, 400);
  assert.equal((await post({ ...ok, sections: ['nope'] })).status, 400);
  assert.equal((await post({ ...ok, dry_run: 'false' })).status, 400);
  const big = await post({ ...ok, data: { scripts: [{ name: 'big', command: 'x'.repeat(5 * 1024 * 1024 + 10) }] } });
  assert.equal(big.status, 413);

  // Item level problems show as conflicts in a dry run and block a real import. Nothing is written.
  const items = {
    groups: [{ name: 'g1', ord: 'one' }, { name: 'g1' }, { name: 'g2', surprise: true }, { name: '' }, 'text'],
    scripts: [{ name: 's1' }],
    schedules: [{ name: 'sch', type: 'script', cron: 'not a cron' }, { name: 'sch2', type: 'script', cron: '0 1 * * *', host: 'no-such-host' }],
    channels: [{ name: 'c1', kind: 'pigeon', config: {} }, { name: 'c2', kind: 'webhook', config: 'x' }],
    users: [{ username: 'u1', role: 'root' }],
    settings: { timezone: 'Mars/Base', jobs_days: 'many', theme: 'dark', backup_time: '99:99', _github_token: 'x', unknown_key: 1 },
    builtin_schedules: [{ key: 'cert_expiry', enabled: 'yes' }]
  };
  const dry = await post({ ...ok, data: items, dry_run: true });
  assert.equal(dry.status, 200);
  const reasons = dry.data.plan.conflicts.map(c => `${c.section}:${c.name}`);
  for (const want of ['groups:g1', 'groups:g2', 'groups:#4', 'groups:#5', 'scripts:s1', 'schedules:sch', 'channels:c1', 'channels:c2', 'users:u1',
    'settings:timezone', 'settings:jobs_days', 'settings:backup_time', 'builtin_schedules:cert_expiry']) assert.ok(reasons.includes(want), `conflict ${want} in ${reasons.join(', ')}`);
  assert.ok(dry.data.plan.skip.some(x => x.section === 'schedules' && x.name === 'sch2'), 'unknown host is a skip, not a blocker');
  assert.ok(dry.data.plan.skip.some(x => x.name === '_github_token'));
  assert.ok(dry.data.plan.skip.some(x => x.name === 'unknown_key'));
  const real = await post({ ...ok, data: items, dry_run: false, confirm: 'IMPORT' });
  assert.equal(real.status, 409);
  assert.ok(real.data.plan.conflicts.length >= 10);
  assert.equal(s.ctx.db.prepare('SELECT COUNT(*) AS n FROM groups').get().n, 0);
  assert.equal(s.ctx.settings.get('theme'), 'dark');
  assert.equal(s.ctx.settings.get('_github_token'), undefined);
});

test('a failure inside the apply step rolls the whole import back', async (t) => {
  const { s, admin } = await setup(t);
  s.ctx.db.exec("CREATE TRIGGER fail_tags BEFORE INSERT ON tags BEGIN SELECT RAISE(ABORT, 'forced'); END");
  const r = await admin('POST', '/api/config/import', { format: 'labctl-config', version: 1, dry_run: false, confirm: 'IMPORT',
    data: { groups: [{ name: 'g-rollback' }], tags: [{ name: 't-rollback' }] } });
  assert.equal(r.status, 500);
  assert.equal(s.ctx.db.prepare('SELECT COUNT(*) AS n FROM groups').get().n, 0);
});

test('host display_name and icon are validated on import, and null clears them', async (t) => {
  const b = await setup(t);
  const id = randomUUID();
  b.s.ctx.db.prepare("INSERT INTO hosts (id, hostname, kind, status, data, display_name, icon, created_at, updated_at) VALUES (?, 'h-one', 'agent', 'offline', '{}', 'Old name', 'linux', ?, ?)").run(id, stamp, stamp);
  const file = hosts => ({ format: 'labctl-config', version: 1, data: { hosts } });
  const imp = importer(b.admin);
  const bad = await imp(file([{ name: 'h-one', icon: 'not-an-icon' }]), { dry_run: true });
  assert.ok(bad.data.plan.conflicts.some(r => r.name === 'h-one' && /icon must be one of/.test(r.reason)), JSON.stringify(bad.data.plan));
  const long = await imp(file([{ name: 'h-one', display_name: 'x'.repeat(65) }]), { dry_run: true });
  assert.ok(long.data.plan.conflicts.some(r => /64 characters/.test(r.reason)));
  const ok = await imp(file([{ name: 'h-one', display_name: null, icon: 'debian' }]), { dry_run: false, confirm: 'IMPORT' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const row = b.s.ctx.db.prepare('SELECT display_name, icon FROM hosts WHERE id = ?').get(id);
  assert.deepEqual([row.display_name, row.icon], [null, 'debian']);
  const again = await imp(file([{ name: 'h-one', display_name: null, icon: 'debian' }]), { dry_run: true });
  assert.ok(again.data.plan.skip.some(r => r.name === 'h-one' && r.reason === 'unchanged'));
});
