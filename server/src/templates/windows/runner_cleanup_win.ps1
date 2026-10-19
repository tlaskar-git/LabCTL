$workDays = Get-Int 'WORK_DAYS' 7
$diagDays = Get-Int 'DIAG_DAYS' 14
$toolDays = Get-Int 'TOOL_DAYS' 30
$prevDays = Get-Int 'PREV_DAYS' 7
$runners = @(Get-RunnersOrDie)
Step 'Waiting for an idle host'
Invoke-Gate
$freeBefore = Get-FreeGB

foreach ($r in $runners) {
    $dir = $r.Dir
    Step "Runner $($r.Name) in $dir"
    Say "Workspaces older than $workDays days"
    Remove-Older (Join-Path $dir '_work') $workDays -DirsOnly -SkipName '_*'
    Say "Diagnostic logs older than $diagDays days"
    Remove-Older (Join-Path $dir '_diag') $diagDays -FilesOnly
    Say 'Temporary files'
    Clear-Dir (Join-Path $dir '_work\_temp')
    Say "Tool cache entries older than $toolDays days"
    foreach ($tool in @(Get-ChildItem -LiteralPath (Join-Path $dir '_work\_tool') -Directory -ErrorAction SilentlyContinue)) {
        Remove-Older $tool.FullName $toolDays -DirsOnly
    }
    Say "Old update folders older than $prevDays days"
    $parent = Split-Path -Parent $dir
    $leaf = Split-Path -Leaf $dir
    foreach ($old in @(Get-ChildItem -LiteralPath $parent -Directory -Filter "$leaf.labctl-*" -ErrorAction SilentlyContinue)) {
        if ($old.LastWriteTime -lt (Get-Date).AddDays(-$prevDays)) {
            if ($DryRun) { Say "[dry-run] remove $($old.FullName)" } else { Remove-Item -LiteralPath $old.FullName -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }
}
if (Get-Flag 'CLEAN_TEMP' $true) {
    Step 'Windows temp files older than 2 days'
    Remove-Older "$env:SystemRoot\Temp" 2
    Remove-Older $env:TEMP 2
}
Say "Space freed: $([math]::Round((Get-FreeGB) - $freeBefore, 1)) GB (free now $(Get-FreeGB) GB)"
