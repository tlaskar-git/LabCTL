'use strict';
// Windows deploy launcher, run for real against local PowerShell: a fake remote session executes every generated
// snippet in powershell.exe (stdin, as over OpenSSH), with the work folder in a temp dir instead of ProgramData.
// First launch is the hidden Start-Process child; the fallback runs with useTask: false, so it goes to WMI and no
// scheduled task is created. Skipped where powershell.exe is missing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const windows = require('../src/deploy/windows');

const PS = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '1'], { windowsHide: true }).status === 0;
const SKIP = PS ? false : 'powershell.exe is not available on this machine';
const TOKEN = 'TOKEN-VALUE-windows-0123456789';
const AGENT_DIR = path.join(__dirname, '..', '..', 'agent');

const ps = (args, input) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', ...args], { input, encoding: 'utf8', windowsHide: true });

function localSession({ drop } = {}) {
  const scripts = [];
  return { scripts, chunk: 400000, transport: 'ssh', hostKey: null, close: async () => {},
    async run(script) {
      scripts.push(script);
      const fake = drop && drop(script); // a launch the "host" swallows: it answers but never runs the wrapper
      if (typeof fake === 'string') return fake;
      const r = ps(['-Command', '-'], script);
      return r.stdout.trim() || r.stderr.trim();
    } };
}

const dummy = body => `param([string]$ServerUrl, [string]$Token, [switch]$Uninstall)\r\n${body}\r\n`;

function harness(t, setup) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labctl-test-windeploy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = [];
  const h = { id: `t${Date.now().toString(16)}`, mode: 'install', server: 'https://labctl.example.test', token: TOKEN, phase: () => {},
    log: l => logs.push(l), out: c => logs.push(...String(c).split(/\r?\n/).filter(Boolean)), lastLine: () => logs.at(-1),
    file: name => (name === 'setup-windows.ps1' ? dummy(setup) : 'print("dummy agent")\n') };
  return { root, logs, h, dir: path.join(root, `labctl-deploy-${h.id}`) };
}
const target = { os: 'windows', address: '192.0.2.90', port: 22, user: 'Administrator' };
const noToken = (logs, err) => assert.ok(![...logs, err?.message || ''].some(l => l.includes(TOKEN)), 'the token never reaches the log');

test('windows launcher: success writes the wrapper line first, streams the lines and removes the folder', { skip: SKIP }, async t => {
  const { root, logs, h, dir } = harness(t, "Write-Output 'dummy step one'\r\nWrite-Host 'dummy step two'\r\nexit 0");
  const res = await windows.install(target, h, { pollMs: 300, root, useTask: false, open: async () => localSession() });
  assert.equal(res.transport, 'ssh');
  const run = logs.filter(l => /wrapper started|dummy step/.test(l));
  assert.match(run[0], /^wrapper started as .+, elevated=(True|False), psversion=\d+\.\d+/);
  assert.deepEqual(run.slice(1), ['dummy step one', 'dummy step two']);
  assert.ok(logs.includes('Starting the setup script (hidden process)'));
  assert.ok(!logs.some(l => /did not start|WMI|scheduled task/.test(l)), 'no fallback when the hidden process starts');
  assert.ok(logs.some(l => /^Signed in as .+, elevated=/.test(l)));
  assert.ok(!fs.existsSync(dir), 'work folder removed');
  noToken(logs);
});

test('windows launcher: a non-zero exit fails with the code and the last line, and still cleans up', { skip: SKIP }, async t => {
  const { root, logs, h, dir } = harness(t, "Write-Output 'dummy failing step'\r\nexit 3");
  const err = await windows.install(target, h, { pollMs: 300, root, useTask: false, open: async () => localSession() }).catch(e => e);
  assert.match(err.message, /^The setup script exited with code 3\. Last line: dummy failing step$/);
  assert.ok(logs.includes('dummy failing step'));
  assert.ok(!fs.existsSync(dir));
  noToken(logs, err);
});

test('windows launcher: a thrown error ends as exit 1 with an ERROR line (uninstall mode)', { skip: SKIP }, async t => {
  const { root, logs, h } = harness(t, "if (-not $Uninstall) { exit 9 }\r\nthrow 'Run this script in an elevated PowerShell (Run as administrator).'");
  h.mode = 'uninstall';
  const err = await windows.install(target, h, { pollMs: 300, root, useTask: false, open: async () => localSession() }).catch(e => e);
  assert.match(err.message, /exited with code 1\. Last line: ERROR: Run this script in an elevated PowerShell/);
  noToken(logs, err);
});

