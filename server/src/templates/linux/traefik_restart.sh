need_root
MODE="${LABCTL_P_MODE:-docker}"
NAME="${LABCTL_P_NAME:-traefik}"
need_match MODE '^(docker|systemd)$' "$MODE"
need_match NAME '^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$' "$NAME"
step "Restart Traefik ($MODE: $NAME)"
if [ "$MODE" = docker ]; then
  run docker restart "$NAME"
  if [ "$DRY_RUN" = 0 ]; then
    sleep 5
    [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] || die "Container $NAME is not running"
  fi
else
  run systemctl restart "$NAME"
  if [ "$DRY_RUN" = 0 ]; then sleep 3; systemctl is-active --quiet "$NAME" || die "Unit $NAME is not active"; fi
fi
say "Traefik is back"
