// Agent downloads and install help (v1 routes). Phase 4 (A4) extends this file.
const path = require('path');
const fs = require('fs');
module.exports = (app, ctx) => {
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
    const allowed = new Set(['setup-linux.sh', 'setup-windows.ps1', 'labctl-agent.py']);
    const file = req.params.file;
    if (!allowed.has(file)) return res.status(404).json({ error: 'Not found' });
    const dir = ctx.paths.serverDir;
    const found = [path.join(dir, 'agent', file), path.join(dir, '..', 'agent', file)].find(p => fs.existsSync(p));
    if (!found) return res.status(404).json({ error: 'Agent file not found in image' });
    res.download(found, file);
  });
};
