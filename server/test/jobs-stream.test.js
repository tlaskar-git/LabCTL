// Phase 6: per-job SSE (replay, live, final, resume), the change-notice stream, job groups, log search, the log cap.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, login, api, wsOpen, waitFor } = require('./helpers');

async function setup(t) {
  const s = await startApp();
  s.sockets = [];
  // Close the fake agents and let the server's close handlers run before the database closes.
  t.after(async () => {
    await Promise.all(s.sockets.map(w => new Promise(r => { if (w.readyState === 3) return r(); w.on('close', r); w.close(); })));
    await new Promise(r => setTimeout(r, 50));
    await s.stop();
  });
  const token = await login(s.base);
  const admin = api(s.base, token);
  const tok = await admin('POST', '/api/tokens', { label: 'stream-test' });
  return { s, token, admin, enrol: tok.data.value };
}

// A fake agent: registers a host and hands every job frame to `onJob(ws, jobId, frame)`.
async function fakeAgent(s, enrol, id, name, onJob = () => {}) {
  const ws = await wsOpen(s.port, enrol);
  s.sockets.push(ws);
  ws.send(JSON.stringify({ type: 'register', host_id: id, hostname: name, os: 'linux', kind: 'agent', agent_version: '2.0.0', info: {} }));
  ws.on('message', d => {
    const m = JSON.parse(d.toString());
    if (m.type === 'run_job') onJob(ws, m.job_id, m);
    if (m.type === 'job') onJob(ws, m.job.id, m);
  });
  await waitFor(() => s.ctx.db.prepare('SELECT 1 FROM hosts WHERE id = ?').get(id));
  return ws;
}
const out = (ws, job_id, stream, chunk) => ws.send(JSON.stringify({ type: 'job_output', job_id, seq: 1, stream, chunk }));
const complete = (ws, job_id, status = 'success', exit_code = 0) => ws.send(JSON.stringify({ type: 'job_complete', job_id, status, exit_code, duration_ms: 12 }));

// Minimal SSE client: collects {id, event, data} blocks and the raw text.
async function sse(url, token, headers = {}) {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, ...headers }, signal: ctrl.signal });
  const c = { res, events: [], raw: '', ended: false, close: () => ctrl.abort() };
  c.reading = (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const part of res.body) {
        const text = dec.decode(part, { stream: true });
        c.raw += text; buf += text;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = { id: null, event: 'message', data: null };
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) ev.id = line.slice(4);
            else if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
          }
          if (ev.data !== null) c.events.push(ev);
        }
      }
    } catch { /* aborted */ }
    c.ended = true;
  })();
  return c;
}
const text = c => c.events.filter(e => e.event === 'chunk').map(e => e.data.chunk).join('');

test('job stream: replay, live chunks with stream and timestamp, final event, then the stream closes', async (t) => {
  const { s, token, enrol } = await setup(t);
  let jobId;
  const ws = await fakeAgent(s, enrol, 'h1', 'one.example.test', (w, id) => { jobId = id; });
  const job = s.ctx.jobs.create({ host_id: 'h1', type: 'script', script: 'echo hi', shell: 'bash', actor: 'op1' });
  await waitFor(() => jobId === job.id);
  out(ws, job.id, 'stdout', '\x1b[32mone\x1b[0m\n');
  await waitFor(() => s.ctx.jobs.get(job.id).bytes_received > 0);

  const c = await sse(`${s.base}/api/jobs/${job.id}/stream`, token);
  assert.match(c.res.headers.get('content-type'), /text\/event-stream/);
  await waitFor(() => text(c).includes('one'));
  assert.equal(c.events[0].event, 'meta');
  const first = c.events.find(e => e.event === 'chunk');
  assert.equal(first.data.stream, 'stdout');
  assert.ok(first.data.ts > 0);
  assert.equal(first.id, String(Buffer.byteLength('\x1b[32mone\x1b[0m\n')));

  out(ws, job.id, 'stderr', 'oops\n');
  await waitFor(() => text(c).includes('oops'));
  const live = c.events.filter(e => e.event === 'chunk').pop();
  assert.equal(live.data.stream, 'stderr');
  assert.ok(Number(live.id) > Number(first.id));

  complete(ws, job.id, 'success', 0);
  await waitFor(() => c.ended);
  const done = c.events.at(-1);
  assert.equal(done.event, 'done');
  assert.equal(done.data.status, 'completed');
  assert.equal(done.data.exit_code, 0);
  assert.equal(done.data.duration_ms, 12);
  const j = s.ctx.jobs.out(s.ctx.jobs.get(job.id));
  assert.equal(j.started_by, 'op1');
  assert.equal(j.bytes_received, Buffer.byteLength('\x1b[32mone\x1b[0m\noops\n'));
  assert.ok(j.ended_at);
  c.close();
});

