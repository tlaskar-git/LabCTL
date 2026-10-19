$runners = @(Get-RunnersOrDie)
foreach ($r in $runners) {
    Step "Runner $($r.Name)"
    Say "Folder: $($r.Dir)"
    if (-not $r.Service) { Warn 'Not installed as a service'; continue }
    $svc = Get-CimInstance Win32_Service -Filter "Name = '$($r.Service)'"
    Say "Service: $($svc.Name), state $($svc.State), start mode $($svc.StartMode)"
    Say "Service account: $($svc.StartName)"
    if ($svc.StartName -match 'LocalSystem') { Warn 'The runner runs as LocalSystem: every workflow has full control of this machine' }
    if ($svc.StartMode -ne 'Auto') { Warn 'The service does not start automatically' }
}
Step 'Signed-in sessions'
try { Show (quser) } catch { Say 'No signed-in sessions' }
Step 'Disk'
Say "Free space on C: $(Get-FreeGB) GB"
Say "Windows temp: $(Get-DirSizeMB "$env:SystemRoot\Temp") MB"
Step '.NET SDKs'
if (Get-Command dotnet -ErrorAction SilentlyContinue) { Show (dotnet --list-sdks) } else { Say 'dotnet is not installed' }
Step 'NuGet cache size'
foreach ($p in @("$env:SystemRoot\System32\config\systemprofile\.nuget\packages", "$env:SystemRoot\ServiceProfiles\NetworkService\.nuget\packages")) {
    if (Test-Path -LiteralPath $p) { Say "$p : $(Get-DirSizeMB $p) MB" }
}
