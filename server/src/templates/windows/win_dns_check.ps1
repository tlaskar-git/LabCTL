$names = @((Get-Param 'NAMES') -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
foreach ($n in $names) { Test-Match 'NAMES' '^[A-Za-z0-9._-]+$' $n }
$bad = 0

Step 'DNS service'
$svc = Get-Service -Name 'DNS' -ErrorAction SilentlyContinue
if (-not $svc) { Die 'The DNS Server role is not installed' }
Say "DNS: $($svc.Status)"
if ($svc.Status -ne 'Running') { $bad++ }

if (Get-Command Get-DnsServerZone -ErrorAction SilentlyContinue) {
    Step 'Zones'
    Show (Get-DnsServerZone | Select-Object ZoneName, ZoneType, IsDsIntegrated | Format-Table -AutoSize)
}
if ($names.Count -gt 0) {
    Step 'Test lookups against this server'
    foreach ($n in $names) {
        try { $a = Resolve-DnsName -Name $n -Server 127.0.0.1 -DnsOnly -ErrorAction Stop; Say "${n}: $((@($a | ForEach-Object { $_.IPAddress }) -join ', '))" }
        catch { Warn "${n}: lookup failed"; $bad++ }
    }
}
Result 'dns_problems' $bad
if ($bad -gt 0) { exit 1 }
