// Editing templates in the app: overrides, hides, custom templates, the live catalogue, roles, validation and audit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { startApp, login, api, wsOpen, waitFor, tempDir } = require('./helpers');

const DIR = path.join(__dirname, '../src/templates');
// Hash of every built-in file (manifest, prelude, scripts, runbooks); index.js is code, not template data.
function hashTree(dir = DIR) {
  const h = crypto.createHash('sha256');
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (p !== path.join(DIR, 'index.js')) h.update(p).update(fs.readFileSync(p));
  });
  walk(dir);
  return h.digest('hex');
}
const BEFORE = hashTree();

const CUSTOM = { name: 'Disk report (test)', description: 'Synthetic test script', category: 'custom', os: ['linux'], kinds: ['agent'], shell: 'bash',
  script: 'echo "free space for $LABCTL_P_PATH"\n', params: [{ name: 'PATH', type: 'string', label: 'Path', default: '/' }], guard: false, drain: false };

async function setup(t, dataDir) {
  const s = await startApp(dataDir ? { dataDir } : {});
  t.after(() => s.stop());
  const admin = api(s.base, await login(s.base));
  await admin('POST', '/api/users', { username: 'viewer1', password: 'pw-viewer', role: 'viewer' });
  await admin('POST', '/api/users', { username: 'op1', password: 'pw-op', role: 'operator' });
  const op = api(s.base, await login(s.base, 'op1', 'pw-op'));
  const viewer = api(s.base, await login(s.base, 'viewer1', 'pw-viewer'));
  return { s, admin, op, viewer };
}

test('edit, hide and restore a built-in; the merged catalogue follows', async t => {
  const { s, admin } = await setup(t);
  const cat = s.ctx.templates.catalogue;
  const orig = (await admin('GET', '/api/templates/vps_cleanup')).data;
  const edit = await admin('PUT', '/api/templates/vps_cleanup', { name: 'Cleanup (edited)', script: 'echo edited-cleanup\n' });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  assert.equal(edit.data.template.source, 'edited');
  assert.equal(cat.byId.get('vps_cleanup').name, 'Cleanup (edited)');
  const list = (await admin('GET', '/api/templates')).data;
  assert.equal(list.find(x => x.id === 'vps_cleanup').name, 'Cleanup (edited)');
  assert.equal(list.find(x => x.id === 'vps_cleanup').editable, true);
  assert.ok(list.every(x => !('script' in x) && !('text' in x)));
  assert.equal((await admin('GET', '/api/templates/vps_cleanup')).data.script, 'echo edited-cleanup\n');

  const hide = await admin('DELETE', '/api/templates/vps_cleanup', {});
  assert.equal(hide.status, 200, JSON.stringify(hide.data));
  assert.ok(!cat.byId.has('vps_cleanup'));
  assert.ok(!(await admin('GET', '/api/templates')).data.some(x => x.id === 'vps_cleanup'));
  assert.ok((await admin('GET', '/api/templates?hidden=1')).data.find(x => x.id === 'vps_cleanup').hidden);

  // Unhide keeps the edit; a second restore goes back to the manifest.
  assert.equal((await admin('POST', '/api/templates/vps_cleanup/restore')).data.action, 'unhide');
  assert.equal(cat.byId.get('vps_cleanup').name, 'Cleanup (edited)');
  assert.equal((await admin('POST', '/api/templates/vps_cleanup/restore')).data.action, 'reset');
  assert.equal(cat.byId.get('vps_cleanup').name, orig.name);
  assert.equal(cat.byId.get('vps_cleanup').source, 'builtin');
  assert.equal((await admin('GET', '/api/templates/vps_cleanup')).data.script, orig.script);
  assert.equal((await admin('POST', '/api/templates/vps_cleanup/restore')).status, 400);
});

