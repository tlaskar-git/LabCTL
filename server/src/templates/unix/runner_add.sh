need_root
[ -n "${LABCTL_SECRET_REG_TOKEN:-}" ] || die "A registration token is required"
URL="${LABCTL_P_URL:-}"
NAME="${LABCTL_P_NAME:-}"
LABELS="${LABCTL_P_LABELS:-}"
GROUP="${LABCTL_P_RUNNER_GROUP:-}"
need_match URL '^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)?$' "$URL"
need_match NAME '^[A-Za-z0-9_.-]{1,64}$' "$NAME"
need_match LABELS '^[A-Za-z0-9_.:,-]*$' "$LABELS"
need_match RUNNER_GROUP '^[A-Za-z0-9 _.-]*$' "$GROUP"
if [ "$OS_NAME" = Darwin ]; then DEFAULT_USER="$(console_user)"; else DEFAULT_USER=runner; fi
U="${LABCTL_P_RUN_USER:-$DEFAULT_USER}"
need_match RUN_USER '^[A-Za-z0-9._-]+$' "$U"
if [ "$OS_NAME" = Darwin ]; then DEFAULT_DIR="$(home_of "$U")/actions-runner-$NAME"; else DEFAULT_DIR="/opt/actions-runner-$NAME"; fi
DIR="${LABCTL_P_INSTALL_DIR:-$DEFAULT_DIR}"
need_match INSTALL_DIR '^/[A-Za-z0-9_./-]+$' "$DIR"
[ ! -e "$DIR/.runner" ] || die "A runner is already configured in $DIR"

step "Latest runner package"
fetch_runner_release "${LABCTL_P_VERSION:-}"
step "Plan"
say "Add runner $NAME for $URL in $DIR as user $U (service installed and started)"
if [ "$DRY_RUN" = 1 ]; then say "[dry-run] nothing downloaded or installed"; exit 0; fi

if ! id -u "$U" >/dev/null 2>&1; then
  [ "$OS_NAME" != Darwin ] || die "User $U does not exist"
  step "Creating user $U"
  useradd -m -s /bin/bash "$U"
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
step "Download and unpack"
download_runner "$TMP/runner.tar.gz"
mkdir -p "$DIR"
tar -xzf "$TMP/runner.tar.gz" -C "$DIR"
chown -R "$U" "$DIR"
if [ "$OS_NAME" != Darwin ]; then "$DIR/bin/installdependencies.sh"; fi

step "Register"
export LABCTL_DIR="$DIR" LABCTL_URL="$URL" LABCTL_NAME="$NAME" LABCTL_LABELS="$LABELS" LABCTL_GROUP="$GROUP"
export LABCTL_EPHEMERAL=0 LABCTL_NOUPDATE=0
if truthy "${LABCTL_P_EPHEMERAL:-0}"; then LABCTL_EPHEMERAL=1; fi
if truthy "${LABCTL_P_DISABLE_UPDATE:-0}"; then LABCTL_NOUPDATE=1; fi
export ACTIONS_RUNNER_INPUT_TOKEN="$LABCTL_SECRET_REG_TOKEN"
if [ "$U" = root ]; then export RUNNER_ALLOW_RUNASROOT=1; fi
as_user "$U" "$RUNNER_CONFIG_SCRIPT" || die "Registration failed"
unset ACTIONS_RUNNER_INPUT_TOKEN

step "Install and start the service"
if [ "$OS_NAME" = Darwin ]; then runner_svc "$DIR" install; else runner_svc "$DIR" install "$U"; fi
runner_svc "$DIR" start
wait_svc_active "$DIR" 60 || die "The service is not active"
result runner_added "$NAME"
