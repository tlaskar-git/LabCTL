// Agent install endpoints. GET /install/<linux.sh|mac.sh|windows.ps1|agent.py> is gated by an enrolment token
// (?token=<value> or Authorization: Bearer <value>), not by a session, so curl and irm work on the target host.
// The setup scripts are templates: the server URL and the token are rendered into their default lines.
// The token is the enrolment credential and is part of the rendered script by design. It is never logged or audited.
const path = require('path');
const fs = require('fs');

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;
const PUBLIC_URL_RE = /^(https?):\/\/([^/?#\s]+)$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,200}$/;

// file -> [source in agent/, content type, regexes for the two default lines]
const SH = [/^DEFAULT_SERVER=.*$/m, /^DEFAULT_TOKEN=.*$/m, "DEFAULT_SERVER='%s'", "DEFAULT_TOKEN='%s'"];
const PS = [/^\$DefaultServer = .*$/m, /^\$DefaultToken = .*$/m, "$DefaultServer = '%s'", "$DefaultToken = '%s'"];
const SCRIPTS = {
  'linux.sh': ['setup-linux.sh', 'text/x-shellscript; charset=utf-8', SH],
  'mac.sh': ['setup-mac.sh', 'text/x-shellscript; charset=utf-8', SH],
  'windows.ps1': ['setup-windows.ps1', 'text/plain; charset=utf-8', PS]
};

// Values are validated before they get here (host and token whitelists), so quoting is a second line of defence.
const shQuote = s => String(s).replace(/'/g, "'\\''");
const psQuote = s => String(s).replace(/'/g, "''");

module.exports = (app, ctx) => {
  const agentFile = name => [path.join(ctx.paths.serverDir, 'agent', name), path.join(ctx.paths.serverDir, '..', 'agent', name)]
    .find(p => fs.existsSync(p));

  // shortcut: in-memory fixed window per client IP, reset on restart. Upgrade to a shared store if the server is ever clustered.
  const hits = new Map();
  const LIMIT = 60, WINDOW_MS = 60000;
  const limited = ip => {
    const now = Date.now();
    if (hits.size > 10000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    let h = hits.get(ip);
    if (!h || h.reset < now) { h = { n: 0, reset: now + WINDOW_MS }; hits.set(ip, h); }
    return ++h.n > LIMIT;
  };

  function serverBase(req) {
    const pub = ctx.settings.get('public_url');
    const m = typeof pub === 'string' && PUBLIC_URL_RE.exec(pub.trim());
    if (m && HOST_RE.test(m[2])) return `${m[1]}://${m[2]}`;
    const host = req.get('host');
    if (!host || !HOST_RE.test(host)) return null;
    return `${req.protocol === 'https' ? 'https' : 'http'}://${host}`;
  }

  function gate(req, res, next) {
    if (limited(req.ip)) return res.status(429).end();
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
    const value = typeof req.query.token === 'string' ? req.query.token : bearer && bearer[1];
    const tokenId = value && TOKEN_RE.test(value) ? ctx.tokens.verify(value) : null;
    if (!tokenId) return res.status(401).end();
    req.install = { token: value, tokenId };
    next();
  }

  app.get('/install/agent.py', gate, (req, res) => {
    const f = agentFile('labctl-agent.py');
    if (!f) return res.status(404).end();
    ctx.audit('install', 'install.fetch', null, { file: 'agent.py', token_id: req.install.tokenId }, req.ip);
    res.set('Cache-Control', 'no-store').type('text/x-python; charset=utf-8').send(fs.readFileSync(f));
  });

  app.get('/install/:script', gate, (req, res) => {
    const kind = req.params.script;
    if (!Object.hasOwn(SCRIPTS, kind)) return res.status(404).end();
    const server = serverBase(req);
    if (!server) return res.status(400).end();
    const [file, type, [reServer, reToken, tplServer, tplToken]] = SCRIPTS[kind];
    const f = agentFile(file);
    if (!f) return res.status(404).end();
    const quote = kind.endsWith('.ps1') ? psQuote : shQuote;
    // Function replacers: the value is literal text, never a replacement pattern.
    const text = fs.readFileSync(f, 'utf8')
      .replace(reServer, () => tplServer.replace('%s', () => quote(server)))
      .replace(reToken, () => tplToken.replace('%s', () => quote(req.install.token)));
    ctx.audit('install', 'install.fetch', null, { file: kind, token_id: req.install.tokenId }, req.ip);
    res.set('Cache-Control', 'no-store').type(type).send(text);
  });

  app.get('/api/agents/info', (req, res) => {
    const wsProto = req.protocol === 'https' ? 'wss' : 'ws';
    res.json({
      server_url: `${wsProto}://${req.get('host')}/ws/agent`,
      files: [
        { id: 'linux', label: 'Linux setup script', path: '/api/agents/download/setup-linux.sh' },
        { id: 'windows', label: 'Windows setup script', path: '/api/agents/download/setup-windows.ps1' },
        { id: 'agent', label: 'Agent source', path: '/api/agents/download/labctl-agent.py' }
      ]
    });
  });
  app.get('/api/agents/download/:file', (req, res) => {
    const allowed = new Set(['setup-linux.sh', 'setup-mac.sh', 'setup-windows.ps1', 'labctl-agent.py']);
    const file = req.params.file;
    if (!allowed.has(file)) return res.status(404).json({ error: 'Not found' });
    const found = agentFile(file);
    if (!found) return res.status(404).json({ error: 'Agent file not found in image' });
    res.download(found, file);
  });
};