test('job stream: from= and Last-Event-ID resume at a byte offset, stream info survives replay, unknown job is 404', async (t) => {
  const { s, token, admin, enrol } = await setup(t);
  const ws = await fakeAgent(s, enrol, 'h1', 'one.example.test');
  const job = s.ctx.jobs.create({ host_id: 'h1', type: 'script', script: 'x', shell: 'bash' });
  await waitFor(() => s.ctx.jobs.get(job.id).status === 'sent');
  out(ws, job.id, 'stdout', 'aaaa\n');
  out(ws, job.id, 'stderr', 'bbbb\n');
  out(ws, job.id, 'stdout', 'cccc\n');
  complete(ws, job.id);
  await waitFor(() => s.ctx.jobs.get(job.id).status === 'completed');

  const all = await sse(`${s.base}/api/jobs/${job.id}/stream`, token);
  await waitFor(() => all.ended);
  assert.deepEqual(all.events.filter(e => e.event === 'chunk').map(e => [e.data.stream, e.data.chunk]), [['stdout', 'aaaa\n'], ['stderr', 'bbbb\n'], ['stdout', 'cccc\n']]);

  const from = await sse(`${s.base}/api/jobs/${job.id}/stream?from=5`, token);
  await waitFor(() => from.ended);
  assert.equal(text(from), 'bbbb\ncccc\n');
  const resume = await sse(`${s.base}/api/jobs/${job.id}/stream?from=0`, token, { 'Last-Event-ID': '10' });
  await waitFor(() => resume.ended);
  assert.equal(text(resume), 'cccc\n');
  const tail = await sse(`${s.base}/api/jobs/${job.id}/stream?tail=7`, token);
  await waitFor(() => tail.ended);
  assert.equal(text(tail), 'cccc\n'); // starts on a line boundary
  assert.equal((await admin('GET', '/api/jobs/nope/stream')).status, 404);
  const r = await admin('GET', `/api/jobs/${job.id}/log?from=6&to=10`);
  assert.equal(r.status, 200);
});

test('streams send a heartbeat comment', async (t) => {
  const { s, token, enrol } = await setup(t);
  s.ctx.sseHeartbeatMs = 30;
  const ws = await fakeAgent(s, enrol, 'h1', 'one.example.test');
  const job = s.ctx.jobs.create({ host_id: 'h1', type: 'script', script: 'x', shell: 'bash' });
  const c = await sse(`${s.base}/api/jobs/${job.id}/stream`, token);
  await waitFor(() => c.raw.includes(': hb'));
  c.close();
});

test('GET /api/events sends small change notices only', async (t) => {
  const { s, token, enrol } = await setup(t);
  const c = await sse(`${s.base}/api/events`, token);
  const ws = await fakeAgent(s, enrol, 'h1', 'one.example.test');
  await waitFor(() => c.events.some(e => e.event === 'host' && e.data.id === 'h1' && e.data.online));
  const job = s.ctx.jobs.create({ host_id: 'h1', type: 'script', script: 'x', shell: 'bash' });
  await waitFor(() => c.events.some(e => e.event === 'job' && e.data.id === job.id));
  assert.ok(c.events.every(e => JSON.stringify(e.data).length < 300));
  c.close();
});

test('host groups: summary with per-host status, retry-failed creates a new group for the failed hosts only', async (t) => {
  const { s, token, admin, enrol } = await setup(t);
  let failOnA = true;
  const agent = (id, name) => fakeAgent(s, enrol, id, name, (w, jobId, m) => {
    const bad = id === 'ha' ? failOnA : id === 'hb';
    out(w, jobId, 'stdout', `${name} working\n`);
    complete(w, jobId, bad ? 'failed' : 'success', bad ? 2 : 0);
  });
  const wsA = await agent('ha', 'a.example.test');
  const wsB = await agent('hb', 'b.example.test');
  const wsC = await agent('hc', 'c.example.test');
  const group = s.ctx.jobs.createGroup({ label: 'demo', type: 'script', actor: 'op1' });
  for (const h of ['ha', 'hb', 'hc']) s.ctx.jobs.create({ host_id: h, type: 'script', script: 'x', shell: 'bash', group_id: group.id });
  await waitFor(() => s.ctx.jobs.groupSummary(group.id).finished);

  const sum = (await admin('GET', `/api/job-groups/${group.id}`)).data;
  assert.equal(sum.total, 3);
  assert.deepEqual(sum.counts, { completed: 1, failed: 2 });
  assert.equal(sum.progress, 100);
  assert.deepEqual(sum.hosts.map(h => [h.hostname, h.status]).sort(), [['a.example.test', 'failed'], ['b.example.test', 'failed'], ['c.example.test', 'completed']]);
  assert.equal(sum.hosts.find(h => h.hostname === 'c.example.test').last_line, 'c.example.test working');

  failOnA = false;
  const retry = await admin('POST', `/api/job-groups/${group.id}/retry-failed`);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data.jobs.map(j => j.host_id).sort(), ['ha', 'hb']);
  await waitFor(() => s.ctx.jobs.groupSummary(retry.data.group_id).finished);
  const second = (await admin('GET', `/api/job-groups/${retry.data.group_id}`)).data;
  assert.equal(second.retry_of, group.id);
  assert.deepEqual(second.counts, { completed: 1, failed: 1 });
  assert.equal((await admin('POST', '/api/job-groups/nope/retry-failed')).status, 404);

  // The group stream sends a status summary and closes once every host has finished.
  const c = await sse(`${s.base}/api/job-groups/${group.id}/stream`, token);
  await waitFor(() => c.ended);
  assert.equal(c.events[0].event, 'status');
  assert.equal(c.events[0].data.finished, true);
});

