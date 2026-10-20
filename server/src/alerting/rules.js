// Alert metrics and the default rule pack.
// A metric is registered with { label, unit, scope, live, eval }.
//   scope 'host'  : eval(env, host, rule) runs once per in-scope host.
//   scope 'fleet' : eval(env, rule) runs once; items may carry host_id (used for scope and display).
//   live          : true means the metric is skipped while the host is offline (its data would be stale).
// eval returns items [{ key, value, detail?, host_id? }]. No item for a subject means "fine, resolve it".
// An item with value null means "no data": the subject keeps its current state.
// env: { now (ms), db, hostsLatest(), inv(host), hb(host), fact(hostId, key), githubRunners(), githubQueued(),
//        githubCheck(), cfg (alert_config), mem (Maps that live as long as the engine) }
const { compareVersions } = require('../hostops');

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const GB = 1024 ** 3;
const nodata = [{ key: '', value: null }];
const single = (value, detail) => (value === null || value === undefined ? nodata : [{ key: '', value, detail }]);
const names = (list, pick) => list.slice(0, 5).map(pick).join(', ') + (list.length > 5 ? ` and ${list.length - 5} more` : '');
const winMinutes = (rule, def) => Math.max(1, Number(rule?.params?.window_minutes) || def);

// Remembers when a flag first became true for a key, so "offline for N minutes" works without a timestamp from the source.
function sinceFlag(env, bucket, key, active, iso) {
  const map = (env.mem[bucket] ||= new Map());
  if (!active) { map.delete(key); return null; }
  if (iso && !isNaN(Date.parse(iso))) { map.set(key, Date.parse(iso)); return map.get(key); }
  if (!map.has(key)) map.set(key, env.now);
  return map.get(key);
}

