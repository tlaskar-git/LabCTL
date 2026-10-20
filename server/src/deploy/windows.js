// Windows targets: OpenSSH first (port 22), else WinRM (5986 HTTPS, then 5985 HTTP). Files go over as base64 chunks
// inside PowerShell commands into $env:TEMP\labctl-deploy-<id> of the signed-in account. The setup starts as a hidden
// Start-Process child of the remote session (proven in the field: the session stays open while the server polls).
// wrap.ps1 writes its first run.log line before anything else, so a missing run.log means "did not start". Only then the
// server stops that process and falls back to a one-shot scheduled task as SYSTEM, else a process created through WMI
// (Win32_Process.Create). The server polls run.log and run.exit, so the log streams live on either transport.
const conn = require('./conn');
const winrm = require('./winrm');
const { parseKv } = require('./unix');

const psq = v => `'${String(v).replace(/'/g, "''")}'`;
const MIN_FREE_KB = 204800;
const PORTS = [22, 5986, 5985];
const NO_WAY_IN = 'LabCTL needs one of two ways in to a Windows host: (1) the OpenSSH Server optional feature on port 22 '
  + '(Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0, then Start-Service sshd), or (2) WinRM on port 5985 (HTTP) or 5986 (HTTPS) '
  + '(run winrm quickconfig as an administrator). Also check that the Windows firewall allows the port from the LabCTL server.';
const kindOf = port => (port === 5985 || port === 5986 ? 'winrm' : 'ssh');
// One line only: PowerShell reading a script from stdin (-Command -) drops multi-line blocks without any error.
const oneLine = body => body.split(/\r?\n/).map(l => l.trim()).filter(Boolean).join(";");
const wrap = body => `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';try{${oneLine(body)}}catch{'ERR='+$_.Exception.Message}`;
// root: the parent of the work folder. Tests point it at a temp folder; a deploy uses $env:TEMP as before.
const dirVar = (id, root) => `$d=Join-Path ${root ? psq(root) : '$env:TEMP'} ${psq('labctl-deploy-' + id)}`;
const taskName = id => `LabCTL-Deploy-${id}`;
const dur = ms => (ms % 60000 ? `${Math.round(ms / 1000)} s` : `${ms / 60000} minute${ms === 60000 ? '' : 's'}`);

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
  checks.push({ name: 'Python 3', ok: true, warn: !okPy, detail: okPy ? kv.python : 'Not found. The installer will fetch the signed Python 3.12 installer from python.org.' });
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
    const why = await conn.tcpCheck(t.address, port);
    const kind = kindOf(port);
    tried.push(`${port} ${why ? 'closed' : 'open'} (${kind === 'ssh' ? 'OpenSSH' : port === 5986 ? 'WinRM over HTTPS' : 'WinRM over HTTP'})${why ? `: ${why}` : ''}`);
    if (!why) return { port, kind, tried };
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
  checks.push({ name: 'Port reachability', ok: !!pick.kind, detail: pick.kind ? pick.tried.join(', ') : `${pick.tried.join(', ')}. ${NO_WAY_IN}` });
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

async function push(session, id, name, content, root) {
  const b64 = Buffer.from(content).toString('base64');
  for (let i = 0, n = 0; n === 0 || i < b64.length; i += session.chunk, n++) {
    await run(session, `${dirVar(id, root)};` +
      `$f=[IO.File]::Open((Join-Path $d ${psq(name)}),${psq(n === 0 ? 'Create' : 'Append')});` +
      `$b=[Convert]::FromBase64String(${psq(b64.slice(i, i + session.chunk))});$f.Write($b,0,$b.Length);$f.Close()`);
  }
}

// Creates the work folder (as the first push did before). Reports who the session is; that part never fails the deploy.
const prepareScript = (id, root) => `${dirVar(id, root)};New-Item -ItemType Directory -Force -Path $d | Out-Null;` +
  'try{$me=[Security.Principal.WindowsIdentity]::GetCurrent();' +
  "'WHO='+$me.Name;'ELEVATED='+([Security.Principal.WindowsPrincipal]$me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);" +
  "'HIGH='+[bool]((whoami.exe /groups) -match 'S-1-16-12288');'PS='+$PSVersionTable.PSVersion}catch{'WHOERR='+$_.Exception.Message}";