test('POST /api/jobs/batch puts the jobs in one group; POST /api/jobs/:id/retry copies a finished job', async (t) => {
  const { s, admin, enrol } = await setup(t);
  const ws = await fakeAgent(s, enrol, 'ha', 'a.example.test', (w, id) => complete(w, id, 'failed', 1));
  const b = await admin('POST', '/api/jobs/batch', { host_ids: ['ha'], type: 'script_demo', params: {} });
  assert.equal(b.status, 200);
  assert.match(b.data[0].group_id, /^grp-/);
  const id = b.data[0].id;
  await waitFor(() => s.ctx.jobs.get(id).status === 'failed');
  const r = await admin('POST', `/api/jobs/${id}/retry`);
  assert.equal(r.status, 200);
  assert.notEqual(r.data.id, id);
  assert.equal(s.ctx.jobs.get(r.data.id).type, 'script_demo');
  const open = s.ctx.jobs.create({ host_id: 'zzz', type: 'x' });
  assert.equal((await admin('POST', `/api/jobs/${open.id}/retry`)).status, 409);
});

test('log search: newest jobs, host and status filters, ANSI removed, context lines, validation', async (t) => {
  const { s, admin } = await setup(t);
  const { db, jobs } = s.ctx;
  db.prepare("INSERT INTO hosts (id, hostname, os, kind, status) VALUES ('h1', 'one.example.test', 'linux', 'agent', 'offline'), ('h2', 'two.example.test', 'linux', 'agent', 'offline')").run();
  const j1 = jobs.create({ host_id: 'h1', type: 'x', dispatchNow: false });
  jobs.output(j1.id, 'start\n\x1b[31mNeedle here\x1b[0m\nafter\nnext\n');
  jobs.complete(j1.id, 'success');
  const j2 = jobs.create({ host_id: 'h2', type: 'x', dispatchNow: false });
  jobs.output(j2.id, 'nothing\nanother needle\n');
  jobs.complete(j2.id, 'failed');

  const all = (await admin('GET', '/api/logs/search?q=needle')).data;
  assert.equal(all.matches.length, 2);
  const m = all.matches.find(x => x.job_id === j1.id);
  assert.equal(m.text, 'Needle here');
  assert.equal(m.line, 2);
  assert.deepEqual(m.before, ['start']);
  assert.deepEqual(m.after, ['after']);
  assert.equal(m.hostname, 'one.example.test');
  assert.deepEqual((await admin('GET', '/api/logs/search?q=needle&host=two.example.test')).data.matches.map(x => x.job_id), [j2.id]);
  assert.deepEqual((await admin('GET', '/api/logs/search?q=needle&status=completed')).data.matches.map(x => x.job_id), [j1.id]);
  assert.equal((await admin('GET', '/api/logs/search?q=needle&limit=1')).data.matches.length, 1);
  assert.equal((await admin('GET', '/api/logs/search?q=n')).status, 400);
});

test('a log over the cap keeps head and tail and still streams', async (t) => {
  const { s, token } = await setup(t);
  const { jobs, settings } = s.ctx;
  const cap = settings.get('job_log_max_bytes');
  assert.equal(cap, 20971520);
  const job = jobs.create({ host_id: 'h1', type: 'x', dispatchNow: false });
  const mb = 'x'.repeat(1048575) + '\n';
  jobs.output(job.id, 'HEAD-START\n' + mb);
  for (let i = 0; i < 23; i++) jobs.output(job.id, mb);
  jobs.output(job.id, 'TAIL-END\n');
  // While running: still streams (head, marker, tail) and the tail request stays small.
  const small = await sse(`${s.base}/api/jobs/${job.id}/stream?tail=65536`, token);
  await waitFor(() => small.events.some(e => e.event === 'chunk'), 10000);
  const meta = small.events[0].data;
  assert.ok(meta.total <= cap + 200);
  assert.ok(meta.start > 0);
  assert.ok(text(small).endsWith('TAIL-END\n'));
  assert.ok(text(small).length <= 70000);
  small.close();
  jobs.complete(job.id, 'success');
  const full = await sse(`${s.base}/api/jobs/${job.id}/stream`, token);
  await waitFor(() => full.ended, 20000);
  const body = text(full);
  assert.ok(body.startsWith('HEAD-START\n'));
  assert.ok(body.includes('output truncated'));
  assert.ok(body.endsWith('TAIL-END\n'));
  assert.ok(Buffer.byteLength(body) <= cap + 200);
  assert.equal(full.events.at(-1).event, 'done');
});