const norm = p => String(p || '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
function diskFor(inv, folder) {
  const p = norm(folder);
  let best = null;
  for (const d of inv.disks || []) {
    const m = norm(d.mount);
    if ((m === '' || p === m || p.startsWith(`${m}/`)) && num(d.percent) !== null && (!best || m.length > norm(best.mount).length)) best = d;
  }
  return best;
}

const METRICS = {
  host_offline: { flag: true, label: 'Host offline', unit: '', scope: 'host', live: false,
    eval: (env, h) => (h.status === 'gone' ? [] : h.status === 'online' || h.status === 'offline' ? single(h.status === 'offline' ? 1 : 0) : nodata) },
  disk_pct: { label: 'Disk used (fullest mount)', unit: '%', scope: 'host', live: true,
    eval(env, h) {
      const disks = (env.inv(h).disks || []).filter(d => num(d.percent) !== null);
      if (!disks.length) return nodata;
      const top = disks.reduce((a, b) => (b.percent > a.percent ? b : a));
      return single(top.percent, top.mount);
    } },
  ram_pct: { label: 'RAM used', unit: '%', scope: 'host', live: true,
    eval: (env, h) => single(num(env.hb(h).ram) ?? num(env.inv(h).memory?.percent)) },
  cpu_pct: { label: 'CPU average', unit: '%', scope: 'host', live: true,
    eval(env, h, rule) {
      const from = Math.floor(env.now / 1000) - winMinutes(rule, 5) * 60;
      let row = null;
      try { row = env.db.prepare('SELECT AVG(cpu) AS a, COUNT(cpu) AS n FROM metric_points WHERE host_id = ? AND ts >= ? AND cpu IS NOT NULL').get(h.id, from); } catch { /* metrics table not there yet */ }
      return single(row && row.n >= 2 ? row.a : num(env.hb(h).cpu));
    } },
  failed_services: { label: 'Failed services', unit: '', scope: 'host', live: true,
    eval(env, h) {
      const failed = env.inv(h).services?.failed;
      return Array.isArray(failed) ? single(failed.length, names(failed, s => s.name)) : nodata;
    } },
  docker_unhealthy_or_restarting: { label: 'Docker containers unhealthy or restarting', unit: '', scope: 'host', live: true,
    eval(env, h) {
      const list = env.inv(h).docker?.containers;
      if (!Array.isArray(list)) return nodata;
      const bad = list.filter(c => c.health === 'unhealthy' || ['restarting', 'dead'].includes(String(c.state || '').toLowerCase()));
      return single(bad.length, names(bad, c => c.name));
    } },
  reboot_pending_days: { label: 'Reboot pending', unit: ' days', scope: 'host', live: true,
    eval(env, h) {
      const u = env.inv(h).updates;
      if (!u) return nodata;
      return single(u.reboot_required || u.restart_required ? num(u.reboot_pending_days) ?? 0 : 0);
    } },
  agent_outdated: { flag: true, label: 'Agent behind the fleet', unit: '', scope: 'host', live: false,
    eval(env, h) {
      if (h.kind === 'ssh' || !h.agent_version) return [];
      const latest = env.latestAgent();
      return single(latest && compareVersions(h.agent_version, latest) < 0 ? 1 : 0, `${h.agent_version} < ${latest}`);
    } },
  job_failed: { label: 'Failed jobs', unit: '', scope: 'host', live: false,
    eval(env, h, rule) {
      const since = new Date(env.now - winMinutes(rule, 60) * 60000).toISOString();
      const rows = env.db.prepare("SELECT type FROM jobs WHERE host_id = ? AND status = 'failed' AND completed_at >= ?").all(h.id, since);
      return single(rows.length, names(rows, r => r.type));
    } },
  schedule_missed: { label: 'Missed schedule runs', unit: '', scope: 'host', live: false,
    eval(env, h, rule) {
      const since = new Date(env.now - winMinutes(rule, 60) * 60000).toISOString();
      const rows = env.db.prepare('SELECT name FROM schedules WHERE host_id = ? AND last_missed >= ?').all(h.id, since);
      return single(rows.length, names(rows, r => r.name));
    } },
  cert_expiry_days: { label: 'Certificate expires in', unit: ' days', scope: 'host', live: false,
    eval(env, h) {
      const v = num(env.fact(h.id, 'cert_expiry_days'));
      return v === null ? [] : single(v);
    } },
  docker_disk_gb: { label: 'Docker disk use', unit: ' GB', scope: 'host', live: true,
    eval(env, h) {
      const d = env.inv(h).docker;
      const bytes = num(d?.disk_bytes) ?? num(d?.size_bytes);
      return bytes === null ? [] : single(Math.round(bytes / GB * 10) / 10);
    } },
  runner_volume_pct: { label: 'Runner volume used', unit: '%', scope: 'host', live: true,
    eval(env, h) {
      const inv = env.inv(h);
      const out = [];
      for (const r of inv.runners || []) {
        const d = r.path && diskFor(inv, r.path);
        if (d) out.push({ key: r.name || r.path, value: d.percent, detail: d.mount });
      }
      return out;
    } },
  runner_work_size_gb: { label: 'Runner _work size', unit: ' GB', scope: 'host', live: true,
    eval(env, h) {
      return (env.inv(h).runners || []).filter(r => num(r.sizes?.work) !== null)
        .map(r => ({ key: r.name || r.path, value: Math.round(r.sizes.work / GB * 10) / 10 }));
    } },
  runner_offline_minutes: { label: 'Runner offline in GitHub', unit: ' min', scope: 'fleet', live: false,
    eval(env) {
      return env.githubRunners().map(r => {
        const key = `${r.host_id || ''}:${r.name}`;
        const since = sinceFlag(env, 'offline', key, r.online === false, r.offline_since);
        return since === null ? null : { host_id: r.host_id, key: r.name, value: Math.round((env.now - since) / 600) / 100 };
      }).filter(Boolean);
    } },
  runner_busy_hours: { label: 'Runner busy for', unit: ' h', scope: 'fleet', live: false,
    eval(env) {
      return env.githubRunners().map(r => {
        const key = `${r.host_id || ''}:${r.name}`;
        const since = sinceFlag(env, 'busy', key, r.busy === true && r.online !== false, r.busy_since);
        return since === null ? null : { host_id: r.host_id, key: r.name, value: Math.round((env.now - since) / 36000) / 100 };
      }).filter(Boolean);
    } },
  queued_wait_minutes_with_runner_unavailable: { label: 'Queued run waiting with no free runner', unit: ' min', scope: 'fleet', live: false,
    eval(env) {
      const queued = env.githubQueued();
      const runners = env.githubRunners();
      return Object.entries(queued).filter(([, q]) => q && q.count > 0).map(([repo, q]) => {
        const match = runners.filter(r => r.repo === repo || (Array.isArray(r.repos) && r.repos.includes(repo)) || (r.url && String(r.url).endsWith(`/${repo}`)));
        const pool = match.length ? match : runners;
        const free = pool.some(r => r.online !== false && !r.busy);
        return { key: repo, value: free ? 0 : Math.round(q.oldest_age_s / 6) / 10, detail: `${q.count} queued` };
      });
    } },
  runner_behind_days: { label: 'Runner version behind latest', unit: ' days', scope: 'fleet', live: false,
    eval: env => env.githubRunners().filter(r => num(r.behind_days) !== null)
      .map(r => ({ host_id: r.host_id, key: r.name, value: r.behind_days, detail: r.version })) },
  runner_public_repo: { flag: true, label: 'Runner attached to a public repository', unit: '', scope: 'fleet', live: false,
    eval: env => env.githubRunners().map(r => ({ host_id: r.host_id, key: r.name, value: r.public_repo ? 1 : 0 })) },
  github_permission_check_failed: { flag: true, label: 'GitHub token permission check failed', unit: '', scope: 'fleet', live: false,
    eval(env) {
      const c = env.githubCheck();
      return typeof c?.ok === 'boolean' ? [{ key: 'github', value: c.ok ? 0 : 1, detail: c.error ? String(c.error).slice(0, 200) : undefined }] : [];
    } }
};

const OPS = {
  '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b,
  '==': (a, b) => a === b, '!=': (a, b) => a !== b
};

const rule = (id, name, severity, metric, op, threshold, for_minutes, params = {}, description = '') =>
  ({ id: `default-${id}`, name, enabled: true, severity, scope: { type: 'all' }, condition: { metric, op, threshold, for_minutes }, params, channels: [], description });

// Seeded once. GitHub rules are enabled but stay dormant until the GitHub settings keys hold data.
const DEFAULT_RULES = [
  rule('host-offline', 'Host offline', 'critical', 'host_offline', '>=', 1, 3, {}, 'The host stopped reporting.'),
  rule('disk-high', 'Disk high', 'warning', 'disk_pct', '>=', 90, 10, {}, 'The fullest mount is at or above the threshold.'),
  rule('ram-high', 'RAM high', 'warning', 'ram_pct', '>=', 90, 10),
  rule('cpu-sustained', 'CPU sustained', 'warning', 'cpu_pct', '>=', 90, 15, { window_minutes: 5 }, 'Average CPU over the window.'),
  rule('failed-service', 'Failed service', 'warning', 'failed_services', '>=', 1, 5),
  rule('docker-problem', 'Docker problem', 'warning', 'docker_unhealthy_or_restarting', '>=', 1, 5),
  rule('reboot-pending', 'Reboot pending more than 7 days', 'warning', 'reboot_pending_days', '>', 7, 0),
  rule('agent-outdated', 'Agent outdated', 'info', 'agent_outdated', '>=', 1, 0),
  rule('job-failed', 'Job failed', 'warning', 'job_failed', '>=', 1, 0, { window_minutes: 60 }, 'A job failed in the last hour.'),
  rule('schedule-missed', 'Schedule missed', 'warning', 'schedule_missed', '>=', 1, 0, { window_minutes: 60 }),
  rule('cert-expiry', 'Certificate expires within 14 days', 'warning', 'cert_expiry_days', '<', 14, 0, {}, 'Needs the certificate template to print LABCTL_RESULT cert_expiry_days=<days>.'),
  rule('runner-offline', 'Runner offline in GitHub for more than 5 minutes', 'warning', 'runner_offline_minutes', '>', 5, 0),
  rule('runner-busy', 'Runner busy for more than 6 hours', 'warning', 'runner_busy_hours', '>', 6, 0),
  rule('queued-wait', 'Queued runs waiting more than 10 minutes with no free runner', 'warning', 'queued_wait_minutes_with_runner_unavailable', '>', 10, 0),
  rule('runner-volume', 'Runner volume above 80 percent', 'warning', 'runner_volume_pct', '>', 80, 10),
  rule('runner-work-size', 'Runner _work above its size limit', 'warning', 'runner_work_size_gb', '>', 50, 0, { threshold_setting: 'runner_work_limit_gb' }),
  rule('docker-disk', 'Docker disk above its limit', 'warning', 'docker_disk_gb', '>', 100, 0, { threshold_setting: 'docker_disk_limit_gb' }),
  rule('runner-behind', 'Runner version behind latest by more than 14 days', 'info', 'runner_behind_days', '>', 14, 0),
  rule('runner-public', 'Runner attached to a public repository', 'critical', 'runner_public_repo', '>=', 1, 0),
  rule('github-permission', 'GitHub token permission check fails', 'warning', 'github_permission_check_failed', '>=', 1, 0)
];

module.exports = { METRICS, OPS, DEFAULT_RULES, SEVERITIES: ['info', 'warning', 'critical'] };
