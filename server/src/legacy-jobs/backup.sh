# Run Backup: runs the backup script with bash, then optionally schedules a reboot when it succeeded.
script="${LABCTL_P_SCRIPT:-/root/proxmox-vm-backup.sh}"
[ -f "$script" ] || die "Backup script not found: $script"
echo "Backup script: $script"
bash -- "$script"
rc=$?
echo "Exit code: $rc"
if [ "$rc" = 0 ] && truthy "${LABCTL_P_REBOOT_AFTER:-0}"; then
  shutdown -r +2 "LabCTL: Rebooting after backup" 2>&1 && echo "Reboot scheduled in 2 minutes."
fi
exit "$rc"
