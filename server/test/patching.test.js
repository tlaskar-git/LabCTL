// Patch policies: validation and typed confirm, ring order, stop on failure, dry run, maintenance skip and wait,
// post-update health failures, reboot only when required, scheduler hook (run, missed) and the maintenance guard.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, login, api, wsOpen, waitFor } = require('./helpers');

// Fake agents answer by template id. state.failTemplates: Map host -> Set of template ids that fail.
async function setup(t, hostIds = ['h0', 'h1', 'h2']) {
  const s = await startApp();
  s.sockets = [];
  s.reconnects = []; // a reboot reconnects later: teardown waits for it so no agent is mid-register when the db closes
  t.after(async () => {
    await Promise.allSettled(s.reconnects);
    await Promise.all(s.sockets.map(w => new Promise(r => { if (w.readyState === 3) return r(); w.on('close', r); w.close(); })));
    await new Promise(r => setTimeout(r, 50));
    await s.stop();
  });
  const admin = api(s.base, await login(s.base));
  const enrol = (await admin('POST', '/api/tokens', { label: 'patch' })).data.value;
  const state = { ran: [], fail: new Map(), rebootRequired: false };
  const connect = async (id) => {
    const ws = await wsOpen(s.port, enrol);
    s.sockets.push(ws);
    ws.send(JSON.stringify({ type: 'register', host_id: id, hostname: `${id}.example.test`, os: 'linux', kind: 'agent', agent_version: '2.0.0', info: {} }));
    ws.on('message', d => {
      const m = JSON.parse(d.toString());
      if (m.type !== 'run_job') return;
      const tpl = String(s.ctx.jobs.get(m.job_id).type).replace('template:', '');
      state.ran.push({ host: id, template: tpl, env: m.env });
      const fail = state.fail.get(id)?.has(tpl);
      const line = tpl === 'vps_apt_upgrade' && state.rebootRequired ? 'LABCTL_RESULT reboot_required=yes\n' : 'done\n';
      ws.send(JSON.stringify({ type: 'job_output', job_id: m.job_id, seq: 1, stream: 'stdout', chunk: line }));
      ws.send(JSON.stringify({ type: 'job_complete', job_id: m.job_id, status: fail ? 'failed' : 'success', exit_code: fail ? 1 : 0, duration_ms: 5 }));
      // A reboot job ends, then the agent drops and comes back.
      if (tpl === 'vps_scheduled_reboot') {
        s.reconnects.push(new Promise(r => setTimeout(() => { ws.close(); setTimeout(() => r(connect(id)), 150); }, 30)));
      }
    });
    await waitFor(() => s.ctx.agents.isOnline(id));
    return ws;
  };
  for (const id of hostIds) await connect(id);
  s.ctx.patching.pollMs = 20;
  s.ctx.patching.maintPollMs = 20;
  s.ctx.patching.pendingMs = 2000;
  const tag = (hostId, name) => {
    const row = s.ctx.db.prepare('SELECT id FROM tags WHERE name = ?').get(name) || (() => {
      const id = `tag-${name}`; s.ctx.db.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(id, name); return { id };
    })();
    s.ctx.db.prepare('INSERT OR IGNORE INTO host_tags (host_id, tag_id) VALUES (?, ?)').run(hostId, row.id);
  };
  hostIds.forEach((id, n) => tag(id, `ring${n}`));
  const policy = async (body = {}) => {
    const r = await admin('POST', '/api/patch-policies', { name: 'Fleet patching', reboot: { mode: 'never' }, ...body });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  const runPolicy = async (p, body = {}) => {
    const r = await admin('POST', `/api/patch-policies/${p.id}/run`, body);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await waitFor(() => ['completed', 'failed', 'dry_run', 'skipped'].includes(s.ctx.patching.getRun(r.data.run_id).status), 8000);
    return s.ctx.patching.getRun(r.data.run_id);
  };
  return { s, admin, state, connect, tag, policy, runPolicy };
}

const hostStatuses = run => run.results.map(r => ({ ring: r.ring, status: r.status, hosts: r.hosts.map(h => `${h.host_id}:${h.status}`) }));

test('policy validation and typed confirm for a policy that can reboot', async (t) => {
  const { admin } = await setup(t, ['h0']);
  assert.equal((await admin('POST', '/api/patch-policies', { name: '' })).status, 400);
  assert.equal((await admin('POST', '/api/patch-policies', { name: 'x', rings: [3] })).status, 400);
  assert.equal((await admin('POST', '/api/patch-policies', { name: 'x', rings: [0, 0] })).status, 400);
  assert.equal((await admin('POST', '/api/patch-policies', { name: 'x', update_type: 'everything' })).status, 400);
  assert.equal((await admin('POST', '/api/patch-policies', { name: 'x', cron: 'not cron' })).status, 400);
  assert.equal((await admin('POST', '/api/patch-policies', { name: 'x', drain: { enabled: true, force: true } })).status, 400);
  assert.equal((await admin('POST', '/api/patch-policies', { name: 'x', health: { services: ['a b'] } })).status, 400);
  const made = await admin('POST', '/api/patch-policies', { name: 'Reboots', cron: '0 2 * * 2', reboot: { mode: 'if_required' } });
  assert.equal(made.status, 200);
  assert.equal(made.data.enabled, false);
  assert.equal(made.data.guarded, true);
  assert.deepEqual(made.data.rings, [0, 1, 2]);
  // Enabling a policy that reboots needs its name typed.
  const no = await admin('PUT', `/api/patch-policies/${made.data.id}`, { enabled: true });
  assert.equal(no.status, 400);
  assert.equal(no.data.confirm_word, 'Reboots');
  const yes = await admin('PUT', `/api/patch-policies/${made.data.id}`, { enabled: true, confirm: 'Reboots' });
  assert.equal(yes.status, 200);
  assert.ok(yes.data.next_run, 'next run is scheduled');
  // A manual run needs the name too, a dry run does not.
  assert.equal((await admin('POST', `/api/patch-policies/${made.data.id}/run`, {})).status, 400);
  assert.equal((await admin('DELETE', `/api/patch-policies/${made.data.id}`)).status, 200);
  assert.equal((await admin('GET', `/api/patch-policies/${made.data.id}`)).status, 404);
});

test('rings run in order and a failed ring stops the next one', async (t) => {
  const { s, state, policy, runPolicy } = await setup(t);
  const p = await policy();
  const ok = await runPolicy(p);
  assert.equal(ok.status, 'completed', JSON.stringify(ok));
  assert.deepEqual(state.ran.filter(r => r.template === 'vps_apt_upgrade').map(r => r.host), ['h0', 'h1', 'h2']);
  assert.equal(ok.stopped_at_ring, null);
  assert.deepEqual(hostStatuses(ok).map(r => r.status), ['completed', 'completed', 'completed']);

  state.ran.length = 0;
  state.fail.set('h0', new Set(['vps_apt_upgrade']));
  const bad = await runPolicy(p);
  assert.equal(bad.status, 'failed');
  assert.equal(bad.stopped_at_ring, 0);
  assert.deepEqual(hostStatuses(bad), [
    { ring: 0, status: 'failed', hosts: ['h0:failed'] },
    { ring: 1, status: 'not_run', hosts: ['h1:not_run'] },
    { ring: 2, status: 'not_run', hosts: ['h2:not_run'] }]);
  assert.deepEqual(state.ran.map(r => r.host), ['h0'], 'later rings ran nothing');
  assert.equal(s.ctx.patching.listRuns({ policy_id: p.id }).length, 2, 'both runs are in the history');
});

test('all hosts of a ring are patched when the concurrency setting is lower than the host count', async (t) => {
  const { s, state, policy, runPolicy, tag, connect } = await setup(t, ['a0', 'a1', 'a2']);
  ['a0', 'a1', 'a2'].forEach(id => tag(id, 'ring1'));
  await connect('b0'); tag('b0', 'ring1');
  s.ctx.settings.set('patch_concurrency', 2);
  const p = await policy({ rings: [1] });
  const run = await runPolicy(p);
  assert.equal(run.status, 'completed');
  assert.equal(run.summary.success, 4);
  assert.equal(state.ran.length, 4);
});

test('dry run plans every host and creates no job', async (t) => {
  const { state, policy, runPolicy } = await setup(t);
  const p = await policy({ update_type: 'all' });
  const run = await runPolicy(p, { dry_run: true });
  assert.equal(run.status, 'dry_run');
  assert.equal(run.dry_run, true);
  assert.equal(state.ran.length, 0);
  assert.equal(run.results.length, 3);
  assert.deepEqual(run.results[0].hosts[0].steps.map(s => s.template), ['vps_apt_upgrade']);
  assert.equal(run.summary.planned, 3);
});

test('a host in a maintenance window is skipped and recorded, and wait mode proceeds after the window', async (t) => {
  const { s, state, policy, runPolicy } = await setup(t);
  s.ctx.maintenance = { isInMaintenance: id => id === 'h1' };
  const p = await policy();
  const run = await runPolicy(p);
  assert.equal(run.status, 'completed', 'a skipped host does not fail the ring');
  const h1 = run.results[1].hosts[0];
  assert.equal(h1.status, 'skipped');
  assert.equal(h1.reason, 'skipped: maintenance');
  assert.ok(!state.ran.some(r => r.host === 'h1'));

  state.ran.length = 0;
  const waiter = await policy({ name: 'Waits', maintenance: { mode: 'wait', wait_max_minutes: 5 } });
  setTimeout(() => { s.ctx.maintenance = { isInMaintenance: () => false }; }, 150);
  const waited = await runPolicy(waiter);
  assert.equal(waited.results[1].hosts[0].status, 'success');
  assert.ok(state.ran.some(r => r.host === 'h1'));
});

test('a failed post-update health check fails the host and stops the next ring', async (t) => {
  const { state, policy, runPolicy } = await setup(t);
  state.fail.set('h0', new Set(['vps_post_reboot_check']));
  const p = await policy({ health: { services: ['sshd'] } });
  const run = await runPolicy(p);
  assert.equal(run.status, 'failed');
  assert.equal(run.stopped_at_ring, 0);
  const rec = run.results[0].hosts[0];
  assert.match(rec.reason, /Health check failed: services/);
  assert.ok(rec.steps.some(st => st.template === 'vps_post_reboot_check' && st.status === 'failed'));
  assert.deepEqual(state.ran.find(r => r.template === 'vps_post_reboot_check').env.LABCTL_P_SERVICES, 'sshd');
});

test('runner health: offline runner in GitHub fails the host, missing GitHub is recorded as skipped', async (t) => {
  const { s, policy, runPolicy } = await setup(t, ['h0']);
  s.ctx.db.prepare('UPDATE hosts SET inventory = ? WHERE id = ?').run(JSON.stringify({ runners: [{ name: 'runner-a' }] }), 'h0');
  const p = await policy({ rings: [0] });
  const none = await runPolicy(p);
  assert.equal(none.status, 'completed');
  assert.ok(none.results[0].hosts[0].steps.some(st => st.name.includes('runners online') && st.status === 'skipped'));
  s.ctx.github = { runnerOnline: async () => false };
  const down = await runPolicy(p);
  assert.equal(down.status, 'failed');
  assert.match(down.results[0].hosts[0].reason, /runner runner-a is not online/);
  s.ctx.github = { runnerOnline: async () => true };
  assert.equal((await runPolicy(p)).status, 'completed');
});

test('reboot runs only when required, waits for the agent to return, and passes the delay', async (t) => {
  const { s, state, policy, runPolicy } = await setup(t, ['h0']);
  s.ctx.patching.pollMs = 20;
  const p = await policy({ rings: [0], reboot: { mode: 'if_required', delay_min: 3 } });
  assert.equal(s.ctx.patching.get(p.id).guarded, true);
  const first = await runPolicy(p, { confirm: 'Fleet patching' });
  assert.equal(first.status, 'completed');
  assert.ok(!state.ran.some(r => r.template === 'vps_scheduled_reboot'), 'no reboot when no update asked for one');

  state.rebootRequired = true;
  state.ran.length = 0;
  const second = await runPolicy(p, { confirm: 'Fleet patching' });
  assert.equal(second.status, 'completed', JSON.stringify(second.results));
  const reboot = state.ran.find(r => r.template === 'vps_scheduled_reboot');
  assert.ok(reboot, 'reboot job ran');
  assert.equal(reboot.env.LABCTL_P_DELAY_MIN, '3');
  assert.ok(second.results[0].hosts[0].steps.some(st => st.name === 'Health: agent heartbeat' && st.status === 'success'));
});

test('the scheduler hook starts a due policy, records a missed one, and skips a policy after a failed ring policy', async (t) => {
  const { s, state, policy } = await setup(t, ['h0', 'h1']);
  const p = await policy({ rings: [0], cron: '0 2 * * 2', enabled: true });
  const db = s.ctx.db;
  const at = new Date();
  db.prepare('UPDATE patch_policies SET next_run = ? WHERE id = ?').run(new Date(at.getTime() - 5000).toISOString(), p.id);
  await s.ctx.patching.tick(at);
  const runs = s.ctx.patching.listRuns({ policy_id: p.id });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger, 'schedule');
  assert.equal(runs[0].status, 'completed');
  assert.ok(state.ran.some(r => r.host === 'h0'));
  assert.ok(s.ctx.patching.get(p.id).next_run > at.toISOString(), 'next run moved forward');

  // More than the grace period late: recorded as missed, not run.
  state.ran.length = 0;
  db.prepare('UPDATE patch_policies SET next_run = ? WHERE id = ?').run(new Date(at.getTime() - 3600000).toISOString(), p.id);
  await s.ctx.patching.tick(at);
  const missed = s.ctx.patching.listRuns({ policy_id: p.id }).find(r => r.status === 'missed');
  assert.ok(missed);
  assert.equal(state.ran.length, 0);

  // Dependency: ring 1 policy is skipped when the ring 0 policy failed.
  state.fail.set('h0', new Set(['vps_apt_upgrade']));
  const failed = s.ctx.patching.start(s.ctx.patching.get(p.id), { actor: 'test' });
  await failed.done;
  const dep = await policy({ name: 'Ring 1', rings: [1], depends_on: p.id });
  const r = s.ctx.patching.start(dep, { actor: 'test' });
  await r.done;
  const skipped = s.ctx.patching.getRun(r.run.id);
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.error, /previous ring policy failed/);
});

