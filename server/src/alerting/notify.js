// Notification channels: SMTP (built-in client, no dependency), generic webhook and Telegram.
// Channel config is sealed as JSON in channels.config_sealed. API output shows secrets as MASK, never the value.
const net = require('net');
const tls = require('tls');
const os = require('os');
const { randomUUID, createHmac } = require('crypto');
const { ensureColumn } = require('../db');

const MASK = '********';
const KINDS = ['smtp', 'webhook', 'telegram'];
const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };
const EMAIL = /^[^\s<>@,;]+@[^\s<>@,;]+$/;

// ---- config handling ------------------------------------------------------------------------------------------

// Secret fields per kind. 'headers' is a map whose values are secret (header names are shown).
const SECRETS = { smtp: ['password'], webhook: ['hmac_secret', 'headers'], telegram: ['bot_token'] };

function secretValues(kind, config) {
  const out = [];
  for (const f of SECRETS[kind] || []) {
    const v = config?.[f];
    if (f === 'headers' && v && typeof v === 'object') out.push(...Object.values(v));
    else out.push(v);
  }
  return out.filter(v => typeof v === 'string' && v.length >= 4);
}

const scrub = (text, kind, config) => {
  let s = String(text ?? '');
  for (const v of secretValues(kind, config)) s = s.split(v).join('[redacted]');
  return s.slice(0, 500);
};

function mask(kind, config) {
  const out = { ...config };
  for (const f of SECRETS[kind] || []) {
    if (f === 'headers') out.headers = Object.fromEntries(Object.keys(config.headers || {}).map(k => [k, MASK]));
    else if (config[f]) out[f] = MASK;
  }
  return out;
}

// Incoming secret fields: absent or MASK keeps the stored value, null clears it, a string replaces it.
function merge(kind, existing, incoming) {
  const out = { ...existing, ...incoming };
  for (const f of SECRETS[kind] || []) {
    if (!(f in incoming)) continue;
    if (f === 'headers') {
      if (incoming.headers === null) { out.headers = {}; continue; }
      out.headers = {};
      for (const [k, v] of Object.entries(incoming.headers || {})) {
        if (v === MASK || v === '') { if (existing.headers?.[k] !== undefined) out.headers[k] = existing.headers[k]; } else out.headers[k] = String(v);
      }
    } else if (incoming[f] === MASK || incoming[f] === '') out[f] = existing[f];
    else if (incoming[f] === null) delete out[f];
  }
  return out;
}

function validate(kind, c) {
  if (!KINDS.includes(kind)) return { error: `kind must be one of ${KINDS.join(', ')}` };
  const minSeverity = c.min_severity === undefined ? 'info' : c.min_severity;
  if (!(minSeverity in SEVERITY_RANK)) return { error: 'min_severity must be info, warning or critical' };
  if (kind === 'smtp') {
    const port = c.port === undefined ? 25 : Number(c.port);
    const to = (Array.isArray(c.to) ? c.to : String(c.to || '').split(/[,\s]+/)).map(s => String(s).trim()).filter(Boolean);
    if (!c.host || !/^[A-Za-z0-9._:-]+$/.test(String(c.host))) return { error: 'host is required' };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'port must be 1 to 65535' };
    if (!['none', 'starttls', 'tls'].includes(c.secure || 'none')) return { error: 'secure must be none, starttls or tls' };
    if (!EMAIL.test(String(c.from || ''))) return { error: 'from must be an email address' };
    if (!to.length || to.some(a => !EMAIL.test(a))) return { error: 'to must list at least one email address' };
    return { config: { host: String(c.host), port, secure: c.secure || 'none', user: c.user ? String(c.user) : undefined,
      password: c.password || undefined, from: c.from, to, reject_unauthorized: c.reject_unauthorized !== false, min_severity: minSeverity } };
  }
  if (kind === 'webhook') {
    let url;
    try { url = new URL(String(c.url || '')); } catch { return { error: 'url must be a valid http or https URL' }; }
    if (!['http:', 'https:'].includes(url.protocol)) return { error: 'url must be a valid http or https URL' };
    const method = String(c.method || 'POST').toUpperCase();
    if (!['POST', 'PUT', 'PATCH'].includes(method)) return { error: 'method must be POST, PUT or PATCH' };
    if (c.headers && (typeof c.headers !== 'object' || Array.isArray(c.headers))) return { error: 'headers must be an object' };
    for (const k of Object.keys(c.headers || {})) if (!/^[A-Za-z0-9-]+$/.test(k)) return { error: `invalid header name ${k}` };
    if (c.template) { try { JSON.parse(typeof c.template === 'string' ? c.template : JSON.stringify(c.template)); } catch { return { error: 'template must be valid JSON' }; } }
    return { config: { url: url.toString(), method, headers: c.headers || {}, template: c.template ? (typeof c.template === 'string' ? c.template : JSON.stringify(c.template)) : undefined,
      hmac_secret: c.hmac_secret || undefined, min_severity: minSeverity } };
  }
  if (!String(c.bot_token || '').trim()) return { error: 'bot_token is required' };
  if (!String(c.chat_id ?? '').trim()) return { error: 'chat_id is required' };
  const thread = c.message_thread_id === undefined || c.message_thread_id === '' || c.message_thread_id === null ? undefined : Number(c.message_thread_id);
  if (thread !== undefined && !Number.isInteger(thread)) return { error: 'message_thread_id must be a number' };
  return { config: { bot_token: String(c.bot_token).trim(), chat_id: String(c.chat_id).trim(), message_thread_id: thread, min_severity: minSeverity } };
}

