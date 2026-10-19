#!/bin/bash
# LabCTL agent setup for Linux. Run as root:
#   curl -fsSL "https://labctl.example.test/install/linux.sh?token=TOKEN" | sudo bash
#   sudo ./setup-linux.sh --server https://labctl.example.test --token TOKEN
#   sudo SERVER_URL=https://labctl.example.test TOKEN=TOKEN ./setup-linux.sh
#
# Options: --no-service  run the agent in the background instead of systemd (containers, no systemd)
#          --uninstall   stop the agent and remove /opt/labctl/agent
#
# Installs to /opt/labctl/agent with its own venv (websocket-client is never installed system wide).
# Uses labctl-agent.py from this folder when present, else downloads it from the server with the token.
# Re-running upgrades the agent in place. The server renders DEFAULT_SERVER and DEFAULT_TOKEN when it serves this script.
set -euo pipefail

DEFAULT_SERVER=''
DEFAULT_TOKEN=''

INSTALL_DIR="/opt/labctl/agent"
UNIT="labctl-agent"
SERVER_URL="${SERVER_URL:-$DEFAULT_SERVER}"
TOKEN="${TOKEN:-$DEFAULT_TOKEN}"
NO_SERVICE=0
UNINSTALL=0
PYTHON=""
TMP_FILES=()

usage() {
  echo "Usage: sudo $0 --server URL --token TOKEN [--no-service] [--uninstall]" >&2
  echo "   or: sudo SERVER_URL=URL TOKEN=TOKEN $0" >&2
  exit 2
}

cleanup() {
  if [ "${#TMP_FILES[@]}" -gt 0 ]; then
    rm -f -- "${TMP_FILES[@]}"
  fi
}
trap cleanup EXIT

stop_agent() {
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    systemctl disable --now "${UNIT}-watchdog.timer" "${UNIT}-watchdog.service" "$UNIT" >/dev/null 2>&1 || true
  fi
  if [ -f "${INSTALL_DIR}/agent.pid" ]; then
    local pid
    pid="$(cat "${INSTALL_DIR}/agent.pid")"
    kill "$pid" >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" >/dev/null 2>&1 || break
      sleep 1
    done
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "${INSTALL_DIR}/agent.pid"
  fi
}

pkg_install() {
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq && apt-get install -y -qq "$@"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q "$@"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q "$@"
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install "$@"
  else
    return 1
  fi
}

# A Python 3.8+ that can build a venv with pip.
find_python() {
  local c
  for c in python3 python3.13 python3.12 python3.11 python3.10 python3.9 python3.8; do
    if command -v "$c" >/dev/null 2>&1 \
      && "$c" -c 'import sys, venv, ensurepip; sys.exit(sys.version_info < (3, 8))' >/dev/null 2>&1; then
      PYTHON="$(command -v "$c")"
      return 0
    fi
  done
  return 1
}

# fetch URL OUTFILE: curl, then wget. The token goes through stdin or a private file, never the command line.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -fsSL --retry 3 -K - -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    local rc
    rc="$(mktemp)"
    TMP_FILES+=("$rc")
    printf 'header = Authorization: Bearer %s\n' "$TOKEN" > "$rc"
    WGETRC="$rc" wget -q -t 3 -O "$2" "$1"
  else
    echo "Neither curl nor wget is installed." >&2
    return 1
  fi
}

