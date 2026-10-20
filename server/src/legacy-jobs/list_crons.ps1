# List Scheduled Tasks: every task that is not disabled. The table is for reading, the LABCTL_RESULT_JSON line is
# what the host Crons tab parses (TaskName, TaskPath, State, NextRun, as v1 returned).
$tasks = @(Get-ScheduledTask | Where-Object { $_.State -ne 'Disabled' } | ForEach-Object {
    $info = $_ | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
    $next = $null
    if ($info -and $info.NextRunTime) { $next = $info.NextRunTime.ToString('o') }
    [pscustomobject]@{ TaskName = $_.TaskName; TaskPath = $_.TaskPath; State = [string]$_.State; NextRun = $next }
})
Show ($tasks | Format-Table TaskPath, TaskName, State, NextRun -AutoSize)
Say "$($tasks.Count) scheduled task(s)"
Say ('LABCTL_RESULT_JSON ' + (ConvertTo-Json -InputObject $tasks -Depth 3 -Compress))
exit 0
