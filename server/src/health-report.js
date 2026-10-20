// Daily health report: fleet counts, compliance problems, active alerts and failed jobs, as plain text and simple HTML.
// build(ctx) never throws for a missing collaborator (ctx.alerting is optional). send(ctx) uses the alerting notifier.
const compliance = require('./compliance');

const DAY = 86400000;
const SECTIONS = ['Fleet', 'Compliance', 'Alerts', 'Jobs'];
const ONLINE_MS = 90000;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const names = (rows, n = 8) => (rows.length > n ? [...rows.slice(0, n).map(r => r.hostname), `and ${rows.length - n} more`] : rows.map(r => r.hostname)).join(', ');

// opts.sections: the section titles to include (default all).
function build(ctx, now = new Date(), opts = {}) {
  const { db } = ctx;
  const ms = now.getTime();
  const hosts = db.prepare('SELECT id, hostname, last_seen FROM hosts ORDER BY hostname COLLATE NOCASE').all();
  const offline = hosts.filter(h => !(h.last_seen && ms - Date.parse(h.last_seen) <= ONLINE_MS));
  const rep = compliance.build(ctx, now);
  const s = rep.summary;
  const failedJobs = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed' AND COALESCE(completed_at, created_at) >= ?").get(new Date(ms - DAY).toISOString()).n;
  let alerts = null;
  try { alerts = ctx.alerting?.listAlerts({ state: 'active', limit: 20 }) || null; } catch { alerts = null; }
  const alertRows = alerts && !alerts.error ? alerts.rows : null;

  const withIssue = key => rep.hosts.filter(h => h.issues.includes(key));
  const all = [
    { title: 'Fleet', lines: [`${hosts.length} hosts, ${hosts.length - offline.length} online, ${offline.length} offline`, ...(offline.length ? [`Offline: ${names(offline)}`] : [])] },
    { title: 'Compliance', lines: [
      `${s.compliant} of ${s.hosts} hosts have no findings`,
      `End of life: ${s.eol}, ending soon: ${s.eol_soon}`,
      `Patch age over ${rep.thresholds.patch_days} days: ${s.patch_old}, with pending updates: ${s.pending_updates}, waiting for a reboot: ${s.reboot_pending}`,
      `Agents out of date: ${s.agent_outdated}`,
      `No successful backup job in ${rep.thresholds.backup_days} days: ${s.no_backup}${s.no_backup ? ` (${names(withIssue('no_backup'))})` : ''}`,
      ...(s.eol ? [`End of life hosts: ${names(withIssue('eol'))}`] : [])
    ] },
    { title: 'Alerts', lines: alertRows === null ? ['Alerting is not available on this server'] : alertRows.length === 0 ? ['No active alerts'] :
      [`${alerts.total} active`, ...alertRows.slice(0, 10).map(a => `${String(a.severity).toUpperCase()} ${a.rule_name || a.rule_id}${a.hostname ? ` on ${a.hostname}` : ''}: ${a.message || ''}`.trim())] },
    { title: 'Jobs', lines: [`${failedJobs} failed in the last 24 hours`] }
  ];
  const want = Array.isArray(opts.sections) && opts.sections.length ? opts.sections : SECTIONS;
  const sections = all.filter(sec => want.includes(sec.title));
  const counts = { Fleet: offline.length, Compliance: s.eol + s.patch_old + s.no_backup, Alerts: alertRows ? alertRows.length : 0, Jobs: failedJobs };
  const problems = sections.reduce((n, sec) => n + counts[sec.title], 0);
  const subject = `LabCTL daily health report: ${problems ? `${problems} item${problems === 1 ? '' : 's'} need attention` : 'all clear'}`;
  const text = [subject, `Generated ${now.toISOString()}`, '', ...sections.flatMap(sec => [sec.title.toUpperCase(), ...sec.lines.map(l => `  ${l}`), ''])].join('\n').trim();
  const html = `<h2>${esc(subject)}</h2><p>Generated ${esc(now.toISOString())}</p>` +
    sections.map(sec => `<h3>${esc(sec.title)}</h3><ul>${sec.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`).join('');
  return { subject, text, html, problems, severity: problems ? 'warning' : 'info', generated_at: now.toISOString() };
}

// Sends through ctx.alerting's notifier. Channels: opts.channels, else the health_report_channels setting, else the alerting
// defaults. opts.sections as for build().
async function send(ctx, now = new Date(), opts = {}) {
  const report = build(ctx, now, opts);
  const notifier = ctx.alerting?.notifier;
  if (!notifier) return { ok: false, error: 'Notification channels are not available (the alerting module is not loaded)', report };
  const ids = opts.channels?.length ? opts.channels : ctx.settings.get('health_report_channels') || [];
  const payload = { rule: 'Daily health report', severity: report.severity, host: null, message: report.text, since: report.generated_at,
    link: notifier.link('fleet'), recovery: false, report: true, subject: report.subject, html: report.html };
  const results = await notifier.dispatch(payload, ids);
  if (!results.length) return { ok: false, error: 'No enabled channel accepted the report. Set health_report_channels or default alert channels.', report };
  const failed = results.filter(r => !r.ok);
  return { ok: failed.length === 0, sent: results.length - failed.length, failed: failed.length, error: failed[0]?.error, report };
}

module.exports = { build, send, SECTIONS };
