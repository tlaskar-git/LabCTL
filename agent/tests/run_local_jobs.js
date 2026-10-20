#!/usr/bin/env node
// Real-agent job test on this machine: starts a throwaway LabCTL server (temp data dir, random key), runs the real
// agent against it with a temp config, then runs typed v1 jobs through the API and checks each one completes with
// output. Windows: list_crons (scheduled tasks), custom_command, service_control (status of a harmless service),
// file_browse of a temp folder, list_task_folders. Linux and macOS: list_crons, custom_command, file_browse.
// Run: node agent/tests/run_local_jobs.js   Env: LABCTL_TEST_PYTHON=<python with websocket-client> (default python)
'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const { createApp } = require(path.join(REPO, 'server', 'src', 'app'));
const PY = process.env.LABCTL_TEST_PYTHON || 'python';
const WIN = process.platform === 'win32';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[local-jobs]', ...a);

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(500); }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'labctl-test-local-'));
  const browse = path.join(tmp, 'browse');
  fs.mkdirSync(path.join(browse, 'sub-folder'), { recursive: true });
  fs.writeFileSync(path.join(browse, 'hello.txt'), 'hello\n');
  const inst = createApp({ dataDir: path.join(tmp, 'data'), masterKey: crypto.randomBytes(32).toString('base64'), quiet: true });
  const port = await inst.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const enrol = inst.ctx.tokens.create('local job test', 'test').value;
  const session = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'LabCTLAdmin', password: 'LabCTL' }) })).json()).token;
  const call = async (method, p, body) => (await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` },
    body: body ? JSON.stringify(body) : undefined })).json();

  const cfg = path.join(tmp, 'agent.json');
  const agentLog = path.join(tmp, 'agent.out');
  const out = fs.openSync(agentLog, 'w');
  const agent = spawn(PY, ['-I', path.join(REPO, 'agent', 'labctl-agent.py'), '--config', cfg, '--server', base, '--token', enrol],
    { stdio: ['ignore', out, out], env: { ...process.env, LABCTL_CONFIG: cfg } });
  const results = [];
  let failed = false;
  try {
    const host = await waitFor(async () => (await call('GET', '/api/hosts')).find(h => h.online), 60000, 'the agent to register');
    log(`agent registered: ${host.hostname} os ${host.os} agent ${host.agent_version}`);
    const cases = WIN ? [
      ['list_crons', {}, j => { const t = JSON.parse(j.result); return Array.isArray(t) && t.length > 0 && t[0].TaskName ? `${t.length} tasks parsed` : null; }],
      ['custom_command', { command: 'echo hi & whoami' }, j => (/hi/.test(j.result) ? 'cmd output seen' : null)],
      ['custom_command', { command: 'Write-Output "ps $($PSVersionTable.PSVersion.Major)"', shell: 'powershell' }, j => (/ps \d/.test(j.result) ? 'PowerShell output seen' : null)],
      ['service_control', { service: 'EventLog', action: 'status' }, j => (/Running/.test(j.result) ? 'EventLog Running' : null)],
      ['file_browse', { path: browse }, j => (/sub-folder/.test(j.result) && /hello\.txt/.test(j.result) ? 'listing has both entries' : null)],
      ['list_task_folders', {}, j => (/\\Microsoft/.test(j.result) ? 'folders listed' : null)]
    ] : [
      ['list_crons', {}, j => (/=== Root crontab ===/.test(j.result) ? 'sections listed' : null)],
      ['custom_command', { command: 'echo hi; id' }, j => (/hi/.test(j.result) && /uid=/.test(j.result) ? 'output seen' : null)],
      ['file_browse', { path: browse }, j => (/sub-folder/.test(j.result) ? 'listing seen' : null)]
    ];
    for (const [type, params, check] of cases) {
      const { id } = await call('POST', '/api/jobs', { host_id: host.id, type, params });
      const job = await waitFor(async () => { const j = await call('GET', `/api/jobs/${id}`); return ['completed', 'failed', 'cancelled'].includes(j.status) && j; }, 180000, `${type} to finish`);
      const note = job.status === 'completed' && job.exit_code === 0 && job.bytes_received > 0 ? check(job) : null;
      if (!note) failed = true;
      results.push(`${note ? 'PASS' : 'FAIL'} ${type}: status ${job.status}, exit ${job.exit_code}, ${job.bytes_received} bytes${note ? `, ${note}` : `\n${String(job.result).slice(0, 800)}\n${job.error || ''}`}`);
    }
  } catch (e) {
    failed = true;
    results.push(`FAIL ${e.message}\n${fs.readFileSync(agentLog, 'utf8').split('\n').slice(-10).join('\n')}`);
  } finally {
    agent.kill();
    await sleep(500);
    await inst.close();
    fs.closeSync(out);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  results.forEach(r => log(r));
  return failed ? 1 : 0;
}

main().then(code => process.exit(code));
