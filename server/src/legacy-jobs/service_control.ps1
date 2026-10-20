# Service Control: start, stop, restart or status of one or more Windows services.
$action = Get-Param 'ACTION' 'status'
if ($action -notin @('start', 'stop', 'restart', 'status')) { Die 'Action must be start, stop, restart or status.' }
$names = Get-List 'SERVICES'
if ($names.Count -eq 0) { $names = Get-List 'SERVICE' }
if ($names.Count -eq 0) { Die 'No service specified.' }
$rc = 0
foreach ($n in $names) {
    Say "=== $n ==="
    if ($n -match '[*?\[\]]') { [Console]::Error.WriteLine("ERROR: invalid service name: $n"); $rc = 1; continue }
    try {
        switch ($action) {
            'start' { Start-Service -Name $n -ErrorAction Stop }
            'stop' { Stop-Service -Name $n -ErrorAction Stop }
            'restart' { Restart-Service -Name $n -ErrorAction Stop }
        }
        Show (Get-Service -Name $n -ErrorAction Stop | Format-List Name, DisplayName, Status, StartType, ServiceType)
    } catch {
        [Console]::Error.WriteLine("ERROR: $($_.Exception.Message)")
        $rc = 1
    }
}
exit $rc
