// SQLite backups (online backup API), retention, nightly timer, server lock and the restore procedure.
// The same file is the restore CLI: node src/backup.js restore <backup file> [--data-dir dir] --force
// (the Docker image ships src/ but not scripts/, so the CLI lives here; scripts/restore.js is a thin wrapper).
// Backups hold credentials only as sealed blobs. They stay unreadable without the same LABCTL_MASTER_KEY.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const FILE_RE = /^labctl-[0-9TZ-]+\.db$/;
const LOCK_NAME = 'labctl.lock';
const LOCK_BEAT_MS = 15000;
const LOCK_STALE_MS = 60000;
const MIN_KEEP = 3; // never delete below this many files
const DEFAULTS = { backup_enabled: true, backup_time: '02:30', backup_keep_days: 14 };

// Validates the three backup settings. Returns { error } or { values }.
function validateSettings(patch = {}) {
  const values = {};
  if (patch.backup_enabled !== undefined) {
    if (typeof patch.backup_enabled !== 'boolean') return { error: 'backup_enabled must be true or false' };
    values.backup_enabled = patch.backup_enabled;
  }
  if (patch.backup_time !== undefined) {
    if (typeof patch.backup_time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.backup_time)) return { error: 'backup_time must be HH:MM (24 hour)' };
    values.backup_time = patch.backup_time;
  }
  if (patch.backup_keep_days !== undefined) {
    const n = Number(patch.backup_keep_days);
    if (!Number.isInteger(n) || n < 1 || n > 3650) return { error: 'backup_keep_days must be a whole number from 1 to 3650' };
    values.backup_keep_days = n;
  }
  return { values };
}

// Both sides are hashed first, so the compare has a fixed length and takes constant time.
function secretMatches(given, expected) {
  if (!expected || typeof given !== 'string') return false;
  const h = v => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(h(given), h(expected));
}

function createBackups(ctx) {
  const dir = path.join(ctx.paths.dataDir, 'backups');
  const lockPath = path.join(ctx.paths.dataDir, LOCK_NAME);
  let timer = null;
  let beat = null;
  let nextAt = null;
  let running = null;

  const get = key => { const v = ctx.settings.get(key); return v === undefined ? DEFAULTS[key] : v; };
  const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

  const self = {
    FILE_RE, dir,
    settings: () => ({ enabled: get('backup_enabled') !== false, time: get('backup_time'), keep_days: get('backup_keep_days') }),
    // Newest first.
    list() {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter(f => FILE_RE.test(f)).map(file => {
        const st = fs.statSync(path.join(dir, file));
        return { file, size: st.size, created: st.mtime.toISOString() };
      }).sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : b.file.localeCompare(a.file)));
    },
    resolve: file => (typeof file === 'string' && FILE_RE.test(file) ? path.join(dir, file) : null),
    remove(file) {
      const p = self.resolve(file);
      if (!p || !fs.existsSync(p)) return false;
      fs.unlinkSync(p);
      return true;
    },
    // Deletes files older than backup_keep_days. The newest MIN_KEEP files always stay.
    prune() {
      const cutoff = Date.now() - get('backup_keep_days') * 86400000;
      const gone = [];
      for (const f of self.list().slice(MIN_KEEP)) {
        if (new Date(f.created).getTime() < cutoff && self.remove(f.file)) gone.push(f.file);
      }
      return gone;
    },
    run() {
      if (running) return running; // one backup at a time; a second caller shares the result
      running = (async () => {
        fs.mkdirSync(dir, { recursive: true });
        let name = `labctl-${stamp()}`;
        for (let i = 1; fs.existsSync(path.join(dir, `${name}.db`)); i++) name = `labctl-${stamp()}-${i}`;
        const final = path.join(dir, `${name}.db`);
        const tmp = path.join(dir, `.tmp-${name}`);
        const at = new Date().toISOString();
        try {
          await ctx.db.backup(tmp);
          const copy = new Database(tmp);
          let result;
          try { copy.pragma('journal_mode = DELETE'); result = copy.pragma('integrity_check', { simple: true }); } finally { copy.close(); }
          if (result !== 'ok') throw new Error(`Integrity check failed: ${String(result).slice(0, 200)}`);
          fs.chmodSync(tmp, 0o600);
          fs.renameSync(tmp, final);
          const last = { ok: true, file: `${name}.db`, size: fs.statSync(final).size, at, error: null };
          ctx.settings.set('backup_last', last);
          try { self.prune(); } catch (e) { ctx.logger.error('[backup] prune:', e.message); }
          return last;
        } catch (err) {
          fs.rmSync(tmp, { force: true });
          const last = { ok: false, file: null, size: 0, at, error: String(err.message).slice(0, 300) };
          ctx.settings.set('backup_last', last);
          return last;
        }
      })().finally(() => { running = null; });
      return running;
    },
    last: () => ctx.settings.get('backup_last') || null,
    next: () => (self.settings().enabled ? nextAt : null),
    reschedule() {
      const s = self.settings();
      const [h, m] = s.time.split(':').map(Number);
      try { nextAt = ctx.scheduler.nextRun(`${m} ${h} * * *`); } catch { nextAt = null; }
    },
    // Ticks every 60 s. A run missed while the server was down is not caught up (same rule as schedules).
    start() {
      self.reschedule();
      timer = setInterval(async () => {
        if (!nextAt || Date.now() < new Date(nextAt).getTime()) return;
        const enabled = self.settings().enabled;
        self.reschedule();
        if (!enabled) return;
        const r = await self.run();
        ctx.audit('system', r.ok ? 'backup.nightly' : 'backup.failed', null, r.ok ? { file: r.file, size: r.size } : { error: r.error });
      }, 60000);
      timer.unref();
      try {
        fs.mkdirSync(ctx.paths.dataDir, { recursive: true });
        const touch = () => fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        touch();
        beat = setInterval(() => { try { touch(); } catch { /* data dir gone */ } }, LOCK_BEAT_MS);
        beat.unref();
      } catch { /* a missing lock only weakens the restore guard */ }
    },
    stop() {
      clearInterval(timer);
      clearInterval(beat);
      fs.rmSync(lockPath, { force: true });
    }
  };
  return self;
}

