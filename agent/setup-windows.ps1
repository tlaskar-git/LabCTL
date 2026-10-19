# LabCTL agent setup for Windows (Server 2016 and later, Windows 10 and 11). Run in an elevated PowerShell.
#
#   irm "https://labctl.example.test/install/windows.ps1?token=TOKEN" | iex
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-windows.ps1 -ServerUrl https://labctl.example.test -Token TOKEN
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-windows.ps1 -Uninstall
#
# Installs to C:\ProgramData\LabCTL\agent with its own venv (websocket-client is never installed system wide),
# and registers two SYSTEM scheduled tasks:
#   LabCTL-Agent           at startup, restarts every minute on failure (up to 999 times), no time limit
#   LabCTL-Agent-Watchdog  every minute, runs "labctl-agent.py --watchdog" twice (30 s apart) and starts the
#                          agent task again when it is not running (for example after exit code 75)
# Uses labctl-agent.py from this folder when present, else downloads it from the server with the token.
# Python 3.8 or newer is installed silently (winget, else the signed python.org installer) when it is missing.
# The server renders $DefaultServer and $DefaultToken when it serves this script. This file is ASCII only on purpose.
[CmdletBinding()]
param(
    [string]$ServerUrl,
    [string]$Token,
    [string]$InstallDir = (Join-Path $env:ProgramData 'LabCTL\agent'),
    [string]$TaskName = 'LabCTL-Agent',
    [switch]$Uninstall,
    [switch]$InstallPSWindowsUpdate
)

$DefaultServer = ''
$DefaultToken = ''

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$PythonVersion = '3.12.10'
$LogFile = Join-Path (Split-Path -Path $InstallDir -Parent) 'setup.log'

function Write-Log {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer with coloured progress')]
    param([string]$Message, [string]$Color = 'Gray')
    Write-Host $Message -ForegroundColor $Color
    Write-LogFile $Message
}

function Write-LogFile {
    param([string]$Message)
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path -Path $LogFile -Parent) | Out-Null
        Add-Content -LiteralPath $LogFile -Value ('{0} {1}' -f (Get-Date -Format 's'), $Message)
    } catch {
        $null = $_ # logging must never stop the setup
    }
}

# Runs a native command without PowerShell 5.1 turning stderr output into terminating errors.
function Invoke-Native {
    param([string]$File, [string[]]$Arguments = @(), [string]$InputText)
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($InputText) {
            $out = $InputText | & $File @Arguments 2>&1 | ForEach-Object { "$_" }
        } else {
            $out = & $File @Arguments 2>&1 | ForEach-Object { "$_" }
        }
        return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = (@($out) -join "`n") }
    } catch {
        return [pscustomobject]@{ ExitCode = -1; Output = $_.Exception.Message }
    } finally {
        $ErrorActionPreference = $old
    }
}

