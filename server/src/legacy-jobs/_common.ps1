# LabCTL typed job (v1 job types run as v2 scripts). Parameters arrive as LABCTL_P_<NAME> environment variables
# and secrets as LABCTL_SECRET_<NAME>. Neither is ever placed inside code that PowerShell parses.
$ErrorActionPreference = 'Continue'
function Say([string]$Text) { [Console]::Out.WriteLine($Text) }
function Die([string]$Text) { [Console]::Error.WriteLine("ERROR: $Text"); exit 1 }
function Show($Data) { $Data | Out-String -Stream -Width 400 | ForEach-Object { [Console]::Out.WriteLine($_) } }
function Get-Param([string]$Name, [string]$Default = '') {
    $v = [Environment]::GetEnvironmentVariable("LABCTL_P_$Name")
    if ([string]::IsNullOrEmpty($v)) { return $Default }
    return $v
}
function Get-Flag([string]$Name, [bool]$Default) {
    $v = Get-Param $Name ''
    if ($v -eq '') { return $Default }
    return ($v -in @('1', 'true', 'True', 'TRUE', 'yes', 'on'))
}
# Lists arrive one item per line (a comma list is accepted too).
function Get-List([string]$Name) { return @((Get-Param $Name) -split '[\r\n,]+' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
function Test-Opt([string]$Name) { $o = Get-List 'OPTIONS'; return ($o.Count -eq 0 -or $o -contains $Name) }
