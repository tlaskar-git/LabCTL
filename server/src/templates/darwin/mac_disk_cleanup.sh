[ "$OS_NAME" = Darwin ] || die "This template is for macOS"
need_root
DAYS="${LABCTL_P_DAYS:-14}"; need_int DAYS "$DAYS"
TRASH_DAYS="${LABCTL_P_TRASH_DAYS:-7}"; need_int TRASH_DAYS "$TRASH_DAYS"
U="${LABCTL_P_RUN_USER:-$(console_user)}"
need_match RUN_USER '^[A-Za-z0-9._-]+$' "$U"
H="$(home_of "$U")"; [ -d "$H" ] || die "No home directory for $U"
BEFORE="$(free_kb /)"
gate

step "User caches older than $DAYS days"
prune_older "$H/Library/Caches" "$DAYS" 1
step "Logs older than $DAYS days"
prune_older "$H/Library/Logs" "$DAYS" 1
prune_older /Library/Logs "$DAYS" 1
if [ "$DRY_RUN" = 1 ]; then
  find /var/log -maxdepth 2 -name '*.gz' -mtime +"$DAYS" -print | sed 's/^/[dry-run] remove /'
else
  find /var/log -maxdepth 2 -name '*.gz' -mtime +"$DAYS" -exec rm -f {} +
fi
if truthy "${LABCTL_P_DOCKER:-1}"; then
  step "Docker or Colima prune"
  export LABCTL_HOURS=$(( DAYS * 24 ))
  run as_user "$U" 'PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"; if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then docker system prune -f --filter "until=${LABCTL_HOURS}h"; else echo "No running Docker or Colima daemon"; fi'
fi
step "Trash older than $TRASH_DAYS days"
prune_older "$H/.Trash" "$TRASH_DAYS" 1

AFTER="$(free_kb /)"
say "Space freed: $(( (AFTER - BEFORE) / 1024 )) MB (free now $(( AFTER / 1048576 )) GB)"
