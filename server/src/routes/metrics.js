// Monitoring history (v1) and per-host health rows. The v1 GET /api/health rows moved to GET /api/health/hosts.
const { parseJson } = require('../db');
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

  app.get('/api/health/hosts', (req, res) => {
    const latest = db.prepare('SELECT * FROM metrics WHERE host_id = ? ORDER BY created_at DESC LIMIT 1');
    res.json(db.prepare('SELECT id, hostname, last_seen FROM hosts').all().map(h => {
      const lm = latest.get(h.id);
      const m = lm ? row(lm) : null;
      const drives = Array.isArray(m?.drives) ? m.drives : [];
      const maxDisk = drives.reduce((max, d) => Math.max(max, Number(d.percent || 0)), 0);
      const criticals = [];
      if (maxDisk >= 90) criticals.push(`Disk at ${maxDisk}%`);
      if (m?.ram_used_percent >= 90) criticals.push(`RAM at ${m.ram_used_percent}%`);
      if (m?.docker_problem_count > 0) criticals.push(`${m.docker_problem_count} Docker issue(s)`);
      if (m?.critical_services?.length) criticals.push(`${m.critical_services.length} service issue(s)`);
      return { host_id: h.id, hostname: h.hostname, online: agents.isOnline(h.id), last_seen: h.last_seen, latest: m, criticals };
    }));
  });
};
