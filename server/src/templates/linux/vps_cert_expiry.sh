have openssl || die "openssl is not installed"
DOMAINS="${LABCTL_P_DOMAINS:-}"
WARN_DAYS="${LABCTL_P_WARN_DAYS:-21}"; need_int WARN_DAYS "$WARN_DAYS"
[ -n "$DOMAINS" ] || die "DOMAINS is required (comma separated, host or host:port)"
BAD=0
for d in $(printf '%s' "$DOMAINS" | tr ',' ' '); do
  need_match DOMAINS '^[A-Za-z0-9.-]+(:[0-9]{1,5})?$' "$d"
  HOST="${d%%:*}"; PORT=443
  case "$d" in *:*) PORT="${d##*:}" ;; esac
  CERT="$(printf '' | timeout 15 openssl s_client -connect "$HOST:$PORT" -servername "$HOST" 2>/dev/null | openssl x509 2>/dev/null || true)"
  if [ -z "$CERT" ]; then warn "$d: no certificate returned"; BAD=$(( BAD + 1 )); continue; fi
  END="$(printf '%s\n' "$CERT" | openssl x509 -noout -enddate | cut -d= -f2)"
  if printf '%s\n' "$CERT" | openssl x509 -noout -checkend $(( WARN_DAYS * 86400 )) >/dev/null; then
    say "$d: valid until $END"
  else
    warn "$d: expires within $WARN_DAYS days or is expired ($END)"; BAD=$(( BAD + 1 ))
  fi
done
result certificates_at_risk "$BAD"
if truthy "${LABCTL_P_FAIL_ON_EXPIRY:-1}" && [ "$BAD" -gt 0 ]; then exit 1; fi
