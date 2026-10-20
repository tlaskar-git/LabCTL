// Built-in saved scripts seeded into the scripts table (moved unchanged from the v1 server.js).
const BUILTIN_SCRIPTS = [
  {
    id: 'builtin-proxmox-vm-backup-installer',
    name: 'Install Proxmox VM Backup Script',
    description: 'Creates /root/proxmox-vm-backup.sh on a Proxmox/Linux host. The installed script backs up selected VM IDs with vzdump snapshot mode and zstd compression, removes backups older than RETENTION_DAYS, and can optionally rclone sync the backup root to a configured remote. Edit VM_LIST, BACKUP_ROOT, retention, zstd level, and rclone settings before running the installed script.',
    os: 'linux',
    target: 'host',
    timeout: 120,
    command: `set -e
install -d -m 0755 /root
cat > /root/proxmox-vm-backup.sh <<'LABCTL_PROXMOX_BACKUP_SH'
#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# LabCTL Proxmox VM backup script
#
# What this does:
# - Backs up selected Proxmox VM IDs using vzdump snapshot mode.
# - Compresses each backup with zstd using ZSTD_LEVEL.
# - Stores backups in BACKUP_ROOT/HOSTNAME so each Proxmox host has its own folder.
# - Deletes local backup files older than RETENTION_DAYS.
# - Optionally syncs BACKUP_ROOT to an rclone remote for off-host backup storage.
# - Uses a lock file so two backups do not run at the same time.
#
# Before using:
# - Update VM_LIST with the VM IDs you want backed up.
# - Update BACKUP_ROOT to your mounted local/NAS backup path.
# - If using rclone, run "rclone config" first and set RCLONE_REMOTE.
# - Set ENABLE_RCLONE=1 only after the rclone remote has been tested.
###############################################################################

VM_LIST="100 101"
BACKUP_ROOT="/mnt/backups/proxmox"
RETENTION_DAYS=14
ZSTD_LEVEL=3

ENABLE_RCLONE=0
RCLONE_REMOTE="remote:proxmox"

HOST="$(hostname -s)"
HOST_BACKUP_DIR="$BACKUP_ROOT/$HOST"
LOG_DIR="/var/log/labctl"
LOGFILE="$LOG_DIR/proxmox-vm-backup.log"
RCLONE_LOG="$LOG_DIR/proxmox-vm-backup-rclone.log"
LOCKFILE="/tmp/proxmox-vm-backup.lock"

mkdir -p "$HOST_BACKUP_DIR" "$LOG_DIR"

if [ -f "$LOCKFILE" ]; then
  echo "Backup already running. Lock file exists at $LOCKFILE" | tee -a "$LOGFILE"
  exit 1
fi

command -v vzdump >/dev/null 2>&1 || {
  echo "vzdump was not found. Run this on a Proxmox host." | tee -a "$LOGFILE"
  exit 1
}

if [ "$ENABLE_RCLONE" = "1" ]; then
  command -v rclone >/dev/null 2>&1 || {
    echo "rclone was not found, but ENABLE_RCLONE=1." | tee -a "$LOGFILE"
    exit 1
  }
fi

touch "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

echo "============================" >> "$LOGFILE"
echo "Backup start $(date)" >> "$LOGFILE"
echo "Host $HOST" >> "$LOGFILE"
echo "Backup directory $HOST_BACKUP_DIR" >> "$LOGFILE"

################################
# BACKUP SELECTED VMS
################################

for VMID in $VM_LIST
do
  echo "Backing up VM $VMID" >> "$LOGFILE"

  vzdump "$VMID" \
    --mode snapshot \
    --compress zstd \
    --zstd "$ZSTD_LEVEL" \
    --dumpdir "$HOST_BACKUP_DIR" >> "$LOGFILE" 2>&1
done

echo "VM backup finished $(date)" >> "$LOGFILE"

################################
# CLEAN OLD LOCAL BACKUPS
################################

echo "Deleting backup files older than $RETENTION_DAYS days from $HOST_BACKUP_DIR" >> "$LOGFILE"
find "$HOST_BACKUP_DIR" -type f -mtime +"$RETENTION_DAYS" -delete

################################
# OPTIONAL RCLONE SYNC
################################

if [ "$ENABLE_RCLONE" = "1" ]; then
  echo "Starting rclone sync $(date)" >> "$RCLONE_LOG"

  rclone sync \
    "$BACKUP_ROOT" \
    "$RCLONE_REMOTE" \
    --fast-list \
    --transfers 4 \
    --checkers 8 \
    --delete-after \
    --log-file="$RCLONE_LOG" \
    --log-level INFO

  echo "rclone finished $(date)" >> "$RCLONE_LOG"
fi

echo "Backup complete $(date)" >> "$LOGFILE"
LABCTL_PROXMOX_BACKUP_SH
chmod 750 /root/proxmox-vm-backup.sh
echo "Installed /root/proxmox-vm-backup.sh"
echo "Edit VM_LIST, BACKUP_ROOT, RETENTION_DAYS, ZSTD_LEVEL, ENABLE_RCLONE, and RCLONE_REMOTE before running it."
echo "Run manually with: /root/proxmox-vm-backup.sh"`
  }
];
module.exports = BUILTIN_SCRIPTS;