// First launch: the hidden child of the remote session, as before. -PassThru only adds the PID for diagnostics.
const startScript = (id, root) => `${dirVar(id, root)};$p=Start-Process -FilePath powershell.exe -WindowStyle Hidden -PassThru ` +
  "-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $d 'wrap.ps1');'PID='+$p.Id";

// Fallback launch: one-shot scheduled task as SYSTEM, else WMI. Both survive the end of the remote session.
const launchScript = (id, root, useTask) => `${dirVar(id, root)};$n=${psq(taskName(id))};` +
  `$ps=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe';` +
  `$arg='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $d 'wrap.ps1')+'"';$te='';$how='';` +
  (useTask ? 'try{$a=New-ScheduledTaskAction -Execute $ps -Argument $arg -WorkingDirectory $d;' +
    "$p=New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest;" +
    '$s=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1);' +
    "Register-ScheduledTask -TaskName $n -Action $a -Principal $p -Settings $s -Force | Out-Null;Start-ScheduledTask -TaskName $n;$how='task'" +
    "}catch{$te=$_.Exception.Message -replace '\\s+',' '};" : "$te='not tried';") +
  'if(-not $how){$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=(\'"\'+$ps+\'" \'+$arg);CurrentDirectory=$d};' +
  "if($r.ReturnValue -ne 0){throw ('The scheduled task failed ('+$te+') and WMI Win32_Process.Create returned '+$r.ReturnValue+'.')};" +
  "$how='wmi';'PID='+$r.ProcessId};'LAUNCH='+$how;if($te){'TASKERR='+$te}";

const pollScript = (id, root, seen) => `${dirVar(id, root)};$done=Test-Path (Join-Path $d 'run.exit');$l=@();` +
  "if(Test-Path (Join-Path $d 'run.log')){$l=@(Get-Content (Join-Path $d 'run.log') -ErrorAction SilentlyContinue)};" +
  `'LINES='+$l.Count;$l | Select-Object -Skip ${seen};if($done){'EXITCODE='+((Get-Content (Join-Path $d 'run.exit') | Select-Object -First 1))}`;

const diagScript = (id, root, pid) => `${dirVar(id, root)};$t=Get-ScheduledTask -TaskName ${psq(taskName(id))} -ErrorAction SilentlyContinue;` +
  "if($t){$i=$t | Get-ScheduledTaskInfo;'TASKSTATE='+$t.State;'TASKRESULT='+$i.LastTaskResult};" +
  `if(${pid}){'ALIVE='+[bool](Get-Process -Id ${pid} -ErrorAction SilentlyContinue)};'FOLDER='+(Test-Path $d)`;

// Stops a wrapper process that is still running, only when its command line points at this work folder.
const killPart = pid => (pid ? `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Where-Object { $_.CommandLine -like ('*'+$d+'*') } | Invoke-CimMethod -MethodName Terminate | Out-Null;` : '');
const killScript = (id, root, pid) => `${dirVar(id, root)};${killPart(pid)}`;

// Removes the task, stops a wrapper that is still running, then the folder.
const cleanupScript = (id, root, pid) => `${dirVar(id, root)};$n=${psq(taskName(id))};` +
  'if(Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue){Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue};' +
  `${killPart(pid)}Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue`;

const WRAP_PS1 = `# Written by the LabCTL server. Runs run.ps1 and records its output and exit code next to it.
$dir = $PSScriptRoot
$log = Join-Path $dir 'run.log'
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = ([Security.Principal.WindowsPrincipal]$me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Add-Content -LiteralPath $log -Encoding UTF8 -Value ('wrapper started as {0}, elevated={1}, psversion={2}' -f $me.Name, $elevated, $PSVersionTable.PSVersion)
$rc = 1
try {
    & (Join-Path $dir 'run.ps1') *>&1 | ForEach-Object { Add-Content -LiteralPath $log -Encoding UTF8 -Value "$_" }
    $rc = $LASTEXITCODE
    if ($null -eq $rc) { $rc = 0 }
} catch {
    Add-Content -LiteralPath $log -Encoding UTF8 -Value ('ERROR: {0}' -f $_.Exception.Message)
    $rc = 1
}
Set-Content -LiteralPath (Join-Path $dir 'run.exit') -Encoding ASCII -Value $rc
exit $rc
`;

