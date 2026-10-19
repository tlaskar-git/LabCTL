# LabCTL template prelude for PowerShell 5.1 and later. The server puts this in front of every .ps1 template.
# Parameters arrive as LABCTL_P_<NAME> environment variables and secrets as LABCTL_SECRET_<NAME>.
# Neither is ever placed inside code that PowerShell parses (no Invoke-Expression, no -Command strings).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

# Output goes through the console writer so functions that return values stay clean.
function Say([string]$Text) { [Console]::Out.WriteLine($Text) }
function Step([string]$Title) { [Console]::Out.WriteLine(''); [Console]::Out.WriteLine("== $Title ==") }
function Warn([string]$Text) { [Console]::Error.WriteLine("WARNING: $Text") }
function Die([string]$Text) { [Console]::Error.WriteLine("ERROR: $Text"); exit 1 }
# A line the runbook engine reads back: LABCTL_RESULT key=value
function Result([string]$Key, $Value) { [Console]::Out.WriteLine("LABCTL_RESULT $Key=$Value") }
# Show: sends command output (tables, native tools) through the console writer.
function Show($Data) { $Data | Out-String -Stream | ForEach-Object { [Console]::Out.WriteLine($_) } }

function Get-Param([string]$Name, [string]$Default = '') {
    $v = [Environment]::GetEnvironmentVariable("LABCTL_P_$Name")
    if ([string]::IsNullOrEmpty($v)) { return $Default }
    return $v
}
function Get-Flag([string]$Name, [bool]$Default = $false) {
    $v = Get-Param $Name ''
    if ($v -eq '') { return $Default }
    return ($v -in @('1', 'true', 'True', 'TRUE', 'yes', 'on'))
}
function Get-Int([string]$Name, [int]$Default) {
    $v = Get-Param $Name ([string]$Default)
    $n = 0
    if (-not [int]::TryParse($v, [ref]$n) -or $n -lt 0) { Die "Parameter $Name must be a whole number" }
    return $n
}
function Test-Match([string]$Name, [string]$Pattern, [string]$Value) {
    if ($Value -notmatch $Pattern) { Die "Parameter $Name has an invalid value" }
}
function Get-Secret([string]$Name) { return [Environment]::GetEnvironmentVariable("LABCTL_SECRET_$Name") }

$DryRun = Get-Flag 'DRY_RUN'
$Drain = Get-Flag 'DRAIN'
$Force = Get-Flag 'FORCE'
$DrainTimeoutMin = Get-Int 'DRAIN_TIMEOUT_MIN' 120
if ($DryRun) { Say 'DRY RUN: nothing will be changed' }

