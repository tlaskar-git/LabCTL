// Windows targets: OpenSSH first (port 22), else WinRM (5986 HTTPS, then 5985 HTTP). Files go over as base64 chunks
// inside PowerShell commands. The setup runs as a hidden background process that writes run.log and run.exit, and the
// server polls both, so the log streams live on either transport. The admin token of an OpenSSH or WinRM session is
// elevated, so the preflight requires membership of Administrators. Not testable without a real Windows host in CI.
const conn = require('./conn');
const winrm = require('./winrm');
const { parseKv } = require('./unix');

const psq = v => `'${String(v).replace(/'/g, "''")}'`;
const MIN_FREE_KB = 204800;
const PORTS = [22, 5986, 5985];
const kindOf = port => (port === 5985 || port === 5986 ? 'winrm' : 'ssh');
// One line only: PowerShell reading a script from stdin (-Command -) drops multi-line blocks without any error.
const oneLine = body => body.split(/\r?\n/).map(l => l.trim()).filter(Boolean).join(";");
const wrap = body => `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';try{${oneLine(body)}}catch{'ERR='+$_.Exception.Message}`;
const dirVar = id => `$d=Join-Path $env:TEMP ${psq('labctl-deploy-' + id)}`;

const probeScript = server => `
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$o=Get-CimInstance Win32_OperatingSystem
"os_name=$($o.Caption) $($o.Version)"
"arch=$env:PROCESSOR_ARCHITECTURE"
"admin=" + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$py=''
foreach($n in 'python','python3'){ $c=Get-Command $n -ErrorAction SilentlyContinue | Where-Object { $_.Source -notmatch 'WindowsApps' } | Select-Object -First 1; if($c){ $py=(& $c.Source --version 2>&1 | Out-String).Trim(); break } }
"python=$py"
"free_kb=" + [int64]((Get-PSDrive -Name $env:ProgramData.Substring(0,1)).Free/1KB)
try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 -Uri ${psq(server + '/api/health')} | Out-Null; 'outbound=ok' } catch { 'outbound=fail' }
`;

function winChecks(kv, t) {
  const checks = [];
  const isWin = /Windows/i.test(kv.os_name || '');
  checks.push({ name: 'Operating system', ok: isWin, detail: isWin ? `${kv.os_name} (${kv.arch})` : `You chose Windows but the host reports ${kv.os_name || 'an unknown system'}.` });
  checks.push({ name: 'Administrator rights', ok: kv.admin === 'True',
    detail: kv.admin === 'True' ? `${t.user} is an elevated administrator` : `${t.user} is not an elevated administrator. Use a member of the Administrators group.` });
  const m = /Python 3\.(\d+)/.exec(kv.python || '');
  const okPy = m && Number(m[1]) >= 8;
  checks.push({ name: 'Python 3', ok: true, warn: !okPy, detail: okPy ? kv.python : 'Not found. The installer will fetch Python 3.12 (winget or python.org).' });
  const free = Number(kv.free_kb);
  checks.push({ name: 'Disk space', ok: free >= MIN_FREE_KB, detail: kv.free_kb ? `${Math.floor(free / 1024)} MB free (200 MB needed)` : 'Could not read the free space.' });
  checks.push({ name: 'Server reachable from the target', ok: kv.outbound === 'ok',
    detail: kv.outbound === 'ok' ? 'The target reached the LabCTL server' : 'The target cannot reach the LabCTL server. The agent could not connect.' });
  return checks;
}

// Which port to use. An explicit port is used as is. Returns { port, kind, tried }.
async function pickTransport(t) {
  const ports = t.port ? [t.port] : PORTS;
  const tried = [];
  for (const port of ports) {
    const open = await conn.tcpOpen(t.address, port);
    const kind = kindOf(port);
    tried.push(`${port} ${open ? 'open' : 'closed'} (${kind === 'ssh' ? 'OpenSSH' : port === 5986 ? 'WinRM over HTTPS' : 'WinRM over HTTP'})`);
    if (open) return { port, kind, tried };
  }
  return { port: null, kind: null, tried };
}

async function openSession(t, kind) {
  if (kind === 'winrm') return { ...(await winrm.open(t)), chunk: 1800, transport: 'winrm' };
  const { client, hostKey } = await conn.connect(t);
  const run = async script => {
    let out = '';
    let err = '';
    await conn.exec(client, 'powershell -NoProfile -NonInteractive -Command -', { stdin: script, onOut: (d, s) => { if (s === 'stdout') out += d; else err += d; } });
    return out.trim() || err.trim();
  };
  return { run, close: () => client.end(), hostKey, chunk: 400000, transport: 'ssh' };
}

// Runs a script body with the error wrapper. A thrown PowerShell error comes back as an ERR= line.
async function run(session, body) {
  const out = await session.run(wrap(body));
  const bad = /^ERR=(.*)$/m.exec(out);
  if (bad) throw new Error(bad[1].trim());
  return out;
}

