# LabCTL template prelude for bash. The server puts this in front of every .sh template.
# Written for bash 3.2 (macOS) and later. Parameters arrive as LABCTL_P_<NAME> environment variables and
# secrets as LABCTL_SECRET_<NAME>. Neither is ever placed inside code that a shell or interpreter parses.
set -euo pipefail
export LC_ALL=C
OS_NAME="$(uname -s)"

step() { printf '\n== %s ==\n' "$*"; }
say() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
# A line the runbook engine reads back: LABCTL_RESULT key=value
result() { printf 'LABCTL_RESULT %s=%s\n' "$1" "$2"; }

truthy() { case "${1:-}" in 1|true|TRUE|True|yes|YES|on) return 0 ;; *) return 1 ;; esac; }
is_int() { case "${1:-}" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
need_int() { is_int "$2" || die "Parameter $1 must be a whole number"; }
need_match() { printf '%s' "$3" | grep -Eq "$2" || die "Parameter $1 has an invalid value"; } # name, regex, value
need_root() { [ "$(id -u)" = 0 ] || die "This template must run as root"; }
have() { command -v "$1" >/dev/null 2>&1; }

DRY_RUN=0; if truthy "${LABCTL_P_DRY_RUN:-0}"; then DRY_RUN=1; fi
DRAIN=0; if truthy "${LABCTL_P_DRAIN:-0}"; then DRAIN=1; fi
FORCE=0; if truthy "${LABCTL_P_FORCE:-0}"; then FORCE=1; fi
DRAIN_TIMEOUT_MIN="${LABCTL_P_DRAIN_TIMEOUT_MIN:-120}"
[ "$DRY_RUN" = 0 ] || say "DRY RUN: nothing will be changed"

# run: executes the command, or only prints it in a dry run. Arguments are never parsed again by a shell.
run() { if [ "$DRY_RUN" = 1 ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }

sha256_of() { if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
free_kb() { df -k "$1" | awk 'NR==2 {print $4}'; }
size_kb() { du -sk "$1" 2>/dev/null | cut -f1; }

# prune_older DIR DAYS DEPTH [find tests]: removes entries exactly DEPTH levels below DIR that are older than
# DAYS days. Extra arguments are find tests (for example -type f).
prune_older() {
  local dir="$1" days="$2" depth="$3"
  shift 3
  [ -d "$dir" ] || return 0
  if [ "$DRY_RUN" = 1 ]; then
    find "$dir" -mindepth "$depth" -maxdepth "$depth" "$@" -mtime +"$days" -print | sed 's/^/[dry-run] remove /'
  else
    find "$dir" -mindepth "$depth" -maxdepth "$depth" "$@" -mtime +"$days" -exec rm -rf {} +
  fi
}
# prune_files DIR DAYS: removes files older than DAYS days anywhere below DIR, then empty directories.
prune_files() {
  [ -d "$1" ] || return 0
  if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] $(find "$1" -type f -mtime +"$2" | wc -l | tr -d ' ') file(s) older than $2 days in $1"
  else
    find "$1" -type f -mtime +"$2" -exec rm -f {} +
    find "$1" -mindepth 1 -type d -empty -exec rmdir {} + 2>/dev/null || true
  fi
}
# clear_dir DIR: removes everything inside DIR.
clear_dir() {
  [ -d "$1" ] || return 0
  if [ "$DRY_RUN" = 1 ]; then say "[dry-run] would empty $1 ($(find "$1" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ') entries)"
  else find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf {} +; fi
}

# ---- users -------------------------------------------------------------------------------------
console_user() { if [ "$OS_NAME" = Darwin ]; then stat -f %Su /dev/console; else logname 2>/dev/null || id -un; fi; }
owner_of() { if [ "$OS_NAME" = Darwin ]; then stat -f %Su "$1"; else stat -c %U "$1"; fi; }
home_of() {
  if [ "$OS_NAME" = Darwin ]; then dscl . -read "/Users/$1" NFSHomeDirectory | awk '{print $2}'
  else getent passwd "$1" | cut -d: -f6; fi
}
# as_user USER SCRIPT: runs the constant SCRIPT text with bash as USER. Values reach it as exported
# environment variables only (read them as "$VAR" inside SCRIPT). Runs directly when already that user.
as_user() {
  local u="$1" script="$2" h
  if [ "$(id -un)" = "$u" ]; then bash -c "$script"; return; fi
  [ "$(id -u)" = 0 ] || die "Cannot switch to user $u without root"
  h="$(home_of "$u")"
  export LABCTL_AS_HOME="$h" LABCTL_AS_SCRIPT="$script"
  if [ "$OS_NAME" = Darwin ]; then
    launchctl asuser "$(id -u "$u")" su -m "$u" -c 'HOME="$LABCTL_AS_HOME"; export HOME; exec bash -c "$LABCTL_AS_SCRIPT"'
  else
    runuser -u "$u" -- bash -c 'HOME="$LABCTL_AS_HOME"; export HOME; exec bash -c "$LABCTL_AS_SCRIPT"'
  fi
}

# ---- runners -----------------------------------------------------------------------------------
# Machine wide on purpose: a build in any runner on this host blocks disruptive work.
runner_busy() { pgrep -x Runner.Worker >/dev/null 2>&1; }

# idle_gate: returns when no build runs. DRAIN waits (re-checks after 5 s and notes a job that started in
# the gap). FORCE continues with a build running. Without either, a running build stops the script.
idle_gate() {
  need_int DRAIN_TIMEOUT_MIN "$DRAIN_TIMEOUT_MIN"
  local deadline
  deadline=$(( $(date +%s) + DRAIN_TIMEOUT_MIN * 60 ))
  if [ "$DRAIN" = 1 ]; then
    say "Drain: waiting for Runner.Worker to finish (up to $DRAIN_TIMEOUT_MIN minutes)"
    while :; do
      while runner_busy; do
        if [ "$(date +%s)" -ge "$deadline" ]; then
          if [ "$FORCE" = 1 ]; then warn "Drain timed out and force is set: continuing with a build running"; return 0; fi
          die "Drain timed out: a build is still running"
        fi
        sleep 15
      done
      sleep 5
      if runner_busy; then say "A job started during the 5 s re-check, waiting again"; continue; fi
      say "No build running after the 5 s re-check"
      return 0
    done
  fi
  if runner_busy; then
    if [ "$FORCE" = 1 ]; then warn "Runner.Worker is active and force is set: continuing"; return 0; fi
    die "Runner.Worker is active. Use drain, or force with typed confirmation"
  fi
}

# gate: idle_gate for real runs. A dry run only reports whether a build is running.
gate() {
  if [ "$DRY_RUN" = 1 ]; then
    if runner_busy; then say "[dry-run] Runner.Worker is active: a real run would wait (drain), continue (force) or stop"; else say "[dry-run] No build is running"; fi
  else
    idle_gate
  fi
}

# find_runners: one runner directory per line (a runner directory holds a .runner file).
# shortcut: paths with spaces are not found through the process list, use LABCTL_P_RUNNER_DIR then.
find_runners() {
  local d
  if [ -n "${LABCTL_P_RUNNER_DIR:-}" ]; then
    [ -f "$LABCTL_P_RUNNER_DIR/.runner" ] || die "No .runner file in the given runner directory"
    printf '%s\n' "$LABCTL_P_RUNNER_DIR"
    return 0
  fi
  {
    ps -axo args= 2>/dev/null | grep -Eo '[^ ]+/bin/Runner\.Listener' | sed 's#/bin/Runner\.Listener$##' || true
    for d in /opt/actions-runner* /opt/*/actions-runner* /srv/actions-runner* /srv/*/actions-runner* \
      /home/*/actions-runner* /home/*/*/actions-runner* /Users/*/actions-runner* /Users/*/*/actions-runner*; do
      if [ -d "$d" ]; then printf '%s\n' "$d"; fi
    done
  } | sort -u | while IFS= read -r d; do
    if [ -f "$d/.runner" ]; then printf '%s\n' "$d"; fi
  done
}
runner_dirs_or_die() { RUNNER_DIRS="$(find_runners)"; [ -n "$RUNNER_DIRS" ] || die "No runner found. Set the runner directory parameter"; }
# single_runner: exactly one directory, or the given one.
single_runner() {
  runner_dirs_or_die
  [ "$(printf '%s\n' "$RUNNER_DIRS" | wc -l | tr -d ' ')" = 1 ] || die "More than one runner found. Set the runner directory parameter"
  printf '%s\n' "$RUNNER_DIRS"
}
runner_name_of() { grep -o '"agentName": *"[^"]*"' "$1/.runner" | sed 's/.*: *"\(.*\)"/\1/'; }
runner_url_of() { grep -o '"gitHubUrl": *"[^"]*"' "$1/.runner" | sed 's/.*: *"\(.*\)"/\1/'; }

# runner_svc DIR ACTION [USER]: start, stop, install or uninstall through the runner's own svc.sh, as the directory owner.
runner_svc() {
  local dir="$1" act="$2" owner
  [ -f "$dir/svc.sh" ] || die "No svc.sh in $dir"
  owner="$(owner_of "$dir")"
  if [ "$OS_NAME" = Darwin ]; then
    export LABCTL_DIR="$dir" LABCTL_ACT="$act"
    as_user "$owner" 'cd "$LABCTL_DIR" && ./svc.sh "$LABCTL_ACT"'
  else
    if [ -n "${3:-}" ]; then ( cd "$dir" && ./svc.sh "$act" "$3" ); else ( cd "$dir" && ./svc.sh "$act" ); fi
  fi
}
# runner_svc_active DIR: true when the runner service is running.
runner_svc_active() {
  local dir="$1" unit label owner
  if [ "$OS_NAME" = Darwin ]; then
    [ -f "$dir/.service" ] || return 1
    label="$(basename "$(cat "$dir/.service")" .plist)"
    owner="$(owner_of "$dir")"
    launchctl asuser "$(id -u "$owner")" launchctl list 2>/dev/null | awk -v l="$label" '$3 == l && $1 ~ /^[0-9]+$/ { f = 1 } END { exit !f }'
  else
    [ -f "$dir/.service" ] || return 1
    unit="$(cat "$dir/.service")"
    systemctl is-active --quiet "$unit"
  fi
}
wait_svc_active() { # dir, seconds
  local n=0
  while [ "$n" -lt "$2" ]; do
    if runner_svc_active "$1"; then return 0; fi
    sleep 3; n=$(( n + 3 ))
  done
  return 1
}

# runner_arch: x64, arm64 or arm. runner_os: linux or osx.
runner_arch() { case "$(uname -m)" in x86_64|amd64) echo x64 ;; aarch64|arm64) echo arm64 ;; armv7l|armv6l) echo arm ;; *) die "Unsupported CPU: $(uname -m)" ;; esac; }
runner_os() { if [ "$OS_NAME" = Darwin ]; then echo osx; else echo linux; fi; }

