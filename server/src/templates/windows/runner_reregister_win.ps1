$token = Get-Secret 'REG_TOKEN'
if (-not $token) { Die 'A registration token is required' }
$runners = @(Get-RunnersOrDie)
if ($runners.Count -ne 1) { Die 'More than one runner found. Set the runner directory parameter' }
$r = $runners[0]
$dir = $r.Dir
$name = Get-Param 'NAME' $r.Name
$url = Get-Param 'URL' $r.Url
$labels = Get-Param 'LABELS'
$group = Get-Param 'RUNNER_GROUP'
Test-Match 'NAME' '^[A-Za-z0-9_.-]{1,64}$' $name
Test-Match 'URL' '^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)?$' $url
Test-Match 'LABELS' '^[A-Za-z0-9_.:,-]*$' $labels
Test-Match 'RUNNER_GROUP' '^[A-Za-z0-9 _.-]*$' $group
if (-not $labels) { Say 'No labels given: the runner gets its default labels. Pass the current labels to keep custom ones.' }

Step "Re-registering $name at $url"
Invoke-Gate
if ($DryRun) { Say '[dry-run] would stop the service, replace the registration with --replace, start the service'; exit 0 }
if (-not $r.Service) { Die 'This runner is not installed as a service' }
Stop-Service -Name $r.Service -Force
# Ephemeral replacement: a clean machine for the next job (_temp lives inside _work).
if (Get-Flag 'CLEAN_WORK') { Step 'Clearing _work and _temp'; Clear-Dir (Join-Path $dir '_work') }
$bak = Join-Path $dir '.labctl-reg-bak'
if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Recurse -Force }
New-Item -ItemType Directory -Path $bak | Out-Null
$files = @('.runner', '.credentials', '.credentials_rsaparams')
foreach ($f in $files) { if (Test-Path -LiteralPath "$dir\$f") { Move-Item -LiteralPath "$dir\$f" -Destination "$bak\$f" } }

$cfg = @('--unattended', '--replace', '--url', $url, '--name', $name, '--work', '_work')
if ($labels) { $cfg += @('--labels', $labels) }
if ($group) { $cfg += @('--runnergroup', $group) }
if (Get-Flag 'EPHEMERAL') { $cfg += '--ephemeral' }
if (Get-Flag 'DISABLE_UPDATE') { $cfg += '--disableupdate' }
$env:ACTIONS_RUNNER_INPUT_TOKEN = $token
try { & "$dir\config.cmd" @cfg | ForEach-Object { Say $_ } } finally { Remove-Item Env:\ACTIONS_RUNNER_INPUT_TOKEN -ErrorAction SilentlyContinue }
if ($LASTEXITCODE -ne 0) {
    Warn 'Registration failed. Restoring the old registration.'
    foreach ($f in $files) { if (Test-Path -LiteralPath "$bak\$f") { Move-Item -LiteralPath "$bak\$f" -Destination "$dir\$f" -Force } }
    Start-Service -Name $r.Service
    Die 'Registration failed'
}
Remove-Item -LiteralPath $bak -Recurse -Force
Start-Service -Name $r.Service
if (-not (Wait-ServiceRunning $r.Service 60)) { Die 'The service is not running after registration' }
Result 'runner_reregistered' $name