// ---- restore -------------------------------------------------------------------------------------------------------

// The server touches data/labctl.lock every 15 s and removes it on a clean stop. A lock younger than 60 s means it runs.
function serverRunning(dataDir, nowMs = Date.now()) {
  try { return nowMs - fs.statSync(path.join(dataDir, LOCK_NAME)).mtimeMs < LOCK_STALE_MS; } catch { return false; }
}

// Replaces data/labctl.db with a backup. The old file is kept as labctl.db.before-restore-<ts>, with its -wal and -shm renamed alongside.
function restore({ file, dataDir, force = false, now = new Date() }) {
  if (!force) throw new Error('Refusing to restore without --force. Stop the server first.');
  if (!file) throw new Error('Give the backup file to restore.');
  if (!dataDir) throw new Error('No data directory.');
  if (serverRunning(dataDir)) throw new Error('The server lock is fresh: LabCTL is running. Stop it first (the lock goes stale 60 seconds after the server stops).');
  let source = file;
  if (!path.isAbsolute(source) && !fs.existsSync(source)) source = path.join(dataDir, 'backups', path.basename(file));
  if (!fs.existsSync(source)) throw new Error(`Backup file not found: ${file}`);
  const check = new Database(source, { readonly: true, fileMustExist: true });
  try {
    const result = check.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`The backup failed its integrity check: ${String(result).slice(0, 200)}`);
    if (!check.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_version'").get()) throw new Error('The file is not a LabCTL database.');
  } finally { check.close(); }

  const live = path.join(dataDir, 'labctl.db');
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const kept = `${live}.before-restore-${ts}`;
  const incoming = path.join(dataDir, `.restore-${ts}.tmp`);
  fs.copyFileSync(source, incoming);
  fs.chmodSync(incoming, 0o600);
  const hadLive = fs.existsSync(live);
  if (hadLive) fs.renameSync(live, kept);
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(live + ext)) fs.renameSync(live + ext, kept + ext);
  }
  fs.renameSync(incoming, live);
  return { restored: path.basename(source), kept: hadLive ? path.basename(kept) : null };
}

function restoreMain(argv, env = process.env) {
  const args = argv.filter(a => a !== 'restore');
  const force = args.includes('--force');
  const i = args.indexOf('--data-dir');
  const dataDir = i >= 0 ? args[i + 1] : (env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const file = args.find((a, n) => !a.startsWith('--') && args[n - 1] !== '--data-dir');
  try {
    const r = restore({ file, dataDir, force });
    console.log(`Restored ${r.restored}.${r.kept ? ` The replaced database is kept as ${r.kept}.` : ''} Start LabCTL again. Use the same LABCTL_MASTER_KEY as when the backup was taken.`);
    return 0;
  } catch (err) {
    console.error(`restore: ${err.message}`);
    console.error('Usage: node src/backup.js restore <backup file> [--data-dir <dir>] --force');
    return 1;
  }
}

module.exports = { createBackups, validateSettings, secretMatches, restore, restoreMain, serverRunning, FILE_RE, MIN_KEEP, DEFAULTS };

if (require.main === module) process.exit(restoreMain(process.argv.slice(2)));
