$ageMin = Get-Int 'MIN_AGE_MIN' 30
Step 'Waiting for an idle host'
Invoke-Gate
Step "Orphaned build processes (parent gone, started from a _work folder, older than $ageMin minutes)"
# shortcut: matches the _work path in the command line or image path only, not the working directory
$cut = (Get-Date).AddMinutes(-$ageMin)
$alive = @{}
foreach ($p in @(Get-Process)) { $alive[[int]$p.Id] = $true }
$found = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and $_.CreationDate -lt $cut -and -not $alive.ContainsKey([int]$_.ParentProcessId) -and
    (([string]$_.CommandLine).Contains('\_work\') -or ([string]$_.ExecutablePath).Contains('\_work\'))
})
if ($found.Count -eq 0) { Say 'None found'; Result 'orphans_killed' 0; exit 0 }
$count = 0
foreach ($p in $found) {
    $line = [string]$p.CommandLine
    if ($line.Length -gt 200) { $line = $line.Substring(0, 200) }
    Say "$($p.ProcessId) $($p.Name) $line"
    if ($DryRun) { Say "[dry-run] would stop $($p.ProcessId)"; continue }
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    $count++
}
Result 'orphans_killed' $count
