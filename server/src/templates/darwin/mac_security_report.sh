[ "$OS_NAME" = Darwin ] || die "This template is for macOS"
WARNS=0
flag() { warn "$*"; WARNS=$(( WARNS + 1 )); }

step "System integrity protection"
OUT="$(csrutil status 2>&1 || true)"; say "$OUT"
printf '%s' "$OUT" | grep -q "enabled" || flag "SIP is not enabled"
step "Gatekeeper"
OUT="$(spctl --status 2>&1 || true)"; say "$OUT"
printf '%s' "$OUT" | grep -q "enabled" || flag "Gatekeeper is not enabled"
step "FileVault"
OUT="$(fdesetup status 2>&1 || true)"; say "$OUT"
printf '%s' "$OUT" | grep -q "On" || flag "FileVault is off"
step "Application firewall"
OUT="$(/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>&1 || true)"; say "$OUT"
printf '%s' "$OUT" | grep -qi "enabled" || flag "The application firewall is off"
step "Automatic updates"
for k in AutomaticCheckEnabled AutomaticDownload AutomaticallyInstallMacOSUpdates CriticalUpdateInstall ConfigDataInstall; do
  printf '%s = %s\n' "$k" "$(defaults read /Library/Preferences/com.apple.SoftwareUpdate "$k" 2>/dev/null || echo unset)"
done
step "XProtect"
say "version $(defaults read /Library/Apple/System/Library/CoreServices/XProtect.bundle/Contents/Info CFBundleShortVersionString 2>/dev/null || echo unknown)"
step "Remote login and screen sharing"
launchctl print-disabled system 2>/dev/null | grep -E 'com.openssh.sshd|com.apple.screensharing' || say "No state recorded"
step "Pending software updates"
softwareupdate -l 2>&1 | head -n 30 || true
step "Install history (latest 5)"
softwareupdate --history 2>/dev/null | tail -n 5 || true

say "Warnings: $WARNS"
result security_warnings "$WARNS"
if truthy "${LABCTL_P_FAIL_ON_WARN:-0}" && [ "$WARNS" -gt 0 ]; then exit 1; fi