// ---- message ----------------------------------------------------------------------------------------------------

function render(p) {
  // A report (the daily health report) is not an alert: its own subject, no firing or recovery wording.
  if (p.report) return { title: p.subject || p.rule, text: [p.message, p.link ? `Open: ${p.link}` : ''].filter(Boolean).join('\n') };
  const title = `[${p.recovery ? 'RESOLVED' : p.test ? 'TEST' : 'FIRING'}] ${String(p.severity || 'info').toUpperCase()} ${p.rule}${p.host ? ` on ${p.host}` : ''}`;
  const lines = [p.message, p.recovery ? `Resolved: ${p.resolved_at}` : p.since ? `Since: ${p.since}` : '', p.link ? `Open: ${p.link}` : ''].filter(Boolean);
  return { title, text: lines.join('\n') };
}

// {{var}} in every string leaf of the template. Substituting leaves (not text) keeps the result valid JSON.
function fillTemplate(node, vars) {
  if (typeof node === 'string') return node.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
  if (Array.isArray(node)) return node.map(n => fillTemplate(n, vars));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fillTemplate(v, vars)]));
  return node;
}

// ---- SMTP ---------------------------------------------------------------------------------------------------------

function makeReader(stream) {
  let buf = '';
  let lines = [];
  let closed = null;
  const ready = [];
  const waiting = [];
  const push = r => (waiting.length ? waiting.shift().resolve(r) : ready.push(r));
  const onData = d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      lines.push(line);
      if (/^\d{3}( |$)/.test(line)) { push({ code: Number(line.slice(0, 3)), lines }); lines = []; }
    }
  };
  const onClose = () => { closed = new Error('SMTP connection closed'); waiting.splice(0).forEach(w => w.reject(closed)); };
  stream.on('data', onData);
  stream.on('close', onClose);
  return {
    read: () => (ready.length ? Promise.resolve(ready.shift()) : closed ? Promise.reject(closed) : new Promise((resolve, reject) => waiting.push({ resolve, reject }))),
    detach: () => { stream.off('data', onData); stream.off('close', onClose); }
  };
}

const header = s => String(s).replace(/[\r\n]+/g, ' ');
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

const b64Lines = s => (b64(s).match(/.{1,76}/g) || []).join('\r\n');