test('custom templates: create, edit, clone, delete with the typed name', async t => {
  const { s, admin } = await setup(t);
  const made = await admin('POST', '/api/templates', CUSTOM);
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const id = made.data.template.id;
  assert.match(id, /^custom-[0-9a-f-]{36}$/);
  assert.equal(made.data.template.source, 'custom');
  assert.ok(s.ctx.templates.catalogue.byId.has(id));

  const ed = await admin('PUT', `/api/templates/${id}`, { description: 'Changed', guard: true });
  assert.equal(ed.status, 200);
  assert.equal(ed.data.template.guard, true);
  assert.equal(ed.data.template.description, 'Changed');

  const copy = await admin('POST', `/api/templates/${id}/clone`);
  assert.equal(copy.status, 200);
  assert.equal(copy.data.template.name, `${CUSTOM.name} (copy)`);
  assert.equal((await admin('GET', `/api/templates/${copy.data.template.id}`)).data.script, CUSTOM.script);
  const builtinCopy = await admin('POST', '/api/templates/traefik_restart/clone');
  assert.equal(builtinCopy.data.template.source, 'custom');
  assert.equal(builtinCopy.data.template.guard, true);

  const wrong = await admin('DELETE', `/api/templates/${id}`, { confirm: 'nope' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.data.confirm_required, true);
  assert.equal((await admin('DELETE', `/api/templates/${id}`, { confirm: CUSTOM.name })).status, 200);
  assert.ok(!s.ctx.templates.catalogue.all.has(id));
  assert.equal((await admin('GET', `/api/templates/${id}`)).status, 404);
  assert.equal((await admin('POST', `/api/templates/${copy.data.template.id}/restore`)).status, 400);
});

test('an edited script is what the agent receives; a hidden template cannot run', async t => {
  const { s, admin, op } = await setup(t);
  s.ctx.db.prepare("INSERT INTO hosts (id, hostname, os, kind, status) VALUES ('h1', 'node-a.example.test', 'linux', 'agent', 'offline')").run();
  const tok = await admin('POST', '/api/tokens', { label: 'test' });
  const ws = await wsOpen(s.port, tok.data.value);
  const frames = [];
  ws.on('message', d => frames.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify({ type: 'register', host_id: 'h1', hostname: 'node-a.example.test', os: 'linux', kind: 'agent', agent_version: '2.0.0', info: {} }));
  await waitFor(() => s.ctx.agents.isOnline('h1'));

  await admin('PUT', '/api/templates/vps_cleanup', { script: 'echo synthetic-edited-marker\n' });
  const r = await op('POST', '/api/templates/vps_cleanup/run', { host_ids: ['h1'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const frame = await waitFor(() => frames.find(f => f.type === 'run_job'));
  assert.match(frame.script, /synthetic-edited-marker/);
  assert.match(frame.script, /LabCTL template prelude/);
  assert.doesNotMatch(frame.script, /journalctl --vacuum-time/);

  const custom = (await admin('POST', '/api/templates', { ...CUSTOM, shell: 'python', script: 'print("synthetic")\n', params: [] })).data.template;
  const pr = await op('POST', `/api/templates/${custom.id}/run`, { host_ids: ['h1'] });
  assert.equal(pr.status, 200);
  const pf = await waitFor(() => frames.find(f => f.type === 'run_job' && f.job_id === pr.data.jobs[0].job_id));
  assert.equal(pf.shell, 'python');
  assert.equal(pf.script, 'print("synthetic")\n');

  await admin('DELETE', '/api/templates/vps_cleanup', {});
  assert.equal((await op('POST', '/api/templates/vps_cleanup/run', { host_ids: ['h1'] })).status, 404);
  ws.close();
  await waitFor(() => !s.ctx.agents.isOnline('h1'));
});

test('a guarded built-in keeps its guard; custom templates set their own', async t => {
  const { s, admin } = await setup(t);
  const r = await admin('PUT', '/api/templates/traefik_restart', { guard: false });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /guard cannot be removed/);
  assert.equal(s.ctx.templates.catalogue.byId.get('traefik_restart').guard, true);
  assert.equal((await admin('PUT', '/api/templates/traefik_restart', { name: 'Traefik restart (edited)' })).data.template.guard, true);
  assert.equal((await admin('POST', '/api/templates', { ...CUSTOM, guard: true })).data.template.guard, true);
});

test('roles: viewers and operators cannot write or read scripts; admins can', async t => {
  const { admin, op, viewer } = await setup(t);
  for (const who of [viewer, op]) {
    assert.equal((await who('POST', '/api/templates', CUSTOM)).status, 403);
    assert.equal((await who('PUT', '/api/templates/vps_cleanup', { name: 'x' })).status, 403);
    assert.equal((await who('POST', '/api/templates/vps_cleanup/clone')).status, 403);
    assert.equal((await who('DELETE', '/api/templates/vps_cleanup', {})).status, 403);
    assert.equal((await who('POST', '/api/templates/vps_cleanup/restore')).status, 403);
    const one = await who('GET', '/api/templates/vps_cleanup');
    assert.equal(one.status, 200);
    assert.equal(one.data.script, undefined);
  }
  assert.match((await admin('GET', '/api/templates/vps_cleanup')).data.script, /journalctl/);
});

test('validation: size, NUL, empty script, param names, types, select options, shell, os, kinds', async t => {
  const { admin } = await setup(t);
  const bad = async (patch, re) => {
    const r = await admin('POST', '/api/templates', { ...CUSTOM, ...patch });
    assert.equal(r.status, 400, JSON.stringify(patch).slice(0, 80));
    if (re) assert.match(r.data.error, re);
  };
  await bad({ script: 'x'.repeat(200 * 1024 + 1) }, /200 KB/);
  await bad({ script: 'echo a\u0000b' }, /NUL/);
  await bad({ script: '   ' }, /Script is required/);
  await bad({ params: [{ name: 'lower', type: 'string', label: 'x', default: '' }] }, /Parameter name/);
  await bad({ params: [{ name: 'A'.repeat(33), type: 'string', label: 'x', default: '' }] }, /Parameter name/);
  await bad({ params: [{ name: 'DRAIN', type: 'bool', label: 'x', default: false }] }, /reserved/);
  await bad({ params: [{ name: 'TOKEN', type: 'secret', label: 'x', default: '' }] }, /type must be/);
  await bad({ params: [{ name: 'MODE', type: 'enum', label: 'x', default: 'a', options: [] }] }, /options/);
  await bad({ params: [{ name: 'MODE', type: 'enum', label: 'x', default: 'c', options: ['a', 'b'] }] }, /default/);
  await bad({ params: [{ name: 'N', type: 'int', label: 'x', default: 'ten' }] }, /default/);
  await bad({ params: [{ name: 'X', type: 'string', label: 'x', default: '' }, { name: 'X', type: 'string', label: 'y', default: '' }] }, /twice/);
  await bad({ shell: 'zsh' }, /shell/);
  await bad({ os: ['plan9'] }, /os must/);
  await bad({ kinds: [] }, /kinds must/);
  await bad({ name: '' }, /Name/);
  const ok = await admin('POST', '/api/templates', { ...CUSTOM, script: 'if then fi (\n',
    params: [{ name: 'MODE', type: 'enum', label: 'Mode', options: ['a', 'b'] }, { name: 'N', type: 'int', label: 'N', default: 3, required: true }, { name: 'B', type: 'bool', label: 'B' }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.template.params.find(p => p.name === 'MODE').default, 'a');
  assert.ok(Array.isArray(ok.data.warnings)); // bash -n findings when bash exists, never a block
});

test('references: a used template needs the extra tick before it goes', async t => {
  const { s, admin } = await setup(t);
  const id = (await admin('POST', '/api/templates', CUSTOM)).data.template.id;
  const rb = await admin('POST', '/api/runbooks', { name: 'uses custom', steps: [{ kind: 'template', name: 'a', template: id }] });
  assert.equal(rb.status, 200, JSON.stringify(rb.data));
  assert.deepEqual((await admin('GET', `/api/templates/${id}`)).data.references.map(r => r.kind), ['runbook']);
  const refused = await admin('DELETE', `/api/templates/${id}`, { confirm: CUSTOM.name });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.references[0].name, 'uses custom');
  assert.equal((await admin('DELETE', `/api/templates/${id}`, { confirm: CUSTOM.name, force_referenced: true })).status, 200);

  s.ctx.db.prepare("INSERT INTO patch_policies (id, name, config) VALUES ('p1', 'ring policy', '{}')").run();
  assert.ok((await admin('GET', '/api/templates/vps_apt_upgrade')).data.references.some(r => r.kind === 'patch_policy'));
  assert.equal((await admin('DELETE', '/api/templates/vps_apt_upgrade', {})).status, 409);
  assert.equal((await admin('DELETE', '/api/templates/vps_apt_upgrade', { force_referenced: true })).status, 200);
});

test('audit rows name the change but never hold the script text', async t => {
  const { s, admin } = await setup(t);
  const marker = 'synthetic-audit-marker-7d1c';
  const id = (await admin('POST', '/api/templates', { ...CUSTOM, script: `echo ${marker}\n` })).data.template.id;
  await admin('PUT', `/api/templates/${id}`, { script: `echo ${marker} again\n` });
  await admin('PUT', '/api/templates/vps_cleanup', { script: `echo ${marker}\n` });
  const rows = s.ctx.db.prepare('SELECT * FROM audit_log').all();
  assert.ok(!JSON.stringify(rows).includes(marker), 'script text reached the audit log');
  const edit = s.ctx.audit.query({ action: 'template.edit' }).rows[0];
  assert.equal(edit.detail.script_sha256.length, 12);
  assert.ok(edit.detail.script_bytes > 0);
  assert.ok(s.ctx.audit.query({ action: 'template.create' }).rows.length === 1);
});

test('edits survive a restart and the built-in files never change', async t => {
  const dataDir = tempDir();
  const first = await startApp({ dataDir });
  const a1 = api(first.base, await login(first.base));
  await a1('PUT', '/api/templates/win_update', { name: 'Windows update (edited)' });
  assert.equal((await a1('DELETE', '/api/templates/mac_reboot', { force_referenced: true })).status, 200);
  const id = (await a1('POST', '/api/templates', CUSTOM)).data.template.id;
  await first.close();

  const { s } = await setup(t, dataDir);
  const cat = s.ctx.templates.catalogue;
  assert.equal(cat.byId.get('win_update').name, 'Windows update (edited)');
  assert.ok(!cat.byId.has('mac_reboot'));
  assert.equal(cat.byId.get(id).name, CUSTOM.name);
  assert.equal(hashTree(), BEFORE, 'a built-in template file changed on disk');
});

test('a runbook step on a removed template fails with a clear message', async t => {
  const { s, admin } = await setup(t);
  s.ctx.db.prepare("INSERT INTO hosts (id, hostname, os, kind, status) VALUES ('h1', 'node-a.example.test', 'linux', 'agent', 'offline')").run();
  const id = (await admin('POST', '/api/templates', CUSTOM)).data.template.id;
  const rb = (await admin('POST', '/api/runbooks', { name: 'rb', steps: [{ kind: 'template', name: 'a', template: id }] })).data;
  await admin('DELETE', `/api/templates/${id}`, { confirm: CUSTOM.name, force_referenced: true });
  const started = (await admin('POST', `/api/runbooks/${rb.id}/run`, { host_ids: ['h1'] })).data;
  const run = await waitFor(() => { const r = s.ctx.runbooks.getRun(started.id); return r && r.status !== 'running' && r; }, 5000);
  assert.equal(run.status, 'failed');
  assert.equal(run.results[0].hosts[0].error, `Unknown template ${id}`);
});
