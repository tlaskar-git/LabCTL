// Job output with the shapes real agents send: Windows CRLF tables, apt progress lines with a lone CR, an index that
// is short, missing or longer than the log, UTF-8 and colour codes split across chunks, and a 3 MB log.
// Every path (replay, SSE stream, polling endpoint, the terminal's text functions) must return every byte of text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createJobLog } = require('../src/joblog');
const { startApp, login, tempDir } = require('./helpers');

const PUBLIC = path.join(__dirname, '..', 'public');
const textMod = () => import(pathToFileURL(path.join(PUBLIC, 'js', 'components', 'terminal-text.js')).href);
const ansiMod = () => import(pathToFileURL(path.join(PUBLIC, 'vendor', 'ansi_up', 'ansi_up.js')).href);

const WIN = [
  'Checking for Windows updates (PSWindowsUpdate). This can take a long time.',
  'HOST-A (01/01/2026 10:00:00): Connecting to Microsoft Update server. Please wait...',
  'Found [1] Updates in pre search criteria',
  '',
  'ComputerName Status     KB          Size Title',
  '------------ ------     --          ---- -----',
  'HOST-A       -------    KB0000001   12MB Example update for testing'
].join('\r\n') + '\r\n';
const APT = 'Reading package lists...\r\n0% [Working]\r            \rGet:1 http://deb.example.test stable InRelease\n' +
  'Progress: [ 10%]\rProgress: [ 50%]\rProgress: [100%]\n';
const UTF = 'café ✓ résumé \u{1F600} done\n';

function logWith(t, id, chunks, idx = 'full') {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jl = createJobLog(dir);
  chunks.forEach((c, i) => jl.append(id, c, { stream: 'stdout', ts: 1000 + i }));
  const idxPath = path.join(dir, id + '.idx');
  if (idx === 'missing') fs.rmSync(idxPath);
  if (idx === 'short') fs.writeFileSync(idxPath, fs.readFileSync(idxPath, 'utf8').split('\n')[0] + '\n');
  if (idx === 'long') fs.appendFileSync(idxPath, '9999\t500\to\n');
  return jl;
}
const joined = entries => entries.map(e => e.chunk).join('');

test('replay returns every byte with a full, short, missing or too long index', (t) => {
  const half = Buffer.from(WIN).subarray(0, 76);
  const rest = Buffer.from(WIN).subarray(76);
  for (const idx of ['full', 'short', 'missing', 'long']) {
    const jl = logWith(t, 'w-' + idx, [half, rest], idx);
    const entries = jl.replay('w-' + idx);
    assert.equal(joined(entries), WIN, idx);
    assert.equal(entries[entries.length - 1].end, Buffer.byteLength(WIN), idx);
    if (idx === 'short') { // the index covers the first record; the remainder is plain stdout
      assert.equal(entries[0].ts, 1000);
      assert.equal(entries[1].ts, null);
      assert.equal(entries[1].stream, 'stdout');
    }
    assert.equal(joined(jl.replay('w-' + idx, 76)), rest.toString(), `${idx} from an offset`);
  }
});

test('replay keeps a UTF-8 character that is split between two index records', (t) => {
  const buf = Buffer.from(UTF);
  const cut = buf.indexOf(0xa9); // inside the two-byte e-acute
  const jl = logWith(t, 'u1', [buf.subarray(0, cut), buf.subarray(cut)]);
  const entries = jl.replay('u1');
  assert.equal(joined(entries), UTF);
  assert.ok(!joined(entries).includes('�'));
  assert.equal(entries[entries.length - 1].end, buf.length);
});

