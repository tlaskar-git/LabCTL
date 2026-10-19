have qm || die "This is not a Proxmox VE host"
step "Virtual machines (qm list)"
qm list
step "Containers (pct list)"
pct list
STOPPED_AUTOSTART=0
step "Guests set to start at boot but not running"
for id in $(qm list | awk 'NR > 1 && $3 != "running" { print $1 }'); do
  if qm config "$id" | grep -q '^onboot: 1'; then say "VM $id"; STOPPED_AUTOSTART=$(( STOPPED_AUTOSTART + 1 )); fi
done
for id in $(pct list | awk 'NR > 1 && $2 != "running" { print $1 }'); do
  if pct config "$id" | grep -q '^onboot: 1'; then say "CT $id"; STOPPED_AUTOSTART=$(( STOPPED_AUTOSTART + 1 )); fi
done
[ "$STOPPED_AUTOSTART" != 0 ] || say "none"
result guests_down_with_onboot "$STOPPED_AUTOSTART"
