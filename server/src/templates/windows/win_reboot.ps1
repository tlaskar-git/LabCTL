$delay = Get-Int 'DELAY_MIN' 1
if ($delay -lt 1) { Die 'DELAY_MIN must be at least 1' }
Step 'Runner check'
Invoke-Gate
Step "Reboot in $delay minute(s)"
if ($DryRun) { Say "[dry-run] shutdown /r /t $($delay * 60)" }
else { shutdown.exe /r /t ($delay * 60) /c 'LabCTL scheduled reboot'; if ($LASTEXITCODE -ne 0) { Die 'shutdown.exe failed' } }
Result 'rebooting' 'yes'