# rollback_dir DIR: puts DIR.labctl-prev back (the _work folder moves back with it) and starts the service.
rollback_dir() {
  local dir="$1" prev="$1.labctl-prev" failed="$1.labctl-failed"
  [ -d "$prev" ] || die "No previous version at $prev"
  runner_svc "$dir" stop || true
  rm -rf "$failed"
  mv "$dir" "$failed"
  if [ -d "$failed/_work" ] && [ ! -e "$prev/_work" ]; then mv "$failed/_work" "$prev/_work"; fi
  mv "$prev" "$dir"
  runner_svc "$dir" start
  wait_svc_active "$dir" 60 || die "Rolled back, but the service is not active"
  say "Rolled back to $("$dir/bin/Runner.Listener" --version 2>/dev/null || echo the previous version)"
}

# Constant script for as_user. Values arrive as LABCTL_DIR, LABCTL_URL, LABCTL_NAME, LABCTL_LABELS, LABCTL_GROUP,
# LABCTL_EPHEMERAL and LABCTL_NOUPDATE. The token arrives as ACTIONS_RUNNER_INPUT_TOKEN, which the runner reads itself.
# shellcheck disable=SC2016
RUNNER_CONFIG_SCRIPT='cd "$LABCTL_DIR" && args=(--unattended --replace --url "$LABCTL_URL" --name "$LABCTL_NAME" --work _work); [ -z "$LABCTL_LABELS" ] || args+=(--labels "$LABCTL_LABELS"); [ -z "$LABCTL_GROUP" ] || args+=(--runnergroup "$LABCTL_GROUP"); [ "$LABCTL_EPHEMERAL" != 1 ] || args+=(--ephemeral); [ "$LABCTL_NOUPDATE" != 1 ] || args+=(--disableupdate); ./config.sh "${args[@]}"'

