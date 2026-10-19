#!/bin/bash
# LabCTL agent setup for macOS. Run as root:
#   sudo ./setup-mac.sh --server https://labctl.example.test --token <enrolment token>
#   sudo SERVER_URL=https://labctl.example.test TOKEN=<token> ./setup-mac.sh
#   curl -fsSL "https://labctl.example.test/install/mac.sh?token=<token>" | sudo bash
#
# Installs to /usr/local/labctl/agent with its own venv (websocket-client is never
# installed system wide), writes the launchd daemons com.labctl.agent and
# com.labctl.agent.watchdog, and rotates /var/log/labctl-agent.log with newsyslog.
# Uses labctl-agent.py from this folder when present, else downloads it from the server with the token.
# The server renders DEFAULT_SERVER and DEFAULT_TOKEN when it serves this script.
set -euo pipefail

DEFAULT_SERVER=''
DEFAULT_TOKEN=''

INSTALL_DIR="/usr/local/labctl/agent"
LABEL="com.labctl.agent"
WATCHDOG_LABEL="com.labctl.agent.watchdog"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"
WATCHDOG_PLIST="/Library/LaunchDaemons/${WATCHDOG_LABEL}.plist"
LOG_FILE="/var/log/labctl-agent.log"
NEWSYSLOG_CONF="/etc/newsyslog.d/labctl.conf"
SERVER_URL="${SERVER_URL:-$DEFAULT_SERVER}"
TOKEN="${TOKEN:-$DEFAULT_TOKEN}"
PYTHON=""

usage() {
  echo "Usage: sudo $0 --server URL --token TOKEN" >&2
  echo "   or: sudo SERVER_URL=URL TOKEN=TOKEN $0" >&2
  exit 2
}

main() {
exec < /dev/null # the script may arrive on stdin (curl | bash): keep commands from eating it
while [ "$#" -gt 0 ]; do
  case "$1" in
    --server)
      [ "$#" -ge 2 ] || usage
      SERVER_URL="$2"
      shift 2
      ;;
    --token)
      [ "$#" -ge 2 ] || usage
      TOKEN="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      if [ -z "$SERVER_URL" ]; then
        SERVER_URL="$1"
      elif [ -z "$TOKEN" ]; then
        TOKEN="$1"
      else
        usage
      fi
      shift
      ;;
  esac
done

[ -n "$SERVER_URL" ] || usage
[ -n "$TOKEN" ] || usage
[ "$(uname -s)" = "Darwin" ] || { echo "This script is for macOS." >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }

# Directory of this script when it is a real file (empty when piped into bash).
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
# https://host, wss://host/ws/agent and ws://host:port all map to the server's http(s) base URL.
HTTP_BASE="$(printf '%s' "$SERVER_URL" | sed -e 's#^wss://#https://#' -e 's#^ws://#http://#' -e 's#/ws/agent.*$##' -e 's#/*$##')"
case "$HTTP_BASE" in
  http://*|https://*) ;;
  *) HTTP_BASE="https://${HTTP_BASE}" ;;
esac

find_python() {
  if [ -x /Library/Developer/CommandLineTools/usr/bin/python3 ]; then
    PYTHON=/Library/Developer/CommandLineTools/usr/bin/python3
    return 0
  fi
  # /usr/bin/python3 is a stub that opens an install dialog when no developer tools exist.
  if xcode-select -p >/dev/null 2>&1 && /usr/bin/python3 -c 'import venv' >/dev/null 2>&1; then
    PYTHON=/usr/bin/python3
    return 0
  fi
  local p
  for p in /usr/local/bin/python3 /opt/homebrew/bin/python3; do
    if [ -x "$p" ]; then
      PYTHON="$p"
      return 0
    fi
  done
  return 1
}

install_clt() {
  echo "Installing the Command Line Tools for Python 3. This can take several minutes."
  local marker="/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress"
  local label
  touch "$marker"
  label="$(softwareupdate -l 2>/dev/null \
    | sed -n -e 's/^[[:space:]]*\* Label: \(Command Line Tools.*\)$/\1/p' -e 's/^[[:space:]]*\* \(Command Line Tools.*\)$/\1/p' \
    | tail -n 1)"
  if [ -z "$label" ]; then
    rm -f "$marker"
    echo "softwareupdate does not offer the Command Line Tools. Install them with: xcode-select --install" >&2
    exit 1
  fi
  softwareupdate -i "$label" --verbose
  rm -f "$marker"
}

