$stale = Get-Int 'STALE_S' 180
$staleCount = 0
Step 'Tunnel services'
$tunnels = @(Get-Service -Name 'WireGuardTunnel$*' -ErrorAction SilentlyContinue)
if ($tunnels.Count -eq 0) { Warn 'No WireGuard tunnel service found'; $staleCount++ }
foreach ($t in $tunnels) { Say "$($t.Name): $($t.Status)"; if ($t.Status -ne 'Running') { $staleCount++ } }

$wg = Get-Command wg.exe -ErrorAction SilentlyContinue
if (-not $wg -and (Test-Path "$env:ProgramFiles\WireGuard\wg.exe")) { $wg = Get-Command "$env:ProgramFiles\WireGuard\wg.exe" }
if ($wg) {
    Step 'Peers (last handshake)'
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    # wg show never prints private keys. Peer keys are shortened here.
    foreach ($line in @(& $wg.Source show all latest-handshakes)) {
        $parts = ([string]$line) -split "`t"
        if ($parts.Count -lt 3) { continue }
        $ts = [int64]$parts[2]
        $short = $parts[1].Substring(0, 8)
        if ($ts -eq 0) { Say "$($parts[0]) $short...: never"; $staleCount++; continue }
        $age = $now - $ts
        Say "$($parts[0]) $short...: $age s ago"
        if ($age -gt $stale) { $staleCount++ }
    }
} else { Say 'wg.exe not found, handshake times skipped' }
Result 'wireguard_problems' $staleCount
if ($staleCount -gt 0 -and (Get-Flag 'FAIL_ON_STALE')) { exit 1 }