function Get-FreeGB([string]$Drive = 'C') { return [math]::Round((Get-PSDrive -Name $Drive).Free / 1GB, 1) }
function Get-DirSizeMB([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $sum = (Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    if (-not $sum) { return 0 }
    return [math]::Round($sum / 1MB, 0)
}
# Remove-Older: removes direct children of Path older than Days days. Optional filters: dirs only, files only, names to skip.
function Remove-Older([string]$Path, [int]$Days, [switch]$DirsOnly, [switch]$FilesOnly, [string]$SkipName = '') {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $cut = (Get-Date).AddDays(-$Days)
    foreach ($item in @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue)) {
        if ($item.LastWriteTime -ge $cut) { continue }
        if ($DirsOnly -and -not $item.PSIsContainer) { continue }
        if ($FilesOnly -and $item.PSIsContainer) { continue }
        if ($SkipName -ne '' -and $item.Name -like $SkipName) { continue }
        if ($DryRun) { Say "[dry-run] remove $($item.FullName)" }
        else { Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
# Remove-FilesOlder: removes files older than Days days anywhere below Path.
function Remove-FilesOlder([string]$Path, [int]$Days) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $cut = (Get-Date).AddDays(-$Days)
    $old = @(Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cut })
    if ($DryRun) { Say "[dry-run] $($old.Count) file(s) older than $Days days in $Path"; return }
    foreach ($f in $old) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue }
}
function Clear-Dir([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $items = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue)
    if ($DryRun) { Say "[dry-run] would empty $Path ($($items.Count) entries)"; return }
    foreach ($i in $items) { Remove-Item -LiteralPath $i.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}

# ---- runners -----------------------------------------------------------------------------------
# Machine wide on purpose: a build in any runner on this host blocks disruptive work.
function Test-RunnerBusy { return [bool](Get-Process -Name 'Runner.Worker' -ErrorAction SilentlyContinue) }

# Wait-Idle: returns when no build runs. -Drain waits (re-checks after 5 s and notes a job that started in the
# gap). -Force continues with a build running. Without either, a running build stops the script.
function Wait-Idle {
    if ($Drain) {
        Say "Drain: waiting for Runner.Worker to finish (up to $DrainTimeoutMin minutes)"
        $deadline = (Get-Date).AddMinutes($DrainTimeoutMin)
        while ($true) {
            while (Test-RunnerBusy) {
                if ((Get-Date) -ge $deadline) {
                    if ($Force) { Warn 'Drain timed out and force is set: continuing with a build running'; return }
                    Die 'Drain timed out: a build is still running'
                }
                Start-Sleep -Seconds 15
            }
            Start-Sleep -Seconds 5
            if (Test-RunnerBusy) { Say 'A job started during the 5 s re-check, waiting again'; continue }
            Say 'No build running after the 5 s re-check'
            return
        }
    }
    if (Test-RunnerBusy) {
        if ($Force) { Warn 'Runner.Worker is active and force is set: continuing'; return }
        Die 'Runner.Worker is active. Use drain, or force with typed confirmation'
    }
}
# Invoke-Gate: Wait-Idle for real runs. A dry run only reports whether a build is running.
function Invoke-Gate {
    if ($DryRun) {
        if (Test-RunnerBusy) { Say '[dry-run] Runner.Worker is active: a real run would wait (drain), continue (force) or stop' }
        else { Say '[dry-run] No build is running' }
    } else { Wait-Idle }
}

# Get-Runners: one object per runner: Dir, Service (service name or $null), Name, Url, Account.
function Get-Runners {
    $services = @(Get-CimInstance Win32_Service -Filter "Name LIKE 'actions.runner.%'" -ErrorAction SilentlyContinue)
    $dirs = New-Object System.Collections.Generic.List[string]
    $given = Get-Param 'RUNNER_DIR'
    if ($given) {
        if (-not (Test-Path -LiteralPath (Join-Path $given '.runner'))) { Die 'No .runner file in the given runner directory' }
        $dirs.Add($given.TrimEnd('\'))
    } else {
        foreach ($s in $services) {
            if ($s.PathName -match '^"?([^"]+)\\bin\\RunnerService\.exe') { $dirs.Add($Matches[1]) }
        }
        foreach ($root in @('C:\', 'D:\')) {
            foreach ($d in @(Get-ChildItem -LiteralPath $root -Directory -Filter 'actions-runner*' -ErrorAction SilentlyContinue)) {
                if (Test-Path -LiteralPath (Join-Path $d.FullName '.runner')) { $dirs.Add($d.FullName) }
            }
        }
    }
    $out = @()
    foreach ($dir in ($dirs | Sort-Object -Unique)) {
        $svc = $null
        foreach ($s in $services) { if ($s.PathName.ToLower().Contains(($dir + '\bin\').ToLower())) { $svc = $s } }
        $cfg = $null
        try { $cfg = Get-Content -LiteralPath (Join-Path $dir '.runner') -Raw | ConvertFrom-Json } catch { }
        $out += [pscustomobject]@{
            Dir = $dir
            Service = $(if ($svc) { $svc.Name } else { $null })
            Account = $(if ($svc) { $svc.StartName } else { $null })
            Name = $(if ($cfg) { $cfg.agentName } else { '' })
            Url = $(if ($cfg) { $cfg.gitHubUrl } else { '' })
        }
    }
    return $out
}
# Callers wrap the result in @() so zero or one runner still behaves as a list.
function Get-RunnersOrDie { $r = @(Get-Runners); if ($r.Count -eq 0) { Die 'No runner found. Set the runner directory parameter' }; return $r }
function Get-RunnerVersion([string]$Dir) {
    $exe = Join-Path $Dir 'bin\Runner.Listener.exe'
    if (-not (Test-Path -LiteralPath $exe)) { return 'unknown' }
    try { return ([string](& $exe --version)).Trim() } catch { return 'unknown' }
}
function Wait-ServiceRunning([string]$Name, [int]$Seconds) {
    $end = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $end) {
        if ((Get-Service -Name $Name).Status -eq 'Running') { return $true }
        Start-Sleep -Seconds 3
    }
    return $false
}

# Get-RunnerRelease: the actions/runner release for Version (empty means latest) with the SHA-256 from its notes.
# No hash means no install.
function Get-RunnerRelease([string]$Version) {
    if ($Version) {
        Test-Match 'VERSION' '^\d+\.\d+\.\d+$' $Version
        $url = "https://api.github.com/repos/actions/runner/releases/tags/v$Version"
    } else { $url = 'https://api.github.com/repos/actions/runner/releases/latest' }
    $headers = @{ 'User-Agent' = 'labctl'; 'Accept' = 'application/vnd.github+json' }
    $token = Get-Secret 'GITHUB_TOKEN'
    if ($token) { $headers['Authorization'] = "Bearer $token" }
    $rel = Invoke-RestMethod -Uri $url -Headers $headers -UseBasicParsing
    $arch = 'x64'
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }
    $tag = "win-$arch"
    $ver = ([string]$rel.tag_name).TrimStart('v')
    $name = "actions-runner-$tag-$ver.zip"
    $asset = $rel.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
    if (-not $asset) { Die "No runner package named $name in release $ver" }
    $body = [string]$rel.body
    $m = [regex]::Match($body, 'BEGIN SHA ' + [regex]::Escape($tag) + ' -->([0-9a-f]{64})<!--')
    if (-not $m.Success) { $m = [regex]::Match($body, [regex]::Escape($name) + '[^0-9a-f]*([0-9a-f]{64})') }
    if (-not $m.Success) { Die "The release notes carry no SHA-256 for $tag, refusing to install an unverified package" }
    return [pscustomobject]@{ Version = $ver; Url = $asset.browser_download_url; Sha = $m.Groups[1].Value }
}
function Save-RunnerPackage($Rel, [string]$Dest) {
    Invoke-WebRequest -Uri $Rel.Url -OutFile $Dest -UseBasicParsing
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Dest).Hash.ToLower()
    if ($hash -ne $Rel.Sha) { Remove-Item -LiteralPath $Dest -Force; Die 'SHA-256 mismatch on the downloaded runner package' }
    Say 'SHA-256 verified'
}
# Restore-RunnerPrevious: puts Dir.labctl-prev back (the _work folder moves back with it) and starts the service.
function Restore-RunnerPrevious([string]$Dir, [string]$Service) {
    $prev = "$Dir.labctl-prev"
    $failed = "$Dir.labctl-failed"
    if (-not (Test-Path -LiteralPath $prev)) { Die "No previous version at $prev" }
    if ($Service) { Stop-Service -Name $Service -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $failed) { Remove-Item -LiteralPath $failed -Recurse -Force }
    Move-Item -LiteralPath $Dir -Destination $failed
    if ((Test-Path -LiteralPath "$failed\_work") -and -not (Test-Path -LiteralPath "$prev\_work")) { Move-Item -LiteralPath "$failed\_work" -Destination "$prev\_work" }
    Move-Item -LiteralPath $prev -Destination $Dir
    if ($Service) {
        Start-Service -Name $Service
        if (-not (Wait-ServiceRunning $Service 60)) { Die 'Rolled back, but the service is not running' }
    }
    Say "Rolled back to version $(Get-RunnerVersion $Dir)"
}
