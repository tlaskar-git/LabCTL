WORK_DAYS="${LABCTL_P_WORK_DAYS:-7}"; need_int WORK_DAYS "$WORK_DAYS"
DIAG_DAYS="${LABCTL_P_DIAG_DAYS:-14}"; need_int DIAG_DAYS "$DIAG_DAYS"
TOOL_DAYS="${LABCTL_P_TOOL_DAYS:-30}"; need_int TOOL_DAYS "$TOOL_DAYS"
PREV_DAYS="${LABCTL_P_PREV_DAYS:-7}"; need_int PREV_DAYS "$PREV_DAYS"
runner_dirs_or_die
step "Waiting for an idle host"
gate

while IFS= read -r DIR <&3; do
  step "Runner $(runner_name_of "$DIR") in $DIR"
  BEFORE="$(size_kb "$DIR")"
  say "Workspaces older than $WORK_DAYS days"
  prune_older "$DIR/_work" "$WORK_DAYS" 1 -type d ! -name '_*'
  say "Diagnostic logs older than $DIAG_DAYS days"
  prune_older "$DIR/_diag" "$DIAG_DAYS" 1 -type f
  say "Temporary files"
  clear_dir "$DIR/_work/_temp"
  say "Tool cache entries older than $TOOL_DAYS days"
  prune_older "$DIR/_work/_tool" "$TOOL_DAYS" 2 -type d
  say "Old update folders older than $PREV_DAYS days"
  prune_older "$(dirname "$DIR")" "$PREV_DAYS" 1 -name "$(basename "$DIR").labctl-*"
  AFTER="$(size_kb "$DIR")"
  say "Space freed in this runner: $(( (BEFORE - AFTER) / 1024 )) MB"
done 3<<< "$RUNNER_DIRS"
