have pveversion || die "This is not a Proxmox VE host"
step "Version"
pveversion
if truthy "${LABCTL_P_REFRESH:-1}" && [ "$(id -u)" = 0 ] && [ "$DRY_RUN" = 0 ]; then
  step "Refresh package lists"
  apt-get -o DPkg::Lock::Timeout=120 update -qq
fi
step "Pending updates"
PENDING="$(apt list --upgradable 2>/dev/null | tail -n +2 || true)"
if [ -n "$PENDING" ]; then printf '%s\n' "$PENDING"; else say "none"; fi
result pve_updates_pending "$(printf '%s' "$PENDING" | grep -c . || true)"

step "Cluster"
pvecm status 2>/dev/null | grep -E 'Quorate|Nodes|Name' || say "Standalone node"

if have zpool; then
  step "ZFS pools"
  zpool list
  zpool status -x
  if [ -r /proc/spl/kstat/zfs/arcstats ]; then
    step "ZFS ARC"
    awk '$1 == "size" { printf "ARC size: %.1f GiB\n", $3 / 1073741824 } $1 == "c_max" { printf "ARC max:  %.1f GiB\n", $3 / 1073741824 }' /proc/spl/kstat/zfs/arcstats
  fi
fi

step "Storage usage"
pvesm status
step "Root filesystem"
df -h /
