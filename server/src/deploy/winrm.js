// WinRM client for Windows targets. Default: winrm_helper.py, a small pywinrm process (NTLM inside the Negotiate scheme,
// message encryption over HTTP 5985), because domain controllers offer only Negotiate and refuse unencrypted traffic.
// Fallback when no Python with pywinrm is found: the winrm-client package (sends the NTLM scheme, no message encryption).
// One remote shell is reused for every command of a deploy. Scripts travel as -EncodedCommand, so quoting never matters.
// Certificates are not verified on 5986 (targets use self-signed ones). The password goes to the helper on stdin only.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const HELPER = path.join(__dirname, 'winrm_helper.py');
const VENV_PY = '/opt/winrm-venv/bin/python';
const HOST_RE = /^(?!-)[A-Za-z0-9._:-]{1,253}$/;
const CTRL = /[\x00-\x1f\x7f]/;

const explain = (err, t) => {
  const m = String(err.message || err);
  if (/401|Unauthorized|authenticat|logon/i.test(m)) return `WinRM rejected the sign-in for ${t.user} on ${t.address}. Check the user name and password. Over HTTP (5985) the target must also allow unencrypted WinRM.`;
  if (err.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(m)) return `Connection refused on ${t.address}:${t.port}. Is WinRM enabled (winrm quickconfig)?`;
  if (err.code === 'ETIMEDOUT' || /timed out|ETIMEDOUT/i.test(m)) return `Timed out connecting to ${t.address}:${t.port}.`;
  if (/unencrypted/i.test(m)) return 'WinRM refused unencrypted traffic. Use port 5986 (HTTPS) or allow unencrypted WinRM on the target.';
  return m;
};

// A failed PowerShell command returns its error stream as CLIXML. Show the text parts only.
const cleanErr = s => (/#< CLIXML/.test(s)
  ? [...s.matchAll(/<S S="Error">(.*?)<\/S>/g)].map(m => m[1].replace(/_x000D__x000A_/g, ' ').replace(/_x[0-9A-F]{4}_/g, '')).join(' ').trim()
  : s);

function validate(t) {
  if (!HOST_RE.test(String(t.address || ''))) throw new Error('WinRM: the address must be a host name or IP address');
  if (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535) throw new Error('WinRM: the port must be 1 to 65535');
  if (typeof t.user !== 'string' || !t.user || t.user.length > 100 || CTRL.test(t.user)) throw new Error('WinRM: the user name must be 1 to 100 characters, no control characters');
  if (typeof t.password !== 'string' || !t.password || t.password.length > 1024) throw new Error('WinRM: a password is required');
}

const pythons = () => [process.env.LABCTL_WINRM_PYTHON, fs.existsSync(VENV_PY) && VENV_PY, 'python3'].filter(Boolean);
const notRunnable = message => Object.assign(new Error(message), { notRunnable: true });

