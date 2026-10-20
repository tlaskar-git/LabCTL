// Monitoring history (v1) and per-host health rows. The v1 GET /api/health rows moved to GET /api/health/hosts.
const { parseJson } = require('../db');
const { RANGES, FIXED, DYNAMIC } = require('../metrics');
const { buildView } = require('../host-view');
module.exports = (app, ctx) => {
  const { db, agents } = ctx;
  const row = m => ({ id: m.id, host_id: m.host_id, created_at: m.created_at, ...parseJson(m.data, {}) });

  app.get('/api/metrics', (req, res) => {
    const { host_id, limit = 500 } = req.query;
    const lim = Math.min(5000, Number(limit) || 500);
    const rows = host_id
      ? db.prepare('SELECT * FROM metrics WHERE host_id = ? ORDER BY created_at DESC LIMIT ?').all(host_id, lim)
      : db.prepare('SELECT * FROM metrics ORDER BY created_at DESC LIMIT ?').all(lim);
    res.json(rows.map(row));
  });

  // Chart data. series is a comma list of cpu, ram, swap, load1, disk, rx, tx or disk:<mount>, inodes:<mount>,
  // net:<iface>:rx|tx, temp:<sensor>. The server picks the resolution (at most about 600 points).
  const hostRow = (req, res) => {
    const h = db.prepare('SELECT id, inventory, inventory_at FROM hosts WHERE id = ?').get(req.params.id);
    if (!h) res.status(404).json({ error: 'Host not found' });
    return h;
  };
  app.get('/api/hosts/:id/metrics', (req, res) => {
    if (!hostRow(req, res)) return;
    const range = req.query.range || '24h';
    if (!RANGES[range]) return res.status(400).json({ error: 'range must be 1h, 24h, 7d or 30d' });
    const names = String(req.query.series || 'cpu,ram,swap,load1,disk,rx,tx').split(',').map(s => s.trim()).filter(Boolean);
    if (!names.length || names.length > 24) return res.status(400).json({ error: 'series must hold 1 to 24 names' });
    const bad = names.find(n => !FIXED.includes(n) && !DYNAMIC.test(n));
    if (bad) return res.status(400).json({ error: `Unknown series ${bad.slice(0, 40)}` });
    res.json(ctx.metrics.query(req.params.id, range, [...new Set(names)]));
  });

  // Latest inventory, whole or one slice (processes is procs, network is net).
  app.get('/api/hosts/:id/inventory', (req, res) => {
    const h = hostRow(req, res);
    if (h) res.json({ host_id: h.id, at: h.inventory_at, data: parseJson(h.inventory, null) });
  });
  const SLICES = { processes: 'procs', network: 'net', services: 'services', docker: 'docker', updates: 'updates',
    security: 'security', runners: 'runners', disks: 'disks', temps: 'temps', smart: 'smart' };
  app.get(`/api/hosts/:id/:slice(${Object.keys(SLICES).join('|')})`, (req, res) => {
    const h = hostRow(req, res);
    if (h) res.json({ host_id: h.id, at: h.inventory_at, data: parseJson(h.inventory, {})?.[SLICES[req.params.slice]] ?? null });
  });

  // One row per host from the stored heartbeat, inventory and system_info (src/host-view.js), so an offline host
  // still shows its last reported values.
  app.get('/api/health/hosts', (req, res) => {
    res.json(db.prepare('SELECT * FROM hosts ORDER BY hostname COLLATE NOCASE').all().map(h => {
      const online = agents.isOnline(h.id);
      const { net, temps, top_processes, failed_services, containers, ...view } = buildView(h, { full: true, online });
      const dockerProblems = (containers || []).filter(c => c.state !== 'running' || c.health === 'unhealthy').length;
      const criticals = [];
      if (view.disk_max_percent >= 90) criticals.push(`Disk at ${Math.round(view.disk_max_percent)}%`);
      if (view.ram.percent >= 90) criticals.push(`RAM at ${Math.round(view.ram.percent)}%`);
      if (dockerProblems > 0) criticals.push(`${dockerProblems} Docker issue(s)`);
      if (view.failed_services_count > 0) criticals.push(`${view.failed_services_count} failed service(s)`);
      return { host_id: h.id, hostname: h.hostname, os: h.os, kind: h.kind, online, last_seen: h.last_seen,
        view: { ...view, docker_problems: dockerProblems }, criticals };
    }));
  });
};
