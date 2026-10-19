need_root
ACTION="${LABCTL_P_ACTION:-rollback}"
need_match ACTION '^(rollback|discard)$' "$ACTION"
runner_dirs_or_die
FOUND=0
while IFS= read -r DIR <&3; do
  [ -d "$DIR.labctl-prev" ] || continue
  FOUND=1
  step "Runner in $DIR: $ACTION"
  if [ "$ACTION" = discard ]; then
    run rm -rf "$DIR.labctl-prev" "$DIR.labctl-failed"
  else
    gate
    if [ "$DRY_RUN" = 1 ]; then say "[dry-run] would restore $DIR.labctl-prev"; else rollback_dir "$DIR"; fi
  fi
done 3<<< "$RUNNER_DIRS"
[ "$FOUND" = 1 ] || die "No previous runner folder (.labctl-prev) found"
