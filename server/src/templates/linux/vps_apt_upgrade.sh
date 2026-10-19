need_root
have apt-get || die "This template needs apt (Debian or Ubuntu)"
export DEBIAN_FRONTEND=noninteractive
APT=(apt-get -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=--force-confold -y)

step "Package lists"
run apt-get -o DPkg::Lock::Timeout=300 update
step "Upgradable packages"
apt list --upgradable 2>/dev/null | tail -n +2 || true
step "Held packages"
HOLD="$(apt-mark showhold || true)"
if [ -n "$HOLD" ]; then printf '%s\n' "$HOLD"; else say "none"; fi

step "Upgrade"
if truthy "${LABCTL_P_FULL_UPGRADE:-0}"; then run "${APT[@]}" full-upgrade; else run "${APT[@]}" upgrade; fi
if truthy "${LABCTL_P_AUTOREMOVE:-0}"; then run "${APT[@]}" autoremove; fi

step "Held back after the upgrade"
BACK="$(apt-get -s upgrade 2>/dev/null | awk '/^The following packages have been kept back:/ { f = 1; next } f && /^[[:space:]]/ { print; next } { f = 0 }' || true)"
if [ -n "$BACK" ]; then printf '%s\n' "$BACK"; else say "none"; fi

step "Reboot needed"
if [ -f /var/run/reboot-required ]; then
  say "Reboot required"; cat /var/run/reboot-required.pkgs 2>/dev/null || true; result reboot_required yes
else
  say "No reboot required"; result reboot_required no
fi
if have needrestart; then step "Services needing a restart"; needrestart -b -r l 2>/dev/null | grep -E '^NEEDRESTART-SVC' || say "none"; fi
