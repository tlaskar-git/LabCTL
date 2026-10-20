$action = Get-Param 'ACTION' 'restart'
Test-Match 'ACTION' '^(stop|start|restart)$' $action
$wait = Get-Int 'WAIT_S' 60
$runners = @(Get-RunnersOrDie)
if ($action -ne 'start') { Step 'Waiting for an idle host'; Invoke-Gate }
foreach ($r in $runners) {
    Step "Runner $($r.Name): $action"
    if (-not $r.Service) { Die "Runner $($r.Name) is not installed as a service" }
    if ($DryRun) { Say "[dry-run] $action service $($r.Service)"; continue }
    if ($action -ne 'start') { Stop-Service -Name $r.Service -Force }
    if ($action -ne 'stop') {
        Start-Service -Name $r.Service
        if (-not (Wait-ServiceRunning $r.Service $wait)) { Die "The service is not running after $wait s" }
    }
}
Result 'runner_action' $action