echo "=== LabCTL agent setup (macOS) ==="
echo "Server: $HTTP_BASE"

if ! find_python; then
  install_clt
  find_python || { echo "Python 3 is still missing after the Command Line Tools install." >&2; exit 1; }
fi
echo "Python: $PYTHON"

# Stop an existing install before replacing its files.
launchctl bootout "system/${WATCHDOG_LABEL}" 2>/dev/null || true
launchctl bootout "system/${LABEL}" 2>/dev/null || true
sleep 1

mkdir -p "$INSTALL_DIR"
chown root:wheel "$INSTALL_DIR"
chmod 755 "$INSTALL_DIR"

NEW_AGENT="${INSTALL_DIR}/labctl-agent.py.new"
if [ -n "$SCRIPT_DIR" ] && [ -f "${SCRIPT_DIR}/labctl-agent.py" ]; then
  cp "${SCRIPT_DIR}/labctl-agent.py" "$NEW_AGENT"
else
  echo "Downloading the agent from the server"
  # The token goes through stdin, never the command line.
  printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -fsSL --retry 3 -K - -o "$NEW_AGENT" "${HTTP_BASE}/install/agent.py"
fi

"$PYTHON" -m venv --clear "${INSTALL_DIR}/venv"
VENV_PY="${INSTALL_DIR}/venv/bin/python"
"$VENV_PY" -m pip install --quiet --disable-pip-version-check --upgrade pip
if [ -n "$SCRIPT_DIR" ] && [ -f "${SCRIPT_DIR}/requirements.txt" ]; then
  "$VENV_PY" -m pip install --quiet --disable-pip-version-check -r "${SCRIPT_DIR}/requirements.txt"
else
  "$VENV_PY" -m pip install --quiet --disable-pip-version-check 'websocket-client>=1.6,<2'
fi

"$VENV_PY" -m py_compile "$NEW_AGENT"
mv -f "$NEW_AGENT" "${INSTALL_DIR}/labctl-agent.py"
chmod 755 "${INSTALL_DIR}/labctl-agent.py"
rm -rf "${INSTALL_DIR}/__pycache__"

# The token goes through the environment, never the command line.
umask 077
LABCTL_SERVER_URL="$HTTP_BASE" LABCTL_TOKEN="$TOKEN" "$VENV_PY" - "${INSTALL_DIR}/agent.json" <<'PY'
import json, os, sys
path = sys.argv[1]
cfg = {}
if os.path.exists(path):
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
cfg["server_url"] = os.environ["LABCTL_SERVER_URL"]
cfg["token"] = os.environ["LABCTL_TOKEN"]
with open(path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
os.chmod(path, 0o600)
PY
umask 022

touch "$LOG_FILE"
chmod 640 "$LOG_FILE"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${VENV_PY}</string>
    <string>${INSTALL_DIR}/labctl-agent.py</string>
    <string>--config</string>
    <string>${INSTALL_DIR}/agent.json</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PYTHONUNBUFFERED</key>
    <string>1</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
</dict>
</plist>
EOF

cat > "$WATCHDOG_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${WATCHDOG_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${VENV_PY}</string>
    <string>${INSTALL_DIR}/labctl-agent.py</string>
    <string>--watchdog</string>
    <string>--config</string>
    <string>${INSTALL_DIR}/agent.json</string>
  </array>
  <key>StartInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
</dict>
</plist>
EOF

chown root:wheel "$PLIST" "$WATCHDOG_PLIST"
chmod 644 "$PLIST" "$WATCHDOG_PLIST"

mkdir -p "$(dirname "$NEWSYSLOG_CONF")"
cat > "$NEWSYSLOG_CONF" <<EOF
# logfilename                 [owner:group]  mode  count  size(KB)  when  flags
${LOG_FILE}     root:wheel     640   5      10240     *     J
EOF

launchctl bootstrap system "$PLIST"
launchctl enable "system/${LABEL}"
launchctl bootstrap system "$WATCHDOG_PLIST"
launchctl enable "system/${WATCHDOG_LABEL}"

echo ""
echo "=== LabCTL agent installed ==="
echo "Status: sudo launchctl print system/${LABEL}"
echo "Logs:   tail -f ${LOG_FILE}"
}

main "$@"
