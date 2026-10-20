# Docker Update, as v1: COMPOSE_DIR pulls and recreates that compose project; CONTAINERS pulls each image and, unless
# RESTART is false, recreates it through its compose service (or restarts it); CONTAINER (legacy) pulls, stops and
# removes that one container; with none of them, pulls the image of every running container.
have docker || die "Docker is not installed on this host."
valid_name() { case "$1" in ''|-*|*[!A-Za-z0-9_.-]*) return 1 ;; *) return 0 ;; esac; }
rc=0
if [ -n "${LABCTL_P_COMPOSE_DIR:-}" ]; then
  echo "Compose update in $LABCTL_P_COMPOSE_DIR:"
  cd -- "$LABCTL_P_COMPOSE_DIR" || die "Folder not found: $LABCTL_P_COMPOSE_DIR"
  docker compose pull 2>&1 && docker compose up -d 2>&1 || rc=1
elif [ -n "$(list_of "${LABCTL_P_CONTAINERS:-}")" ]; then
  while IFS= read -r c; do
    valid_name "$c" || { printf 'ERROR: invalid container name: %s\n' "$c" >&2; rc=1; continue; }
    image="$(docker inspect --format '{{.Config.Image}}' -- "$c" 2>/dev/null)"
    if [ -z "$image" ]; then echo "[$c] Could not find image"; rc=1; continue; fi
    echo "[$c] Pulling $image"
    docker pull -- "$image" 2>&1 || { rc=1; continue; }
    truthy "${LABCTL_P_RESTART:-1}" || continue
    wd="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' -- "$c" 2>/dev/null)"
    svc="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' -- "$c" 2>/dev/null)"
    if [ -n "$wd" ] && [ -n "$svc" ] && [ -d "$wd" ]; then
      echo "[$c] Restarting via compose service $svc"
      (cd -- "$wd" && docker compose up -d -- "$svc") 2>&1 || rc=1
    else
      echo "[$c] Restarting"
      docker restart -- "$c" 2>&1 || rc=1
    fi
  done <<EOF
$(list_of "${LABCTL_P_CONTAINERS:-}")
EOF
elif [ -n "${LABCTL_P_CONTAINER:-}" ]; then
  c="$LABCTL_P_CONTAINER"
  valid_name "$c" || die "Invalid container name: $c"
  image="$(docker inspect --format '{{.Config.Image}}' -- "$c" 2>/dev/null)"
  [ -n "$image" ] || die "Could not find the image of $c"
  docker pull -- "$image" 2>&1 && echo "Pulled latest $image" || rc=1
  docker stop -- "$c" 2>&1 && docker rm -- "$c" 2>&1 && echo "Stopped and removed $c" || rc=1
  echo "Container stopped. Use docker compose or re-run with the original parameters."
else
  echo "Pulling updates for every running container:"
  for c in $(docker ps --format '{{.Names}}'); do
    img="$(docker inspect --format '{{.Config.Image}}' -- "$c")"
    echo "Pulling $img for $c"
    docker pull -- "$img" 2>&1 || rc=1
  done
fi
exit "$rc"
