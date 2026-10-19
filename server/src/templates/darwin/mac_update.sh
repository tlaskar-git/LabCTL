[ "$OS_NAME" = Darwin ] || die "This template is for macOS"
need_root
RESTART=0; if truthy "${LABCTL_P_RESTART:-0}"; then RESTART=1; fi
ADMIN_USER="${LABCTL_P_ADMIN_USER:-}"

step "Available updates"
LIST="$(softwareupdate -l 2>&1 || true)"
printf '%s\n' "$LIST"
if printf '%s' "$LIST" | grep -q "No new software available"; then
  say "Nothing to install"
  result updates_available no
  result reboot_required no
  exit 0
fi
result updates_available yes
if printf '%s' "$LIST" | grep -qi "restart"; then result reboot_required yes; else result reboot_required no; fi

if [ "$(uname -m)" = arm64 ]; then
  say "Apple Silicon: macOS updates need a user credential (a volume owner). Without ADMIN_USER and its stored password the install can fail with an authorisation error."
fi

ARGS=(-i -a)
if [ "$RESTART" = 1 ]; then ARGS+=(--restart); fi
if truthy "${LABCTL_P_AGREE_TO_LICENSE:-0}"; then ARGS+=(--agree-to-license); fi
if [ -n "$ADMIN_USER" ]; then
  need_match ADMIN_USER '^[A-Za-z0-9._-]+$' "$ADMIN_USER"
  [ -n "${LABCTL_SECRET_ADMIN_PASSWORD:-}" ] || die "ADMIN_USER is set but no admin password was supplied"
  ARGS+=(--user "$ADMIN_USER" --stdinpass)
fi

step "Install"
if [ "$RESTART" = 1 ]; then gate; fi
if [ "$DRY_RUN" = 1 ]; then
  say "[dry-run] softwareupdate ${ARGS[*]}"
elif [ -n "$ADMIN_USER" ]; then
  printf '%s\n' "$LABCTL_SECRET_ADMIN_PASSWORD" | softwareupdate "${ARGS[@]}"
else
  softwareupdate "${ARGS[@]}"
fi

step "Remaining updates"
softwareupdate -l 2>&1 || true
