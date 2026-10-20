// Typed v1 jobs run on v2 agents: translation to run_job scripts, secrets, the stale 'sent' sweeper, offline hosts,
// schedules and the stored result. Real shells check the scripts when they exist (bash -n, the PowerShell parser).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const legacy = require('../src/legacy-jobs');
const { OFFLINE } = require('../src/jobs');
const { startApp, login, api, wsOpen, waitFor } = require('./helpers');

const OSES = ['linux', 'darwin', 'windows'];
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const psExe = ['pwsh', 'powershell'].find(e => spawnSync(e, ['-NoProfile', '-Command', 'exit 0']).status === 0);

test('every typed job translates for every OS, with params only in the environment', () => {
  for (const type of Object.keys(legacy.TYPES)) {
    for (const os of OSES) {
      const t = legacy.translate(type, { path: '/labctl-param-x', delay: 30, reboot: true, options: ['tmp', 'journal'] }, os);
      assert.equal(t.shell, os === 'windows' ? 'powershell' : 'bash', `${type} ${os}`);
      assert.ok(t.timeout_s > 0);
      assert.equal(t.env.LABCTL_P_DELAY, '30');
      assert.equal(t.env.LABCTL_P_REBOOT, '1');
      assert.equal(t.env.LABCTL_P_OPTIONS, 'tmp\njournal');
      assert.ok(!t.script.includes('/labctl-param-x'), `${type} ${os}: a param value reached the script text`);
    }
  }
  assert.equal(legacy.translate('no_such_type', {}, 'linux'), null);
  assert.match(legacy.translate('list_crons', {}, 'linux').script, /crontab -l/);
  assert.match(legacy.translate('list_crons', {}, 'linux').script, /list-timers/);
  assert.match(legacy.translate('list_crons', {}, 'darwin').script, /launchctl list/);
  assert.match(legacy.translate('list_crons', {}, 'windows').script, /LABCTL_RESULT_JSON/);
  assert.match(legacy.translate('custom_command', {}, 'linux').script, /exec bash -c "\$LABCTL_P_COMMAND"/);
  assert.match(legacy.translate('custom_command', {}, 'windows').script, /cmd\.exe \/d \/c '%LABCTL_P_COMMAND%'/);
  assert.match(legacy.translate('linux_update', {}, 'linux').script, /apt-get update[\s\S]*dnf -y upgrade[\s\S]*yum -y update[\s\S]*zypper/);
  assert.match(legacy.translate('autologin', {}, 'windows').script, /LABCTL_SECRET_PASSWORD/);
  assert.equal(legacy.translate('custom_command', { command: 'x', timeout: 42 }, 'linux').timeout_s, 42);
  // Windows-only and Unix-only types fail with a clear message on the other family.
  const wrong = legacy.translate('windows_update', {}, 'linux');
  assert.match(wrong.script, /only supported on Windows/);
  assert.match(legacy.translate('backup', {}, 'windows').script, /only supported on Linux and macOS/);
  // Server-only keys never become environment variables.
  assert.deepEqual(Object.keys(legacy.paramEnv({ _wait_for: 'j', credential_id: 'c', password: 'p', env: {}, 'bad-name': 1, ok: 'y' })), ['LABCTL_P_OK']);
});

test('injection: quotes, semicolons and $(...) only travel in the environment', () => {
  const evil = `'; rm -rf / ; echo "$(id)" \`id\` %PATH% & del C:\\x`;
  for (const type of Object.keys(legacy.TYPES)) {
    for (const os of OSES) {
      const plain = legacy.translate(type, { command: 'x', service: 'x', path: 'x', script: 'x', container: 'x' }, os);
      const hostile = legacy.translate(type, { command: evil, service: evil, path: evil, script: evil, container: evil }, os);
      assert.equal(hostile.script, plain.script, `${type} ${os}`);
      assert.equal(hostile.env.LABCTL_P_COMMAND, evil);
    }
  }
});

