runner_dirs_or_die
PROBLEMS=0
bad() { warn "$*"; PROBLEMS=$(( PROBLEMS + 1 )); }

step "Host"
if runner_busy; then say "Runner.Worker: a job is running"; else say "Runner.Worker: idle"; fi
say "Free space on /: $(( $(free_kb /) / 1048576 )) GB"

LATEST=""
if truthy "${LABCTL_P_CHECK_LATEST:-0}"; then fetch_runner_release ""; LATEST="$REL_VERSION"; fi

while IFS= read -r DIR <&3; do
  step "Runner $(runner_name_of "$DIR")"
  say "Folder: $DIR"
  say "Registered at: $(runner_url_of "$DIR")"
  VER="$("$DIR/bin/Runner.Listener" --version 2>/dev/null || echo unknown)"
  say "Version: $VER"
  if [ -n "$LATEST" ] && [ "$VER" != "$LATEST" ]; then warn "Latest is $LATEST"; fi
  if runner_svc_active "$DIR"; then say "Service: active"; else bad "Service is not active"; fi
  if pgrep -x Runner.Listener >/dev/null 2>&1; then say "Listener process: running"; else bad "No Runner.Listener process"; fi
  say "_work size: $(( $(size_kb "$DIR/_work") / 1024 )) MB"
  LOG="$(ls -t "$DIR"/_diag/Runner_*.log 2>/dev/null | head -n 1 || true)"
  if [ -n "$LOG" ]; then
    say "Latest listener log: $(basename "$LOG")"
    grep -E 'Listening for Jobs|Running job|completed with result|Connected|Error|Exception' "$LOG" | tail -n 5 || true
  fi
done 3<<< "$RUNNER_DIRS"

say "Problems: $PROBLEMS"
result runner_problems "$PROBLEMS"
if truthy "${LABCTL_P_FAIL_ON_DOWN:-1}" && [ "$PROBLEMS" -gt 0 ]; then exit 1; fi