function Test-Administrator {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-HttpBase {
    param([string]$Url)
    $base = ($Url.Trim() -replace '^wss://', 'https://' -replace '^ws://', 'http://' -replace '/ws/agent.*$', '' -replace '/+$', '')
    if ($base -notmatch '^https?://') { $base = "https://$base" }
    if ($base -notmatch '^https?://[A-Za-z0-9.:\[\]-]+(/[A-Za-z0-9._~/-]*)?$') { throw 'The server URL is not valid.' }
    return $base
}

# Returns the best usable system Python (3.8 or newer, with venv and ensurepip), or $null.
# Skips the Microsoft Store stub and per-user installs, because the SYSTEM account must be able to run it.
function Find-Python {
    $paths = New-Object System.Collections.Generic.List[string]
    try {
        $r = Invoke-Native 'py.exe' @('-3', '-c', 'import sys; print(sys.executable)')
        if ($r.ExitCode -eq 0 -and $r.Output) { $paths.Add($r.Output.Trim()) }
    } catch { $null = $_ }
    foreach ($c in @(Get-Command python.exe -All -ErrorAction SilentlyContinue)) { $paths.Add($c.Source) }
    foreach ($g in @("$env:ProgramFiles\Python3*\python.exe", "$env:SystemDrive\Python3*\python.exe")) {
        foreach ($f in @(Get-ChildItem -Path $g -ErrorAction SilentlyContinue)) { $paths.Add($f.FullName) }
    }
    $best = $null
    $bestVersion = 0
    foreach ($p in ($paths | Select-Object -Unique)) {
        if (-not $p -or -not (Test-Path -LiteralPath $p)) { continue }
        if ($p -like '*\WindowsApps\*' -or $p -like "$env:SystemDrive\Users\*") { continue }
        $r = Invoke-Native $p @('-c', 'import sys, venv, ensurepip; print(sys.version_info[0] * 100 + sys.version_info[1])')
        $v = 0
        if ($r.ExitCode -eq 0 -and [int]::TryParse($r.Output.Trim(), [ref]$v) -and $v -ge 308 -and $v -gt $bestVersion) {
            $best = $p
            $bestVersion = $v
        }
    }
    return $best
}

function Install-Python {
    if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
        Write-Log 'Installing Python with winget'
        $r = Invoke-Native 'winget.exe' @('install', '--id', 'Python.Python.3.12', '-e', '--silent', '--scope', 'machine',
            '--accept-package-agreements', '--accept-source-agreements')
        Write-LogFile ("winget exit code {0}" -f $r.ExitCode)
        if (Find-Python) { return }
        Write-Log 'winget did not give a usable Python. Trying the python.org installer.' 'Yellow'
    }
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'amd64' }
    $url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-$arch.exe"
    $installer = Join-Path $env:TEMP ('labctl-python-{0}.exe' -f [guid]::NewGuid().ToString('N'))
    try {
        Write-Log "Downloading $url"
        Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing
        $sig = Get-AuthenticodeSignature -FilePath $installer
        if ($sig.Status -ne 'Valid' -or -not $sig.SignerCertificate -or $sig.SignerCertificate.Subject -notmatch '(^|, )(CN|O)=Python Software Foundation(,|$)') {
            throw 'The Python installer does not carry a valid Python Software Foundation signature. It was not run.'
        }
        Write-Log 'Signature is valid. Installing Python silently for all users.'
        $p = Start-Process -FilePath $installer -Wait -PassThru -ArgumentList @('/quiet', 'InstallAllUsers=1', 'PrependPath=0',
            'Include_launcher=0', 'Include_test=0', 'Include_doc=0')
        if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "The Python installer failed with exit code $($p.ExitCode)." }
    } finally {
        Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
    }
}

function Test-InstallDirSafe {
    param([string]$Path)
    $full = [IO.Path]::GetFullPath($Path)
    $parts = @($full -split '[\\/]+' | Where-Object { $_ -and $_ -notmatch ':$' })
    return ($parts.Count -ge 2 -and $full -match 'labctl')
}

function Remove-AgentTask {
    [CmdletBinding(SupportsShouldProcess)]
    param([string]$Name)
    if ((Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) -and $PSCmdlet.ShouldProcess($Name, 'Unregister scheduled task')) {
        Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    }
}

# Wrapper scripts live in the install folder. They are static: every path comes from $PSScriptRoot or agent.json.
$RunAgentScript = @'
# Runs the LabCTL agent and appends its output to agent.log (rotated at 10 MB). Written by setup-windows.ps1.
$ErrorActionPreference = 'Continue'
$dir = $PSScriptRoot
$log = Join-Path $dir 'agent.log'
$env:PYTHONUNBUFFERED = '1'
$env:PYTHONUTF8 = '1'
& (Join-Path $dir 'venv\Scripts\python.exe') (Join-Path $dir 'labctl-agent.py') --config (Join-Path $dir 'agent.json') 2>&1 | ForEach-Object {
    if ((Test-Path -LiteralPath $log) -and ((Get-Item -LiteralPath $log).Length -gt 10MB)) {
        Move-Item -LiteralPath $log -Destination "$log.1" -Force -ErrorAction SilentlyContinue
    }
    Add-Content -LiteralPath $log -Value "$_" -Encoding UTF8
}
exit $LASTEXITCODE
'@

$WatchdogScript = @'
# Self-update watchdog. The scheduled task starts it every minute, so it checks twice, 30 s apart.
# It also starts the agent task when that task is idle, which covers exit code 75 (restart after a self-update).
$ErrorActionPreference = 'Continue'
$dir = $PSScriptRoot
$py = Join-Path $dir 'venv\Scripts\python.exe'
$agent = Join-Path $dir 'labctl-agent.py'
$config = Join-Path $dir 'agent.json'
$name = 'LabCTL-Agent'
try {
    $c = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
    if ($c.windows_task_name) { $name = [string]$c.windows_task_name }
} catch {
    $null = $_
}
for ($i = 0; $i -lt 2; $i++) {
    if ($i -gt 0) { Start-Sleep -Seconds 30 }
    & $py $agent --watchdog --config $config 2>&1 | Out-Null
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($t -and $t.State -eq 'Ready') { Start-ScheduledTask -TaskName $name }
}
'@

