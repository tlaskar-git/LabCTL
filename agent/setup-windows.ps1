# LabCTL Agent Setup - Windows (Server 2025, Win 10, Win 11)
# Run as Administrator in PowerShell
#
# Usage:
#   .\setup-windows.ps1 -ServerUrl "ws://YOUR_SERVER_IP:7700/ws/agent"

param(
    [Parameter(Mandatory=$true)]
    [string]$ServerUrl
)

$ErrorActionPreference = "Stop"
$PythonDir = "C:\Python312"
$PythonExe = "$PythonDir\python.exe"
$AgentDir = "C:\labctl\agent"
$PythonVersion = "3.12.7"
$PythonInstaller = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-amd64.exe"

Write-Host "=== LabCTL Agent Setup (Windows) ===" -ForegroundColor Cyan
Write-Host "Server: $ServerUrl"
Write-Host ""

# ── Step 1: Ensure agent directory exists ──────────────────
Write-Host "[1/5] Setting up agent directory..." -ForegroundColor Yellow
New-Item -ItemType Directory -Path $AgentDir -Force | Out-Null

# Copy agent script to target if not already there
$ScriptSource = Join-Path $PSScriptRoot "labctl-agent.py"
$ScriptDest = Join-Path $AgentDir "labctl-agent.py"
if (Test-Path $ScriptSource) {
    Copy-Item $ScriptSource $ScriptDest -Force
    Write-Host "  Agent script copied to $ScriptDest"
} elseif (-not (Test-Path $ScriptDest)) {
    Write-Host "  ERROR: labctl-agent.py not found in $PSScriptRoot or $AgentDir" -ForegroundColor Red
    exit 1
}

# ── Step 2: Install Python system-wide ─────────────────────
Write-Host "[2/5] Checking Python installation..." -ForegroundColor Yellow

if (Test-Path $PythonExe) {
    $ver = & $PythonExe --version 2>&1
    Write-Host "  Python already installed: $ver"
} else {
    Write-Host "  Python not found at $PythonDir. Installing system-wide..."

    # Check if Python is installed per-user (common issue)
    $userPython = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"

    # Download fresh installer
    $installerPath = "$env:TEMP\python-installer.exe"
    Write-Host "  Downloading Python $PythonVersion..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $PythonInstaller -OutFile $installerPath -UseBasicParsing

    if (Test-Path $userPython) {
        # Per-user install exists. Uninstall it first to avoid conflicts.
        Write-Host "  Found per-user Python install. Removing to avoid conflicts..."
        $uninstallArgs = "/uninstall /quiet"
        Start-Process $installerPath -ArgumentList $uninstallArgs -Wait -ErrorAction SilentlyContinue
        Start-Sleep 3
    }

    # Install system-wide
    Write-Host "  Installing Python to $PythonDir..."
    $installArgs = "/quiet InstallAllUsers=1 TargetDir=$PythonDir PrependPath=1 Include_launcher=0"
    Start-Process $installerPath -ArgumentList $installArgs -Wait

    # Clean up installer
    Remove-Item $installerPath -Force -ErrorAction SilentlyContinue

    # Verify installation
    if (Test-Path $PythonExe) {
        $ver = & $PythonExe --version 2>&1
        Write-Host "  Python installed: $ver" -ForegroundColor Green
    } else {
        Write-Host "  ERROR: Python installation failed. Install manually to $PythonDir" -ForegroundColor Red
        Write-Host "  Download from https://www.python.org/downloads/" -ForegroundColor Red
        Write-Host "  Select 'Customize installation' > check 'Install for all users' > set path to $PythonDir" -ForegroundColor Red
        exit 1
    }
}

# ── Step 3: Install websocket-client ───────────────────────
Write-Host "[3/5] Installing Python dependencies..." -ForegroundColor Yellow
& $PythonExe -m pip install websocket-client --quiet 2>&1 | Out-Null
& $PythonExe -c "import websocket; print('  websocket-client: OK')"

# ── Step 4: Install PSWindowsUpdate module ─────────────────
Write-Host "[4/5] Checking PSWindowsUpdate module..." -ForegroundColor Yellow
if (-not (Get-Module -ListAvailable -Name PSWindowsUpdate)) {
    Write-Host "  Installing PSWindowsUpdate..."
    Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Confirm:$false | Out-Null
    Install-Module -Name PSWindowsUpdate -Force -Confirm:$false
    Write-Host "  PSWindowsUpdate installed" -ForegroundColor Green
} else {
    Write-Host "  PSWindowsUpdate: already installed"
}

# ── Step 5: Create scheduled task ──────────────────────────
Write-Host "[5/5] Creating scheduled task..." -ForegroundColor Yellow

# Remove existing task if present
$existing = Get-ScheduledTask -TaskName "LabCTL-Agent" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "  Removing existing LabCTL-Agent task..."
    Stop-ScheduledTask -TaskName "LabCTL-Agent" -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName "LabCTL-Agent" -Confirm:$false
}

$action = New-ScheduledTaskAction `
    -Execute $PythonExe `
    -Argument "$ScriptDest --server $ServerUrl" `
    -WorkingDirectory $AgentDir

$trigger = New-ScheduledTaskTrigger -AtStartup

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 365)

$principal = New-ScheduledTaskPrincipal `
    -UserId "SYSTEM" `
    -LogonType ServiceAccount `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName "LabCTL-Agent" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null

Start-ScheduledTask -TaskName "LabCTL-Agent"
Start-Sleep 3

$state = (Get-ScheduledTask -TaskName "LabCTL-Agent").State
if ($state -eq "Running") {
    Write-Host ""
    Write-Host "=== LabCTL Agent is running ===" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "=== Task created but state is: $state ===" -ForegroundColor Yellow
    Write-Host "Check Task Scheduler for details."
}

Write-Host ""
Write-Host "Task:    LabCTL-Agent (runs as SYSTEM at startup)"
Write-Host "Agent:   $ScriptDest"
Write-Host "Python:  $PythonExe"
Write-Host "Server:  $ServerUrl"
Write-Host ""
Write-Host "Commands:"
Write-Host "  Status:  Get-ScheduledTask -TaskName 'LabCTL-Agent' | Select-Object State"
Write-Host "  Stop:    Stop-ScheduledTask -TaskName 'LabCTL-Agent'"
Write-Host "  Start:   Start-ScheduledTask -TaskName 'LabCTL-Agent'"
Write-Host "  Remove:  Unregister-ScheduledTask -TaskName 'LabCTL-Agent' -Confirm:`$false"
