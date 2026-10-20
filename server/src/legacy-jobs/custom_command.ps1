# Custom Command: the operator's own command. SHELL=cmd (default, as v1) lets cmd.exe expand the variable itself,
# SHELL=powershell builds a script block from it. The command text never enters this script's text.
$cmd = Get-Param 'COMMAND'
if (-not $cmd) { Die 'No command specified.' }
if ((Get-Param 'SHELL' 'cmd') -eq 'powershell') {
    $global:LASTEXITCODE = 0
    & ([scriptblock]::Create($cmd))
    if (-not $?) { exit 1 }
    exit [int]$LASTEXITCODE
}
& cmd.exe /d /c '%LABCTL_P_COMMAND%'
exit [int]$LASTEXITCODE
