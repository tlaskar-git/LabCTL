[ "$OS_NAME" = Darwin ] || die "This template is for macOS"
need_root
FAILS=0
bad() { warn "$*"; FAILS=$(( FAILS + 1 )); }
U="${LABCTL_P_RUN_USER:-}"
if [ -z "$U" ]; then
  FIRST="$(find_runners | head -n 1 || true)"
  if [ -n "$FIRST" ]; then U="$(owner_of "$FIRST")"; else U="$(console_user)"; fi
fi
need_match RUN_USER '^[A-Za-z0-9._-]+$' "$U"
say "Runner user: $U"

step "Console session"
CON="$(console_user)"; say "Console user: $CON"
[ "$CON" = "$U" ] || bad "The runner user has no GUI session ($CON is on the console). LaunchAgent runners need one."
pgrep -x loginwindow >/dev/null || bad "loginwindow is not running"

step "Automatic login"
AL="$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || echo none)"
say "autoLoginUser = $AL"
[ "$AL" = "$U" ] || bad "Automatic login is not set to the runner user. A reboot leaves the runner offline until someone signs in."

step "Login keychain"
HOME_U="$(home_of "$U")"
export LABCTL_KC="$HOME_U/Library/Keychains/login.keychain-db"
# A locked keychain with no GUI prompt gives "User interaction is not allowed"; an unlocked one reports "not found".
KC_OUT="$(as_user "$U" 'security find-generic-password -a labctl-probe -s labctl-probe "$LABCTL_KC" 2>&1 || true')"
if printf '%s' "$KC_OUT" | grep -qi "interaction is not allowed"; then bad "The login keychain is locked"
elif printf '%s' "$KC_OUT" | grep -qi "could not be found"; then say "Login keychain is unlocked"
else say "Keychain probe: $(printf '%s' "$KC_OUT" | head -n 1)"; fi

step "Runner LaunchAgent"
ls "$HOME_U"/Library/LaunchAgents/actions.runner.*.plist 2>/dev/null || bad "No runner LaunchAgent plist found for $U"

step "Sleep settings"
pmset -g | grep -E '^ *(sleep|displaysleep|disksleep)' || true

say "Problems: $FAILS"
result runner_check_problems "$FAILS"
[ "$FAILS" = 0 ] || exit 1