$ConfigCode = @'
import json, os, sys
path = sys.argv[1]
cfg = {}
if os.path.exists(path):
    with open(path, encoding="utf-8-sig") as f:
        cfg = json.load(f)
cfg["server_url"] = os.environ["LABCTL_SERVER_URL"]
cfg["token"] = os.environ["LABCTL_TOKEN"]
cfg["windows_task_name"] = os.environ["LABCTL_TASK_NAME"]
with open(path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
'@

# Builds the two task definitions without registering them (also used by the checks).
function Get-AgentTaskDefinition {
    param([string]$Dir)
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $common = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File'
    $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $agentSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden `
        -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    $watchSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden `
        -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    $repeat = New-ScheduledTaskTrigger -Once -At ([datetime]'2000-01-01T00:00:00') -RepetitionInterval (New-TimeSpan -Minutes 1) `
        -RepetitionDuration (New-TimeSpan -Days 9999)
    return @{
        Agent = @{
            Action = New-ScheduledTaskAction -Execute $ps -Argument "$common `"$(Join-Path $Dir 'run-agent.ps1')`"" -WorkingDirectory $Dir
            Trigger = New-ScheduledTaskTrigger -AtStartup
            Settings = $agentSettings
            Principal = $principal
        }
        Watchdog = @{
            Action = New-ScheduledTaskAction -Execute $ps -Argument "$common `"$(Join-Path $Dir 'watchdog.ps1')`"" -WorkingDirectory $Dir
            Trigger = $repeat
            Settings = $watchSettings
            Principal = $principal
        }
    }
}

function Install-Agent {
    param([string]$Server, [string]$AgentToken, [string]$Dir, [string]$Task, [bool]$WithWindowsUpdate)
    if (-not $Server -or -not $AgentToken) { throw 'Usage: setup-windows.ps1 -ServerUrl URL -Token TOKEN  (or -Uninstall)' }
    if ($AgentToken -notmatch '^[A-Za-z0-9_-]{16,200}$') { throw 'The token is not valid.' }
    if ($Task -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw 'The task name is not valid.' }
    $base = Get-HttpBase $Server
    $watchName = "$Task-Watchdog"
    Write-Log '=== LabCTL agent setup (Windows) ===' 'Cyan'
    Write-Log "Server: $base"

    Write-Log '[1/6] Python' 'Yellow'
    $python = Find-Python
    if (-not $python) {
        Install-Python
        $python = Find-Python
        if (-not $python) { throw 'Python 3.8 or newer with venv support is required and could not be installed.' }
    }
    Write-Log "Python: $python"

    Write-Log '[2/6] Install folder' 'Yellow'
    Remove-AgentTask $watchName
    Remove-AgentTask $Task
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    # Only SYSTEM and Administrators may touch this folder: the SYSTEM tasks run scripts from it and agent.json holds the token.
    $acl = Invoke-Native 'icacls.exe' @($Dir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
    if ($acl.ExitCode -ne 0) { throw "Could not secure $Dir. $($acl.Output)" }

    Write-Log '[3/6] Agent' 'Yellow'
    $agentPath = Join-Path $Dir 'labctl-agent.py'
    $newAgent = "$agentPath.new"
    $here = Get-Variable -Name PSScriptRoot -ValueOnly -ErrorAction SilentlyContinue
    if ($here -and (Test-Path -LiteralPath (Join-Path $here 'labctl-agent.py'))) {
        Copy-Item -LiteralPath (Join-Path $here 'labctl-agent.py') -Destination $newAgent -Force
    } else {
        Write-Log 'Downloading the agent from the server'
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        try {
            Invoke-WebRequest -Uri "$base/install/agent.py" -Headers @{ Authorization = "Bearer $AgentToken" } -OutFile $newAgent -UseBasicParsing
        } catch {
            throw 'Could not download the agent. Check the server URL and the token.'
        }
    }

    Write-Log '[4/6] Python environment' 'Yellow'
    $venvPy = Join-Path $Dir 'venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $venvPy)) {
        $r = Invoke-Native $python @('-m', 'venv', (Join-Path $Dir 'venv'))
        if ($r.ExitCode -ne 0) { throw "Could not create the venv. $($r.Output)" }
    }
    $r = Invoke-Native $venvPy @('-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--upgrade', 'websocket-client>=1.6,<2')
    if ($r.ExitCode -ne 0) { throw "pip could not install websocket-client. $($r.Output)" }
    $r = Invoke-Native $venvPy @('-m', 'py_compile', $newAgent)
    if ($r.ExitCode -ne 0) { throw "The agent file does not compile. $($r.Output)" }
    Move-Item -LiteralPath $newAgent -Destination $agentPath -Force
    Remove-Item -LiteralPath (Join-Path $Dir '__pycache__') -Recurse -Force -ErrorAction SilentlyContinue

    $configPath = Join-Path $Dir 'agent.json'
    $env:LABCTL_SERVER_URL = $base
    $env:LABCTL_TOKEN = $AgentToken
    $env:LABCTL_TASK_NAME = $Task
    try {
        $r = Invoke-Native $venvPy @('-', $configPath) -InputText $ConfigCode
    } finally {
        Remove-Item Env:\LABCTL_SERVER_URL, Env:\LABCTL_TOKEN, Env:\LABCTL_TASK_NAME -ErrorAction SilentlyContinue
    }
    if ($r.ExitCode -ne 0) { throw "Could not write agent.json. $($r.Output)" }
    Set-Content -LiteralPath (Join-Path $Dir 'run-agent.ps1') -Value $RunAgentScript -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $Dir 'watchdog.ps1') -Value $WatchdogScript -Encoding ASCII

    if ($WithWindowsUpdate -and -not (Get-Module -ListAvailable -Name PSWindowsUpdate)) {
        Write-Log 'Installing the PSWindowsUpdate module'
        Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Confirm:$false | Out-Null
        Install-Module -Name PSWindowsUpdate -Force -Confirm:$false
    }

    Write-Log '[5/6] Scheduled tasks' 'Yellow'
    $parts = Get-AgentTaskDefinition $Dir
    foreach ($pair in @(@($Task, 'Agent', 'LabCTL agent'), @($watchName, 'Watchdog', 'LabCTL agent watchdog'))) {
        $p = $parts[$pair[1]]
        Register-ScheduledTask -TaskName $pair[0] -Description $pair[2] -Action $p.Action -Trigger $p.Trigger -Settings $p.Settings `
            -Principal $p.Principal -Force | Out-Null
    }
    Start-ScheduledTask -TaskName $Task

    Write-Log '[6/6] Waiting for the agent to connect' 'Yellow'
    $log = Join-Path $Dir 'agent.log'
    $connected = $false
    for ($i = 0; $i -lt 30 -and -not $connected; $i++) {
        Start-Sleep -Seconds 1
        if (Test-Path -LiteralPath $log) { $connected = [bool](Select-String -LiteralPath $log -Pattern '\[ws\] connected' -Quiet -ErrorAction SilentlyContinue) }
    }
    if ($connected) {
        Write-Log '=== LabCTL agent is running and connected ===' 'Green'
    } else {
        Write-Log "=== The agent task is started but has not connected yet. Check $log ===" 'Yellow'
    }
    Write-Log "Tasks:   $Task (agent), $watchName (watchdog), both as SYSTEM"
    Write-Log "Folder:  $Dir"
    Write-Log "Remove:  setup-windows.ps1 -Uninstall"
}

