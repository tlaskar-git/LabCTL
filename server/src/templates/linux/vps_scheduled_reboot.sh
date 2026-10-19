need_root
if truthy "${LABCTL_P_CANCEL:-0}"; then
  step "Cancel the scheduled reboot"
  run shutdown -c
  exit 0
fi
DELAY="${LABCTL_P_DELAY_MIN:-1}"; need_int DELAY_MIN "$DELAY"
[ "$DELAY" -ge 1 ] || die "DELAY_MIN must be at least 1 so this job can finish and report first"
step "Runner check"
gate
step "Reboot in $DELAY minute(s)"
run shutdown -r "+$DELAY" "LabCTL scheduled reboot"
say "After the host returns, run vps_post_reboot_check to confirm WireGuard and the key services."
result rebooting yes