async function inspect(t, h, open = openSession) {
  const checks = [];
  const pick = await pickTransport(t);
  checks.push({ name: 'Port reachability', ok: !!pick.kind, detail: pick.kind ? pick.tried.join(', ') : `${pick.tried.join(', ')}. Enable OpenSSH (22) or WinRM (5985, 5986).` });
  if (!pick.kind) return { checks };
  const tt = { ...t, port: pick.port };
  let session;
  try { session = await open(tt, pick.kind); } catch (e) { checks.push({ name: pick.kind === 'ssh' ? 'SSH sign-in' : 'WinRM sign-in', ok: false, detail: e.message }); return { checks }; }
  try {
    checks.push({ name: pick.kind === 'ssh' ? 'SSH sign-in' : 'WinRM sign-in', ok: true, detail: `Signed in as ${t.user}${session.hostKey ? `. Host key ${session.hostKey}` : ''}` });
    const kv = parseKv(await run(session, probeScript(h.server)));
    checks.push(...winChecks(kv, t));
    return { checks, hostKey: session.hostKey, transport: pick.kind, port: pick.port };
  } catch (e) {
    checks.push({ name: 'Operating system', ok: false, detail: `The probe failed: ${e.message}` });
    return { checks };
  } finally { await session.close(); }
}

async function push(session, id, name, content) {
  const b64 = Buffer.from(content).toString('base64');
  for (let i = 0, n = 0; n === 0 || i < b64.length; i += session.chunk, n++) {
    await run(session, `${dirVar(id)};${n === 0 ? 'New-Item -ItemType Directory -Force -Path $d | Out-Null;' : ''}` +
      `$f=[IO.File]::Open((Join-Path $d ${psq(name)}),${psq(n === 0 ? 'Create' : 'Append')});` +
      `$b=[Convert]::FromBase64String(${psq(b64.slice(i, i + session.chunk))});$f.Write($b,0,$b.Length);$f.Close()`);
  }
}

const WRAP_PS1 = `$log = Join-Path $PSScriptRoot 'run.log'
try { & (Join-Path $PSScriptRoot 'run.ps1') *>> $log; $rc = $LASTEXITCODE } catch { $_.Exception.Message | Out-File -FilePath $log -Append; $rc = 1 }
if ($null -eq $rc) { $rc = 0 }
Set-Content -Path (Join-Path $PSScriptRoot 'run.exit') -Value $rc
`;

async function install(t, h, { pollMs = 2000, maxMs = 1200000, open = openSession } = {}) {
  const pick = t.port ? { port: t.port, kind: kindOf(t.port) } : await pickTransport(t);
  if (!pick.kind) throw new Error(`No OpenSSH or WinRM port is open on ${t.address}.`);
  const session = await open({ ...t, port: pick.port }, pick.kind);
  const un = h.mode === 'uninstall';
  try {
    h.phase('upload');
    h.log(`Uploading the setup files to the temp folder on ${t.address} (${pick.kind === 'ssh' ? 'OpenSSH' : 'WinRM'})`);
    await push(session, h.id, 'setup-windows.ps1', h.file('setup-windows.ps1'));
    if (!un) await push(session, h.id, 'labctl-agent.py', h.file('labctl-agent.py'));
    await push(session, h.id, 'run.ps1', `$ErrorActionPreference = 'Stop'\r\n& (Join-Path $PSScriptRoot 'setup-windows.ps1') ${un ? '-Uninstall' : `-ServerUrl ${psq(h.server)} -Token ${psq(h.token)}`}\r\nexit $LASTEXITCODE\r\n`);
    await push(session, h.id, 'wrap.ps1', WRAP_PS1);
    h.phase('install');
    h.log('Starting the setup script (elevated, hidden)');
    await run(session, `${dirVar(h.id)};Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $d 'wrap.ps1')`);
    let seen = 0;
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      await new Promise(r => setTimeout(r, pollMs));
      const out = await run(session, `${dirVar(h.id)};$done=Test-Path (Join-Path $d 'run.exit');$l=@();if(Test-Path (Join-Path $d 'run.log')){$l=@(Get-Content (Join-Path $d 'run.log') -ErrorAction SilentlyContinue)};` +
        `'LINES='+$l.Count;$l | Select-Object -Skip ${seen};if($done){'EXITCODE='+((Get-Content (Join-Path $d 'run.exit') | Select-Object -First 1))}`);
      const lines = out.split(/\r?\n/);
      const head = /^LINES=(\d+)$/.exec(lines[0] || '');
      const exit = lines.find(l => /^EXITCODE=/.test(l));
      const body = lines.slice(head ? 1 : 0).filter(l => !/^EXITCODE=/.test(l));
      if (head) seen = Math.max(seen, Number(head[1])); // a failed read reports fewer lines: keep the count
      h.out(body.join('\n') + (body.length ? '\n' : ''));
      if (exit) {
        const code = Number(exit.split('=')[1]);
        if (code !== 0) throw new Error(h.lastLine() || `The setup script exited with code ${code}`);
        return { hostKey: session.hostKey, port: pick.port, transport: pick.kind };
      }
    }
    throw new Error('The setup script did not finish within 20 minutes.');
  } finally {
    await run(session, `${dirVar(h.id)};Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue`).catch(() => {});
    await session.close();
  }
}

module.exports = { inspect, install, winChecks, probeScript, pickTransport, psq, wrap };
