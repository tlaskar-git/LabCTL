need_root
have qm || die "This is not a Proxmox VE host"
IDS="${LABCTL_P_VMIDS:-running}"
SNAP="${LABCTL_P_SNAPSHOT_NAME:-prepatch}"
need_match VMIDS '^(running|[0-9]+(,[0-9]+)*)$' "$IDS"
need_match SNAPSHOT_NAME '^[A-Za-z][A-Za-z0-9_-]{0,22}$' "$SNAP"
if truthy "${LABCTL_P_APPEND_DATE:-1}"; then SNAP="${SNAP}_$(date +%Y%m%d%H%M)"; fi
VMSTATE=0; if truthy "${LABCTL_P_INCLUDE_RAM:-0}"; then VMSTATE=1; fi

if [ "$IDS" = running ]; then
  VMS="$(qm list | awk 'NR > 1 && $3 == "running" { print $1 }')"
  CTS="$(pct list | awk 'NR > 1 && $2 == "running" { print $1 }')"
else
  VMS=""; CTS=""
  for id in $(printf '%s' "$IDS" | tr ',' ' '); do
    if qm status "$id" >/dev/null 2>&1; then VMS="$VMS $id"; elif pct status "$id" >/dev/null 2>&1; then CTS="$CTS $id"; else die "No guest with ID $id"; fi
  done
fi

step "Snapshot $SNAP"
FAILED=0
for id in $VMS; do
  if [ "$VMSTATE" = 1 ]; then run qm snapshot "$id" "$SNAP" --vmstate 1 --description "LabCTL pre-patch" || FAILED=$(( FAILED + 1 ))
  else run qm snapshot "$id" "$SNAP" --description "LabCTL pre-patch" || FAILED=$(( FAILED + 1 )); fi
done
for id in $CTS; do run pct snapshot "$id" "$SNAP" --description "LabCTL pre-patch" || FAILED=$(( FAILED + 1 )); done

step "Rollback (not run by LabCTL)"
say "VM:        qm rollback <vmid> $SNAP"
say "Container: pct rollback <ctid> $SNAP"
say "Delete the snapshot once the patch is proven: qm delsnapshot <vmid> $SNAP, pct delsnapshot <ctid> $SNAP"
result snapshot_name "$SNAP"
result snapshot_failures "$FAILED"
[ "$FAILED" = 0 ] || exit 1