function Uninstall-Agent {
    param([string]$Dir, [string]$Task)
    if ($Task -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw 'The task name is not valid.' }
    if (-not (Test-InstallDirSafe $Dir)) { throw "Refusing to remove $Dir." }
    Remove-AgentTask "$Task-Watchdog"
    Remove-AgentTask $Task
    for ($i = 0; $i -lt 10 -and (Test-Path -LiteralPath $Dir); $i++) {
        Remove-Item -LiteralPath $Dir -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $Dir) { Start-Sleep -Seconds 1 }
    }
    if (Test-Path -LiteralPath $Dir) { throw "Could not remove $Dir completely." }
    Write-Log 'LabCTL agent removed.' 'Green'
}

if ($env:LABCTL_SETUP_LIBONLY -eq '1') { return }

try {
    if (-not (Test-Administrator)) { throw 'Run this script in an elevated PowerShell (Run as administrator).' }
    if ($Uninstall) {
        Uninstall-Agent -Dir $InstallDir -Task $TaskName
    } else {
        if (-not $ServerUrl) { $ServerUrl = $DefaultServer }
        if (-not $Token) { $Token = $DefaultToken }
        Install-Agent -Server $ServerUrl -AgentToken $Token -Dir $InstallDir -Task $TaskName -WithWindowsUpdate $InstallPSWindowsUpdate.IsPresent
    }
} catch {
    Write-LogFile ("ERROR: {0}" -f $_.Exception.Message)
    throw
}
