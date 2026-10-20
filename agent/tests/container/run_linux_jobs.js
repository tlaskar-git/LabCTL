#!/usr/bin/env node
// Container test for typed v1 jobs on a real Linux agent. Uses the run_linux_setup.js harness: a throwaway LabCTL
// server and a debian:12 container that installs the agent with --no-service, then runs typed jobs through the API:
//   list_crons, custom_command ('echo hi; id'), service_control status of a missing service (must fail cleanly),
//   file_browse /etc, backup of a test script, linux_update with a fake apt-get first on PATH (nothing is installed).
// disk_cleanup is not run: v1 had no dry run for it (the script is checked by bash -n in server/test).
// Every container, the network and the temp folder are named labctl-test-<random> and removed at the end.
// Run: node agent/tests/container/run_linux_jobs.js   Env: LABCTL_TEST_SSH_HOST=<ssh host alias with docker>
'use strict';
const h = require('./run_linux_setup');

const IMAGE = process.env.LABCTL_TEST_IMAGE || 'debian:12';
const FAKE_APT = "printf '#!/bin/sh\\necho \"fake apt-get $*\"\\n' > /usr/local/sbin/apt-get && chmod +x /usr/local/sbin/apt-get";

async function run(srv, hostId, type, params) {
  const call = async (method, p, body) => (await fetch(srv.api + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${srv.session}` },
    body: body ? JSON.stringify(body) : undefined })).json();
  const { id } = await call('POST', '/api/jobs', { host_id: hostId, type, params });
  return h.waitFor(async () => { const j = await call('GET', `/api/jobs/${id}`); return ['completed', 'failed', 'cancelled'].includes(j.status) && j; }, 300000, `${type} to finish`);
}

async function main() {
  const mode = h.connect();
  if (!mode) { h.log('SKIPPED: neither local docker nor the ssh docker host (LABCTL_TEST_SSH_HOST) is reachable.'); return 0; }
  h.log(`docker via ${mode}, run id ${h.P}`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => h.cleanup().finally(() => process.exit(130)));
  const results = [];
  let failed = false;
  try {
    await h.copyRepo();
    const srv = await h.startServer();
    const name = `${h.P}-jobs`;
    const setup = 'set -o pipefail; curl -fsSL "$LABCTL_URL/install/linux.sh?token=$LABCTL_TOKEN" | bash -s -- --no-service';
    const boot = `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq curl ca-certificates procps >/dev/null && { ${setup}; echo SETUP_EXIT=$?; }; sleep 1800`;
    const r = h.docker(['run', '-d', '--name', name, '--hostname', name, '--network', h.NET, '-e', `LABCTL_URL=http://${h.SRV}:7700`, '-e', `LABCTL_TOKEN=${srv.enrol}`, IMAGE, 'bash', '-c', boot]);
    if (r.code !== 0) throw new Error(`could not start ${IMAGE}: ${r.err}`);
    h.containers.push(name);
    await h.waitFor(() => /SETUP_EXIT=0/.test(h.docker(['logs', name]).out), 420000, 'agent setup');
    const host = await h.waitFor(async () => (await (await fetch(`${srv.api}/api/hosts`, { headers: { authorization: `Bearer ${srv.session}` } })).json()).find(x => x.hostname === name && x.online), 120000, 'the agent to register');
    h.exec(name, `printf '#!/bin/bash\\necho backup-ran\\n' > /root/test-backup.sh && ${FAKE_APT}`);

    const ok = j => j.status === 'completed' && j.exit_code === 0 && j.bytes_received > 0;
    const cases = [
      ['list_crons', {}, j => ok(j) && /=== Root crontab ===/.test(j.result) && /=== Systemd timers ===/.test(j.result)],
      ['custom_command', { command: 'echo hi; id' }, j => ok(j) && /^hi$/m.test(j.result) && /uid=0\(root\)/.test(j.result)],
      ['service_control', { service: 'labctl-no-such-service', action: 'status' }, j => j.status === 'failed' && j.exit_code !== 0 && j.bytes_received > 0],
      ['file_browse', { path: '/etc' }, j => ok(j) && /passwd/.test(j.result) && /^d/m.test(j.result)],
      ['backup', { script: '/root/test-backup.sh' }, j => ok(j) && /backup-ran/.test(j.result) && /Exit code: 0/.test(j.result)],
      ['linux_update', { reboot: false }, j => ok(j) && /fake apt-get update/.test(j.result) && /fake apt-get .*upgrade -y/.test(j.result) && /fake apt-get autoremove -y/.test(j.result)]
    ];
    for (const [type, params, check] of cases) {
      const j = await run(srv, host.id, type, params);
      const pass = check(j);
      if (!pass) failed = true;
      results.push(`${pass ? 'PASS' : 'FAIL'} ${type}: status ${j.status}, exit ${j.exit_code}, ${j.bytes_received} bytes, first line: ${String(j.result).split('\n').find(l => l.trim()) || '-'}` +
        (pass ? '' : `\n${String(j.result).slice(-1500)}\n${j.error || ''}`));
    }
  } catch (e) {
    failed = true;
    results.push('FAIL ' + e.message);
  } finally {
    await h.cleanup();
  }
  results.forEach(x => h.log(x));
  return failed ? 1 : 0;
}

main().then(code => process.exit(code));
