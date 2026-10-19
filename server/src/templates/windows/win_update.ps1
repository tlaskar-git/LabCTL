$install = Get-Flag 'INSTALL' $true
$criteria = "IsInstalled=0 and IsHidden=0 and Type='Software'"
if (Get-Flag 'INCLUDE_DRIVERS') { $criteria = 'IsInstalled=0 and IsHidden=0' }

Step 'Search'
$session = New-Object -ComObject Microsoft.Update.Session
$found = $session.CreateUpdateSearcher().Search($criteria)
Say "$($found.Updates.Count) update(s) available"
$wanted = New-Object -ComObject Microsoft.Update.UpdateColl
foreach ($u in $found.Updates) {
    $needsInput = $u.InstallationBehavior.CanRequestUserInput
    Say ("- {0} ({1} MB){2}" -f $u.Title, [math]::Round($u.MaxDownloadSize / 1MB, 0), $(if ($needsInput) { ' [needs user input, skipped]' } else { '' }))
    if (-not $needsInput) {
        if (-not $u.EulaAccepted) { $u.AcceptEula() }
        [void]$wanted.Add($u)
    }
}
Result 'updates_available' $(if ($wanted.Count -gt 0) { 'yes' } else { 'no' })

if ($wanted.Count -gt 0 -and $install) {
    Step 'Waiting for an idle host'
    Invoke-Gate
    if ($DryRun) { Say "[dry-run] would download and install $($wanted.Count) update(s)" }
    else {
        Step 'Download'
        $dl = $session.CreateUpdateDownloader()
        $dl.Updates = $wanted
        [void]$dl.Download()
        Step 'Install'
        $installer = $session.CreateUpdateInstaller()
        $installer.Updates = $wanted
        $res = $installer.Install()
        Say "Result code $($res.ResultCode) (2 succeeded, 3 succeeded with errors, 4 failed, 5 aborted)"
        if ($res.ResultCode -notin 2, 3) { Die 'Windows Update did not install the updates' }
    }
}
$reboot = (New-Object -ComObject Microsoft.Update.SystemInfo).RebootRequired
Say "Reboot required: $reboot"
Result 'reboot_required' $(if ($reboot) { 'yes' } else { 'no' })
