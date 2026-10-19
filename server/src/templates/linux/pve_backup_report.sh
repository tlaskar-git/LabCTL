have pvesh || die "This is not a Proxmox VE host"
have python3 || die "python3 is required"
LIMIT="${LABCTL_P_LIMIT:-10}"; need_int LIMIT "$LIMIT"
step "Latest backup tasks (vzdump, including jobs that write to Proxmox Backup Server)"
pvesh get "/nodes/$(hostname)/tasks" --typefilter vzdump --limit "$LIMIT" --output-format json | python3 -c '
import json, sys, time
rows = json.load(sys.stdin)
for t in rows:
    when = time.strftime("%Y-%m-%d %H:%M", time.localtime(t.get("starttime", 0)))
    print("%s  %-10s  %s" % (when, t.get("status", "running"), t.get("id") or "-"))
print("LABCTL_RESULT recent_backup_failures=%d" % sum(1 for t in rows if t.get("status") not in ("OK", None)))
'
if have proxmox-backup-manager; then step "Proxmox Backup Server tasks"; proxmox-backup-manager task list --limit "$LIMIT" || true; fi
step "Backup storage"
pvesm status --content backup
