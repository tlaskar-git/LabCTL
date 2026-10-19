// Shared test helpers (no tests here). Each app runs on a random port with its own temp data dir.
const os = require('os');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { generateKey } = require('../src/crypto');

const KEY = generateKey();
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'labctl-test-'));

async function startApp({ dataDir = tempDir(), listen = true } = {}) {
  const { createApp } = require('../src/app');
  const inst = createApp({ dataDir, masterKey: KEY, quiet: true });
  const port = listen ? await inst.listen(0, '127.0.0.1') : null;
  return { ...inst, port, base: `http://127.0.0.1:${port}`, dataDir,
    async stop() { await inst.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

async function login(base, username = 'LabCTLAdmin', password = 'LabCTL') {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  return (await r.json()).token;
}

function api(base, token) {
  return async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await r.json(); } catch { /* not json */ }
    return { status: r.status, data };
  };
}

// Resolves with the HTTP status of the upgrade: 101 when the socket opened, else the rejection status.
function wsStatus(port, token) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    ws.on('unexpected-response', (req, res) => { resolve(res.statusCode); req.destroy(); });
    ws.on('open', () => { resolve(101); ws.close(); });
    ws.on('error', () => {});
  });
}

function wsOpen(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent?token=${encodeURIComponent(token)}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

const nextMessage = ws => new Promise(resolve => ws.once('message', d => resolve(JSON.parse(d.toString()))));
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('waitFor timed out');
};

module.exports = { KEY, tempDir, startApp, login, api, wsStatus, wsOpen, nextMessage, waitFor };
