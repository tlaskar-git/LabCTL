need_root
AGE_MIN="${LABCTL_P_MIN_AGE_MIN:-30}"; need_int MIN_AGE_MIN "$AGE_MIN"
step "Waiting for an idle host"
gate

step "Orphaned build processes (parent gone, started from a _work folder, older than $AGE_MIN minutes)"
# shortcut: matches the _work path in the command line only, not the working directory of the process
PIDS="$(ps -axo pid=,ppid=,etime=,args= | awk -v min="$AGE_MIN" '
  $2 == 1 && index($0, "/_work/") > 0 {
    e = $3; d = 0
    if (e ~ /-/) { split(e, a, "-"); d = a[1]; e = a[2] }
    n = split(e, t, ":"); s = t[n] + 60 * t[n - 1]
    if (n == 3) s += 3600 * t[1]
    s += 86400 * d
    if (s >= min * 60) print $1
  }')"
if [ -z "$PIDS" ]; then say "None found"; result orphans_killed 0; exit 0; fi
COUNT=0
for p in $PIDS; do
  say "$(ps -o pid=,etime=,args= -p "$p" | cut -c1-200)"
  if [ "$DRY_RUN" = 1 ]; then say "[dry-run] would stop $p"; continue; fi
  kill -TERM "$p" 2>/dev/null || true
  COUNT=$(( COUNT + 1 ))
done
if [ "$DRY_RUN" = 0 ]; then
  sleep 5
  for p in $PIDS; do
    if kill -0 "$p" 2>/dev/null; then say "Process $p ignored TERM, sending KILL"; kill -KILL "$p" 2>/dev/null || true; fi
  done
fi
result orphans_killed "$COUNT"