test('windows launcher: a hidden process that never writes falls back to the next launcher, which runs the setup', { skip: SKIP }, async t => {
  const { root, logs, h, dir } = harness(t, "Write-Output 'dummy via fallback'\r\nexit 0");
  await windows.install(target, h, { pollMs: 300, startMs: 1500, root, useTask: false,
    open: async () => localSession({ drop: s => (s.includes('Start-Process') ? 'PID=0' : null) }) });
  const i = logs.indexOf('The hidden process did not start, trying a scheduled task');
  assert.ok(i > 0, logs.join('\n'));
  assert.match(logs[i + 1], /^Started the setup through WMI \(process \d+\)\. The scheduled task was not used: not tried$/);
  assert.ok(logs.includes('dummy via fallback'));
  assert.ok(!fs.existsSync(dir));
  noToken(logs);
});

test('windows launcher: run.log that never appears after either launch fails fast with what each launcher saw', { skip: SKIP }, async t => {
  const { root, logs, h, dir } = harness(t, 'exit 0');
  const started = Date.now();
  const err = await windows.install(target, h, { pollMs: 300, startMs: 1500, root, useTask: false,
    open: async () => localSession({ drop: s => (s.includes('Start-Process') ? 'PID=0' : s.includes('Win32_Process -MethodName Create') ? 'LAUNCH=wmi\nPID=0\nTASKERR=not tried' : null) }) }).catch(e => e);
  assert.ok(Date.now() - started < 30000);
  assert.ok(logs.includes('The hidden process did not start, trying a scheduled task'));
  assert.match(err.message, /^The setup script did not start: run\.log did not appear within 2 s of each launch\. Tried: hidden process \(Start-Process\) with no PID ended, then WMI Win32_Process\.Create, process 0 ended \(the scheduled task was not used: not tried\)\./);
  assert.match(err.message, /Session: .+, elevated=(True|False), high integrity=(True|False), PowerShell \d/);
  assert.match(err.message, /Likely cause: .+ Fallback: run the one-line installer/);
  assert.ok(!fs.existsSync(dir));
  noToken(logs, err);
});

test('windows launcher: silence gets a notice with the last line, and the overall limit still applies', { skip: SKIP }, async t => {
  const { root, logs, h } = harness(t, "Write-Output 'dummy first'\r\nStart-Sleep -Seconds 10\r\nWrite-Output 'dummy after the pause'\r\nexit 0");
  await windows.install(target, h, { pollMs: 300, quietMs: 3000, root, useTask: false, open: async () => localSession() });
  assert.ok(logs.some(l => l === 'No output for 3 s. Last line: dummy first'), logs.join('\n'));
  assert.ok(logs.includes('dummy after the pause'));

  const h2 = harness(t, "Write-Output 'dummy stuck'\r\nStart-Sleep -Seconds 30\r\nexit 0");
  const err = await windows.install(target, h2.h, { pollMs: 300, maxMs: 4000, root: h2.root, useTask: false, open: async () => localSession() }).catch(e => e);
  assert.match(err.message, /^The setup script did not finish within 4 s\. Last line: dummy stuck$/);
  assert.ok(!fs.existsSync(h2.dir), 'folder removed and the wrapper stopped');
});

test('windows launcher: every generated script and the setup script parse cleanly', { skip: SKIP }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labctl-test-winparse-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scripts = { wrap: windows.WRAP_PS1, prepare: windows.wrap(windows.prepareScript('abc', null)),
    start: windows.wrap(windows.startScript('abc', null)), kill: windows.wrap(windows.killScript('abc', null, 42)),
    taskLaunch: windows.wrap(windows.launchScript('abc', null, true)), wmiLaunch: windows.wrap(windows.launchScript('abc', 'C:\\x y', false)),
    poll: windows.wrap(windows.pollScript('abc', null, 3)), diag: windows.wrap(windows.diagScript('abc', null, 42)),
    cleanup: windows.wrap(windows.cleanupScript('abc', null, 42)) };
  for (const [name, body] of Object.entries(scripts)) fs.writeFileSync(path.join(dir, `${name}.ps1`), body);
  fs.copyFileSync(path.join(AGENT_DIR, 'setup-windows.ps1'), path.join(dir, 'setup.ps1'));
  const r = ps(['-Command', `Get-ChildItem '${dir}' -Filter *.ps1 | ForEach-Object { $e=$null; [void][Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$null,[ref]$e); foreach($x in $e){ $_.Name+': '+$x.Message } }`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '', 'parse errors');
  for (const [name, body] of Object.entries(scripts)) if (name !== 'wrap') assert.ok(!body.includes('\n'), `${name} is one line`);
});
