step "Reboot flag"
if [ -f /var/run/reboot-required ]; then
  say "The OS asks for a reboot"; cat /var/run/reboot-required.pkgs 2>/dev/null || true; FLAG=yes
else
  say "No reboot flag"; FLAG=no
fi
step "Kernel"
RUNNING="$(uname -r)"
say "Running: $RUNNING"
NEWEST="$(ls /boot/vmlinuz-* 2>/dev/null | sed 's#/boot/vmlinuz-##' | sort -V | tail -n 1 || true)"
if [ -n "$NEWEST" ]; then
  say "Newest installed: $NEWEST"
  if [ "$NEWEST" != "$RUNNING" ]; then FLAG=yes; say "A newer kernel is installed but not running"; fi
fi
step "Uptime"
uptime
result reboot_required "$FLAG"