// Starts the helper and opens the remote shell. Rejects with notRunnable when this Python cannot run the helper.
function openHelper(t, python, { env, requestMs = 120000, lifeMs = 1800000 } = {}) {
  const hide = s => (t.password.length >= 4 ? String(s).split(t.password).join('[redacted]') : String(s));
  return new Promise((resolve, reject) => {
    const child = spawn(python, [HELPER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: env || process.env });
    let stderr = '';
    let settled = false;
    let gone = false;
    const waiting = new Map();
    let nextId = 0;
    const fail = err => { for (const w of waiting.values()) w.reject(err); waiting.clear(); };
    const kill = () => { if (!gone) child.kill('SIGKILL'); };
    const life = setTimeout(kill, lifeMs); // a deploy that abandons its session must not leave the helper running
    life.unref();
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
    child.stdin.on('error', () => {}); // a dead helper is reported by 'exit'
    child.on('error', e => { if (!settled) { settled = true; reject(notRunnable(`${python}: ${e.code || e.message}`)); } });
    child.on('exit', code => {
      gone = true;
      clearTimeout(life);
      if (!settled) { settled = true; reject(notRunnable(`${python} exited with code ${code}${stderr ? `: ${hide(stderr.trim().split(/\r?\n/).pop())}` : ''}`)); }
      fail(new Error(`The WinRM helper stopped (code ${code})${stderr ? `: ${hide(stderr.trim().split(/\r?\n/).pop())}` : ''}`));
    });
    readline.createInterface({ input: child.stdout }).on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (!settled) {
        settled = true;
        if (msg.ready) return resolve(session);
        if (msg.code === 'no_pywinrm') { kill(); return reject(notRunnable(`${python}: ${msg.error}`)); }
        kill();
        return reject(new Error(hide(msg.error || 'WinRM sign-in failed')));
      }
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      if (!msg.ok) return w.reject(new Error(hide(msg.error)));
      w.resolve(msg.stdout.trim() ? msg.stdout : cleanErr(msg.stderr));
    });
    const session = {
      run(script) {
        if (gone) return Promise.reject(new Error('The WinRM helper is not running'));
        const id = ++nextId;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => { waiting.delete(id); kill(); rej(new Error(`Timed out after ${Math.round(requestMs / 1000)} s waiting for WinRM on ${t.address}:${t.port}.`)); }, requestMs);
          waiting.set(id, { resolve: v => { clearTimeout(timer); res(v); }, reject: e => { clearTimeout(timer); rej(e); } });
          child.stdin.write(JSON.stringify({ id, script }) + '\n');
        });
      },
      close: () => new Promise(res => {
        if (gone) return res();
        const timer = setTimeout(kill, 15000);
        child.once('exit', () => { clearTimeout(timer); res(); });
        child.stdin.end();
      }),
      engine: 'pywinrm'
    };
    child.stdin.write(JSON.stringify({ host: t.address, port: t.port, https: t.port === 5986, username: t.user, password: t.password,
      timeout_s: Math.max(5, Math.floor(requestMs / 1000) - 20) }) + '\n');
  });
}

// The winrm-client fallback. lib is injectable for tests.
async function openNode(t, lib) {
  const params = { host: t.address, port: t.port, path: '/wsman', authMethod: 'ntlm', useHttps: t.port === 5986, rejectUnauthorized: false,
    username: /[\\@]/.test(t.user) ? t.user : `.\\${t.user}`, password: t.password };
  let shellId;
  try { shellId = await lib.Shell.doCreateShell(params); } catch (e) { throw new Error(explain(e, t)); }
  const p = { ...params, shellId };
  return {
    async run(script) {
      try {
        const command = 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
        const commandId = await lib.Command.doExecuteCommand({ ...p, command });
        return cleanErr(await lib.Command.doReceiveOutput({ ...p, command, commandId }));
      } catch (e) { throw new Error(explain(e, t)); }
    },
    close: () => Promise.resolve(lib.Shell.doDeleteShell(p)).catch(() => {}),
    engine: 'winrm-client'
  };
}

// Resolves { run(script) -> stdout text, close(), engine }. opts: python (one interpreter to try), env, requestMs, lifeMs,
// lib (forces the winrm-client fallback with this library, for tests).
async function open(t, opts = {}) {
  validate(t);
  if (opts.lib) return openNode(t, opts.lib);
  const why = [];
  for (const py of opts.python ? [opts.python] : pythons()) {
    try { return await openHelper(t, py, opts); } catch (e) { if (!e.notRunnable) throw e; why.push(e.message); }
  }
  try { return await openNode(t, require('winrm-client')); } catch (e) {
    throw new Error(`${e.message} Also, pywinrm is not installed (${why.join('; ')}), so LabCTL used its built-in client, which cannot sign in to hosts that offer only Negotiate, such as domain controllers.`);
  }
}

module.exports = { open, explain, cleanErr, validate, HELPER };
