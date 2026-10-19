const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const catalogue = require('../src/templates');
const { startApp, login, api, wsOpen, waitFor } = require('./helpers');

const DIR = path.join(__dirname, '../src/templates');
const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const cat = catalogue.load();
const read = f => fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\r\n/g, '\n');
const full = t => catalogue.script(cat, t);

const REQUIRED_IDS = ['mac_update', 'brew_update', 'xcode_cleanup', 'mac_disk_cleanup', 'mac_reboot', 'mac_security_report',
  'runner_update', 'runner_restart', 'runner_health_check', 'runner_cleanup', 'runner_reregister', 'runner_remove', 'runner_add',
  'orphan_process_killer', 'docker_cleanup', 'toolchain_cleanup', 'mac_runner_checks', 'win_runner_report',
  'vps_apt_upgrade', 'vps_reboot_required', 'vps_unattended_status', 'vps_fail2ban_status', 'vps_listening_ports', 'vps_cert_expiry',
  'vps_wireguard_status', 'vps_wireguard_restart', 'vps_cleanup', 'vps_scheduled_reboot', 'vps_post_reboot_check', 'traefik_restart',
  'win_update', 'win_service_health', 'win_wireguard_state', 'win_dc_health', 'win_dns_check', 'win_dns_restart',
  'pve_status', 'pve_guests', 'pve_backup_report', 'pve_snapshot'];

// ---- manifest -----------------------------------------------------------------------------------------------------
test('manifest: every entry is valid and every referenced file exists', () => {
  assert.deepEqual(catalogue.validateManifest(raw, DIR), []);
  for (const id of REQUIRED_IDS) assert.ok(cat.byId.has(id), `missing template ${id}`);
  // Every script file in the tree is listed (no orphan scripts).
  const listed = new Set(raw.templates.map(t => t.file));
  for (const sub of ['darwin', 'linux', 'unix', 'windows']) {
    for (const f of fs.readdirSync(path.join(DIR, sub))) assert.ok(listed.has(`${sub}/${f}`), `${sub}/${f} is not in the manifest`);
  }
});

test('manifest: guards, drain and admin flags follow the contract', () => {
  const guarded = ['vps_wireguard_restart', 'vps_scheduled_reboot', 'traefik_restart', 'win_dns_restart', 'win_dc_health', 'win_reboot', 'runner_remove', 'runner_remove_win'];
  for (const id of guarded) assert.equal(cat.byId.get(id).guard, true, `${id} must be guarded`);
  for (const id of ['runner_remove', 'runner_remove_win']) assert.equal(cat.byId.get(id).admin, true);
  for (const id of ['runner_update', 'runner_restart', 'runner_cleanup', 'runner_reregister', 'runner_update_win', 'mac_reboot']) {
    assert.equal(cat.byId.get(id).drain, true, `${id} needs the drain option`);
    assert.ok(cat.byId.get(id).params.some(p => p.name === 'DRAIN_TIMEOUT_MIN'));
  }
});

test('manifest: the validator rejects broken entries', () => {
  const bad = { templates: [{ id: 'Bad Id' }, { ...raw.templates[0], file: '../x.sh' }, { ...raw.templates[0], params: [{ name: 'drain', type: 'bool', default: false, label: 'x' }] }] };
  const errors = catalogue.validateManifest(bad, DIR);
  assert.ok(errors.length >= 3, errors.join('\n'));
});

test('runbook: ci_host_patch_cycle uses the three step kinds and real templates', () => {
  const rb = cat.runbooks.find(r => r.id === 'ci_host_patch_cycle');
  assert.ok(rb);
  assert.deepEqual([...new Set(rb.steps.map(s => s.kind))].sort(), ['github_runner_online', 'script', 'wait_agent']);
  assert.deepEqual(catalogue.validateRunbook(rb, new Set(cat.byId.keys())), []);
  assert.ok(catalogue.validateRunbook({ id: 'x_y', steps: [{ id: 'a', kind: 'script', template: 'nope' }] }, new Set()).length);
});

// ---- static checks on the scripts --------------------------------------------------------------------------------
const allFiles = () => [...cat.templates.map(t => t.file), '_lib.sh', '_lib.ps1'];

