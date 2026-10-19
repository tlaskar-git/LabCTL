HOURS="${LABCTL_P_HOURS:-24}"; need_int HOURS "$HOURS"
CAP="${LABCTL_P_CACHE_CAP_GB:-20}"; need_int CACHE_CAP_GB "$CAP"
if [ "$OS_NAME" = Darwin ]; then DEFAULT_USER="$(console_user)"; else DEFAULT_USER=root; fi
U="${LABCTL_P_RUN_USER:-$DEFAULT_USER}"
need_match RUN_USER '^[A-Za-z0-9._-]+$' "$U"
export LABCTL_HOURS="$HOURS" LABCTL_CAP="$CAP" LABCTL_ALL=0 LABCTL_VOLS=0
if truthy "${LABCTL_P_ALL_IMAGES:-0}"; then LABCTL_ALL=1; fi
if truthy "${LABCTL_P_VOLUMES:-0}"; then LABCTL_VOLS=1; fi
PATHFIX='PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"; export PATH;'

step "Docker disk use before"
as_user "$U" "$PATHFIX docker system df"
if [ "$DRY_RUN" = 1 ]; then say "[dry-run] would prune objects older than $HOURS hours and keep the build cache under $CAP GB"; exit 0; fi
step "Waiting for an idle host"
gate
step "System prune"
as_user "$U" "$PATHFIX args=(system prune -f --filter \"until=\${LABCTL_HOURS}h\"); [ \"\$LABCTL_ALL\" != 1 ] || args+=(-a); [ \"\$LABCTL_VOLS\" != 1 ] || args+=(--volumes); docker \"\${args[@]}\""
step "Build cache prune"
as_user "$U" "$PATHFIX docker builder prune -f --keep-storage \"\${LABCTL_CAP}GB\""
step "Docker disk use after"
as_user "$U" "$PATHFIX docker system df"
