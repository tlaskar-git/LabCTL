// Host actions panel (Phase 8): which templates fit one host, grouped for the UI, and the latest result log per template.
// Also adds, in front of POST /api/templates/:id/run (routes/templates.js loads later, files load in sorted order):
//  - the typed confirmation for any run that touches a domain controller, which guards.js does not know about
//  - one audit row per host for every confirmed guarded run (actor, template, host, confirm: true, no secrets)
const { parseJson } = require('../db');
const { needsConfirm, confirmWord } = require('../guards');

const GROUPS = ['Patch', 'Security', 'Network', 'Cleanup', 'Health', 'Danger'];
const BY_ID = {
  vps_apt_upgrade: 'Patch', vps_reboot_required: 'Patch', vps_unattended_status: 'Patch', win_update: 'Patch', pve_status: 'Patch',
  pve_snapshot: 'Patch', mac_update: 'Patch', brew_update: 'Patch',
  vps_fail2ban_status: 'Security', vps_listening_ports: 'Security', vps_cert_expiry: 'Security', mac_security_report: 'Security',
  vps_wireguard_status: 'Network', win_wireguard_state: 'Network', vps_wireguard_restart: 'Network', traefik_restart: 'Network',
  win_dns_check: 'Network', win_dns_restart: 'Network',
  vps_cleanup: 'Cleanup',
  vps_post_reboot_check: 'Health', win_service_health: 'Health', win_dc_health: 'Health', pve_guests: 'Health', pve_backup_report: 'Health',
  vps_scheduled_reboot: 'Danger', win_reboot: 'Danger', mac_reboot: 'Danger'
};
const groupOf = t => BY_ID[t.id] || (t.admin || /(^|_)(reboot|remove)(_|$)/.test(t.id) ? 'Danger' : /cleanup|killer/.test(t.id) ? 'Cleanup'
  : /update|upgrade/.test(t.id) ? 'Patch' : /restart/.test(t.id) ? 'Network' : 'Health');
const DC_ONLY = new Set(['win_dc_health', 'win_dns_check', 'win_dns_restart']);

// Role comes from the kind, the last inventory and, for a domain controller, the agent flag or a "domain-controller" tag.
function rolesOf(db, host) {
  const inv = parseJson(host.inventory, null) || {};
  const tags = db.prepare('SELECT t.name FROM tags t JOIN host_tags ht ON ht.tag_id = t.id WHERE ht.host_id = ?').all(host.id).map(t => t.name.toLowerCase());
  const win = inv.windows || {};
  return {
    vps: host.kind === 'vps',
    proxmox: host.kind === 'proxmox' || !!inv.proxmox || tags.includes('proxmox'),
    domain_controller: host.os === 'windows' && (win.domain_controller === true || [4, 5].includes(Number(win.domain_role)) || tags.includes('domain-controller')),
    runner: host.kind === 'runner' || (Array.isArray(inv.runners) && inv.runners.length > 0)
  };
}

function applicable(tpl, host, roles) {
  if (host.os && !tpl.os.includes(host.os)) return false;
  if (!tpl.kinds.includes(host.kind)) return false;
  if (tpl.category === 'proxmox') return roles.proxmox;
  if (tpl.category === 'runner') return roles.runner;
  if (DC_ONLY.has(tpl.id)) return roles.domain_controller;
  return true;
}

module.exports = (app, ctx) => {
  const { db } = ctx;
  const hostRow = id => db.prepare('SELECT * FROM hosts WHERE id = ?').get(String(id));

  app.get('/api/hosts/:id/actions', (req, res) => {
    const host = hostRow(req.params.id);
    if (!host) return res.status(404).json({ error: 'Host not found' });
    const roles = rolesOf(db, host);
    const word = host.hostname || host.id;
    const list = ctx.templates.catalogue.templates.filter(t => applicable(t, host, roles)).map(t => {
      const dc = roles.domain_controller;
      return { id: t.id, name: t.name, description: t.description, category: t.category, group: groupOf(t), params: t.params, secrets: t.secrets,
        drain: t.drain, admin: t.admin, guard: t.guard || dc, guard_reason: t.guard ? 'template' : dc ? 'domain_controller' : null, confirm_word: word };
    });
    res.json({ host: { id: host.id, hostname: word, os: host.os, kind: host.kind }, roles: Object.keys(roles).filter(k => roles[k]),
      groups: GROUPS.map(group => ({ group, actions: list.filter(a => a.group === group) })).filter(g => g.actions.length) });
  });

  // Latest finished job per template on this host, with the tail of its log, for the result cards.
  app.get('/api/hosts/:id/action-results', (req, res) => {
    if (!hostRow(req.params.id)) return res.status(404).json({ error: 'Host not found' });
    const rows = db.prepare(`SELECT id, type, status, created_at, completed_at FROM jobs WHERE host_id = ? AND type LIKE 'template:%'
      AND status NOT IN ('pending','sent','running','waiting') ORDER BY created_at DESC LIMIT 300`).all(req.params.id);
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      if (seen.has(r.type)) continue;
      seen.add(r.type);
      out.push({ template: r.type.slice('template:'.length), job_id: r.id, status: r.status, at: r.completed_at || r.created_at,
        log: String(ctx.joblog.read(r.id) || '').slice(-200000) });
    }
    res.json(out);
  });

  app.post('/api/templates/:id/run', (req, res, next) => {
    const tpl = ctx.templates.catalogue.byId.get(req.params.id);
    if (!tpl) return next();
    const hosts = ctx.templates.resolveHosts(req.body || {}).hosts.filter(h => !h.os || tpl.os.includes(h.os));
    const dc = hosts.filter(h => rolesOf(db, h).domain_controller);
    const guarded = needsConfirm(tpl, req.body) || dc.length > 0;
    if (!guarded) return next();
    res.on('finish', () => {
      if (res.statusCode !== 200) return;
      const actor = req.user?.username;
      for (const h of hosts) {
        ctx.audit(actor, 'template.guard_confirmed', h.id, { template: tpl.id, confirm: true,
          reason: needsConfirm(tpl, req.body) ? (tpl.guard ? 'template' : 'force') : 'domain_controller' });
      }
    });
    if (needsConfirm(tpl, req.body)) return next(); // guards.js asks for it
    return ctx.requireConfirm(() => confirmWord(tpl, hosts))(req, res, next);
  });
};
