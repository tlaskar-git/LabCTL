# Windows Update, as v1: installs every available update through PSWindowsUpdate, then reboots in 30 s when REBOOT is
# on (the v1 default) and Windows reports that a reboot is required.
Say 'Checking for Windows updates (PSWindowsUpdate). This can take a long time.'
if (-not (Get-Module -ListAvailable -Name PSWindowsUpdate)) {
    Say 'Installing the PSWindowsUpdate module'
    Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Confirm:$false | Out-Null
    Install-Module -Name PSWindowsUpdate -Force -Confirm:$false
}
try { Import-Module PSWindowsUpdate -ErrorAction Stop } catch { Die "PSWindowsUpdate could not be loaded: $($_.Exception.Message)" }
Show (Get-WindowsUpdate -AcceptAll -Install -IgnoreReboot -Verbose 4>&1 2>&1)
$rebootRequired = [bool](Get-WURebootStatus -Silent)
Say "REBOOT_REQUIRED=$rebootRequired"
if ((Get-Flag 'REBOOT' $true) -and $rebootRequired) {
    & shutdown.exe /r /t 30 /c 'LabCTL: Rebooting after Windows Update'
    Say 'Reboot initiated (30 second delay).'
}
exit 0
