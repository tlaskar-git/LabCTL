// Job payloads carry host_name (the display name, else the hostname) next to the real hostname.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, login, api } = require('./helpers');

test('jobs list, detail and group summary include host_name', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const admin = api(s.base, await login(s.base));
  const at = new Date().toISOString();
  s.ctx.db.prepare("INSERT INTO hosts (id, hostname, kind, display_name, created_at) VALUES ('h1', 'srv-01.example.test', 'agent', 'Kitchen NAS', ?)").run(at);
  s.ctx.db.prepare("INSERT INTO hosts (id, hostname, kind, created_at) VALUES ('h2', 'srv-02.example.test', 'agent', ?)").run(at);
  const g = s.ctx.jobs.createGroup({ label: 'test', type: 'reboot' });
  const ins = s.ctx.db.prepare("INSERT INTO jobs (id, host_id, type, status, created_at, group_id) VALUES (?, ?, 'reboot', 'completed', ?, ?)");
  ins.run('j1', 'h1', at, g.id);
  ins.run('j2', 'h2', at, g.id);

  const list = (await admin('GET', '/api/jobs')).data;
  const j1 = list.find(j => j.id === 'j1'), j2 = list.find(j => j.id === 'j2');
  assert.deepEqual([j1.hostname, j1.host_name], ['srv-01.example.test', 'Kitchen NAS']);
  assert.deepEqual([j2.hostname, j2.host_name], ['srv-02.example.test', 'srv-02.example.test']);
  assert.equal((await admin('GET', '/api/jobs/j1')).data.host_name, 'Kitchen NAS');
  const sum = s.ctx.jobs.groupSummary(g.id);
  assert.equal(sum.hosts.find(h => h.job_id === 'j1').host_name, 'Kitchen NAS');
  assert.equal(sum.hosts.find(h => h.job_id === 'j1').hostname, 'srv-01.example.test');
});
