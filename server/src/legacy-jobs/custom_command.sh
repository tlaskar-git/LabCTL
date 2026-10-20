# Custom Command: the operator's own command, run by bash from the environment, never from this script's text.
[ -n "${LABCTL_P_COMMAND:-}" ] || die "No command specified."
exec bash -c "$LABCTL_P_COMMAND"