# The token goes through the environment, never the command line. An existing config keeps its other keys.
write_config() {
  umask 077
  LABCTL_SERVER_URL="$HTTP_BASE" LABCTL_TOKEN="$TOKEN" "$VENV_PY" - "$1" <<'PY'
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
      --no-service)
        NO_SERVICE=1
        shift
        ;;
      --uninstall)
        UNINSTALL=1
        shift
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

  [ "$(uname -s)" = "Linux" ] || { echo "This script is for Linux." >&2; exit 1; }
  [ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }

  if [ "$UNINSTALL" -eq 1 ]; then
    stop_agent
    rm -f "/etc/systemd/system/${UNIT}.service" "/etc/systemd/system/${UNIT}-watchdog.service" "/etc/systemd/system/${UNIT}-watchdog.timer"
    if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
      systemctl daemon-reload || true
      systemctl reset-failed "$UNIT" >/dev/null 2>&1 || true
    fi
    rm -rf -- "$INSTALL_DIR"
    echo "LabCTL agent removed."
    exit 0
  fi

  [ -n "$SERVER_URL" ] || usage
  [ -n "$TOKEN" ] || usage

  # https://host, wss://host/ws/agent and ws://host:port all map to the server's http(s) base URL.
  HTTP_BASE="$(printf '%s' "$SERVER_URL" | sed -e 's#^wss://#https://#' -e 's#^ws://#http://#' -e 's#/ws/agent.*$##' -e 's#/*$##')"
  case "$HTTP_BASE" in
    http://*|https://*) ;;
    *) HTTP_BASE="https://${HTTP_BASE}" ;;
  esac

  # Directory of this script when it is a real file (empty when piped into bash).
  SCRIPT_DIR=""
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  fi

  echo "=== LabCTL agent setup (Linux) ==="
  echo "Server: $HTTP_BASE"

  if ! find_python; then
    echo "Installing Python 3 and venv support"
    case "$(command -v apt-get || true)" in
      */apt-get) pkg_install python3 python3-venv || true ;;
      *) pkg_install python3 python3-pip || pkg_install python3 || true ;;
    esac
    find_python || { echo "Python 3.8 or newer with venv support is required and could not be installed." >&2; exit 1; }
  fi
  echo "Python: $PYTHON"

  stop_agent
  mkdir -p "$INSTALL_DIR"
  chmod 755 "$INSTALL_DIR"

  NEW_AGENT="${INSTALL_DIR}/labctl-agent.py.new"
  TMP_FILES+=("$NEW_AGENT")
  if [ -n "$SCRIPT_DIR" ] && [ -f "${SCRIPT_DIR}/labctl-agent.py" ]; then
    cp "${SCRIPT_DIR}/labctl-agent.py" "$NEW_AGENT"
  else
    echo "Downloading the agent from the server"
    fetch "${HTTP_BASE}/install/agent.py" "$NEW_AGENT" || { echo "Could not download the agent. Check the server URL and the token." >&2; exit 1; }
  fi

  VENV_PY="${INSTALL_DIR}/venv/bin/python"
  [ -x "$VENV_PY" ] || "$PYTHON" -m venv "${INSTALL_DIR}/venv"
  if [ -n "$SCRIPT_DIR" ] && [ -f "${SCRIPT_DIR}/requirements.txt" ]; then
    "$VENV_PY" -m pip install --quiet --disable-pip-version-check --upgrade -r "${SCRIPT_DIR}/requirements.txt"
  else
    "$VENV_PY" -m pip install --quiet --disable-pip-version-check --upgrade 'websocket-client>=1.6,<2'
  fi

  "$VENV_PY" -m py_compile "$NEW_AGENT"
  mv -f "$NEW_AGENT" "${INSTALL_DIR}/labctl-agent.py"
  chmod 755 "${INSTALL_DIR}/labctl-agent.py"
  rm -rf "${INSTALL_DIR}/__pycache__"

  write_config "${INSTALL_DIR}/agent.json"

  CONFIG="${INSTALL_DIR}/agent.json"
  AGENT="${INSTALL_DIR}/labctl-agent.py"
  if [ "$NO_SERVICE" -eq 0 ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    "$VENV_PY" "$AGENT" --config "$CONFIG" --install-service
    echo ""
    echo "=== LabCTL agent installed ==="
    echo "Status: systemctl status ${UNIT}"
    echo "Logs:   journalctl -u ${UNIT} -f"
  else
    [ "$NO_SERVICE" -eq 1 ] || echo "systemd is not running here. Starting the agent in the background without a service."
    # The shell writes its own pid, then becomes the agent, so stop_agent can find it later.
    # shellcheck disable=SC2016 # $$ must expand in the child shell
    setsid nohup sh -c 'echo $$ > "$1"; shift; exec "$@"' sh "${INSTALL_DIR}/agent.pid" "$VENV_PY" "$AGENT" --config "$CONFIG"       >> "${INSTALL_DIR}/agent.log" 2>&1 < /dev/null &
    echo ""
    echo "=== LabCTL agent started (no service) ==="
    echo "Logs:   tail -f ${INSTALL_DIR}/agent.log"
  fi
}

main "$@"
