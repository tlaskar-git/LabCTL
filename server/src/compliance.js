// Compliance report: one row per host from its latest inventory, plus summary counts and CSV.
// Settings used: compliance_patch_days (35), compliance_backup_days (8), compliance_eol_warn_days (180),
// backup_job_pattern ('backup|vzdump|restic|borg', matched against job type, template id and script name).
const { parseJson } = require('./db');
const { compareVersions, latestAgentVersion } = require('./hostops');
const eol = require('./compliance-eol');

const DAY = 86400000;
const ONLINE_MS = 90000;
const DEFAULT_PATTERN = 'backup|vzdump|restic|borg';
const off = x => x === false || (x && typeof x === 'object' && x.enabled === false);

function backupRegex(pattern) {
  try { return new RegExp(pattern || DEFAULT_PATTERN, 'i'); } catch { return new RegExp(DEFAULT_PATTERN, 'i'); }
}

// Latest successful backup-type job per host: { host_id: iso }.
function lastBackups(db, re) {
  const out = {};
  const rows = db.prepare(`SELECT j.host_id, j.type, j.params, j.completed_at, s.name AS script_name
    FROM jobs j LEFT JOIN scripts s ON s.id = j.script_id WHERE j.status = 'completed' AND j.completed_at IS NOT NULL
    ORDER BY j.completed_at DESC LIMIT 20000`).all();
  for (const r of rows) {
    if (out[r.host_id]) continue;
    const tpl = parseJson(r.params, {}).template || '';
    if (re.test(`${r.type} ${tpl} ${r.script_name || ''}`)) out[r.host_id] = r.completed_at;
  }
  return out;
}

function build(ctx, now = new Date()) {
  const { db, settings } = ctx;
  const num = (k, d) => Number(settings.get(k)) || d;
  const patchDays = num('compliance_patch_days', 35);
  const backupDays = num('compliance_backup_days', 8);
  const warnDays = num('compliance_eol_warn_days', 180);
  const latest = latestAgentVersion(db);
  const backups = lastBackups(db, backupRegex(settings.get('backup_job_pattern')));
  const ms = now.getTime();

  const hosts = db.prepare('SELECT * FROM hosts ORDER BY hostname COLLATE NOCASE').all().map(h => {
    const inv = parseJson(h.inventory, null);
    const u = inv?.updates || {};
    const info = inv?.os_info || {};
    const seen = h.last_seen ? Date.parse(h.last_seen) : NaN;
    const online = Number.isFinite(seen) && ms - seen <= ONLINE_MS;
    const proxmox = h.kind === 'proxmox' && inv?.proxmox?.version ? /(\d+\.\d+(?:\.\d+)?)/.exec(inv.proxmox.version)?.[1] : null;
    const lookup = proxmox
      ? eol.lookup({ name: 'Proxmox VE', version: proxmox }, now, warnDays)
      : eol.lookup({ name: info.name || h.os || '', version: info.version || h.os_version || '', build: info.build }, now, warnDays);
    const patched = u.last_patch ? Date.parse(u.last_patch) : NaN;
    const patchAge = Number.isFinite(patched) ? Math.max(0, Math.floor((ms - patched) / DAY)) : null;
    const rebootPending = !!(u.reboot_required || u.restart_required || inv?.windows?.pending_reboot?.any);
    const sec = inv?.security || {};
    const flags = [];
    if (!online) flags.push('offline');
    if ((inv?.disks || []).some(d => Number(d.percent) > 90)) flags.push('disk_over_90');
    if ((inv?.smart || []).some(d => d.health === 'failing')) flags.push('smart_failing');
    if (off(sec.firewall)) flags.push('firewall_off');
    if (off(sec.filevault)) flags.push('filevault_off');
    if (off(sec.defender)) flags.push('defender_off');
    const lastBackup = backups[h.id] || null;
    const noBackup = !lastBackup || ms - Date.parse(lastBackup) > backupDays * DAY;
    const agentVersion = h.agent_version || null;
    const agentOutdated = !!(h.kind !== 'ssh' && agentVersion && latest && compareVersions(agentVersion, latest) < 0);
    const issues = [];
    if (lookup.status === 'eol') issues.push('eol');
    if (lookup.status === 'eol_soon') issues.push('eol_soon');
    if (patchAge !== null && patchAge > patchDays) issues.push('patch_old');
    if (Number(u.pending) > 0) issues.push('pending_updates');
    if (rebootPending && Number(u.reboot_pending_days) > 7) issues.push('reboot_overdue');
    if (agentOutdated) issues.push('agent_outdated');
    if (noBackup) issues.push('no_backup');
    issues.push(...flags);
    return {
      host_id: h.id, hostname: h.hostname, os: h.os, kind: h.kind, online,
      os_name: info.name || null, os_version: info.version || h.os_version || null,
      eol_status: lookup.status, eol_product: lookup.product, eol_date: lookup.eol_date, eol_days_left: lookup.days_left,
      last_patch: u.last_patch || null, patch_age_days: patchAge, pending_updates: Number(u.pending) || 0, security_updates: Number(u.security) || 0,
      reboot_pending: rebootPending, reboot_pending_days: rebootPending ? (Number(u.reboot_pending_days) || 0) : null,
      agent_version: agentVersion, agent_latest: latest, agent_outdated: agentOutdated,
      last_backup_at: lastBackup, no_recent_backup: noBackup, inventory_at: h.inventory_at || null, flags, issues, compliant: issues.length === 0
    };
  });

  const count = key => hosts.filter(h => h.issues.includes(key)).length;
  const byOs = {};
  for (const h of hosts) byOs[h.os || 'unknown'] = (byOs[h.os || 'unknown'] || 0) + 1;
  return {
    generated_at: now.toISOString(),
    thresholds: { patch_days: patchDays, backup_days: backupDays, eol_warn_days: warnDays },
    summary: {
      hosts: hosts.length, compliant: hosts.filter(h => h.compliant).length, with_issues: hosts.filter(h => !h.compliant).length,
      eol: count('eol'), eol_soon: count('eol_soon'), patch_old: count('patch_old'), pending_updates: count('pending_updates'),
      reboot_pending: hosts.filter(h => h.reboot_pending).length, agent_outdated: count('agent_outdated'), no_backup: count('no_backup'),
      offline: count('offline'), by_os: byOs
    },
    hosts
  };
}

const COLUMNS = ['hostname', 'os', 'kind', 'online', 'os_name', 'os_version', 'eol_status', 'eol_product', 'eol_date', 'last_patch', 'patch_age_days',
  'pending_updates', 'security_updates', 'reboot_pending', 'reboot_pending_days', 'agent_version', 'agent_outdated', 'last_backup_at', 'no_recent_backup', 'issues'];

// Cells that start with = + - @ get a leading quote so a spreadsheet does not run them as a formula.
function csvCell(v) {
  let t = Array.isArray(v) ? v.join(' ') : v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

function toCsv(report) {
  return [COLUMNS.join(','), ...report.hosts.map(h => COLUMNS.map(c => csvCell(h[c])).join(','))].join('\r\n') + '\r\n';
}

module.exports = { build, toCsv, backupRegex, DEFAULT_PATTERN };
