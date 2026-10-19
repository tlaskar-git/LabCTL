WAIT_S="${LABCTL_P_WAIT_S:-120}"; need_int WAIT_S "$WAIT_S"
SERVICES="${LABCTL_P_SERVICES:-}"
IFACE="${LABCTL_P_WG_INTERFACE:-}"
need_match SERVICES '^[A-Za-z0-9_.@:,-]*$' "$SERVICES"
need_match WG_INTERFACE '^[A-Za-z0-9_=+.-]{0,15}$' "$IFACE"
FAILS=0
step "Uptime"
uptime -p 2>/dev/null || uptime

step "Services"
for s in $(printf '%s' "$SERVICES" | tr ',' ' '); do
  N=0
  while ! systemctl is-active --quiet "$s" && [ "$N" -lt "$WAIT_S" ]; do sleep 5; N=$(( N + 5 )); done
  if systemctl is-active --quiet "$s"; then say "$s: active"; else warn "$s: not active"; FAILS=$(( FAILS + 1 )); fi
done

if [ -n "$IFACE" ]; then
  step "WireGuard $IFACE"
  N=0
  while [ "$N" -lt "$WAIT_S" ]; do
    if wg show "$IFACE" latest-handshakes 2>/dev/null | awk '$2 > 0 { f = 1 } END { exit !f }'; then break; fi
    sleep 5; N=$(( N + 5 ))
  done
  if wg show "$IFACE" latest-handshakes 2>/dev/null | awk '$2 > 0 { f = 1 } END { exit !f }'; then say "At least one peer completed a handshake"
  else warn "No peer handshake on $IFACE within $WAIT_S s"; FAILS=$(( FAILS + 1 )); fi
fi
result post_reboot_failures "$FAILS"
[ "$FAILS" = 0 ] || exit 1
