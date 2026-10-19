$token = Get-Secret 'REG_TOKEN'
if (-not $token) { Die 'A registration token is required' }
$url = Get-Param 'URL'
$name = Get-Param 'NAME'
$labels = Get-Param 'LABELS'
$group = Get-Param 'RUNNER_GROUP'
$account = Get-Param 'SERVICE_ACCOUNT' 'NT AUTHORITY\NETWORK SERVICE'
Test-Match 'URL' '^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)?$' $url
Test-Match 'NAME' '^[A-Za-z0-9_.-]{1,64}$' $name
Test-Match 'LABELS' '^[A-Za-z0-9_.:,-]*$' $labels
Test-Match 'RUNNER_GROUP' '^[A-Za-z0-9 _.-]*$' $group
Test-Match 'SERVICE_ACCOUNT' '^[A-Za-z0-9 _.\\$-]+$' $account
$dir = Get-Param 'INSTALL_DIR' "C:\actions-runner-$name"
Test-Match 'INSTALL_DIR' '^[A-Za-z]:\\[A-Za-z0-9_. \\-]+$' $dir
if (Test-Path -LiteralPath "$dir\.runner") { Die "A runner is already configured in $dir" }

Step 'Latest runner package'
$rel = Get-RunnerRelease (Get-Param 'VERSION')
Say "Latest package: version $($rel.Version)"
Step 'Plan'
Say "Add runner $name for $url in $dir as a service running as $account"
if ($DryRun) { Say '[dry-run] nothing downloaded or installed'; exit 0 }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('labctl-runner-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
Step 'Download and unpack'
Save-RunnerPackage $rel (Join-Path $tmp 'runner.zip')
New-Item -ItemType Directory -Path $dir -Force | Out-Null
Expand-Archive -LiteralPath (Join-Path $tmp 'runner.zip') -DestinationPath $dir -Force
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue

Step 'Register and install the service'
$cfg = @('--unattended', '--replace', '--url', $url, '--name', $name, '--work', '_work', '--runasservice', '--windowslogonaccount', $account)
if ($labels) { $cfg += @('--labels', $labels) }
if ($group) { $cfg += @('--runnergroup', $group) }
if (Get-Flag 'EPHEMERAL') { $cfg += '--ephemeral' }
if (Get-Flag 'DISABLE_UPDATE') { $cfg += '--disableupdate' }
$env:ACTIONS_RUNNER_INPUT_TOKEN = $token
$logonPassword = Get-Secret 'SERVICE_PASSWORD'
if ($logonPassword) { $env:ACTIONS_RUNNER_INPUT_WINDOWSLOGONPASSWORD = $logonPassword }
try { & "$dir\config.cmd" @cfg | ForEach-Object { Say $_ } }
finally {
    Remove-Item Env:\ACTIONS_RUNNER_INPUT_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:\ACTIONS_RUNNER_INPUT_WINDOWSLOGONPASSWORD -ErrorAction SilentlyContinue
}
if ($LASTEXITCODE -ne 0) { Die 'Registration failed' }
$svc = @(Get-Runners | Where-Object { $_.Dir -eq $dir.TrimEnd('\') }) | Select-Object -First 1
if (-not $svc -or -not $svc.Service) { Die 'The service was not installed' }
if (-not (Wait-ServiceRunning $svc.Service 60)) { Start-Service -Name $svc.Service; if (-not (Wait-ServiceRunning $svc.Service 60)) { Die 'The service is not running' } }
Result 'runner_added' $name
