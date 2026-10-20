// Static checks for the front-end modules. Run: node --test server/test/ui-modules.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PUBLIC = path.join(__dirname, '..', 'public');
const JS = path.join(PUBLIC, 'js');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

test('every module in the pages manifest exists', async () => {
  const { pages } = await import(pathToFileURL(path.join(JS, 'pages', 'index.js')).href);
  assert.ok(pages.length > 0);
  const ids = new Set();
  for (const p of pages) {
    assert.ok(!ids.has(p.id), `duplicate page id ${p.id}`);
    ids.add(p.id);
    const m = /import\(['"](.+?)['"]\)/.exec(p.load.toString());
    assert.ok(m, `${p.id}: load must be () => import('./x.js')`);
    assert.ok(fs.existsSync(path.join(JS, 'pages', m[1])), `${p.id}: missing ${m[1]}`);
  }
});

test('no stub pages: Tokens lives inside Agents, and no page says it is not built', async () => {
  const { pages } = await import(pathToFileURL(path.join(JS, 'pages', 'index.js')).href);
  assert.ok(!pages.some(p => p.id === 'tokens'), 'the Tokens page entry must be gone');
  assert.ok(!fs.existsSync(path.join(JS, 'pages', 'tokens.js')));
  const agents = fs.readFileSync(path.join(JS, 'pages', 'agents.js'), 'utf8');
  for (const route of ["'/api/tokens'", "'rotate'", "'revoke'"]) assert.ok(agents.includes(route), `agents.js must call ${route}`);
  for (const f of walk(path.join(JS, 'pages')).filter(x => x.endsWith('.js'))) {
    assert.ok(!/StubPage/.test(fs.readFileSync(f, 'utf8')), `${path.basename(f)} is a stub`);
  }
  assert.ok(!/#\/tokens/.test(fs.readFileSync(path.join(JS, 'palette.js'), 'utf8')));
});

test('host detail tab modules exist', () => {
  const src = fs.readFileSync(path.join(JS, 'pages', 'host-detail.js'), 'utf8');
  const files = [...src.matchAll(/import\('\.\/(host-tabs\/[\w-]+\.js)'\)/g)].map(m => m[1]);
  assert.strictEqual(files.length, 10);
  for (const f of files) assert.ok(fs.existsSync(path.join(JS, 'pages', f)), `missing ${f}`);
});

test('relative imports in every module resolve', () => {
  for (const file of walk(JS).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:from\s+|import\()\s*['"](\.[^'"]+)['"]/g)) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), m[1])), `${path.relative(PUBLIC, file)} imports missing ${m[1]}`);
    }
  }
});

test('no external http(s) URL in html, css or own js (vendor excluded)', () => {
  const files = walk(PUBLIC).filter(f => /\.(html|css|js)$/.test(f) && !f.includes(`${path.sep}vendor${path.sep}`));
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/https?:\/\//.test(src), `${path.relative(PUBLIC, f)} contains an http(s) URL`);
  }
  // Vendored code may only mention XML namespace URIs, never a fetchable host.
  for (const f of walk(path.join(PUBLIC, 'vendor')).filter(f => f.endsWith('.js'))) {
    const urls = fs.readFileSync(f, 'utf8').match(/https?:\/\/[^"'\s)]+/g) || [];
    for (const u of urls) assert.match(u, /^http:\/\/www\.w3\.org\//, `${path.relative(PUBLIC, f)} references ${u}`);
  }
});

test('index.html is a shell under 150 lines', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.ok(html.split('\n').length < 150);
  assert.match(html, /<script type="module" src="js\/main\.js">/);
});

test('router matches params and skips unrouted pages', async () => {
  const r = await import(pathToFileURL(path.join(JS, 'router.js')).href);
  const routes = r.buildRoutes([
    { id: 'hosts' }, { id: 'host-detail', route: '/host/:id' }, { id: 'login', route: false },
  ]);
  assert.strictEqual(r.matchRoute(routes, '/hosts').entry.id, 'hosts');
  const hit = r.matchRoute(routes, '/host/a%20b');
  assert.strictEqual(hit.entry.id, 'host-detail');
  assert.strictEqual(hit.params.id, 'a b');
  assert.strictEqual(r.matchRoute(routes, '/login'), null);
  assert.deepStrictEqual(r.parseHash('#/host/x?tab=logs'), { path: '/host/x', query: { tab: 'logs' } });
});