test('server shutdown ends a waiting run as failed before the database closes', async (t) => {
  const { s, policy } = await setup(t, ['h0']);
  s.ctx.maintenance = { isInMaintenance: () => true };
  const p = await policy({ rings: [0], maintenance: { mode: 'wait', wait_max_minutes: 60 } });
  const r = s.ctx.patching.start(s.ctx.patching.get(p.id), { actor: 'test' });
  await new Promise(res => setTimeout(res, 100)); // the run is now in its maintenance wait
  await s.ctx.patching.stop();
  const run = s.ctx.patching.getRun(r.run.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'Interrupted by a server shutdown');
});

test('a policy cannot run twice at once', async (t) => {
  const { s, policy } = await setup(t, ['h0']);
  const p = await policy({ rings: [0] });
  const a = s.ctx.patching.start(s.ctx.patching.get(p.id), { actor: 'test' });
  const b = s.ctx.patching.start(s.ctx.patching.get(p.id), { actor: 'test' });
  assert.equal(b.status, 409);
  await a.done;
});

test('the scheduler stores a job for a host in a maintenance window as skipped', async (t) => {
  const { s } = await setup(t, ['h0']);
  s.ctx.maintenance = { isInMaintenance: id => id === 'h0' };
  const job = s.ctx.jobs.create({ host_id: 'h0', type: 'backup', actor: 'scheduler' });
  assert.equal(job.status, 'skipped');
  assert.equal(job.error, 'skipped: maintenance');
  s.ctx.maintenance = { isInMaintenance: () => false };
  const live = s.ctx.jobs.create({ host_id: 'h0', type: 'backup', actor: 'scheduler' });
  assert.notEqual(live.status, 'skipped');
  const manual = s.ctx.jobs.create({ host_id: 'h0', type: 'backup', actor: 'someone', dispatchNow: false });
  assert.equal(manual.status, 'pending');
});
