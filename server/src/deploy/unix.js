// Linux and Mac targets over SSH (ssh2). The probe, the checks and the install command are shared with the relay path (relay.js).
// The token and the server URL go to the target in a 0600 env file inside a 0700 temp folder, never on a command line.
// The sudo password goes to `sudo -S` on stdin only.
const conn = require('./conn');

const shq = v => `'${String(v).replace(/'/g, `'\\''`)}'`;
const MIN_FREE_KB = 204800; // 200 MB
const WANT_KERNEL = { linux: 'Linux', darwin: 'Darwin' };

// Runs on the target through `sh -s`. Prints key=value lines. Read-only apart from `sudo -n true`.
const probeScript = server => `
echo "kernel=$(uname -s 2>/dev/null)"
echo "arch=$(uname -m 2>/dev/null)"
echo "uid=$(id -u)"
if command -v sw_vers >/dev/null 2>&1; then echo "os_name=macOS $(sw_vers -productVersion)"
elif [ -r /etc/os-release ]; then . /etc/os-release; echo "os_name=\${PRETTY_NAME:-\${NAME:-Linux}}"; fi
for p in python3 python3.13 python3.12 python3.11 python3.10 python3.9 python3.8; do
  if command -v "$p" >/dev/null 2>&1; then echo "python=$p $("$p" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)"; break; fi
done
if [ "$(id -u)" = 0 ]; then echo sudo=root
elif command -v sudo >/dev/null 2>&1; then if sudo -n true >/dev/null 2>&1; then echo sudo=nopasswd; else echo sudo=password; fi
else echo sudo=none; fi
d=/opt; [ "$(uname -s)" = Darwin ] && d=/usr/local
while [ ! -d "$d" ] && [ "$d" != / ]; do d=$(dirname "$d"); done
echo "free_kb=$(df -Pk "$d" 2>/dev/null | awk 'NR==2{print $4}')"
if command -v curl >/dev/null 2>&1; then
  if curl -fsS -m 8 -o /dev/null ${shq(server + '/api/health')} >/dev/null 2>&1; then echo outbound=ok; else echo outbound=fail; fi
elif command -v wget >/dev/null 2>&1; then
  if wget -q -T 8 -O /dev/null ${shq(server + '/api/health')} >/dev/null 2>&1; then echo outbound=ok; else echo outbound=fail; fi
