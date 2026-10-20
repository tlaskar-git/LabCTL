have ss || die "ss is not installed"
ALLOWED="${LABCTL_P_ALLOWED_PORTS:-}"
need_match ALLOWED_PORTS '^[0-9,]*$' "$ALLOWED"
step "Listening sockets"
ss -H -tulpn | awk '{print $1, $5, $7}' | sort -u
step "Reachable from outside (not bound to loopback)"
OPEN="$(ss -H -tuln | awk '{print $5}' | grep -Ev '^(127\.|\[::1\]|::1)' | sed 's/.*://' | sort -un || true)"
say "Ports: $(printf '%s' "$OPEN" | tr '\n' ' ')"
UNEXPECTED=0
if [ -n "$ALLOWED" ]; then
  for p in $OPEN; do
    case ",$ALLOWED," in *",$p,"*) ;; *) warn "Port $p is open and not in the allowed list"; UNEXPECTED=$(( UNEXPECTED + 1 )) ;; esac
  done
fi
result unexpected_ports "$UNEXPECTED"
if truthy "${LABCTL_P_FAIL_ON_UNEXPECTED:-0}" && [ "$UNEXPECTED" -gt 0 ]; then exit 1; fi
