$dir = (Get-Param 'RUNNER_DIR').TrimEnd('\')
if (-not $dir) { Die 'RUNNER_DIR is required: this template never guesses which runner to delete' }
if (-not ((Test-Path -LiteralPath "$dir\.runner") -and (Test-Path -LiteralPath "$dir\config.cmd"))) { Die "$dir is not a runner folder" }
if ($dir -match '^[A-Za-z]:\\?$' -or $dir -match '^[A-Za-z]:\\(Windows|Users|Program Files|Program Files \(x86\)|ProgramData)$') { Die "Refusing to delete $dir" }
$token = Get-Secret 'REMOVE_TOKEN'
if (-not $token) { Die 'A removal token is required' }
$r = @(Get-Runners) | Select-Object -First 1

Step "Removing runner $($r.Name) in $dir"
Invoke-Gate
if ($DryRun) { Say "[dry-run] would stop the service, unregister from GitHub, delete $dir"; exit 0 }
if ($r.Service) { Stop-Service -Name $r.Service -Force -ErrorAction SilentlyContinue }
$env:ACTIONS_RUNNER_INPUT_TOKEN = $token
try { & "$dir\config.cmd" remove --unattended | ForEach-Object { Say $_ } } finally { Remove-Item Env:\ACTIONS_RUNNER_INPUT_TOKEN -ErrorAction SilentlyContinue }
if ($LASTEXITCODE -ne 0) { Die 'GitHub did not accept the removal. The folder is kept.' }
foreach ($p in @($dir, "$dir.labctl-prev", "$dir.labctl-failed")) {
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
}
Say 'Runner folder deleted'
Result 'runner_removed' 'yes'