test('scripts never interpolate parameters into code and never echo secrets', () => {
  for (const f of allFiles()) {
    const lines = read(f).split('\n');
    lines.forEach((line, n) => {
      const where = `${f}:${n + 1}`;
      if (/^\s*#/.test(line)) return;
      assert.ok(!/\beval\b|Invoke-Expression|\biex\b|Set-PSDebug|^\s*set -[a-z]*x/.test(line), `${where} uses eval or tracing`);
      if (/LABCTL_P_/.test(line)) assert.ok(!/\bbash -c\b|\bsh -c\b|-Command\b|\bsource\b|as_user/.test(line), `${where} passes a parameter into code`);
      if (/LABCTL_SECRET_|Get-Secret/.test(line)) {
        // a print command followed, in the same command, by an expansion of a secret
        assert.ok(!/(\becho\b|\bsay\b|\bwarn\b|\bdie\b|\bSay\b|\bWarn\b|\bDie\b|Write-Host|Write-Output|\bResult\b)[^|;]*(\$\{?LABCTL_SECRET_|Get-Secret)/.test(line), `${where} may print a secret`);
        if (/printf/.test(line)) assert.ok(/\||header =/.test(line), `${where} prints a secret without a pipe`);
      }
    });
  }
});

test('scripts hold no private data: placeholders only, ASCII only', () => {
  const files = [...allFiles(), 'manifest.json', 'runbooks/ci_host_patch_cycle.json'];
  const okIp = /^(127\.0\.0\.1|0\.0\.0\.0|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)$/;
  for (const f of files) {
    const text = read(f);
    assert.ok(!/[^\x00-\x7f]/.test(text), `${f} has non-ASCII characters`);
    for (const ip of text.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) || []) assert.ok(okIp.test(ip), `${f} has an IP address: ${ip}`);
    assert.ok(!/[A-Z]:\\(Users|AI)\\[A-Za-z]|\/home\/[a-z]+\/|@[a-z0-9-]+\.(com|ie|net|org)\b/i.test(text), `${f} has a personal path or address`);
  }
});

// ---- syntax --------------------------------------------------------------------------------------------------------
const haveBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

test('bash -n passes on every .sh template (alone and with the prelude)', t => {
  if (!haveBash) return t.skip('bash is not on PATH');
  const run = text => spawnSync('bash', ['-n'], { input: text, encoding: 'utf8' });
  const lib = run(read('_lib.sh'));
  assert.equal(lib.status, 0, lib.stderr);
  for (const tpl of cat.templates.filter(x => x.shell === 'bash')) {
    for (const text of [read(tpl.file), full(tpl)]) {
      const r = run(text);
      assert.equal(r.status, 0, `${tpl.file}: ${r.stderr}`);
    }
  }
});

test('shellcheck passes when it is installed', t => {
  if (spawnSync('shellcheck', ['--version']).status !== 0) return t.skip('shellcheck is not on PATH, CI runs it');
  // SC2046/SC2086: validated lists are split on purpose. SC2034/SC2154: the prelude defines variables a script may not use.
  const args = ['-s', 'bash', '-S', 'warning', '-e', 'SC2046,SC2086,SC2034,SC2154,SC2155', '-'];
  for (const tpl of cat.templates.filter(x => x.shell === 'bash')) {
    const r = spawnSync('shellcheck', args, { input: full(tpl), encoding: 'utf8' });
    assert.equal(r.status, 0, `${tpl.file}\n${r.stdout}`);
  }
});

function psParser() {
  for (const exe of ['powershell', 'pwsh']) {
    if (spawnSync(exe, ['-NoProfile', '-Command', 'exit 0']).status === 0) return exe;
  }
  return null;
}

test('PowerShell parser passes on every .ps1 template (with the prelude)', t => {
  const exe = psParser();
  if (!exe) return t.skip('neither powershell nor pwsh is on PATH, CI runs it');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'labctl-ps-'));
  try {
    const names = [];
    for (const tpl of cat.templates.filter(x => x.shell === 'powershell')) {
      const name = `${tpl.id}.ps1`;
      fs.writeFileSync(path.join(tmp, name), full(tpl));
      names.push(name);
    }
    fs.writeFileSync(path.join(tmp, '_lib.ps1'), read('_lib.ps1'));
    names.push('_lib.ps1');
    const cmd = '$bad = @(); foreach ($f in Get-ChildItem -LiteralPath $env:LABCTL_PS_DIR -Filter *.ps1) { $e = $null; $k = $null; ' +
      '[void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$k, [ref]$e); ' +
      'foreach ($x in $e) { $bad += ($f.Name + ":" + $x.Extent.StartLineNumber + " " + $x.Message) } }; ' +
      'if ($bad.Count) { $bad -join "`n"; exit 1 } else { "parsed ' + names.length + ' files" }';
    const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', cmd], { env: { ...process.env, LABCTL_PS_DIR: tmp }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ---- the bash prelude, run for real (no machine is touched) ------------------------------------------------------
const lib = read('_lib.sh');
const sh = (snippet, env = {}) => spawnSync('bash', [], { input: `${lib}\n${snippet}\n`, encoding: 'utf8', env: { ...process.env, ...env } });

test('prelude: dry run prints the command and does not run it', t => {
  if (!haveBash) return t.skip('bash is not on PATH');
  const r = sh('run echo REAL_OUTPUT', { LABCTL_P_DRY_RUN: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[dry-run\] echo REAL_OUTPUT/);
  assert.doesNotMatch(r.stdout, /^REAL_OUTPUT$/m);
});

test('prelude: parameter checks reject bad values', t => {
  if (!haveBash) return t.skip('bash is not on PATH');
  assert.notEqual(sh('need_int DAYS "1; rm x"').status, 0);
  assert.equal(sh('need_int DAYS 14').status, 0);
  assert.notEqual(sh('need_match NAME "^[a-z]+$" "a b"').status, 0);
  assert.equal(sh('need_match NAME "^[a-z]+$" "ab"').status, 0);
});

test('prelude: the idle gate stops, forces, or drains and notes a job that starts in the gap', t => {
  if (!haveBash) return t.skip('bash is not on PATH');
  const stub = 'sleep() { :; }\n';
  const busy = `${stub}runner_busy() { return 0; }\nidle_gate; echo PASSED`;
  const stopped = sh(busy);
  assert.notEqual(stopped.status, 0);
  assert.match(stopped.stderr, /Runner\.Worker is active/);
  assert.doesNotMatch(stopped.stdout, /PASSED/);

  const forced = sh(busy, { LABCTL_P_FORCE: '1' });
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stderr, /force is set/);

  // busy, then idle, then busy again after the 5 s re-check, then idle for good
  const drain = `${stub}CALLS=0\nrunner_busy() { CALLS=$((CALLS + 1)); case $CALLS in 1|3) return 0 ;; *) return 1 ;; esac; }\nidle_gate; echo PASSED`;
  const drained = sh(drain, { LABCTL_P_DRAIN: '1' });
  assert.equal(drained.status, 0, drained.stderr);
  assert.match(drained.stdout, /A job started during the 5 s re-check/);
  assert.match(drained.stdout, /PASSED/);

  const timeout = sh(`${stub}runner_busy() { return 0; }\ndate() { echo $((9999999999)); }\nidle_gate`, { LABCTL_P_DRAIN: '1', LABCTL_P_DRAIN_TIMEOUT_MIN: '0' });
  assert.notEqual(timeout.status, 0);
});

test('runner_cleanup dry run lists old workspaces and removes nothing', t => {
  if (!haveBash || process.platform === 'win32') return t.skip('needs a Unix shell');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labctl-runner-'));
  try {
    const dir = path.join(root, 'actions-runner');
    for (const sub of ['_work/oldrepo', '_work/newrepo', '_work/_temp', '_diag']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    fs.writeFileSync(path.join(dir, '.runner'), '{"agentName":"test-runner","gitHubUrl":"https://example.test/org/repo"}');
    const old = new Date(Date.now() - 30 * 86400000);
    fs.utimesSync(path.join(dir, '_work/oldrepo'), old, old);
    const r = spawnSync('bash', [], { input: `${lib}\n${read('unix/runner_cleanup.sh')}\n`, encoding: 'utf8',
      env: { ...process.env, LABCTL_P_RUNNER_DIR: dir, LABCTL_P_DRY_RUN: '1' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[dry-run\] remove .*oldrepo/);
    assert.doesNotMatch(r.stdout, /remove .*newrepo/);
    assert.ok(fs.existsSync(path.join(dir, '_work/oldrepo')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- API -----------------------------------------------------------------------------------------------------------
async function setup(t) {
  const s = await startApp();
  t.after(() => s.stop());
  const admin = api(s.base, await login(s.base));
  await admin('POST', '/api/users', { username: 'viewer1', password: 'pw-viewer', role: 'viewer' });
  await admin('POST', '/api/users', { username: 'op1', password: 'pw-op', role: 'operator' });
  const op = api(s.base, await login(s.base, 'op1', 'pw-op'));
  const viewer = api(s.base, await login(s.base, 'viewer1', 'pw-viewer'));
  const addHost = (id, hostname, osName = 'linux') => s.ctx.db.prepare("INSERT INTO hosts (id, hostname, os, kind, status) VALUES (?, ?, ?, 'agent', 'offline')").run(id, hostname, osName);
  return { s, admin, op, viewer, addHost };
}

test('GET /api/templates filters by os, kind, category and host', async t => {
  const { s, op, addHost } = await setup(t);
  const names = r => r.data.map(x => x.id);
  assert.ok(names(await op('GET', '/api/templates?os=darwin')).includes('mac_update'));
  assert.ok(!names(await op('GET', '/api/templates?os=darwin')).includes('win_update'));
  assert.ok(names(await op('GET', '/api/templates?kind=proxmox')).includes('pve_status'));
  assert.ok(names(await op('GET', '/api/templates?category=runner&os=windows')).includes('runner_update_win'));
  addHost('h-win', 'win-a.example.test', 'windows');
  const forHost = await op('GET', '/api/templates?host_id=h-win');
  assert.ok(names(forHost).includes('win_update') && !names(forHost).includes('mac_update'));
  assert.ok(forHost.data.every(x => !('file' in x)));
  const one = await op('GET', '/api/templates/mac_update?script=1');
  assert.match(one.data.script, /softwareupdate/);
  assert.equal((await op('GET', '/api/templates/nope')).status, 404);
  assert.ok((await op('GET', '/api/templates/runbooks')).data.some(r => r.id === 'ci_host_patch_cycle'));
  assert.ok(s.ctx.templates.catalogue.templates.length >= REQUIRED_IDS.length);
});

test('run: viewers are refused, unknown targets and wrong OS are rejected', async t => {
  const { viewer, op, addHost } = await setup(t);
  addHost('h1', 'node-a.example.test');
  assert.equal((await viewer('POST', '/api/templates/vps_cleanup/run', { host_ids: ['h1'] })).status, 403);
  assert.equal((await op('POST', '/api/templates/vps_cleanup/run', {})).status, 400);
  assert.equal((await op('POST', '/api/templates/vps_cleanup/run', { host_ids: ['missing'] })).status, 404);
  const wrongOs = await op('POST', '/api/templates/mac_update/run', { host_ids: ['h1'] });
  assert.equal(wrongOs.status, 400);
  assert.equal(wrongOs.data.skipped.length, 1);
  assert.equal((await op('POST', '/api/templates/nope/run', { host_ids: ['h1'] })).status, 404);
});

test('run: creates a job with the script and LABCTL_P_ environment, validates parameters', async t => {
  const { s, op, addHost } = await setup(t);
  addHost('h1', 'node-a.example.test');
  const r = await op('POST', '/api/templates/vps_cleanup/run', { host_ids: ['h1'], params: { DRY_RUN: true, JOURNAL_DAYS: 7 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const job = s.ctx.jobs.get(r.data.jobs[0].job_id);
  assert.equal(job.type, 'template:vps_cleanup');
  assert.equal(job.shell, 'bash');
  assert.equal(job.host_id, 'h1');
  assert.equal(job.actor, 'op1');
  assert.match(job.script, /journalctl --vacuum-time/);
  assert.match(job.script, /LabCTL template prelude/);
  const env = JSON.parse(job.params).env;
  assert.deepEqual(env, { LABCTL_P_DRY_RUN: '1', LABCTL_P_JOURNAL_DAYS: '7' });

  for (const bad of [{ NOPE: 1 }, { JOURNAL_DAYS: 'x; reboot' }, { DRY_RUN: 'maybe' }, { JOURNAL_DAYS: -1 }]) {
    assert.equal((await op('POST', '/api/templates/vps_cleanup/run', { host_ids: ['h1'], params: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await op('POST', '/api/templates/traefik_restart/run', { host_ids: ['h1'], confirm: 'node-a.example.test', params: { MODE: 'kubernetes' } })).status, 400);
  assert.equal((await op('POST', '/api/templates/vps_cert_expiry/run', { host_ids: ['h1'], params: { DOMAINS: 'a.example.test\nb' } })).status, 400);
  const audit = s.ctx.audit.query({ action: 'template.run' });
  assert.ok(audit.rows.some(a => a.host_id === 'h1'));
});

test('guards: guard:true and force need the typed host name', async t => {
  const { s, op, addHost } = await setup(t);
  addHost('h1', 'node-a.example.test');
  addHost('h2', 'node-b.example.test');
  const run = (id, body) => op('POST', `/api/templates/${id}/run`, body);

  assert.equal((await run('traefik_restart', { host_ids: ['h1'] })).status, 400);
  const wrong = await run('traefik_restart', { host_ids: ['h1'], confirm: 'node-b.example.test' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.data.confirm_required, true);
  assert.equal((await run('traefik_restart', { host_ids: ['h1'], confirm: 'node-a.example.test' })).status, 200);
  // several hosts: the template id is the word
  assert.equal((await run('traefik_restart', { host_ids: ['h1', 'h2'], confirm: 'node-a.example.test' })).status, 400);
  assert.equal((await run('traefik_restart', { host_ids: ['h1', 'h2'], confirm: 'traefik_restart' })).status, 200);
  // an unguarded template needs no confirmation
  assert.equal((await run('vps_cleanup', { host_ids: ['h1'] })).status, 200);

  // force: confirmation first, then drain support
  assert.equal((await run('runner_restart', { host_ids: ['h1'], force: true })).status, 400);
  const forced = await run('runner_restart', { host_ids: ['h1'], force: true, confirm: 'node-a.example.test' });
  assert.equal(forced.status, 200);
  assert.equal(JSON.parse(s.ctx.jobs.get(forced.data.jobs[0].job_id).params).env.LABCTL_P_FORCE, '1');
  const noDrain = await run('vps_cleanup', { host_ids: ['h1'], force: true, confirm: 'node-a.example.test' });
  assert.equal(noDrain.status, 400);
  assert.match(noDrain.data.error, /no drain option/);
  assert.equal((await run('vps_cleanup', { host_ids: ['h1'], drain: true })).status, 400);
});

test('drain: sets LABCTL_P_DRAIN and lengthens the timeout', async t => {
  const { s, op, addHost } = await setup(t);
  addHost('h1', 'node-a.example.test');
  const r = await op('POST', '/api/templates/runner_restart/run', { host_ids: ['h1'], drain: true, params: { ACTION: 'stop', DRAIN_TIMEOUT_MIN: 30 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const job = s.ctx.jobs.get(r.data.jobs[0].job_id);
  const env = JSON.parse(job.params).env;
  assert.equal(env.LABCTL_P_DRAIN, '1');
  assert.equal(env.LABCTL_P_ACTION, 'stop');
  assert.ok(job.timeout_s >= 30 * 60 + 1800);
  assert.equal(env.LABCTL_P_FORCE, undefined);
});

test('targets: group and tag select hosts', async t => {
  const { s, op, addHost } = await setup(t);
  addHost('h1', 'node-a.example.test'); addHost('h2', 'node-b.example.test'); addHost('h3', 'node-c.example.test');
  const db = s.ctx.db;
  db.prepare("INSERT INTO groups (id, name, ord) VALUES ('g1', 'ci', 0)").run();
  db.prepare("INSERT INTO host_groups (host_id, group_id) VALUES ('h1', 'g1')").run();
  db.prepare("UPDATE hosts SET group_id = 'g1' WHERE id = 'h2'").run();
  db.prepare("INSERT INTO tags (id, name) VALUES ('t1', 'edge')").run();
  db.prepare("INSERT INTO host_tags (host_id, tag_id) VALUES ('h3', 't1')").run();
  const byGroup = await op('POST', '/api/templates/vps_cleanup/run', { group: 'ci' });
  assert.deepEqual(byGroup.data.jobs.map(j => j.host_id).sort(), ['h1', 'h2']);
  const byTag = await op('POST', '/api/templates/vps_cleanup/run', { tag: 'edge' });
  assert.deepEqual(byTag.data.jobs.map(j => j.host_id), ['h3']);
  assert.equal((await op('POST', '/api/templates/vps_cleanup/run', { group: 'nope' })).status, 404);
});

test('admin only templates: runner_remove needs the admin role, the confirmation and a credential', async t => {
  const { s, admin, op, addHost } = await setup(t);
  addHost('h1', 'node-a.example.test');
  s.ctx.db.prepare("INSERT INTO credentials (id, host_id, name, purpose, kind, sealed) VALUES ('c1', NULL, 'remove token', 'runner', 'token', ?)")
    .run(s.ctx.crypto.sealJson({ password: 'removal-token-value' }));
  const body = { host_ids: ['h1'], confirm: 'node-a.example.test', params: { RUNNER_DIR: '/opt/actions-runner-demo' }, secrets: { REMOVE_TOKEN: 'c1' } };
  assert.equal((await op('POST', '/api/templates/runner_remove/run', body)).status, 403);
  assert.equal((await admin('POST', '/api/templates/runner_remove/run', { ...body, confirm: 'x' })).status, 400);
  assert.equal((await admin('POST', '/api/templates/runner_remove/run', { ...body, secrets: {} })).status, 400);
  assert.equal((await admin('POST', '/api/templates/runner_remove/run', body)).status, 200);
});

test('secrets reach the agent only in the run_job frame and are never stored', async t => {
  const { s, admin, op, addHost } = await setup(t);
  const SECRET = 'registration-token-value-1234';
  s.ctx.db.prepare("INSERT INTO credentials (id, host_id, name, purpose, kind, sealed) VALUES ('c1', NULL, 'reg token', 'runner', 'token', ?)")
    .run(s.ctx.crypto.sealJson({ token: SECRET }));
  addHost('h-secret', 'runner-a.example.test');
  const tok = await admin('POST', '/api/tokens', { label: 'test' });
  const ws = await wsOpen(s.port, tok.data.value);
  const frames = [];
  ws.on('message', d => frames.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify({ type: 'register', host_id: 'h-secret', hostname: 'runner-a.example.test', os: 'linux', kind: 'agent', agent_version: '2.0.0', info: {} }));
  await waitFor(() => s.ctx.agents.isOnline('h-secret'));

  assert.equal((await op('POST', '/api/templates/runner_reregister/run', { host_ids: ['h-secret'] })).status, 400); // secret required
  assert.equal((await op('POST', '/api/templates/runner_reregister/run', { host_ids: ['h-secret'], secrets: { REG_TOKEN: 'nope' } })).status, 404);
  assert.equal((await op('POST', '/api/templates/runner_reregister/run', { host_ids: ['h-secret'], secrets: { OTHER: 'c1' } })).status, 400);

  const r = await op('POST', '/api/templates/runner_reregister/run', { host_ids: ['h-secret'], secrets: { REG_TOKEN: 'c1' }, params: { LABELS: 'self-hosted,linux', DRY_RUN: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const frame = await waitFor(() => frames.find(f => f.type === 'run_job'));
  assert.equal(frame.job_id, r.data.jobs[0].job_id);
  assert.equal(frame.shell, 'bash');
  assert.equal(frame.env.LABCTL_SECRET_REG_TOKEN, SECRET);
  assert.equal(frame.env.LABCTL_P_LABELS, 'self-hosted,linux');
  assert.equal(frame.env.LABCTL_P_DRY_RUN, '1');
  assert.ok(!frame.script.includes(SECRET));

  const everything = JSON.stringify([
    s.ctx.db.prepare('SELECT * FROM jobs').all(),
    s.ctx.db.prepare('SELECT * FROM audit_log').all(),
    s.ctx.joblog.read(frame.job_id)
  ]);
  assert.ok(!everything.includes(SECRET), 'the secret leaked into the database, audit log or job log');
  assert.deepEqual(s.ctx.templateSecrets.take(frame.job_id), {}); // already sent, nothing held
  ws.close();
  await waitFor(() => !s.ctx.agents.isOnline('h-secret')); // let the server finish its close handling before the database closes
});
