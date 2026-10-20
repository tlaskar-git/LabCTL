// The built-in schedule store on its own: overrides (edit, hide, clear) and custom entries, with a fresh in-memory db.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createStore } = require('../src/builtin-schedule-store');
const { cleanScope, preview } = require('../src/builtin-schedules');

test('overrides: edit, hide and clear one key', () => {
  const db = new Database(':memory:');
  const store = createStore(db);
  createStore(db); // a second open keeps the tables
  assert.equal(store.override('mac_monthly'), null);
  store.setEdit('mac_monthly', { name: 'Mac tidy' }, 'admin1');
  assert.deepEqual(store.override('mac_monthly').fields, { name: 'Mac tidy' });
  assert.equal(store.override('mac_monthly').action, 'edit');
  store.hide('mac_monthly', 'admin1');
  assert.equal(store.override('mac_monthly').action, 'hide');
  assert.deepEqual(store.hiddenKeys(), ['mac_monthly']);
  assert.equal(store.clear('mac_monthly'), true);
  assert.equal(store.override('mac_monthly'), null);
  assert.equal(store.clear('mac_monthly'), false);
});

test('custom entries: create, update, list in creation order, delete', () => {
  const db = new Database(':memory:');
  const store = createStore(db);
  const a = store.createCustom({ name: 'A', cron: '0 1 * * *', steps: [{ template: 'x', params: { N: 1 } }], scope: { all: true }, guarded: false }, 'admin1');
  const b = store.createCustom({ name: 'B', cron: '0 2 * * *', steps: [], scope: { os: ['linux'] }, guarded: true }, 'admin1');
  assert.match(a, /^custom-[0-9a-f]{12}$/);
  assert.notEqual(a, b);
  assert.deepEqual(store.listCustom().map(c => c.name).sort(), ['A', 'B']);
  const got = store.getCustom(a);
  assert.deepEqual(got.steps, [{ template: 'x', params: { N: 1 } }]);
  assert.equal(got.timezone, null);
  store.updateCustom(a, { ...got, name: 'A2', guarded: true });
  assert.equal(store.getCustom(a).name, 'A2');
  assert.equal(store.getCustom(a).guarded, true);
  assert.equal(store.deleteCustom(a), true);
  assert.equal(store.getCustom(a), null);
});

test('scope cleaning and the run preview', () => {
  assert.ok(cleanScope({}).error);
  assert.ok(cleanScope({ os: ['beos'] }).error);
  assert.ok(cleanScope({ rings: [4] }).error);
  assert.deepEqual(cleanScope({ tags: ['a', 'a', ''], rings: ['1'], runners: 1 }).value, { tags: ['a'], rings: [1], runners: true });
  const runs = preview('30 6 * * 1', 'Europe/Dublin', 3, new Date('2026-01-01T00:00:00Z'));
  assert.deepEqual(runs, ['2026-01-05T06:30:00.000Z', '2026-01-12T06:30:00.000Z', '2026-01-19T06:30:00.000Z']);
  assert.throws(() => preview('nope', 'Europe/Dublin'));
});