// Plain text, or multipart/alternative (text then HTML) when html is given. HTML is always base64 (no line limit issue).
function buildMail({ from, to, subject, text, html }) {
  const ascii = /^[\x00-\x7F]*$/.test(text);
  const textHead = ['Content-Type: text/plain; charset=utf-8', `Content-Transfer-Encoding: ${ascii ? '7bit' : 'base64'}`];
  const textBody = ascii ? text.replace(/\r?\n/g, '\r\n') : b64Lines(text);
  const subj = /^[\x20-\x7E]*$/.test(subject) ? header(subject) : `=?UTF-8?B?${b64(header(subject))}?=`;
  const head = [`From: ${from}`, `To: ${to.join(', ')}`, `Subject: ${subj}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@labctl.invalid>`, 'MIME-Version: 1.0'];
  let body = textBody;
  if (html) {
    const boundary = `labctl-${randomUUID()}`;
    head.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [`--${boundary}`, ...textHead, '', textBody, `--${boundary}`, 'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64', '', b64Lines(html), `--${boundary}--`].join('\r\n');
  } else head.push(...textHead);
  const stuffed = body.split('\r\n').map(l => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');
  return `${head.join('\r\n')}\r\n\r\n${stuffed}\r\n.\r\n`;
}

// EHLO, optional STARTTLS, AUTH PLAIN or LOGIN when a user is set, MAIL FROM, RCPT TO, DATA, QUIT.
function smtpSend(cfg, { subject, text, html }, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let sock = null;
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock?.destroy(); } catch { /* already closed */ }
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => finish(new Error(`SMTP timeout after ${timeoutMs / 1000} s`)), timeoutMs);
    const tlsOpts = { host: cfg.host, port: cfg.port, servername: net.isIP(cfg.host) ? undefined : cfg.host, rejectUnauthorized: cfg.reject_unauthorized !== false };

    (async () => {
      sock = cfg.secure === 'tls' ? tls.connect(tlsOpts) : net.connect({ host: cfg.host, port: cfg.port });
      sock.on('error', finish);
      let reader = makeReader(sock);
      const expect = (r, ok) => { if (!ok.includes(r.code)) throw new Error(`SMTP ${r.code} ${r.lines.map(l => l.slice(4)).join(' ')}`.trim()); return r; };
      const cmd = async (line, ok) => { sock.write(`${line}\r\n`); return expect(await reader.read(), ok); };
      const ehlo = async () => {
        sock.write(`EHLO ${os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'labctl'}\r\n`);
        let r = await reader.read();
        if (r.code !== 250) r = await cmd('HELO labctl', [250]);
        return r.lines.slice(1).map(l => l.slice(4).toUpperCase());
      };

      expect(await reader.read(), [220]);
      let caps = await ehlo();
      if (cfg.secure === 'starttls') {
        if (!caps.includes('STARTTLS')) throw new Error('SMTP server does not offer STARTTLS');
        await cmd('STARTTLS', [220]);
        reader.detach();
        sock = tls.connect({ socket: sock, servername: tlsOpts.servername, rejectUnauthorized: tlsOpts.rejectUnauthorized });
        sock.on('error', finish);
        reader = makeReader(sock);
        caps = await ehlo();
      }
      if (cfg.user) {
        const mech = (caps.find(c => c.startsWith('AUTH ')) || '').split(/\s+/).slice(1);
        if (mech.includes('PLAIN')) await cmd(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.password || ''}`)}`, [235]);
        else if (mech.includes('LOGIN')) {
          await cmd('AUTH LOGIN', [334]);
          await cmd(b64(cfg.user), [334]);
          await cmd(b64(cfg.password || ''), [235]);
        } else throw new Error('SMTP server offers no AUTH PLAIN or LOGIN');
      }
      await cmd(`MAIL FROM:<${cfg.from}>`, [250]);
      for (const to of cfg.to) await cmd(`RCPT TO:<${to}>`, [250, 251]);
      await cmd('DATA', [354]);
      sock.write(buildMail({ from: cfg.from, to: cfg.to, subject, text, html }));
      expect(await reader.read(), [250]);
      sock.write('QUIT\r\n');
    })().then(() => finish(), finish);
  });
}

// ---- webhook and Telegram ---------------------------------------------------------------------------------------

async function httpFail(res) {
  const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
  throw new Error(`HTTP ${res.status}${body ? `: ${body}` : ''}`);
}

async function webhookSend(cfg, payload, { timeoutMs = 10000 } = {}) {
  const vars = { ...payload, title: render(payload).title };
  const body = JSON.stringify(cfg.template ? fillTemplate(JSON.parse(cfg.template), vars) : payload);
  const headers = { 'content-type': 'application/json', 'user-agent': 'LabCTL', ...(cfg.headers || {}) };
  if (cfg.hmac_secret) headers['x-labctl-signature'] = `sha256=${createHmac('sha256', cfg.hmac_secret).update(body).digest('hex')}`;
  const res = await fetch(cfg.url, { method: cfg.method || 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) await httpFail(res);
}

async function telegramSend(cfg, { title, text }, { base, timeoutMs = 10000 }) {
  const url = `${String(base || 'https://api.telegram.org').replace(/\/+$/, '')}/bot${cfg.bot_token}/sendMessage`;
  const body = { chat_id: cfg.chat_id, text: `${title}\n${text}`.slice(0, 4000), disable_web_page_preview: true };
  if (cfg.message_thread_id !== undefined) body.message_thread_id = cfg.message_thread_id;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.ok === false)) throw new Error(`Telegram ${res.status}${data?.description ? `: ${data.description}` : ''}`);
}

