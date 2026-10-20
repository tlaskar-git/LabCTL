// Metric storage for the charts. Heartbeats give 30 s points (cpu, ram, load). The latest inventory adds swap, the
// highest disk percentage and network rates to every point, and writes one value per mount, interface and sensor into
// metric_series. Rollups: raw 30 s for 24 h, 5 minute averages up to 7 days, 30 minute averages after that.
// Everything older than the metrics_days setting is deleted. Tables are created here (no db.js migration needed).
const { parseJson } = require('./db');

const RANGES = { '1h': 3600, '24h': 86400, '7d': 604800, '30d': 2592000 };
const FIXED = ['cpu', 'ram', 'swap', 'load1', 'disk', 'rx', 'tx'];
// macOS reports mount paths longer than 100 characters (simulator and app volumes), so allow up to 400.
const DYNAMIC = /^(disk|inodes|net|temp):.{1,400}$/;
const MAX_POINTS = 600;
const ROLLUP_EVERY_MS = 300000;

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sum = list => (list.length ? list.reduce((a, b) => a + b, 0) : null);

// Inventory -> the values every 30 s point carries, plus the per-mount, per-interface and per-sensor series.
function fromInventory(inv = {}) {
  const disks = (Array.isArray(inv.disks) ? inv.disks : []).filter(d => num(d.percent) !== null);
  const nets = (Array.isArray(inv.net) ? inv.net : []).filter(n => n.iface !== 'lo');
  const series = {};
  for (const d of disks) {
    series[`disk:${d.mount}`] = d.percent;
    if (num(d.inodes_percent) !== null) series[`inodes:${d.mount}`] = d.inodes_percent;
  }
  for (const n of nets) {
    if (num(n.rx_bytes_per_s) !== null) series[`net:${n.iface}:rx`] = n.rx_bytes_per_s;
    if (num(n.tx_bytes_per_s) !== null) series[`net:${n.iface}:tx`] = n.tx_bytes_per_s;
  }
  for (const t of Array.isArray(inv.temps) ? inv.temps : []) if (num(t.celsius) !== null) series[`temp:${t.sensor}`] = t.celsius;
  return {
    carry: {
      swap: num(inv.memory?.swap_percent),
      disk: disks.length ? Math.max(...disks.map(d => d.percent)) : null,
      rx: sum(nets.map(n => num(n.rx_bytes_per_s)).filter(v => v !== null)),
      tx: sum(nets.map(n => num(n.tx_bytes_per_s)).filter(v => v !== null))
    },
    series
  };
}

