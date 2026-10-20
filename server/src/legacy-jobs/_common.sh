# LabCTL typed job (v1 job types run as v2 scripts). Parameters arrive as LABCTL_P_<NAME> environment variables
# and secrets as LABCTL_SECRET_<NAME>. Neither is ever placed inside code that a shell parses.
set -u
export LC_ALL=C
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
truthy() { case "${1:-}" in 1|true|TRUE|True|yes|YES|on) return 0 ;; *) return 1 ;; esac; }
is_int() { case "${1:-}" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
# Lists arrive one item per line (a comma list is accepted too).
list_of() { printf '%s\n' "${1:-}" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$' || true; }
# has_opt NAME: true when OPTIONS is empty (run everything) or names NAME.
has_opt() { [ -z "${LABCTL_P_OPTIONS:-}" ] || list_of "$LABCTL_P_OPTIONS" | grep -qx -- "$1"; }
IS_MAC=0; [ "$(uname -s)" = Darwin ] && IS_MAC=1
