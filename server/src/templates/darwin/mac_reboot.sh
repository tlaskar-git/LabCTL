[ "$OS_NAME" = Darwin ] || die "This template is for macOS"
need_root
DELAY="${LABCTL_P_DELAY_MIN:-1}"; need_int DELAY_MIN "$DELAY"
[ "$DELAY" -ge 1 ] || die "DELAY_MIN must be at least 1"
step "Runner check"
gate
step "Reboot in $DELAY minute(s)"
run shutdown -r "+$DELAY"
result rebooting yes
