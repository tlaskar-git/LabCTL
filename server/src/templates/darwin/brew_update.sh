[ "$OS_NAME" = Darwin ] || die "This template is for macOS"
U="${LABCTL_P_RUN_USER:-$(console_user)}"
need_match RUN_USER '^[A-Za-z0-9._-]+$' "$U"
if [ "$U" = root ] || [ "$U" = loginwindow ]; then die "No console user is signed in. Set the run user parameter"; fi
BREW=""
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do if [ -x "$b" ]; then BREW="$b"; break; fi; done
[ -n "$BREW" ] || die "Homebrew is not installed"
export LABCTL_BREW="$BREW" HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1
say "Running Homebrew as $U"

if [ "$DRY_RUN" = 1 ]; then
  step "Outdated formulae and casks"
  as_user "$U" '"$LABCTL_BREW" outdated --greedy'
  exit 0
fi
gate
step "brew update"
as_user "$U" '"$LABCTL_BREW" update'
step "brew upgrade"
as_user "$U" '"$LABCTL_BREW" upgrade'
if truthy "${LABCTL_P_CASKS:-0}"; then
  step "brew upgrade --cask --greedy"
  as_user "$U" '"$LABCTL_BREW" upgrade --cask --greedy'
fi
step "brew cleanup"
as_user "$U" '"$LABCTL_BREW" cleanup --prune=7'
