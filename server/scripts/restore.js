// Restore a LabCTL database backup: node scripts/restore.js <backup file> [--data-dir <dir>] --force
// The logic lives in src/backup.js because the Docker image ships src/ only (use: node src/backup.js restore ...).
process.exit(require('../src/backup').restoreMain(process.argv.slice(2)));
