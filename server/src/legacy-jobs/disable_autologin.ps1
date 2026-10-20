# Disable Auto-Login: turns AutoAdminLogon off and removes the stored password.
$reg = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
try { Set-ItemProperty -Path $reg -Name 'AutoAdminLogon' -Value '0' -ErrorAction Stop } catch { Die $_.Exception.Message }
Remove-ItemProperty -Path $reg -Name 'DefaultPassword' -ErrorAction SilentlyContinue
Say 'AutoLogin disabled'
exit 0