function createMetrics(ctx) {
  const { db } = ctx;
  db.exec(`
    CREATE TABLE IF NOT EXISTS metric_points (
      host_id TEXT NOT NULL, ts INTEGER NOT NULL, res INTEGER NOT NULL DEFAULT 30,
      cpu REAL, ram REAL, swap REAL, load1 REAL, disk REAL, rx REAL, tx REAL,
      PRIMARY KEY (host_id, ts, res)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS metric_series (
      host_id TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL, value REAL,
      PRIMARY KEY (host_id, key, ts)) WITHOUT ROWID;
  `);
  const carry = new Map();  // host_id -> latest inventory-derived values
  let lastRollup = 0;

  const insertPoint = db.prepare(`INSERT OR IGNORE INTO metric_points (host_id, ts, res, cpu, ram, swap, load1, disk, rx, tx)
    VALUES (@host_id, @ts, 30, @cpu, @ram, @swap, @load1, @disk, @rx, @tx)`);
  const insertSeries = db.prepare('INSERT OR REPLACE INTO metric_series (host_id, key, ts, value) VALUES (?, ?, ?, ?)');

  function carried(hostId) {
    if (!carry.has(hostId)) {
      const row = db.prepare('SELECT inventory FROM hosts WHERE id = ?').get(hostId);
      carry.set(hostId, fromInventory(parseJson(row?.inventory, {})).carry);
    }
    return carry.get(hostId);
  }

  function rollup(nowMs = Date.now()) {
    const sec = Math.floor(nowMs / 1000);
    const cut24 = Math.floor((sec - 86400) / 300) * 300;      // aligned, so a bucket is never half rolled up
    const cut7 = Math.floor((sec - 604800) / 1800) * 1800;
    const days = Math.max(1, Number(ctx.settings.get('metrics_days')) || 30);
    const avg = 'AVG(cpu), AVG(ram), AVG(swap), AVG(load1), AVG(disk), AVG(rx), AVG(tx)';
    const cols = 'host_id, ts, res, cpu, ram, swap, load1, disk, rx, tx';
    return db.transaction(() => {
      db.prepare(`INSERT OR REPLACE INTO metric_points (${cols}) SELECT host_id, (ts / 300) * 300, 300, ${avg}
        FROM metric_points WHERE res = 30 AND ts < ? GROUP BY host_id, ts / 300`).run(cut24);
      db.prepare('DELETE FROM metric_points WHERE res = 30 AND ts < ?').run(cut24);
      db.prepare(`INSERT OR REPLACE INTO metric_points (${cols}) SELECT host_id, (ts / 1800) * 1800, 1800, ${avg}
        FROM metric_points WHERE res = 300 AND ts < ? GROUP BY host_id, ts / 1800`).run(cut7);
      db.prepare('DELETE FROM metric_points WHERE res = 300 AND ts < ?').run(cut7);
      // Series: keep 5 minute values for 7 days, then 30 minute averages. Delete first so a bucket start can be reused.
      const old = db.prepare('SELECT host_id, key, (ts / 1800) * 1800 AS b, AVG(value) AS v FROM metric_series WHERE ts < ? GROUP BY host_id, key, ts / 1800').all(cut7);
      db.prepare('DELETE FROM metric_series WHERE ts < ?').run(cut7);
      for (const r of old) insertSeries.run(r.host_id, r.key, r.b, r.v);
      const keep = sec - days * 86400;
      const pruned = db.prepare('DELETE FROM metric_points WHERE ts < ?').run(keep).changes + db.prepare('DELETE FROM metric_series WHERE ts < ?').run(keep).changes;
      lastRollup = nowMs;
      return { pruned };
    })();
  }

  // Called by agents.js for each heartbeat and inventory message.
  function ingest(hostId, msg, nowMs = Date.now()) {
    if (msg?.type !== 'heartbeat' && msg?.type !== 'inventory') return;
    const ts = Math.floor(nowMs / 30000) * 30;  // server clock, one slot per 30 s per host
    if (msg.type === 'inventory') {
      const { carry: c, series } = fromInventory(msg.data || {});
      carry.set(hostId, c);
      db.transaction(() => { for (const [k, v] of Object.entries(series)) insertSeries.run(hostId, k, Math.floor(nowMs / 1000), v); })();
    } else {
      insertPoint.run({ host_id: hostId, ts, cpu: num(msg.cpu), ram: num(msg.ram), load1: num(Array.isArray(msg.load) ? msg.load[0] : msg.load),
        ...carried(hostId) });
    }
    if (nowMs - lastRollup > ROLLUP_EVERY_MS) rollup(nowMs);
  }

  // Columnar result, one aligned timestamp axis for uPlot. The server picks the step so a range has at most ~600 points.
  function query(hostId, range, names, nowMs = Date.now()) {
    const span = RANGES[range];
    const to = Math.floor(nowMs / 1000);
    const from = to - span;
    const step = Math.max(30, Math.ceil(span / MAX_POINTS / 30) * 30);
    const cols = {};
    const fixed = names.filter(n => FIXED.includes(n));
    if (fixed.length) {
      const rows = db.prepare(`SELECT (ts / ?) * ? AS t, ${fixed.map(n => `AVG(${n}) AS ${n}`).join(', ')}
        FROM metric_points WHERE host_id = ? AND ts >= ? AND ts <= ? GROUP BY t ORDER BY t`).all(step, step, hostId, from, to);
      for (const r of rows) for (const n of fixed) (cols[n] ||= new Map()).set(r.t, r[n]);
    }
    for (const n of names.filter(x => DYNAMIC.test(x))) {
      const rows = db.prepare('SELECT (ts / ?) * ? AS t, AVG(value) AS v FROM metric_series WHERE host_id = ? AND key = ? AND ts >= ? AND ts <= ? GROUP BY t ORDER BY t')
        .all(step, step, hostId, n, from, to);
      cols[n] = new Map(rows.map(r => [r.t, r.v]));
    }
    const ts = [...new Set(Object.values(cols).flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
    const series = {};
    for (const n of names) series[n] = ts.map(t => cols[n]?.get(t) ?? null);
    const available = db.prepare('SELECT DISTINCT key FROM metric_series WHERE host_id = ? AND ts >= ? ORDER BY key').all(hostId, from).map(r => r.key);
    return { range, from, to, step, ts, series, available };
  }

  // Fleet-wide average cpu and ram for the last 24 hours in 15 minute buckets.
  function fleetTrend(nowMs = Date.now()) {
    const to = Math.floor(nowMs / 1000);
    const rows = db.prepare('SELECT (ts / 900) * 900 AS t, AVG(cpu) AS cpu, AVG(ram) AS ram FROM metric_points WHERE ts >= ? GROUP BY t ORDER BY t').all(to - 86400);
    return { ts: rows.map(r => r.t), cpu: rows.map(r => r.cpu), ram: rows.map(r => r.ram) };
  }

  return { ingest, rollup, query, fleetTrend, fromInventory };
}

module.exports = { createMetrics, fromInventory, RANGES, FIXED, DYNAMIC };
