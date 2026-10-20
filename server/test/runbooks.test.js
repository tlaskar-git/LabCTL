// Runbooks: definitions, stop-on-failure vs continue, re-run from a failed step, guard confirm, when/wait/GitHub steps.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, login, api, wsOpen, waitFor } = require('./helpers');

// Fake agent behaviour by script text: FAIL fails, RESULT prints a LABCTL_RESULT line, anything else succeeds.
async function setup(t) {
  const s = await startApp();
  s.sockets = [];
  t.after(async () => {
    await Promise.all(s.sockets.map(w => new Promise(r => { if (w.readyState === 3) return r(); w.on('close', r); w.close(); })));
    await new Promise(r => setTimeout(r, 50));
    await s.stop();
  });
  const admin = api(s.base, await login(s.base));
  const enrol = (await admin('POST', '/api/tokens', { label: 'rb' })).data.value;
  const state = { failing: true, ran: [] };
  const connect = async (id, name) => {
    const ws = await wsOpen(s.port, enrol);
    s.sockets.push(ws);
    ws.send(JSON.stringify({ type: 'register', host_id: id, hostname: name, os: 'linux', kind: 'agent', agent_version: '2.0.0', info: {} }));
    ws.on('message', d => {
      const m = JSON.parse(d.toString());
      if (m.type !== 'run_job') return;
      state.ran.push({ host: id, script: m.script, env: m.env });
      const fail = m.script.includes('FAIL') && state.failing;
      const line = m.script.includes('RESULT') ? 'LABCTL_RESULT reboot_required=1\n' : 'done\n';
      ws.send(JSON.stringify({ type: 'job_output', job_id: m.job_id, seq: 1, stream: 'stdout', chunk: line }));
      ws.send(JSON.stringify({ type: 'job_complete', job_id: m.job_id, status: fail ? 'failed' : 'success', exit_code: fail ? 1 : 0, duration_ms: 5 }));
    });
    await waitFor(() => s.ctx.agents.isOnline(id));
    return ws;
  };
  await connect('h1', 'one.example.test');
  return { s, admin, state, connect, enrol };
}

