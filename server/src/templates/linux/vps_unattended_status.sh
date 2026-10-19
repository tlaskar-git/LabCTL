step "Service"
say "enabled: $(systemctl is-enabled unattended-upgrades 2>&1 || true)"
say "active: $(systemctl is-active unattended-upgrades 2>&1 || true)"
step "Periodic settings"
apt-config dump 2>/dev/null | grep -E 'APT::Periodic::(Update-Package-Lists|Unattended-Upgrade|AutocleanInterval)' || say "No periodic settings found"
step "Timers"
systemctl list-timers 'apt-daily*' --no-pager 2>/dev/null || true
step "Last run"
LOG=/var/log/unattended-upgrades/unattended-upgrades.log
if [ -r "$LOG" ]; then tail -n 15 "$LOG"; else say "No log at $LOG"; fi