// Plain words for a setup that never wrote run.log: what the launcher saw, who the session is, and the likely cause.
// attempts: [{ how: 'process'|'task'|'wmi'|undefined, pid, launch, diag }], in launch order.
function notStarted(startMs, id, who, attempts) {
  const alive = d => (d.ALIVE === 'True' ? 'still running' : 'ended');
  let cause = 'The remote shell did not run the launch command.';
  const seen = attempts.map(({ how, pid, launch = {}, diag = {} }) => {
    if (how === 'process') {
      cause = 'powershell.exe started from the remote session wrote nothing. AppLocker, WDAC or an antivirus can block it.';
      return `hidden process (Start-Process) ${pid || 'with no PID'} ${alive(diag)}`;
    }
    if (how === 'task') {
      const res = Number(diag.TASKRESULT);
      const hex = diag.TASKRESULT !== undefined && Number.isFinite(res) ? `0x${(res >>> 0).toString(16)}` : 'unknown';
      if (!diag.TASKSTATE) cause = 'The task is gone. An antivirus or a policy removed it.';
      else if (res === 0x41303) cause = 'Task Scheduler never ran the task. Check that the Task Scheduler service runs and that no policy blocks tasks that run as SYSTEM.';
      else if (diag.TASKSTATE === 'Running') cause = 'The task runs but powershell.exe wrote nothing. AppLocker, WDAC or an antivirus can block it.';
      else cause = 'powershell.exe ended without starting the wrapper. The last result is its exit code. AppLocker, WDAC or an antivirus can cause this.';
      return `scheduled task ${taskName(id)} as SYSTEM, state ${diag.TASKSTATE || 'not found'}, last result ${hex}`;
    }
    if (how === 'wmi') {
      cause = 'Registering a SYSTEM task needs an elevated administrator session. AppLocker, WDAC or an antivirus can also stop powershell.exe started through WMI.';
      return `WMI Win32_Process.Create, process ${pid} ${alive(diag)} (the scheduled task was not used: ${launch.TASKERR || 'no reason given'})`;
    }
    return 'a launch step that reported nothing';
  });
  const session = who.WHO ? ` Session: ${who.WHO}, elevated=${who.ELEVATED}, high integrity=${who.HIGH}, PowerShell ${who.PS}.` : '';
  const folder = attempts.at(-1).diag?.FOLDER === 'False' ? ' The work folder is gone.' : '';
  return `The setup script did not start: run.log did not appear within ${dur(startMs)} of each launch. Tried: ${seen.join(', then ')}.${session}${folder} `
    + `Likely cause: ${cause} Fallback: run the one-line installer from the Add host page in an elevated PowerShell on the host.`;
}

