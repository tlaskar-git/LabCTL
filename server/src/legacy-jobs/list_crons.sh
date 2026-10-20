# List Crons: crontabs for every user, /etc/crontab and /etc/cron.*, systemd timers (Linux) or launchd jobs (macOS).
echo "=== Root crontab ==="
crontab -l 2>&1
echo
echo "=== /etc/crontab ==="
cat /etc/crontab 2>&1
echo
echo "=== /etc/cron.d/ ==="
ls -la /etc/cron.d/ 2>&1 && cat /etc/cron.d/* 2>&1
for d in /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do
  [ -d "$d" ] || continue
  echo
  echo "=== $d ==="
  ls -1 "$d" 2>&1
done
echo
echo "=== User crontabs ==="
if [ "$IS_MAC" = 1 ]; then users="$(dscl . list /Users 2>/dev/null | grep -v '^_')"; else users="$(cut -f1 -d: /etc/passwd)"; fi
for u in $users; do
  out="$(crontab -u "$u" -l 2>/dev/null)" && [ -n "$out" ] && printf '%s\n--- %s ---\n' "$out" "$u"
done
echo
if [ "$IS_MAC" = 1 ]; then
  echo "=== launchd jobs ==="
  ls -1 /Library/LaunchDaemons /Library/LaunchAgents 2>&1
  launchctl list 2>&1
else
  echo "=== Systemd timers ==="
  if have systemctl; then systemctl list-timers --all --no-pager 2>&1; else echo "systemctl is not available on this host"; fi
fi
exit 0
