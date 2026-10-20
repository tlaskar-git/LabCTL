$required = @((Get-Param 'SERVICES') -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
foreach ($n in $required) { Test-Match 'SERVICES' '^[A-Za-z0-9_.$-]+$' $n }
$bad = 0

Step 'Automatic services that are not running'
$stopped = @(Get-CimInstance Win32_Service | Where-Object { $_.StartMode -eq 'Auto' -and $_.State -ne 'Running' -and -not $_.DelayedAutoStart })
if ($stopped.Count -eq 0) { Say 'none' }
else { Show ($stopped | Select-Object Name, State, ExitCode | Sort-Object Name | Format-Table -AutoSize) }
Say "Delayed-start services are not listed: they start a few minutes after boot."

if ($required.Count -gt 0) {
    Step 'Required services'
    foreach ($n in $required) {
        $s = Get-Service -Name $n -ErrorAction SilentlyContinue
        if (-not $s) { Warn "${n}: not found"; $bad++ }
        elseif ($s.Status -ne 'Running') { Warn "${n}: $($s.Status)"; $bad++ }
        else { Say "${n}: Running" }
    }
}
Result 'service_problems' $bad
if ($bad -gt 0 -and (Get-Flag 'FAIL_ON_STOPPED' $true)) { exit 1 }
