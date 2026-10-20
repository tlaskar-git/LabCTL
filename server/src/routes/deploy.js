// Add host wizard and agent deployment (A3). Pre-flight, install over SSH or WinRM (optionally through a relay agent),
// live log (SSE), redeploy, remove agent, and the manual one-line installers. Engine: src/deploy/engine.js.
const ops = require('../hostops');
const { createDeploy } = require('../deploy/engine');

module.exports = (app, ctx) => {
  const { db } = ctx;
  const deploy = ctx.deploy = createDeploy(ctx);
  const admin = ctx.requireRole('admin');
  const isAdmin = req => req.user?.role === 'admin';
  const actor = req => req.user?.username || 'unknown';
  const hostRow = id => db.prepare('SELECT * FROM hosts WHERE id = ?').get(id);
  const handle = fn => async (req, res, next) => {
    try { await fn(req, res); } catch (e) { if (e.expose) res.status(e.status || 400).json({ error: e.message }); else next(e); }
  };
  const needAdminToSave = req => { if (req.body?.save_credential && !isAdmin(req)) throw deploy.bad('admin role required to save a credential', 403); };

  // Online agent hosts that can act as a relay (Linux and Mac).
  app.get('/api/deploy/relays', (req, res) => {
    res.json(ctx.agents.onlineIds().map(hostRow).filter(h => h && h.kind !== 'ssh' && ['linux', 'darwin'].includes(h.os))
      .map(h => ({ id: h.id, hostname: h.hostname, os: h.os, ip: h.ip })));
  });

  app.post('/api/deploy/preflight', handle(async (req, res) => {
    const t = deploy.target(req.body || {});
    res.json(await deploy.preflight(t, deploy.serverBase(req), actor(req)));
  }));

  app.post('/api/deploy/start', handle(async (req, res) => {
    needAdminToSave(req);
    const t = deploy.target(req.body || {});
    const d = deploy.start(t, { actor: actor(req), server: deploy.serverBase(req), name: String(req.body.name || '').slice(0, 100), save: !!req.body.save_credential });
    res.status(202).json({ deploy_id: d.id, state: d.state });
  }));

  app.post('/api/deploy/manual-commands', handle(async (req, res) => {
    res.json(deploy.manualCommands(deploy.serverBase(req), actor(req)));
  }));

  app.get('/api/deploy/:id', (req, res) => {
    const d = deploy.get(req.params.id);
    if (!d) return res.status(404).json({ error: 'Not found' });
    res.json(deploy.view(d));
  });
  app.get('/api/deploy/:id/stream', (req, res) => {
    const d = deploy.get(req.params.id);
    if (!d) return res.status(404).json({ error: 'Not found' });
    deploy.stream(d, req, res);
  });

  // v1 stored the full OS text (for example debian-12 or windows-server-2025), the deploy engine wants linux, mac or windows.
  const osOfHost = v => (/windows/i.test(v || '') ? 'windows' : /darwin|mac/i.test(v || '') ? 'mac' : 'linux');

  // What a redeploy or an offline uninstall knows about the host: the target saved by its last deploy.
  function hostDefaults(h, req) {
    const dd = ops.getData(db, h.id).deploy || {};
    const reset = req.body?.reset_host_key;
    if (reset && !isAdmin(req)) throw deploy.bad('admin role required to reset the host key', 403);
    return { os: dd.os || osOfHost(h.os), address: dd.address || h.ip, port: dd.port, relay_host_id: dd.relay_host_id, no_service: dd.no_service,
      host_key: reset ? '' : dd.host_key, auth: { user: dd.user, credential_id: dd.credential_id } };
  }
  const agentHost = req => {
    const h = hostRow(req.params.id);
    if (!h) throw deploy.bad('Not found', 404);
    if (h.kind === 'ssh') throw deploy.bad('This is an agentless SSH host. It has no agent.');
    return h;
  };

  // Reinstalls the agent on a host. Keeps the host id: the agent registers under the same id.
  app.post('/api/hosts/:id/redeploy', handle(async (req, res) => {
    const h = agentHost(req);
    needAdminToSave(req);
    let t;
    try { t = deploy.target(req.body || {}, hostDefaults(h, req)); } catch (e) {
      if (e.expose && /password or private key/.test(e.message)) throw deploy.bad('No saved credential for this host. Enter a user and a password or key.');
      throw e;
    }
    const d = deploy.start(t, { actor: actor(req), server: deploy.serverBase(req), hostId: h.id, name: h.hostname, save: !!req.body?.save_credential });
    res.status(202).json({ deploy_id: d.id, state: d.state });
  }));

  const waitGone = (hostId, ms) => new Promise(resolve => {
    const done = v => { clearTimeout(timer); ctx.events.off('agent_message', on); resolve(v); };
    const on = ({ host_id, msg }) => { if (host_id === hostId && msg.type === 'agent_gone') done('confirmed'); };
    const timer = setTimeout(() => done('timeout'), ms);
    ctx.events.on('agent_message', on);
  });

  // Removes the agent from the host and leaves the host record (also_remove: true deletes the record as well).
  app.post('/api/hosts/:id/remove-agent', admin, ctx.requireConfirm(req => { const h = hostRow(req.params.id); return h ? (h.hostname || h.id) : null; }),
    handle(async (req, res) => {
      const h = agentHost(req);
      if (req.body?.also_remove) {
        const r = await ops.removeHost(ctx, h, 'uninstall_and_remove', actor(req));
        return res.json({ ok: true, removed: true, uninstall: r.uninstall });
      }
      if (ctx.agents.isOnline(h.id)) {
        const gone = waitGone(h.id, ops.config.uninstallWaitMs);
        ctx.agents.send(h.id, { type: 'uninstall' });
        const uninstall = await gone;
        ctx.audit(actor(req), 'deploy.remove_agent', h.id, { hostname: h.hostname, uninstall, via: 'agent' });
        return res.json({ ok: uninstall === 'confirmed', removed: false, uninstall });
      }
      let t;
      try { t = deploy.target(req.body || {}, hostDefaults(h, req)); } catch {
        throw deploy.bad('The agent is offline and no credential is available. Enter a user and a password or key to uninstall over the network, or delete the host record.', 409);
      }
      const d = deploy.start(t, { actor: actor(req), server: deploy.serverBase(req), hostId: h.id, name: h.hostname, mode: 'uninstall' });
      ctx.audit(actor(req), 'deploy.remove_agent', h.id, { hostname: h.hostname, via: 'network', deploy_id: d.id });
      res.status(202).json({ ok: true, removed: false, uninstall: 'deploy', deploy_id: d.id });
    }));
};