else echo outbound=nocurl; fi
`;

const parseKv = text => Object.fromEntries(String(text).split(/\r?\n/).map(l => l.trim()).filter(l => /^\w+=/.test(l))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

const sudoPassword = t => t.sudo_password || t.password || '';

// Pass or fail rows from the probe output. kv.sudo_verify (ok|fail) is set by the caller after a stdin password test.
function unixChecks(kv, t) {
  const want = WANT_KERNEL[t.os];
  const checks = [];
  checks.push({ name: 'Operating system', ok: kv.kernel === want,
    detail: kv.kernel === want ? `${kv.os_name || kv.kernel} (${kv.arch})`
      : `You chose ${t.os === 'darwin' ? 'Mac' : 'Linux'} but the host reports ${kv.kernel || 'an unknown system'}.` });
  const priv = (ok, detail) => checks.push({ name: 'Administrator rights', ok, detail });
  if (kv.sudo === 'root') priv(true, `Signed in as ${t.user} (uid 0)`);
  else if (kv.sudo === 'nopasswd') priv(true, 'sudo works without a password');
  else if (kv.sudo === 'password') {
    if (!sudoPassword(t)) priv(false, 'sudo needs a password. Enter the sudo password.');
    else priv(kv.sudo_verify === 'ok', kv.sudo_verify === 'ok' ? 'sudo accepted the password' : 'sudo rejected the password');
  } else priv(false, 'sudo is not installed and the user is not root.');
  const m = /^(\S+) (\d+)\.(\d+)$/.exec(kv.python || '');
  const okPy = m && (Number(m[2]) > 3 || (Number(m[2]) === 3 && Number(m[3]) >= 8));
  checks.push({ name: 'Python 3', ok: true, warn: !okPy,
    detail: okPy ? `${m[1]} ${m[2]}.${m[3]}` : (m ? `Python ${m[2]}.${m[3]} is too old (3.8 needed). The installer will try to install a newer one.`
      : 'Not found. The installer will try to install python3 with the package manager.') });
  const free = Number(kv.free_kb);
  checks.push({ name: 'Disk space', ok: free >= MIN_FREE_KB,
    detail: Number.isFinite(free) && kv.free_kb ? `${Math.floor(free / 1024)} MB free (200 MB needed)` : 'Could not read the free space.' });
  checks.push({ name: 'Server reachable from the target', ok: kv.outbound === 'ok' || kv.outbound === 'nocurl', warn: kv.outbound === 'nocurl',
    detail: kv.outbound === 'ok' ? 'The target reached the LabCTL server' : kv.outbound === 'nocurl' ? 'curl and wget are missing, not checked'
      : 'The target cannot reach the LabCTL server. The agent could not connect.' });
  return checks;
}

const envFile = (server, token) => `SERVER_URL=${shq(server)}\nTOKEN=${shq(token)}\n`;

const MAC_UNINSTALL = `#!/bin/bash
for l in com.labctl.agent com.labctl.agent.watchdog; do launchctl bootout "system/$l" >/dev/null 2>&1 || true; done
rm -f /Library/LaunchDaemons/com.labctl.agent.plist /Library/LaunchDaemons/com.labctl.agent.watchdog.plist /etc/newsyslog.d/labctl.conf
rm -rf /usr/local/labctl/agent
echo "LabCTL agent removed"
`;

// The remote command. No secrets in it: the token and the URL come from the env file.
function installCommand(t, dir, { sudo, noService, uninstall }) {
  const script = t.os === 'darwin' ? 'setup-mac.sh' : 'setup-linux.sh';
  const inner = uninstall
    ? `exec bash ${dir}/${t.os === 'darwin' ? 'uninstall.sh' : `${script} --uninstall`}`
    : `. ${dir}/deploy.env && export SERVER_URL TOKEN && exec bash ${dir}/${script}${noService ? ' --no-service' : ''}`;
  return `${sudo ? "sudo -S -p '' " : ''}bash -c ${shq(inner)}`;
}

// Files for the target folder. h.file(name) returns a Buffer from the agent folder.
function uploadFiles(t, h) {
  const script = t.os === 'darwin' ? 'setup-mac.sh' : 'setup-linux.sh';
  if (h.mode === 'uninstall') {
    return t.os === 'darwin' ? [{ name: 'uninstall.sh', content: MAC_UNINSTALL, mode: 0o700 }]
      : [{ name: script, content: h.file(script), mode: 0o700 }];
  }
  return [{ name: script, content: h.file(script), mode: 0o700 }, { name: 'labctl-agent.py', content: h.file('labctl-agent.py'), mode: 0o600 },
    { name: 'deploy.env', content: envFile(h.server, h.token), mode: 0o600 }];
}

async function runCapture(client, command, opts = {}) {
  let out = '';
  const code = await conn.exec(client, command, { ...opts, onOut: (d, s) => { if (s === 'stdout') out += d; } });
  return { code, out };
}

async function inspect(t, h) {
  const checks = [];
  const open = await conn.tcpOpen(t.address, t.port);
  checks.push({ name: 'Port reachability', ok: open, detail: open ? `${t.address}:${t.port} accepts connections` : `${t.address}:${t.port} is not reachable (closed, filtered or the host is down).` });
  if (!open) return { checks };
  let session;
  try { session = await conn.connect(t); } catch (e) { checks.push({ name: 'SSH sign-in', ok: false, detail: e.message }); return { checks }; }
  try {
    checks.push({ name: 'SSH sign-in', ok: true, detail: `Signed in as ${t.user}. Host key ${session.hostKey}` });
    const kv = parseKv((await runCapture(session.client, 'sh -s', { stdin: probeScript(h.server) })).out);
    if (kv.sudo === 'password' && sudoPassword(t)) {
      const v = await runCapture(session.client, "sudo -S -p '' -v", { stdin: sudoPassword(t) + '\n' });
      kv.sudo_verify = v.code === 0 ? 'ok' : 'fail';
    }
    checks.push(...unixChecks(kv, t));
    return { checks, hostKey: session.hostKey, transport: 'ssh', uid: Number(kv.uid) };
  } finally { session.client.end(); }
}

async function install(t, h) {
  const dir = `/tmp/labctl-deploy-${h.id}`;
  const { client, hostKey } = await conn.connect(t);
  try {
    const uid = Number((await runCapture(client, 'id -u')).out.trim());
    h.phase('upload');
    h.log(`Uploading the setup files to ${dir} on ${t.address}`);
    await conn.put(client, dir, uploadFiles(t, h));
    h.phase('install');
    const sudo = uid !== 0;
    h.log(sudo ? 'Running the setup script with sudo' : 'Running the setup script as root');
    const code = await conn.exec(client, installCommand(t, dir, { sudo, noService: t.no_service, uninstall: h.mode === 'uninstall' }),
      { stdin: sudo ? sudoPassword(t) + '\n' : '', onOut: h.out });
    if (code !== 0) throw new Error(h.lastLine() || `The setup script exited with code ${code}`);
  } finally {
    await conn.exec(client, `rm -rf ${shq(dir)}`).catch(() => {});
    client.end();
  }
  return { hostKey };
}

module.exports = { probeScript, parseKv, unixChecks, installCommand, uploadFiles, envFile, sudoPassword, shq, inspect, install };
