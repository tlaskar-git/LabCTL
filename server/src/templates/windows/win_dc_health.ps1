if (-not (Get-Service -Name 'NTDS' -ErrorAction SilentlyContinue)) { Die 'This host is not a domain controller' }
$problems = 0

Step 'Domain controller services'
foreach ($n in @('NTDS', 'DNS', 'Netlogon', 'Kdc', 'DFSR')) {
    $s = Get-Service -Name $n -ErrorAction SilentlyContinue
    if ($s) { Say "${n}: $($s.Status)"; if ($s.Status -ne 'Running') { $problems++ } }
}

Step 'dcdiag (failures only)'
$diag = @(dcdiag /q)
if ($diag.Count -eq 0) { Say 'No failures reported' } else { Show $diag; $problems++ }

Step 'repadmin /replsummary'
$summary = @(repadmin /replsummary)
Show $summary
$fails = 0
foreach ($l in $summary) { if ([string]$l -match '\s(\d+)\s*/\s*(\d+)\s') { $fails += [int]$Matches[1] } }
Say "Replication failures: $fails"
if ($fails -gt 0) { $problems++ }

Result 'dc_problems' $problems
if ($problems -gt 0) { exit 1 }
