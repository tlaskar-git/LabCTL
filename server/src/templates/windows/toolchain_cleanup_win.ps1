$days = Get-Int 'DAYS' 30
$profilePath = Get-Param 'PROFILE'
if (-not $profilePath) {
    $first = @(Get-Runners) | Select-Object -First 1
    $acct = ''
    if ($first -and $first.Account) { $acct = [string]$first.Account }
    if ($acct -match 'NetworkService') { $profilePath = "$env:SystemRoot\ServiceProfiles\NetworkService" }
    elseif ($acct -match 'LocalService') { $profilePath = "$env:SystemRoot\ServiceProfiles\LocalService" }
    elseif ($acct -ne '' -and $acct -notmatch 'LocalSystem') { $profilePath = "C:\Users\$(($acct -split '\\')[-1])" }
    else { $profilePath = "$env:SystemRoot\System32\config\systemprofile" }
}
if (-not (Test-Path -LiteralPath $profilePath)) { Die "Profile folder not found: $profilePath" }
Say "Cleaning caches in the profile of the runner account: $profilePath"
$local = Join-Path $profilePath 'AppData\Local'
$freeBefore = Get-FreeGB
Step 'Waiting for an idle host'
Invoke-Gate

$tools = @(
    @{ Flag = 'NPM';    Label = 'npm cache';        Paths = @("$local\npm-cache") },
    @{ Flag = 'PNPM';   Label = 'pnpm store';       Paths = @("$local\pnpm\store", "$local\pnpm-cache") },
    @{ Flag = 'PIP';    Label = 'pip cache';        Paths = @("$local\pip\Cache") },
    @{ Flag = 'GRADLE'; Label = 'Gradle build cache'; Paths = @("$profilePath\.gradle\caches\build-cache-1") },
    @{ Flag = 'MAVEN';  Label = 'Maven repository (downloaded again on demand)'; Paths = @("$profilePath\.m2\repository") },
    @{ Flag = 'NUGET';  Label = 'NuGet caches';     Paths = @("$local\NuGet\v3-cache", "$local\NuGet\plugins-cache", "$profilePath\.nuget\packages") },
    @{ Flag = 'CARGO';  Label = 'Cargo registry';   Paths = @("$profilePath\.cargo\registry\cache", "$profilePath\.cargo\registry\src") },
    @{ Flag = 'GO';     Label = 'Go build cache';   Paths = @("$local\go-build") }
)
$selected = $false
foreach ($t in $tools) {
    if (-not (Get-Flag $t.Flag)) { continue }
    $selected = $true
    Step "$($t.Label): files older than $days days"
    foreach ($p in $t.Paths) { Remove-FilesOlder $p $days }
}
if (-not $selected) { Say 'No tool selected, nothing to do'; exit 0 }
Say "Space freed: $([math]::Round((Get-FreeGB) - $freeBefore, 1)) GB"