const script = (name, text, extra = {}) => ({ name, kind: 'script', script: text, ...extra });
const create = (admin, name, steps, extra = {}) => admin('POST', '/api/runbooks', { name, steps, ...extra });
async function run(s, admin, rbId, body = { host_ids: ['h1'] }) {
  const r = await admin('POST', `/api/runbooks/${rbId}/run`, body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await s.ctx.runbooks.whenDone(r.data.id);
  return (await admin('GET', `/api/runbook-runs/${r.data.id}`)).data;
}

test('runbook CRUD validates steps and keeps them in order', async (t) => {
  const { admin } = await setup(t);
  assert.equal((await create(admin, 'bad', [])).status, 400);
  assert.equal((await create(admin, 'bad', [{ kind: 'nope' }])).status, 400);
  assert.equal((await create(admin, 'bad', [{ kind: 'script' }])).status, 400);
  assert.equal((await create(admin, 'bad', [{ kind: 'template', template: 'no_such_template' }])).status, 400);
  assert.equal((await create(admin, 'bad', [{ kind: 'sleep', seconds: -1 }])).status, 400);
  const ok = await create(admin, 'Demo', [{ kind: 'note', text: 'hello' }, script('two', 'echo 2'), { kind: 'sleep', seconds: 0 }], { description: 'd' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.steps.map(s => s.kind), ['note', 'script', 'sleep']);
  const put = await admin('PUT', `/api/runbooks/${ok.data.id}`, { steps: [script('only', 'echo 1')] });
  assert.equal(put.data.steps.length, 1);
  assert.equal(put.data.name, 'Demo');
  assert.ok((await admin('GET', '/api/runbooks')).data.some(r => r.id === ok.data.id));
  assert.equal((await admin('DELETE', `/api/runbooks/${ok.data.id}`)).status, 200);
  assert.equal((await admin('GET', `/api/runbooks/${ok.data.id}`)).status, 404);
});

test('stop on failure skips the later steps, continue carries on and ends partial', async (t) => {
  const { s, admin, state } = await setup(t);
  const stop = (await create(admin, 'stop', [script('a', 'echo a'), script('b', 'FAIL'), script('c', 'echo c')])).data;
  const r1 = await run(s, admin, stop.id);
  assert.equal(r1.status, 'failed');
  assert.deepEqual(r1.results.map(x => x.status), ['success', 'failed', 'skipped']);
  assert.ok(r1.results[1].hosts[0].job_id);
  assert.match(r1.results[2].error, /earlier step failed/);
  assert.ok(!state.ran.some(x => x.script === 'echo c'));

  const cont = (await create(admin, 'cont', [script('b', 'FAIL', { on_failure: 'continue' }), script('c', 'echo c')])).data;
  const r2 = await run(s, admin, cont.id);
  assert.equal(r2.status, 'partial');
  assert.deepEqual(r2.results.map(x => x.status), ['failed', 'success']);
  // The step group lets the drawer show the host grid for a step.
  assert.match(r2.results[0].group_id, /^grp-/);
});

test('re-run from a failed step keeps the steps before it and runs the rest', async (t) => {
  const { s, admin, state } = await setup(t);
  const rb = (await create(admin, 'rerun', [script('a', 'echo a'), script('b', 'FAIL'), script('c', 'echo c')])).data;
  const first = await run(s, admin, rb.id);
  assert.equal(first.status, 'failed');
  state.failing = false;
  state.ran.length = 0;
  const re = await admin('POST', `/api/runbook-runs/${first.id}/rerun`, {});
  assert.equal(re.status, 200);
  await s.ctx.runbooks.whenDone(re.data.id);
  const second = (await admin('GET', `/api/runbook-runs/${re.data.id}`)).data;
  assert.equal(second.status, 'completed');
  assert.equal(second.parent_run_id, first.id);
  assert.equal(second.from_step, 1);
  assert.equal(second.results[0].carried, true);
  assert.deepEqual(state.ran.map(x => x.script), ['FAIL', 'echo c']);
  // A completed run has no failed step, and an out-of-range step is refused.
  assert.equal((await admin('POST', `/api/runbook-runs/${second.id}/rerun`, {})).status, 400);
  assert.equal((await admin('POST', `/api/runbook-runs/${first.id}/rerun`, { from_step: 9 })).status, 400);
});

test('a guard:true template needs the typed confirmation (the runbook name)', async (t) => {
  const { s, admin } = await setup(t);
  const cat = s.ctx.templates.catalogue;
  const tpl = cat.templates.find(x => x.guard && x.os.includes('linux') && x.params.every(p => p.default !== undefined) && !x.secrets.some(q => q.required));
  assert.ok(tpl, 'the catalogue has a linux guard template');
  const rb = (await create(admin, 'Guarded run', [{ kind: 'template', name: 'g', template: tpl.id }])).data;
  const refused = await admin('POST', `/api/runbooks/${rb.id}/run`, { host_ids: ['h1'] });
  assert.equal(refused.status, 400);
  assert.equal(refused.data.confirm_required, true);
  assert.equal((await admin('POST', `/api/runbooks/${rb.id}/run`, { host_ids: ['h1'], confirm: 'wrong' })).status, 400);
  const done = await run(s, admin, rb.id, { host_ids: ['h1'], confirm: 'Guarded run' });
  assert.equal(done.status, 'completed');
  assert.equal(s.ctx.jobs.get(done.results[0].hosts[0].job_id).type, `template:${tpl.id}`);
  // An unguarded runbook never asks.
  const plain = (await create(admin, 'plain', [script('a', 'echo a')])).data;
  assert.equal((await run(s, admin, plain.id)).status, 'completed');
  assert.equal((await admin('POST', `/api/runbooks/${plain.id}/run`, {})).status, 400); // hosts are required
});

test('when conditions read LABCTL_RESULT lines from earlier steps; params fill {{NAME}}', async (t) => {
  const { s, admin, state } = await setup(t);
  const rb = (await create(admin, 'when', [
    script('probe', 'RESULT'),
    script('yes', 'echo yes', { when: { reboot_required: true }, params: { who: '{{WHO}}' } }),
    script('no', 'echo no', { when: { reboot_required: false } })
  ], { params: [{ name: 'WHO', default: 'nobody', label: 'Who' }] })).data;
  const r = await run(s, admin, rb.id, { host_ids: ['h1'], params: { WHO: 'sam' } });
  assert.deepEqual(r.results.map(x => x.status), ['success', 'success', 'skipped']);
  assert.equal(state.ran.find(x => x.script === 'echo yes').env.LABCTL_P_WHO, 'sam');
  assert.ok(!state.ran.some(x => x.script === 'echo no'));
  assert.equal((await admin('POST', `/api/runbooks/${rb.id}/run`, { host_ids: ['h1'], params: { NOPE: '1' } })).status, 400);
});

test('github_runner_online fails clearly when the integration is missing and uses it when present', async (t) => {
  const { s, admin } = await setup(t);
  const rb = (await create(admin, 'gh', [{ kind: 'github_runner_online', runner: 'runner-{{N}}', timeout_s: 2 }], { params: [{ name: 'N', default: '1' }] })).data;
  const miss = await run(s, admin, rb.id);
  assert.equal(miss.status, 'failed');
  assert.equal(miss.results[0].error, 'GitHub integration not configured');
  const calls = [];
  s.ctx.github = { runnerOnline: async (host, name, ms) => { calls.push([host.id, name, ms]); return true; } };
  const ok = await run(s, admin, rb.id, { host_ids: ['h1'], params: { N: '7' } });
  assert.equal(ok.status, 'completed');
  assert.deepEqual(calls, [['h1', 'runner-7', 2000]]);
});

test('wait_agent waits for the agent to go away and come back; sleep and note steps run', async (t) => {
  const { s, admin, connect } = await setup(t);
  const rb = (await create(admin, 'wait', [{ kind: 'note', text: 'n' }, { kind: 'sleep', seconds: 0.05 }, { kind: 'wait_agent', timeout_s: 10 }])).data;
  const r = await admin('POST', `/api/runbooks/${rb.id}/run`, { host_ids: ['h1'] });
  await waitFor(() => (s.ctx.runbooks.getRun(r.data.id).results[2].status === 'running'));
  const old = s.sockets[0];
  await new Promise(res => { old.on('close', res); old.close(); });
  await waitFor(() => !s.ctx.agents.isOnline('h1'));
  await connect('h1', 'one.example.test');
  await s.ctx.runbooks.whenDone(r.data.id);
  const done = s.ctx.runbooks.getRun(r.data.id);
  assert.equal(done.status, 'completed', JSON.stringify(done.results));
  assert.deepEqual(done.results.map(x => x.status), ['success', 'success', 'success']);

  const lost = (await create(admin, 'lost', [{ kind: 'wait_agent', timeout_s: 0.4 }])).data;
  const r2 = await run(s, admin, lost.id);
  assert.equal(r2.status, 'failed');
  assert.match(r2.results[0].hosts[0].error, /did not come back/);
});

test('the shipped seed runbook is available', async (t) => {
  const { admin } = await setup(t);
  const fs = require('node:fs');
  const path = require('node:path');
  if (!fs.existsSync(path.join(__dirname, '..', 'src', 'templates', 'runbooks', 'ci_host_patch_cycle.json'))) return t.skip('seed runbook file absent');
  const rb = await admin('GET', '/api/runbooks/ci_host_patch_cycle');
  assert.equal(rb.status, 200);
  assert.ok(rb.data.steps.length >= 5);
  assert.ok(rb.data.params.some(p => p.name === 'RUNNER_NAME'));
});
