need_root
IFACE="${LABCTL_P_INTERFACE:-wg0}"
need_match INTERFACE '^[A-Za-z0-9_=+.-]{1,15}$' "$IFACE"
step "Restart wg-quick@$IFACE"
run systemctl restart "wg-quick@$IFACE"
if [ "$DRY_RUN" = 0 ]; then
  sleep 5
  systemctl is-active --quiet "wg-quick@$IFACE" || die "wg-quick@$IFACE is not active"
  wg show "$IFACE" | grep -E '^(interface|  listening port|peer)' | sed 's/^peer: \(........\).*/peer: \1.../' || true
fi
