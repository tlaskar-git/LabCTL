// Typed-confirmation rules for template runs, in one place. A run needs body.confirm when the template is guarded
// (guard: true), when force is set, or when any target host is a domain controller. One host: the word is its name.
// A run over several hosts needs the template id instead. Every confirmed guarded run writes one
// template.guard_confirmed audit row per host (actor, template, host, confirm: true, reason, no secrets).
const { parseJson } = require('./db');

const needsConfirm = (tpl, body) => !!(tpl.guard || (body && body.force));

const confirmWord = (tpl, hosts) => (hosts.length === 1 ? (hosts[0].hostname || hosts[0].id) : tpl.id);

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

// 'template', 'force', 'domain_controller' or null when the run needs no typed confirmation.
function guardReason(db, tpl, hosts, body) {
  if (needsConfirm(tpl, body)) return tpl.guard ? 'template' : 'force';
  return hosts.some(h => rolesOf(db, h).domain_controller) ? 'domain_controller' : null;
}

// guardMiddleware(ctx): runs after the route has put { tpl, hosts } on req.run.
function guardMiddleware(ctx) {
  return (req, res, next) => {
    const { tpl, hosts } = req.run;
    const reason = guardReason(ctx.db, tpl, hosts, req.body);
    if (!reason) return next();
    res.on('finish', () => {
      if (res.statusCode !== 200) return;
      for (const h of hosts) ctx.audit(req.user?.username, 'template.guard_confirmed', h.id, { template: tpl.id, confirm: true, reason });
    });
    return ctx.requireConfirm(() => confirmWord(tpl, hosts))(req, res, next);
  };
}

module.exports = { needsConfirm, confirmWord, rolesOf, guardReason, guardMiddleware };
