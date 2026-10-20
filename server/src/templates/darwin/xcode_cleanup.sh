[ "$OS_NAME" = Darwin ] || die "This template is for macOS"
need_root
DAYS="${LABCTL_P_DAYS:-30}"; need_int DAYS "$DAYS"
U="${LABCTL_P_RUN_USER:-$(console_user)}"
need_match RUN_USER '^[A-Za-z0-9._-]+$' "$U"
H="$(home_of "$U")"; [ -d "$H" ] || die "No home directory for $U"
X="$H/Library/Developer/Xcode"
BEFORE="$(free_kb /)"
gate

step "DerivedData older than $DAYS days"
prune_older "$X/DerivedData" "$DAYS" 1
step "Unavailable simulators"
run as_user "$U" 'xcrun simctl delete unavailable'
step "Archives older than $DAYS days"
prune_older "$X/Archives" "$DAYS" 1
step "Device support older than $DAYS days"
for d in "iOS DeviceSupport" "watchOS DeviceSupport" "tvOS DeviceSupport"; do prune_older "$X/$d" "$DAYS" 1; done

AFTER="$(free_kb /)"
say "Space freed: $(( (AFTER - BEFORE) / 1024 )) MB (free now $(( AFTER / 1048576 )) GB)"
