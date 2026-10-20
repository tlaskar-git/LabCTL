$runners = @(Get-RunnersOrDie)
Step 'Latest runner package'
$rel = Get-RunnerRelease (Get-Param 'VERSION')
Say "Latest package: version $($rel.Version)"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('labctl-runner-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$zip = Join-Path $tmp 'runner.zip'
$downloaded = $false
$keep = @('.runner', '.credentials', '.credentials_rsaparams', '.path', '.env')

foreach ($r in $runners) {
    $dir = $r.Dir
    $cur = Get-RunnerVersion $dir
    Step "Runner $($r.Name) in $dir (current version $cur)"
    if ($cur -eq $rel.Version) { Say "Already at $cur"; continue }
    Invoke-Gate
    if ($DryRun) { Say "[dry-run] would update $cur to $($rel.Version) and keep the old folder as $dir.labctl-prev"; continue }
    if (-not $r.Service) { Die 'This runner is not installed as a service, so it cannot be updated safely from here' }
    if (-not $downloaded) { Save-RunnerPackage $rel $zip; $downloaded = $true }
    $prev = "$dir.labctl-prev"
    if (Test-Path -LiteralPath $prev) { Remove-Item -LiteralPath $prev -Recurse -Force }

    Say 'Stopping the service'
    Stop-Service -Name $r.Service -Force
    $ok = $true
    try {
        Move-Item -LiteralPath $dir -Destination $prev -ErrorAction Stop
        New-Item -ItemType Directory -Path $dir | Out-Null
        Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
        foreach ($f in $keep) {
            if (Test-Path -LiteralPath "$prev\$f") { Copy-Item -LiteralPath "$prev\$f" -Destination "$dir\$f" -Force }
        }
        if (Test-Path -LiteralPath "$prev\_work") { Move-Item -LiteralPath "$prev\_work" -Destination "$dir\_work" }
    } catch {
        Warn "Replacing the files failed: $($_.Exception.Message)"
        $ok = $false
    }
    if (-not $ok) {
        if ((Test-Path -LiteralPath $prev) -and (Test-Path -LiteralPath $dir)) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
        if ((Test-Path -LiteralPath $prev) -and -not (Test-Path -LiteralPath $dir)) { Move-Item -LiteralPath $prev -Destination $dir }
        Start-Service -Name $r.Service
        Die 'Update failed before the new version started. The previous folder is back.'
    }

    Say 'Starting the service'
    Start-Service -Name $r.Service
    if (Wait-ServiceRunning $r.Service 60) {
        Say "Service running, version $(Get-RunnerVersion $dir)"
        Say "The previous version stays in $prev. Run runner_rollback_win to restore it, or with the discard action to delete it."
        Result 'runner_updated' $r.Name
    } else {
        Warn 'The service did not start. Rolling back.'
        Restore-RunnerPrevious $dir $r.Service
        Die 'Update failed and was rolled back'
    }
}
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