# fetch_runner_release VERSION_OR_EMPTY: sets REL_VERSION, REL_URL, REL_SHA from the actions/runner release.
# The SHA-256 comes from the release notes. No hash means no install.
fetch_runner_release() {
  have python3 || die "python3 is required to read the release information"
  local api="https://api.github.com/repos/actions/runner/releases/latest" json tag asset
  if [ -n "${1:-}" ]; then
    need_match VERSION '^[0-9]+\.[0-9]+\.[0-9]+$' "$1"
    api="https://api.github.com/repos/actions/runner/releases/tags/v$1"
  fi
  if [ -n "${LABCTL_SECRET_GITHUB_TOKEN:-}" ]; then
    json="$(printf 'header = "Authorization: Bearer %s"\n' "$LABCTL_SECRET_GITHUB_TOKEN" | curl -fsSL -K - -H 'Accept: application/vnd.github+json' "$api")"
  else
    json="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api")"
  fi
  tag="$(runner_os)-$(runner_arch)"
  asset="$(printf '%s' "$json" | python3 -c '
import json, re, sys
rel = json.load(sys.stdin)
tag = sys.argv[1]
ver = rel["tag_name"].lstrip("v")
name = "actions-runner-%s-%s.tar.gz" % (tag, ver)
url = next((a["browser_download_url"] for a in rel["assets"] if a["name"] == name), "")
body = rel.get("body") or ""
m = re.search(r"BEGIN SHA %s -->([0-9a-f]{64})<!--" % re.escape(tag), body)
if not m:
    m = re.search(re.escape(name) + r"[^0-9a-f]*([0-9a-f]{64})", body)
print(ver); print(url); print(m.group(1) if m else "")
' "$tag")"
  REL_VERSION="$(printf '%s\n' "$asset" | sed -n 1p)"
  REL_URL="$(printf '%s\n' "$asset" | sed -n 2p)"
  REL_SHA="$(printf '%s\n' "$asset" | sed -n 3p)"
  [ -n "$REL_URL" ] || die "No runner package for $tag in release $REL_VERSION"
  [ -n "$REL_SHA" ] || die "The release notes carry no SHA-256 for $tag, refusing to install an unverified package"
  say "Latest package: version $REL_VERSION for $tag"
}
# download_runner DESTFILE: downloads REL_URL and checks REL_SHA.
download_runner() {
  curl -fsSL -o "$1" "$REL_URL"
  [ "$(sha256_of "$1")" = "$REL_SHA" ] || { rm -f "$1"; die "SHA-256 mismatch on the downloaded runner package"; }
  say "SHA-256 verified"
}
