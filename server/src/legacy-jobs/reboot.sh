# Reboot: schedules a restart after DELAY seconds (rounded to whole minutes, at least one).
delay="${LABCTL_P_DELAY:-30}"
is_int "$delay" || die "Delay must be a whole number of seconds."
min=$((delay / 60))
[ "$min" -ge 1 ] || min=1
shutdown -r "+$min" "LabCTL: Scheduled reboot" 2>&1 || die "shutdown failed."
echo "Reboot scheduled in $delay seconds."