// ---- notifier -----------------------------------------------------------------------------------------------------

function createNotifier(ctx) {
  const { db } = ctx;
  ensureColumn(db, 'channels', 'last_error', 'TEXT');
  ensureColumn(db, 'channels', 'last_error_at', 'TEXT');
  ensureColumn(db, 'channels', 'last_ok_at', 'TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS channel_errors (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, ts TEXT NOT NULL, error TEXT NOT NULL, context TEXT);
    CREATE INDEX IF NOT EXISTS channel_errors_ch ON channel_errors(channel_id, id)`);

  const self = {
    delays: [1000, 4000],          // waits before attempt 2 and 3
    timeoutMs: 15000,
    apiBase: () => ctx.alerting?.config().telegram_api_base || 'https://api.telegram.org',
    config(row) { return ctx.crypto.openJson(row.config_sealed); },

    async attempt(kind, config, payload) {
      const msg = render(payload);
      if (kind === 'smtp') await smtpSend(config, { subject: msg.title, text: msg.text, html: payload.report ? payload.html : undefined }, { timeoutMs: self.timeoutMs });
      else if (kind === 'webhook') await webhookSend(config, payload, { timeoutMs: self.timeoutMs });
      else await telegramSend(config, msg, { base: self.apiBase(), timeoutMs: self.timeoutMs });
    },

    // One try, exact error text (secrets removed). Used by the test button.
    async test(row) {
      const payload = { test: true, rule: 'LabCTL test', severity: 'info', message: 'This is a test message from LabCTL.',
        since: new Date().toISOString(), link: self.link(''), recovery: false, host: null, value: null };
      const config = self.config(row);
      try { await self.attempt(row.kind, config, payload); } catch (err) {
        const error = scrub(err.message || String(err), row.kind, config);
        self.fail(row.id, error, 'test');
        return { ok: false, error };
      }
      db.prepare('UPDATE channels SET last_ok_at = ?, last_error = NULL WHERE id = ?').run(new Date().toISOString(), row.id);
      return { ok: true };
    },

    // Up to three tries with backoff. A final failure goes to channel_errors.
    async send(row, payload) {
      const config = self.config(row);
      let last = '';
      for (let i = 0; i < 3; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, self.delays[i - 1] ?? 0));
        try {
          await self.attempt(row.kind, config, payload);
          db.prepare('UPDATE channels SET last_ok_at = ?, last_error = NULL WHERE id = ?').run(new Date().toISOString(), row.id);
          return { ok: true };
        } catch (err) { last = scrub(err.message || String(err), row.kind, config); }
      }
      self.fail(row.id, last, `${payload.report ? 'report' : payload.recovery ? 'recovery' : 'alert'}: ${payload.rule}`);
      return { ok: false, error: last };
    },

    fail(channelId, error, context) {
      const ts = new Date().toISOString();
      db.prepare('INSERT INTO channel_errors (channel_id, ts, error, context) VALUES (?, ?, ?, ?)').run(channelId, ts, error, String(context || '').slice(0, 200));
      db.prepare('DELETE FROM channel_errors WHERE channel_id = ? AND id NOT IN (SELECT id FROM channel_errors WHERE channel_id = ? ORDER BY id DESC LIMIT 50)').run(channelId, channelId);
      db.prepare('UPDATE channels SET last_error = ?, last_error_at = ? WHERE id = ?').run(error, ts, channelId);
    },

    link: hash => `${String(ctx.alerting?.config().base_url || '').replace(/\/+$/, '')}/#/${hash || 'alerts'}`.replace(/^\/#/, '#'),

    // Sends to the listed channels (or the defaults) that are enabled and whose min_severity is met.
    async dispatch(payload, channelIds) {
      const ids = channelIds?.length ? channelIds : ctx.alerting.config().default_channels || [];
      const results = [];
      for (const id of ids) {
        const row = db.prepare('SELECT * FROM channels WHERE id = ? AND enabled = 1').get(id);
        if (!row) continue;
        let min = 'info';
        try { min = self.config(row).min_severity || 'info'; } catch { /* unreadable config is reported by send */ }
        if ((SEVERITY_RANK[payload.severity] ?? 0) < SEVERITY_RANK[min]) continue;
        results.push({ channel_id: id, ...(await self.send(row, payload)) });
      }
      return results;
    }
  };
  return self;
}

module.exports = { createNotifier, validate, merge, mask, scrub, render, fillTemplate, smtpSend, buildMail, MASK, KINDS, SEVERITY_RANK };
