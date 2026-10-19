have wg || die "WireGuard tools are not installed"
STALE="${LABCTL_P_STALE_S:-180}"; need_int STALE_S "$STALE"
NOW="$(date +%s)"
STALE_PEERS=0
step "Interfaces"
wg show interfaces
step "Peers (last handshake)"
# wg show never prints private keys. Peer keys are shortened here.
while IFS=$'\t' read -r IFACE PEER TS; do
  [ -n "$PEER" ] || continue
  if [ "$TS" = 0 ]; then say "$IFACE $(printf '%.8s' "$PEER")...: never"; STALE_PEERS=$(( STALE_PEERS + 1 )); continue; fi
  AGE=$(( NOW - TS ))
  say "$IFACE $(printf '%.8s' "$PEER")...: $AGE s ago"
  if [ "$AGE" -gt "$STALE" ]; then STALE_PEERS=$(( STALE_PEERS + 1 )); fi
done < <(wg show all latest-handshakes)
result wireguard_stale_peers "$STALE_PEERS"
if truthy "${LABCTL_P_FAIL_ON_STALE:-0}" && [ "$STALE_PEERS" -gt 0 ]; then exit 1; fi
