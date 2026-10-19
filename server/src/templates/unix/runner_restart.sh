need_root
ACTION="${LABCTL_P_ACTION:-restart}"
need_match ACTION '^(stop|start|restart)$' "$ACTION"
WAIT_S="${LABCTL_P_WAIT_S:-60}"; need_int WAIT_S "$WAIT_S"
runner_dirs_or_die
if [ "$ACTION" != start ]; then step "Waiting for an idle host"; gate; fi
while IFS= read -r DIR <&3; do
  step "Runner $(runner_name_of "$DIR"): $ACTION"
  if [ "$ACTION" != start ]; then run runner_svc "$DIR" stop; fi
  if [ "$ACTION" != stop ]; then
    run runner_svc "$DIR" start
    if [ "$DRY_RUN" = 0 ]; then wait_svc_active "$DIR" "$WAIT_S" || die "The service is not active after $WAIT_S s"; fi
  fi
done 3<<< "$RUNNER_DIRS"
result runner_action "$ACTION"
