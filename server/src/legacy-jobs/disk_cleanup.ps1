# Disk Cleanup, as v1: OPTIONS picks from temp, windows_update_cache, recycle_bin, event_logs (empty runs all four),
# then shows free space per drive.
foreach ($o in (Get-List 'OPTIONS')) {
    if ($o -notin @('temp', 'windows_update_cache', 'recycle_bin', 'event_logs')) { Say "Option $o is not available for this host, skipped." }
}
if (Test-Opt 'temp') {
    Remove-Item -Path "$env:TEMP\*" -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path 'C:\Windows\Temp\*' -Recurse -Force -ErrorAction SilentlyContinue
    Say 'Temp files cleared'
}
if (Test-Opt 'windows_update_cache') {
    Stop-Service -Name wuauserv -Force -ErrorAction SilentlyContinue
    Remove-Item -Path 'C:\Windows\SoftwareDistribution\Download\*' -Recurse -Force -ErrorAction SilentlyContinue
    Start-Service -Name wuauserv -ErrorAction SilentlyContinue
    Say 'Windows Update cache cleared'
}
if (Test-Opt 'recycle_bin') {
    Clear-RecycleBin -Force -ErrorAction SilentlyContinue
    Say 'Recycle bin emptied'
}
if (Test-Opt 'event_logs') {
    Get-EventLog -LogName * -ErrorAction SilentlyContinue | ForEach-Object { Clear-EventLog -LogName $_.Log -ErrorAction SilentlyContinue }
    Say 'Event logs cleared'
}
Say ''
Say 'Disk space:'
Show (Get-PSDrive -PSProvider FileSystem | Where-Object { $null -ne $_.Used } |
    Format-Table Name, @{ N = 'Free(GB)'; E = { [math]::Round($_.Free / 1GB, 1) } }, @{ N = 'Used(GB)'; E = { [math]::Round($_.Used / 1GB, 1) } } -AutoSize)
exit 0