test('bash scripts parse (bash -n)', { skip: !hasBash && 'bash is not installed here; CI runs it' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labctl-legacy-'));
  try {
    for (const type of Object.keys(legacy.TYPES)) {
      for (const fam of ['linux', 'darwin']) {
        const f = path.join(dir, `${type}-${fam}.sh`);
        fs.writeFileSync(f, legacy.translate(type, {}, fam).script);
        const r = spawnSync('bash', ['-n', f.replace(/\\/g, '/')], { encoding: 'utf8' });
        assert.equal(r.status, 0, `${type} ${fam}: ${r.stderr}`);
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PowerShell scripts parse', { skip: !psExe && 'PowerShell is not installed here; CI runs it' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labctl-legacy-'));
  try {
    for (const type of Object.keys(legacy.TYPES)) fs.writeFileSync(path.join(dir, `${type}.ps1`), legacy.translate(type, {}, 'windows').script);
    const check = "$bad = 0; Get-ChildItem -LiteralPath $env:LABCTL_DIR -Filter *.ps1 | ForEach-Object { $e = $null; " +
      "[void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$e); " +
      "if ($e.Count) { $bad++; Write-Output ($_.Name + ': ' + $e[0].Message) } }; exit $bad";
    const r = spawnSync(psExe, ['-NoProfile', '-NonInteractive', '-Command', check], { encoding: 'utf8', env: { ...process.env, LABCTL_DIR: dir } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('resultText: the LABCTL_RESULT_JSON line, else the output, only for result types', () => {
  assert.equal(legacy.resultText('list_crons', 'table\nLABCTL_RESULT_JSON [{"TaskName":"a"}]\n'), '[{"TaskName":"a"}]');
  assert.equal(legacy.resultText('file_browse', 'drwx a\n'), 'drwx a\n');
  assert.equal(legacy.resultText('custom_command', 'x'), null);
});

async function setup(t) {
  const s = await startApp();
  s.sockets = [];
  t.after(async () => {
    await Promise.all(s.sockets.map(w => new Promise(r => { if (w.readyState === 3) return r(); w.on('close', r); w.close(); })));
    await new Promise(r => setTimeout(r, 50));
    await s.stop();
  });
  const token = await login(s.base);
  const admin = api(s.base, token);
  const enrol = (await admin('POST', '/api/tokens', { label: 'legacy-test' })).data.value;
  // A fake agent that records every frame.
  s.agent = async (id, osName = 'linux') => {
    const ws = await wsOpen(s.port, enrol);
    s.sockets.push(ws);
    ws.frames = [];
    ws.on('message', d => ws.frames.push(JSON.parse(d.toString())));
    ws.send(JSON.stringify({ type: 'register', host_id: id, hostname: `${id}.example.test`, os: osName, kind: 'agent', agent_version: '2.0.0', info: {} }));
    await waitFor(() => s.ctx.agents.isOnline(id));
    return ws;
  };
  return { s, admin };
}
const frameFor = (ws, id) => ws.frames.find(f => (f.job_id || f.job?.id) === id);

test('typed jobs reach a v2 agent as run_job; unknown types keep the v1 frame; result is stored', async t => {
  const { s, admin } = await setup(t);
  const ws = await s.agent('h-lin');
  const job = await admin('POST', '/api/jobs', { host_id: 'h-lin', type: 'list_crons' });
  const frame = await waitFor(() => frameFor(ws, job.data.id));
  assert.equal(frame.type, 'run_job');
  assert.equal(frame.shell, 'bash');
  assert.match(frame.script, /crontab -l/);
  assert.equal(s.ctx.jobs.get(job.data.id).script, null);
  assert.ok(s.ctx.jobs.get(job.data.id).sent_at);
  ws.send(JSON.stringify({ type: 'job_output', job_id: job.data.id, seq: 0, stream: 'stdout', chunk: '=== Root crontab ===\n0 1 * * * /x\n' }));
  ws.send(JSON.stringify({ type: 'job_complete', job_id: job.data.id, status: 'success', exit_code: 0, duration_ms: 5 }));
  await waitFor(() => s.ctx.jobs.get(job.data.id).status === 'completed');
  const list = await admin('GET', '/api/jobs?host_id=h-lin');
  assert.match(list.data[0].result, /0 1 \* \* \* \/x/);

  const win = await s.agent('h-win', 'windows');
  const fb = await admin('POST', '/api/jobs', { host_id: 'h-win', type: 'list_crons' });
  assert.equal((await waitFor(() => frameFor(win, fb.data.id))).shell, 'powershell');
  const json = JSON.stringify([{ TaskName: 'T'.repeat(5000), State: 'Ready' }]);
  win.send(JSON.stringify({ type: 'job_output', job_id: fb.data.id, seq: 0, stream: 'stdout', chunk: `table\nLABCTL_RESULT_JSON ${json}\n` }));
  win.send(JSON.stringify({ type: 'job_complete', job_id: fb.data.id, status: 'success', exit_code: 0, duration_ms: 5 }));
  await waitFor(() => s.ctx.jobs.get(fb.data.id).status === 'completed');
  // The list endpoint (log tail only) still returns the whole parsed result, also with ?log=0.
  assert.equal((await admin('GET', '/api/jobs?host_id=h-win')).data[0].result, json);
  assert.equal((await admin('GET', `/api/jobs/${fb.data.id}?log=0`)).data.result, json);

  const odd = await admin('POST', '/api/jobs', { host_id: 'h-lin', type: 'made_up_type' });
  assert.equal((await waitFor(() => frameFor(ws, odd.data.id))).type, 'job');
});

test('autologin: the password is sealed, travels only in the run_job env, and is never stored or logged', async t => {
  const { s, admin } = await setup(t);
  const ws = await s.agent('h-win', 'windows');
  const secret = 'Pw-Example-123';
  const r = await admin('POST', '/api/jobs/batch', { host_ids: ['h-win'], type: 'autologin', params: { username: 'tester', password: secret, domain: 'EXAMPLE' } });
  const id = r.data[0].id;
  const frame = await waitFor(() => frameFor(ws, id));
  assert.equal(frame.type, 'run_job');
  assert.equal(frame.env.LABCTL_SECRET_PASSWORD, secret);
  assert.equal(frame.env.LABCTL_P_USERNAME, 'tester');
  assert.equal(frame.env.LABCTL_P_DOMAIN, 'EXAMPLE');
  assert.ok(!frame.script.includes(secret));
  const row = s.ctx.jobs.get(id);
  assert.ok(!JSON.stringify(row).includes(secret));
  assert.ok(JSON.parse(row.params).credential_id);
  const dump = s.ctx.db.prepare("SELECT group_concat(detail) AS d FROM audit_log").get().d || '';
  assert.ok(!dump.includes(secret));
  assert.ok(!fs.readdirSync(s.dataDir, { recursive: true }).some(f => {
    const p = path.join(s.dataDir, f);
    return fs.statSync(p).isFile() && !p.endsWith('.db') && !p.includes('.db-') && fs.readFileSync(p, 'utf8').includes(secret);
  }));

  // A schedule-style autologin (no credential_id) uses the host's saved credential.
  const sched = s.ctx.jobs.create({ host_id: 'h-win', type: 'autologin', params: { _credId: 'h-win' } });
  assert.equal((await waitFor(() => frameFor(ws, sched.id))).env.LABCTL_SECRET_PASSWORD, secret);

  // Operators cannot store an auto-login password.
  await admin('POST', '/api/users', { username: 'op1', password: 'pw-operator-1', role: 'operator' });
  const op = api(s.base, await login(s.base, 'op1', 'pw-operator-1'));
  assert.equal((await op('POST', '/api/jobs', { host_id: 'h-win', type: 'autologin', params: { username: 'x', password: 'y' } })).status, 403);
  assert.equal((await op('POST', '/api/jobs/batch', { host_ids: ['h-win'], type: 'autologin', params: { username: 'x', password: 'y' } })).status, 403);
});

test('never silent: offline hosts say why, stale sent jobs fail after the limit, a late result still lands', async t => {
  const { s, admin } = await setup(t);
  const queued = await admin('POST', '/api/jobs', { host_id: 'h-later', type: 'custom_command', params: { command: 'echo hi' } });
  assert.equal(queued.data.status, 'pending');
  assert.equal(s.ctx.jobs.get(queued.data.id).error, OFFLINE);
  const ws = await s.agent('h-later'); // registering dispatches pending jobs
  await waitFor(() => s.ctx.jobs.get(queued.data.id).status === 'sent');
  assert.equal(s.ctx.jobs.get(queued.data.id).error, '');
  assert.equal(frameFor(ws, queued.data.id).type, 'run_job');

  assert.equal(s.ctx.jobs.sweepStale(Date.now() + 60000), 0);
  assert.equal(s.ctx.jobs.sweepStale(Date.now() + 121000), 1);
  const failed = s.ctx.jobs.get(queued.data.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'The agent did not respond within 120 s. Check that the agent is connected and up to date.');

  // A started job is never swept, and the limit follows the job_sent_timeout_s setting.
  const started = await admin('POST', '/api/jobs', { host_id: 'h-later', type: 'list_crons' });
  await waitFor(() => frameFor(ws, started.data.id));
  ws.send(JSON.stringify({ type: 'job_started', job_id: started.data.id }));
  await waitFor(() => s.ctx.jobs.get(started.data.id).status === 'running');
  s.ctx.settings.set?.('job_sent_timeout_s', 5);
  assert.equal(s.ctx.jobs.sweepStale(Date.now() + 999000), 0);

  ws.send(JSON.stringify({ type: 'job_complete', job_id: queued.data.id, status: 'success', exit_code: 0, duration_ms: 5 }));
  await waitFor(() => s.ctx.jobs.get(queued.data.id).status === 'completed');
});

test('schedules create typed jobs that go out as run_job', async t => {
  const { s } = await setup(t);
  const ws = await s.agent('h-sch');
  const past = new Date(Date.now() - 1000).toISOString();
  s.ctx.db.prepare(`INSERT INTO schedules (id, name, host_id, type, params, cron, enabled, next_run, created_at)
    VALUES ('s1', 'Crons', 'h-sch', 'list_crons', '{}', '* * * * *', 1, ?, ?)`).run(past, past);
  s.ctx.scheduler.tick(new Date());
  const job = await waitFor(() => s.ctx.db.prepare("SELECT * FROM jobs WHERE schedule_id = 's1'").get());
  const frame = await waitFor(() => frameFor(ws, job.id));
  assert.equal(frame.type, 'run_job');
  assert.match(frame.script, /crontab -l/);
});
