# Service Control: start, stop, restart or status of one or more services (systemd, SysV service, or launchd).
action="${LABCTL_P_ACTION:-status}"
case "$action" in start|stop|restart|status) ;; *) die "Action must be start, stop, restart or status." ;; esac
names="$(list_of "${LABCTL_P_SERVICES:-}")"
[ -n "$names" ] || names="$(list_of "${LABCTL_P_SERVICE:-}")"
[ -n "$names" ] || die "No service specified."
rc=0
while IFS= read -r svc; do
  case "$svc" in -*|*[!A-Za-z0-9@._:-]*) printf 'ERROR: invalid service name: %s\n' "$svc" >&2; rc=1; continue ;; esac
  echo "=== $svc ==="
  if [ "$IS_MAC" = 1 ]; then
    case "$action" in
      start) launchctl kickstart "system/$svc" 2>&1 || rc=1 ;;
      restart) launchctl kickstart -k "system/$svc" 2>&1 || rc=1 ;;
      stop) launchctl kill TERM "system/$svc" 2>&1 || rc=1 ;;
    esac
    launchctl print "system/$svc" 2>&1 | head -n 40
    [ "${PIPESTATUS[0]}" = 0 ] || rc=1
  elif have systemctl && [ -d /run/systemd/system ]; then
    if [ "$action" != status ]; then systemctl "$action" -- "$svc" 2>&1 || rc=1; fi
    systemctl status --no-pager -- "$svc" 2>&1
    s=$?
    # 3 means the unit exists but is not running, which is a valid status answer.
    [ "$s" = 0 ] || [ "$s" = 3 ] || rc=$s
  elif have service; then
    service "$svc" "$action" 2>&1 || rc=1
  else
    die "No service manager found (systemctl or service)."
  fi
done <<EOF
$names
EOF
exit "$rc"
