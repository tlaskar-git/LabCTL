$problems = 0
$runners = @(Get-RunnersOrDie)
Step 'Host'
if (Test-RunnerBusy) { Say 'Runner.Worker: a job is running' } else { Say 'Runner.Worker: idle' }
Say "Free space on C: $(Get-FreeGB) GB"
$latest = ''
if (Get-Flag 'CHECK_LATEST') { $latest = (Get-RunnerRelease '').Version }

foreach ($r in $runners) {
    $dir = $r.Dir
    Step "Runner $($r.Name)"
    Say "Folder: $dir"
    Say "Registered at: $($r.Url)"
    $ver = Get-RunnerVersion $dir
    Say "Version: $ver"
    if ($latest -and $ver -ne $latest) { Warn "Latest is $latest" }
    if ($r.Service) {
        $state = (Get-Service -Name $r.Service).Status
        Say "Service $($r.Service): $state, account $($r.Account)"
        if ($state -ne 'Running') { Warn 'Service is not running'; $problems++ }
    } else { Warn 'Not installed as a service'; $problems++ }
    if (-not (Get-Process -Name 'Runner.Listener' -ErrorAction SilentlyContinue)) { Warn 'No Runner.Listener process'; $problems++ }
    Say "_work size: $(Get-DirSizeMB (Join-Path $dir '_work')) MB"
    $log = Get-ChildItem -LiteralPath (Join-Path $dir '_diag') -Filter 'Runner_*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($log) {
        Say "Latest listener log: $($log.Name)"
        Show (Select-String -LiteralPath $log.FullName -Pattern 'Listening for Jobs|Running job|completed with result|Connected|Error|Exception' | Select-Object -Last 5 | ForEach-Object { $_.Line })
    }
}
Say "Problems: $problems"
Result 'runner_problems' $problems
if ((Get-Flag 'FAIL_ON_DOWN' $true) -and $problems -gt 0) { exit 1 }
