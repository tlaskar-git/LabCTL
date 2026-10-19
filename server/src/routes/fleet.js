// Fleet overview: GET /api/fleet/summary. Everything is derived from the hosts table, the latest inventory of each
// host and the jobs table. A host is online when it was seen in the last 90 seconds.
// Exports (app, ctx) => void.
const { parseJson } = require('../db');
const { compareVersions, latestAgentVersion } = require('../hostops');

const ONLINE_MS = 90000;
const DISK_LIMIT = 80;
const PATCH_DAYS = 35;
const DAY = 86400000;
const RUNNER_OK = new Set(['active', 'running', 'started']);

module.exports = (app, ctx) => {
  const { db } = ctx;

  function summary(nowMs = Date.now()) {
    const hosts = db.prepare('SELECT id, hostname, os, kind, status, last_seen, agent_version, inventory FROM hosts').all();
    const out = {
      generated_at: new Date(nowMs).toISOString(), online_window_s: ONLINE_MS / 1000,
      totals: { hosts: hosts.length, online: 0, offline: 0, by_os: {}, by_kind: {}, by_status: {} },
      offline_hosts: [], pending_reboots: [], behind_on_patches: [], agents_out_of_date: [], disks_over_80: [], runners_offline: []
    };
    const latest = latestAgentVersion(db);
    const bump = (map, key) => { map[key || 'unknown'] = (map[key || 'unknown'] || 0) + 1; };
    for (const h of hosts) {
      const seen = h.last_seen ? Date.parse(h.last_seen) : NaN;
      const online = Number.isFinite(seen) && nowMs - seen <= ONLINE_MS;
      const ref = { host_id: h.id, hostname: h.hostname };
      out.totals[online ? 'online' : 'offline']++;
      bump(out.totals.by_os, h.os);
      bump(out.totals.by_kind, h.kind);
      bump(out.totals.by_status, online ? 'online' : 'offline');
      if (!online) out.offline_hosts.push({ ...ref, last_seen: h.last_seen });
      if (h.kind === 'agent' && h.agent_version && latest && compareVersions(h.agent_version, latest) < 0) {
        out.agents_out_of_date.push({ ...ref, agent_version: h.agent_version, latest });
      }
      const inv = parseJson(h.inventory, null);
      if (!inv) continue;
      const u = inv.updates || {};
      if (u.reboot_required || u.restart_required || inv.windows?.pending_reboot?.any) {
        out.pending_reboots.push({ ...ref, days: Number(u.reboot_pending_days) || 0 });
      }
      const patched = u.last_patch ? Date.parse(u.last_patch) : NaN;
      const stale = Number.isFinite(patched) && nowMs - patched > PATCH_DAYS * DAY;
      if (Number(u.pending) > 0 || stale) {
        out.behind_on_patches.push({ ...ref, pending: Number(u.pending) || 0, last_patch: u.last_patch || null,
          reason: Number(u.pending) > 0 ? 'pending updates' : `last patch over ${PATCH_DAYS} days ago` });
      }
      for (const d of Array.isArray(inv.disks) ? inv.disks : []) {
        if (Number(d.percent) > DISK_LIMIT) out.disks_over_80.push({ ...ref, mount: d.mount, percent: d.percent });
      }
      for (const r of Array.isArray(inv.runners) ? inv.runners : []) {
        if (!RUNNER_OK.has(String(r.service_state || '').toLowerCase())) {
          out.runners_offline.push({ ...ref, runner: r.name || r.path, service_state: r.service_state || 'unknown' });
        }
      }
    }
    out.pending_reboots.sort((a, b) => b.days - a.days);
    out.jobs_failed_24h = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed' AND COALESCE(completed_at, created_at) >= ?")
      .get(new Date(nowMs - DAY).toISOString()).n;
    out.queued_runs = Number(ctx.settings.get('github_queued')) || 0; // filled by the GitHub item when it caches queued runs
    out.trend = ctx.metrics.fleetTrend(nowMs);
    return out;
  }

  app.get('/api/fleet/summary', (req, res) => res.json(summary()));
};
