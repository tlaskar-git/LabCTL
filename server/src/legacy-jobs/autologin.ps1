# Set Auto-Login: writes the Winlogon values. The password arrives only as LABCTL_SECRET_PASSWORD and is never printed.
$user = Get-Param 'USERNAME'
$password = [Environment]::GetEnvironmentVariable('LABCTL_SECRET_PASSWORD')
if (-not $user -or -not $password) { Die 'Username and password required.' }
$reg = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
try {
    Set-ItemProperty -Path $reg -Name 'AutoAdminLogon' -Value '1' -ErrorAction Stop
    Set-ItemProperty -Path $reg -Name 'DefaultUserName' -Value $user -ErrorAction Stop
    Set-ItemProperty -Path $reg -Name 'DefaultPassword' -Value $password -ErrorAction Stop
    Set-ItemProperty -Path $reg -Name 'DefaultDomainName' -Value (Get-Param 'DOMAIN') -ErrorAction Stop
} catch { Die $_.Exception.Message }
Say "AutoLogin configured for $user"
exit 0
