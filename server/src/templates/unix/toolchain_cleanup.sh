DAYS="${LABCTL_P_DAYS:-30}"; need_int DAYS "$DAYS"
U="${LABCTL_P_RUN_USER:-}"
if [ -z "$U" ]; then
  FIRST="$(find_runners | head -n 1 || true)"
  if [ -n "$FIRST" ]; then U="$(owner_of "$FIRST")"; elif [ "$OS_NAME" = Darwin ]; then U="$(console_user)"; else die "Set the run user parameter"; fi
fi
need_match RUN_USER '^[A-Za-z0-9._-]+$' "$U"
H="$(home_of "$U")"; [ -d "$H" ] || die "No home directory for $U"
PATHFIX='PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/usr/local/go/bin:$HOME/.cargo/bin"; export PATH;'
SELECTED=0
BEFORE="$(free_kb "$H")"
step "Waiting for an idle host"
gate

# tool_cmd LABEL COMMAND_NAME COMMAND...: runs the constant command text as the cache owner when the tool exists.
tool_cmd() {
  step "$1"
  run as_user "$U" "$PATHFIX if command -v $2 >/dev/null 2>&1; then $3; else echo '$2 is not installed'; fi"
}
if truthy "${LABCTL_P_NPM:-0}"; then SELECTED=1; tool_cmd "npm cache" npm "npm cache clean --force"; fi
if truthy "${LABCTL_P_PNPM:-0}"; then SELECTED=1; tool_cmd "pnpm store" pnpm "pnpm store prune"; fi
if truthy "${LABCTL_P_PIP:-0}"; then SELECTED=1; tool_cmd "pip cache" pip3 "pip3 cache purge"; fi
if truthy "${LABCTL_P_NUGET:-0}"; then SELECTED=1; tool_cmd "NuGet caches" dotnet "dotnet nuget locals all --clear"; fi
if truthy "${LABCTL_P_GO:-0}"; then SELECTED=1; tool_cmd "Go build cache" go "go clean -cache"; fi
if truthy "${LABCTL_P_GRADLE:-0}"; then
  SELECTED=1; step "Gradle build cache and daemon logs older than $DAYS days"
  prune_files "$H/.gradle/caches/build-cache-1" "$DAYS"
  prune_older "$H/.gradle/daemon" "$DAYS" 2 -type f -name '*.log'
fi
if truthy "${LABCTL_P_MAVEN:-0}"; then
  SELECTED=1; step "Maven repository files older than $DAYS days (downloaded again on demand)"
  prune_files "$H/.m2/repository" "$DAYS"
fi
if truthy "${LABCTL_P_CARGO:-0}"; then
  SELECTED=1; step "Cargo registry cache and sources older than $DAYS days"
  prune_files "$H/.cargo/registry/cache" "$DAYS"
  prune_files "$H/.cargo/registry/src" "$DAYS"
fi
[ "$SELECTED" = 1 ] || { say "No tool selected, nothing to do"; exit 0; }

AFTER="$(free_kb "$H")"
say "Space freed: $(( (AFTER - BEFORE) / 1024 )) MB"
