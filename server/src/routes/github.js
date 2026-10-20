// GitHub settings and cache (A7): sealed token, status, permission probe, poll now, queued runs, latest runner release.
// The token is write-only: no route returns it. Runner actions are in runners.js.
const { createGithub } = require('../github');

module.exports = (app, ctx) => {
  const github = createGithub(ctx);
  ctx.github = github; // { runnerOnline, latestRunner, status, queued, fleet, ... } for runbooks and alert rules
  github.start();
  ctx.onClose(() => github.stop());
  const admin = ctx.requireRole('admin');

  // Registered here, not in runners.js: routes load alphabetically and metrics.js claims /api/hosts/:id/runners as an
  // inventory slice, so this file must register it first.
  app.get('/api/hosts/:id/runners', (req, res) => {
    if (!ctx.db.prepare('SELECT 1 FROM hosts WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Host not found' });
    res.json({ runners: github.fleet().filter(r => r.host_id === req.params.id), github: github.status(), latest: github.latestRunner() });
  });

  app.get('/api/github/status', (req, res) => res.json({ ...github.status(), latest: github.latestRunner() }));
  app.get('/api/github/queued', (req, res) => res.json(github.queued()));
  app.get('/api/github/latest', (req, res) => res.json(github.latestRunner()));

  // Body {token}. With no token in the body, the first save reads LABCTL_GITHUB_TOKEN from the server environment.
  app.put('/api/github/token', admin, (req, res) => {
    let value = req.body && req.body.token;
    if (value === undefined || value === null || value === '') value = github.configured() ? null : process.env.LABCTL_GITHUB_TOKEN;
    if (!value) return res.status(400).json({ error: 'token is required (or set LABCTL_GITHUB_TOKEN in the server environment before the first save)' });
    value = String(value).trim();
    if (value.length < 8 || value.length > 500 || /\s/.test(value)) return res.status(400).json({ error: 'token has an invalid format' });
    github.setToken(value);
    ctx.audit(req.user.username, 'github.token.set', null, { source: req.body && req.body.token ? 'request' : 'environment' });
    github.poll().catch(() => {});
    res.json({ configured: true });
  });

  app.delete('/api/github/token', admin, (req, res) => {
    github.clearToken();
    ctx.audit(req.user.username, 'github.token.clear');
    res.json({ configured: false });
  });

  // Body {write_check:true} also tests registration-token creation (the token is discarded at once).
  app.post('/api/github/check-permissions', admin, async (req, res) => {
    try { res.json(await github.checkPermissions({ write_check: !!(req.body && req.body.write_check) })); } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.post('/api/github/poll', async (req, res) => {
    if (!github.configured()) return res.status(400).json({ error: 'GitHub token is not configured' });
    res.json(await github.poll());
  });

  // Body {poll_s (30 or more), repos: ["owner/repo"]}. repos names extra repositories for organisation runners.
  app.put('/api/github/settings', admin, (req, res) => {
    const { poll_s, repos } = req.body || {};
    if (poll_s !== undefined) {
      const n = Number(poll_s);
      if (!Number.isFinite(n) || n < 30 || n > 86400) return res.status(400).json({ error: 'poll_s must be between 30 and 86400' });
      ctx.settings.set('github_poll_s', Math.round(n));
    }
    if (repos !== undefined) {
      const list = Array.isArray(repos) ? repos.map(r => String(r).trim()).filter(Boolean) : null;
      if (!list || list.length > 200 || list.some(r => !github.parseScope(r) || github.parseScope(r).kind !== 'repo')) {
        return res.status(400).json({ error: 'repos must be a list of owner/repo names' });
      }
      ctx.settings.set('github_repos', list.map(r => github.parseScope(r).scope));
    }
    res.json(github.status());
  });
};
