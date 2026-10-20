need_root
step "Latest runner package"
fetch_runner_release "${LABCTL_P_VERSION:-}"
runner_dirs_or_die
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PKG="$TMP/runner.tar.gz"
DOWNLOADED=0
KEEP=".runner .credentials .credentials_rsaparams .path .env .service"

# swap_in DIR PREV OWNER: lays the new files over a fresh DIR and moves the identity files and _work across.
swap_in() {
  local dir="$1" prev="$2" owner="$3" f
  mv "$dir" "$prev" || return 1
  mkdir "$dir" || return 1
  tar -xzf "$PKG" -C "$dir" || return 1
  for f in $KEEP; do
    if [ -e "$prev/$f" ]; then cp -p "$prev/$f" "$dir/$f" || return 1; fi
  done
  if [ -d "$prev/_work" ]; then mv "$prev/_work" "$dir/_work" || return 1; fi
  chown -R "$owner" "$dir" || return 1
}

update_one() {
  local dir="$1" cur owner prev
  owner="$(owner_of "$dir")"
  cur="$("$dir/bin/Runner.Listener" --version 2>/dev/null || echo unknown)"
  step "Runner $(runner_name_of "$dir") in $dir (current version $cur)"
  if [ "$cur" = "$REL_VERSION" ]; then say "Already at $REL_VERSION"; return 0; fi
  gate
  if [ "$DRY_RUN" = 1 ]; then say "[dry-run] would update $cur to $REL_VERSION and keep the old folder as $dir.labctl-prev"; return 0; fi
  if [ "$DOWNLOADED" = 0 ]; then download_runner "$PKG"; DOWNLOADED=1; fi
  prev="$dir.labctl-prev"
  rm -rf "$prev"
  say "Stopping the service"
  runner_svc "$dir" stop || warn "The service stop command reported an error"
  if ! swap_in "$dir" "$prev" "$owner"; then
    warn "Replacing the files failed. Restoring the previous folder."
    rm -rf "$dir"; mv "$prev" "$dir"; runner_svc "$dir" start || true
    die "Update failed before the new version started"
  fi
  say "Starting the service"
  if runner_svc "$dir" start && wait_svc_active "$dir" 60; then
    say "Service active, version $("$dir/bin/Runner.Listener" --version)"
    say "The previous version stays in $prev. Run runner_rollback to restore it, or runner_rollback with the discard action to delete it."
    result runner_updated "$(runner_name_of "$dir")"
  else
    warn "The service did not start. Rolling back."
    rollback_dir "$dir"
    die "Update failed and was rolled back"
  fi
}

while IFS= read -r DIR <&3; do update_one "$DIR"; done 3<<< "$RUNNER_DIRS"
