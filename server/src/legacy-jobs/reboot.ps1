# Reboot: schedules a restart after DELAY seconds.
$delay = 0
if (-not [int]::TryParse((Get-Param 'DELAY' '30'), [ref]$delay) -or $delay -lt 0) { Die 'Delay must be a whole number of seconds.' }
& shutdown.exe /r /t $delay /c 'LabCTL: Scheduled reboot'
if ($LASTEXITCODE -ne 0) { Die "shutdown failed with exit code $LASTEXITCODE." }
Say "Reboot scheduled in $delay seconds."
