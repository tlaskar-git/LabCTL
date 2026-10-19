need_root
DIR="${LABCTL_P_RUNNER_DIR:-}"
[ -n "$DIR" ] || die "RUNNER_DIR is required: this template never guesses which runner to delete"
[ -f "$DIR/.runner" ] && [ -f "$DIR/config.sh" ] || die "$DIR is not a runner folder"
case "$DIR" in /|/opt|/home|/Users|/usr|/var|/etc|/srv|/root) die "Refusing to delete $DIR" ;; esac
[ "$(printf '%s' "$DIR" | awk -F/ '{print NF-1}')" -ge 2 ] || die "Refusing to delete a top level folder"
[ -n "${LABCTL_SECRET_REMOVE_TOKEN:-}" ] || die "A removal token is required"
OWNER="$(owner_of "$DIR")"

step "Removing runner $(runner_name_of "$DIR") in $DIR"
gate
if [ "$DRY_RUN" = 1 ]; then say "[dry-run] would stop and uninstall the service, unregister from GitHub, delete $DIR"; exit 0; fi
runner_svc "$DIR" stop || warn "The service stop command reported an error"
runner_svc "$DIR" uninstall || warn "The service uninstall command reported an error"
export LABCTL_DIR="$DIR"
export ACTIONS_RUNNER_INPUT_TOKEN="$LABCTL_SECRET_REMOVE_TOKEN"
if [ "$OWNER" = root ]; then export RUNNER_ALLOW_RUNASROOT=1; fi
# shellcheck disable=SC2016
as_user "$OWNER" 'cd "$LABCTL_DIR" && ./config.sh remove --unattended' || die "GitHub did not accept the removal. The folder is kept."
unset ACTIONS_RUNNER_INPUT_TOKEN
rm -rf "$DIR" "$DIR.labctl-prev" "$DIR.labctl-failed"
say "Runner folder deleted"
result runner_removed yes