// opts (tests shorten or redirect these): pollMs, maxMs (overall limit), startMs (run.log must appear by then after each
// launch), quietMs (silence before a notice), root (work folder parent), useTask (false: the fallback goes straight to WMI).
async function install(t, h, { pollMs = 5000, maxMs = 1200000, startMs = 45000, quietMs = 180000, root, useTask = true, open = openSession } = {}) {
  const pick = t.port ? { port: t.port, kind: kindOf(t.port) } : await pickTransport(t);
  if (!pick.kind) throw new Error(`No OpenSSH or WinRM port is open on ${t.address}. ${NO_WAY_IN}`);
  const session = await open({ ...t, port: pick.port }, pick.kind);
  const un = h.mode === 'uninstall';
  let pid = 0;
  let finished = false;
  try {
    h.phase('upload');
    const who = parseKv(await run(session, prepareScript(h.id, root)));
    if (who.WHO) {
      h.log(`Signed in as ${who.WHO}, elevated=${who.ELEVATED}, high integrity=${who.HIGH}, PowerShell ${who.PS}`);
      if (who.ELEVATED !== 'True' || who.HIGH !== 'True') {
        h.log('Warning: this session is not elevated. The setup needs an elevated administrator and stops with "Run this script in an elevated PowerShell". Sign in with a member of Administrators.');
      }
    }
    h.log(`Uploading the setup files to the temp folder on ${t.address} (${pick.kind === 'ssh' ? 'OpenSSH' : 'WinRM'})`);
    await push(session, h.id, 'setup-windows.ps1', h.file('setup-windows.ps1'), root);
    if (!un) await push(session, h.id, 'labctl-agent.py', h.file('labctl-agent.py'), root);
    await push(session, h.id, 'run.ps1', `$ErrorActionPreference = 'Stop'\r\n& (Join-Path $PSScriptRoot 'setup-windows.ps1') ${un ? '-Uninstall' : `-ServerUrl ${psq(h.server)} -Token ${psq(h.token)}`}\r\nexit $LASTEXITCODE\r\n`, root);
    await push(session, h.id, 'wrap.ps1', WRAP_PS1, root);
    h.phase('install');
    h.log('Starting the setup script (hidden process)');
    pid = Number(parseKv(await run(session, startScript(h.id, root))).PID) || 0;
    const attempts = [{ how: 'process', pid }];
    let seen = 0;
    let last = '';
    const begin = Date.now();
    let start = begin;
    let heard = begin;
    for (;;) {
      await new Promise(r => setTimeout(r, pollMs));
      const out = await run(session, pollScript(h.id, root, seen));
      const lines = out.split(/\r?\n/);
      const head = /^LINES=(\d+)$/.exec(lines[0] || '');
      const exit = lines.find(l => /^EXITCODE=/.test(l));
      const body = lines.slice(head ? 1 : 0).filter(l => !/^EXITCODE=/.test(l));
      if (head) seen = Math.max(seen, Number(head[1])); // a failed read reports fewer lines: keep the count
      h.out(body.join('\n') + (body.length ? '\n' : ''));
      const now = Date.now();
      const fresh = body.filter(l => l.trim());
      if (fresh.length) { heard = now; last = fresh.at(-1); }
      if (exit) {
        finished = true;
        const code = Number(exit.split('=')[1]);
        if (code !== 0) throw new Error(`The setup script exited with code ${code}. Last line: ${last || h.lastLine() || 'none'}`);
        return { hostKey: session.hostKey, port: pick.port, transport: pick.kind };
      }
      if (!seen && now - start >= startMs) {
        attempts.at(-1).diag = parseKv(await run(session, diagScript(h.id, root, pid)).catch(e => `DIAGERR=${e.message}`));
        if (attempts.length > 1) throw new Error(notStarted(startMs, h.id, who, attempts));
        h.log('The hidden process did not start, trying a scheduled task');
        await run(session, killScript(h.id, root, pid)).catch(() => {}); // never two setups at once
        const launch = parseKv(await run(session, launchScript(h.id, root, useTask)));
        pid = Number(launch.PID) || 0;
        attempts.push({ how: launch.LAUNCH, pid, launch });
        if (launch.LAUNCH === 'task') h.log(`Started the setup as SYSTEM through the one-shot scheduled task ${taskName(h.id)}`);
        else if (launch.LAUNCH === 'wmi') h.log(`Started the setup through WMI (process ${pid}). The scheduled task was not used: ${launch.TASKERR}`);
        start = Date.now();
        continue;
      }
      if (now - begin >= maxMs) throw new Error(`The setup script did not finish within ${dur(maxMs)}. Last line: ${last || 'none'}`);
      if (seen && now - heard >= quietMs) { h.log(`No output for ${dur(quietMs)}. Last line: ${last || 'none'}`); heard = now; }
    }
  } finally {
    await run(session, cleanupScript(h.id, root, finished ? 0 : pid)).catch(() => {});
    await session.close();
  }
}

module.exports = { inspect, install, winChecks, probeScript, pickTransport, psq, wrap, WRAP_PS1, prepareScript, startScript, launchScript, pollScript, diagScript, killScript, cleanupScript };
