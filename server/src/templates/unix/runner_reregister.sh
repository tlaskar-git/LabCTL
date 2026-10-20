need_root
[ -n "${LABCTL_SECRET_REG_TOKEN:-}" ] || die "A registration token is required"
DIR="$(single_runner)"
OWNER="$(owner_of "$DIR")"
NAME="${LABCTL_P_NAME:-$(runner_name_of "$DIR")}"
URL="${LABCTL_P_URL:-$(runner_url_of "$DIR")}"
LABELS="${LABCTL_P_LABELS:-}"
GROUP="${LABCTL_P_RUNNER_GROUP:-}"
need_match NAME '^[A-Za-z0-9_.-]{1,64}$' "$NAME"
need_match URL '^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)?$' "$URL"
need_match LABELS '^[A-Za-z0-9_.:,-]*$' "$LABELS"
need_match RUNNER_GROUP '^[A-Za-z0-9 _.-]*$' "$GROUP"
[ -n "$LABELS" ] || say "No labels given: the runner gets its default labels. Pass the current labels to keep custom ones."

step "Re-registering $NAME at $URL"
gate
if [ "$DRY_RUN" = 1 ]; then say "[dry-run] would stop the service, replace the registration with --replace, start the service"; exit 0; fi
runner_svc "$DIR" stop || warn "The service stop command reported an error"
# Ephemeral replacement: a clean machine for the next job (_temp lives inside _work).
if truthy "${LABCTL_P_CLEAN_WORK:-0}"; then step "Clearing _work and _temp"; clear_dir "$DIR/_work"; fi
BAK="$DIR/.labctl-reg-bak"
rm -rf "$BAK"; mkdir "$BAK"
for f in .runner .credentials .credentials_rsaparams; do
  if [ -e "$DIR/$f" ]; then mv "$DIR/$f" "$BAK/$f"; fi
done

export LABCTL_DIR="$DIR" LABCTL_URL="$URL" LABCTL_NAME="$NAME" LABCTL_LABELS="$LABELS" LABCTL_GROUP="$GROUP"
export LABCTL_EPHEMERAL=0 LABCTL_NOUPDATE=0
if truthy "${LABCTL_P_EPHEMERAL:-0}"; then LABCTL_EPHEMERAL=1; fi
if truthy "${LABCTL_P_DISABLE_UPDATE:-0}"; then LABCTL_NOUPDATE=1; fi
export ACTIONS_RUNNER_INPUT_TOKEN="$LABCTL_SECRET_REG_TOKEN"
if [ "$OWNER" = root ]; then export RUNNER_ALLOW_RUNASROOT=1; fi
if as_user "$OWNER" "$RUNNER_CONFIG_SCRIPT"; then
  unset ACTIONS_RUNNER_INPUT_TOKEN
  rm -rf "$BAK"
else
  unset ACTIONS_RUNNER_INPUT_TOKEN
  warn "Registration failed. Restoring the old registration."
  for f in .runner .credentials .credentials_rsaparams; do
    if [ -e "$BAK/$f" ]; then mv "$BAK/$f" "$DIR/$f"; fi
  done
  runner_svc "$DIR" start || true
  die "Registration failed"
fi
runner_svc "$DIR" start
wait_svc_active "$DIR" 60 || die "The service is not active after registration"
result runner_reregistered "$NAME"
