# List Task Folders: every Task Scheduler folder path, one per line (as v1).
function Get-TaskFolders($Service, [string]$Path) {
    foreach ($f in $Service.GetFolder($Path).GetFolders(0)) { $f.Path; Get-TaskFolders $Service $f.Path }
}
try {
    $svc = New-Object -ComObject Schedule.Service
    $svc.Connect()
    Get-TaskFolders $svc '\' | ForEach-Object { Say $_ }
} catch { Die $_.Exception.Message }
exit 0
