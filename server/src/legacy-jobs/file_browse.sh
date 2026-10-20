# File Browser: ACTION=list (ls -lah of PATH) or ACTION=read (the first MAX_SIZE bytes of the file PATH).
path="${LABCTL_P_PATH:-/}"
case "${LABCTL_P_ACTION:-list}" in
  list) exec ls -lah -- "$path" ;;
  read)
    max="${LABCTL_P_MAX_SIZE:-50000}"
    is_int "$max" || die "MAX_SIZE must be a whole number."
    [ -f "$path" ] || die "Not a file: $path"
    exec head -c "$max" -- "$path" ;;
  *) die "Unknown action" ;;
esac
