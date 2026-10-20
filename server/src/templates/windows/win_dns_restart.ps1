if (-not (Get-Service -Name 'DNS' -ErrorAction SilentlyContinue)) { Die 'The DNS Server role is not installed' }
Step 'Restart the DNS Server service'
if ($DryRun) { Say '[dry-run] would restart the DNS service'; exit 0 }
Restart-Service -Name 'DNS' -Force
if (-not (Wait-ServiceRunning 'DNS' 60)) { Die 'DNS did not return to Running' }
Say 'DNS is running again'
Result 'dns_restarted' 'yes'