test('stream, resume and polling endpoint return the same text for real shapes', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const token = await login(s.base);
  const auth = { authorization: `Bearer ${token}` };
  const { db, joblog } = s.ctx;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO hosts (id, hostname, os, kind, status, created_at, updated_at) VALUES ('h1', 'one.example.test', 'windows', 'agent', 'online', ?, ?)").run(now, now);
  const addJob = (id, status) => db.prepare('INSERT INTO jobs (id, host_id, type, status, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'h1', 'windows_update', status, now, now);
  const big = Array.from({ length: 40000 }, (_, i) => `line ${String(i).padStart(6, '0')} ${'x'.repeat(64)}`).join('\r\n') + '\r\n';
  const shapes = { win: [WIN.slice(0, 76), WIN.slice(76)], apt: [APT], utf: [UTF], ansi: ['\x1b[3', '2mok\x1b[0m\n'], big: [big] };
  const { sseParser } = await textMod();
  const read = async url => {
    const res = await fetch(url, { headers: auth });
    const events = [];
    const parse = sseParser(e => events.push({ ...e, data: JSON.parse(e.data) }));
    const dec = new TextDecoder();
    for await (const part of res.body) parse(dec.decode(part, { stream: true }));
    return { res, events, text: events.filter(e => e.type === 'chunk').map(e => e.data.chunk).join('') };
  };
  for (const [id, chunks] of Object.entries(shapes)) {
    addJob(id, 'completed');
    chunks.forEach(c => joblog.append(id, c));
    const want = chunks.join('');
    const all = await read(`${s.base}/api/jobs/${id}/stream?from=0`);
    assert.match(all.res.headers.get('content-type'), /text\/event-stream/);
    assert.equal(all.events[0].type, 'meta');
    assert.equal(all.events[0].data.total, Buffer.byteLength(want));
    assert.equal(all.events.at(-1).type, 'done', id);
    assert.equal(all.text, want, `${id}: stream`);
    const polled = await fetch(`${s.base}/api/jobs/${id}/log?from=0`, { headers: auth });
    assert.equal(await polled.text(), want, `${id}: polling endpoint`);
    assert.equal(polled.headers.get('x-log-total'), String(Buffer.byteLength(want)));
  }
  // 3 MB: the first load is only the tail, starting at a line start; asking from that point gives the rest.
  const tail = await read(`${s.base}/api/jobs/big/stream?tail=1048576`);
  const start = tail.events[0].data.start;
  assert.ok(start > 0 && Buffer.byteLength(big) - start <= 1048576 + 200);
  assert.equal(tail.text, Buffer.from(big).subarray(start).toString());
  assert.match(tail.text, /^line \d{6} /);

  // A running job: replay, then live output, then resume from the last id with no duplicate text.
  addJob('run', 'running');
  joblog.append('run', WIN.slice(0, 76));
  const ctrl = new AbortController();
  const res = await fetch(`${s.base}/api/jobs/run/stream?tail=1048576`, { headers: auth, signal: ctrl.signal });
  const events = [];
  const parse = sseParser(e => events.push({ ...e, data: JSON.parse(e.data) }));
  const reading = (async () => { try { const dec = new TextDecoder(); for await (const p of res.body) parse(dec.decode(p, { stream: true })); } catch { /* aborted */ } })();
  const until = async fn => { for (let i = 0; i < 150 && !fn(); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(fn()); };
  await until(() => events.some(e => e.type === 'chunk'));
  s.ctx.jobs.output('run', WIN.slice(76));
  await until(() => events.filter(e => e.type === 'chunk').map(e => e.data.chunk).join('') === WIN);
  assert.ok(!events.some(e => e.type === 'done'), 'a running job must not end the stream');
  const firstId = events.find(e => e.type === 'chunk' && e.id).id;
  ctrl.abort();
  await reading;
  s.ctx.jobs.complete('run', 'completed', { exit_code: 0 });
  const resumed = await read(`${s.base}/api/jobs/run/stream?from=${firstId}`);
  assert.equal(WIN.slice(0, 76) + resumed.text, WIN);
  assert.equal(resumed.events.at(-1).type, 'done');
});

test('terminal text: CRLF, lone CR, ANSI split across chunks and HTML escaping', async () => {
  const { addText, crText, plainText } = await textMod();
  const { AnsiUp } = await ansiMod();
  const render = t => { const a = new AnsiUp(); a.use_classes = true; return a.ansi_to_html(crText(t)); };
  const lines = text => { const m = { lines: [] }; for (const c of text) addText(m, 'stdout', 1, c); return m.lines.map(l => plainText(l.t)); };

  // CRLF: one line break, no text lost, the table keeps its columns.
  const win = lines([WIN.slice(0, 76), WIN.slice(76)]);
  assert.deepEqual(win, WIN.split('\r\n').slice(0, -1));
  // Lone CR overwrites from the start of the line; CRLF in the same text is one break.
  assert.deepEqual(lines([APT]), ['Reading package lists...', 'Get:1 http://deb.example.test stable InRelease', 'Progress: [100%]']);
  assert.equal(crText('abcdef\rXY'), 'XYcdef');
  assert.equal(crText('kept\r'), 'kept');
  // Characters split one by one still join into the same lines.
  assert.deepEqual(lines([...WIN]), WIN.split('\r\n').slice(0, -1));
  // A colour code split across two chunks becomes one span once both parts arrive.
  const m = { lines: [] };
  addText(m, 'stdout', 1, 'pre \x1b[3');
  assert.match(render(m.lines[0].t), /^pre /, 'a partial escape never blanks the line');
  addText(m, 'stdout', 1, '2mgreen\x1b[0m <b>&\n');
  const h = render(m.lines[0].t);
  assert.match(h, /<span class="ansi-green-fg">green<\/span>/);
  assert.ok(h.includes('&lt;b&gt;&amp;'), 'output is HTML-escaped');
  assert.ok(!h.includes('\x1b'));
});

test('readSse decodes UTF-8 and events split across network packets', async () => {
  const { readSse } = await textMod();
  const body = Buffer.from(`id: 5\nevent: chunk\ndata: ${JSON.stringify({ chunk: UTF })}\n\n: hb\n\nevent: done\ndata: {"status":"completed"}\r\n\r\n`);
  const cut = body.indexOf(Buffer.from('é')) + 1; // between the two bytes of a character
  const packets = [body.subarray(0, 3), body.subarray(3, cut), body.subarray(cut)];
  const fetchFn = async (url, opts) => {
    assert.equal(opts.headers.Accept, 'text/event-stream');
    return { ok: true, status: 200, body: new ReadableStream({ start(c) { packets.forEach(p => c.enqueue(new Uint8Array(p))); c.close(); } }) };
  };
  const got = [];
  const r = await readSse('/x', e => got.push(e), { fetchFn });
  assert.equal(r.events, 2);
  assert.deepEqual(got.map(e => e.type), ['chunk', 'done']);
  assert.equal(got[0].id, '5');
  assert.equal(JSON.parse(got[0].data).chunk, UTF);
  const failed = await readSse('/x', () => {}, { fetchFn: async () => ({ ok: false, status: 500, body: null }) });
  assert.equal(failed.status, 500);
});
