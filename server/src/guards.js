// Typed-confirmation rules for template runs. A guarded template (guard: true) and any run with force set need
// body.confirm to equal the host name. A run over several hosts needs the template id instead.
const needsConfirm = (tpl, body) => !!(tpl.guard || (body && body.force));

const confirmWord = (tpl, hosts) => (hosts.length === 1 ? (hosts[0].hostname || hosts[0].id) : tpl.id);

// guardMiddleware(ctx): runs after the route has put { tpl, hosts } on req.run.
function guardMiddleware(ctx) {
  return (req, res, next) => {
    if (!needsConfirm(req.run.tpl, req.body)) return next();
    return ctx.requireConfirm(() => confirmWord(req.run.tpl, req.run.hosts))(req, res, next);
  };
}

module.exports = { needsConfirm, confirmWord, guardMiddleware };
