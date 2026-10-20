$action = Get-Param 'ACTION' 'rollback'
Test-Match 'ACTION' '^(rollback|discard)$' $action
$found = $false
foreach ($r in @(Get-RunnersOrDie)) {
    $dir = $r.Dir
    if (-not (Test-Path -LiteralPath "$dir.labctl-prev")) { continue }
    $found = $true
    Step "Runner in ${dir}: $action"
    if ($action -eq 'discard') {
        if ($DryRun) { Say "[dry-run] would delete $dir.labctl-prev" }
        else {
            Remove-Item -LiteralPath "$dir.labctl-prev" -Recurse -Force
            if (Test-Path -LiteralPath "$dir.labctl-failed") { Remove-Item -LiteralPath "$dir.labctl-failed" -Recurse -Force }
        }
    } else {
        Invoke-Gate
        if ($DryRun) { Say "[dry-run] would restore $dir.labctl-prev" } else { Restore-RunnerPrevious $dir $r.Service }
    }
}
if (-not $found) { Die 'No previous runner folder (.labctl-prev) found' }
