// Job output files: data/job-logs/<job_id>.log, append-only, capped at job_log_max_bytes.
// Over the cap the file keeps the first half (head) and the last half (tail) with a marker line between.
// While a job runs, the tail lives in <job_id>.tail and is folded into the .log by finish().
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const MARKER = '\n[labctl] output truncated: the middle part was removed to keep the log under the size cap\n';

function createJobLog(dir, getMaxBytes = () => 20971520) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (id, ext = '.log') => {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(id))) throw new Error('Invalid job id');
    return path.join(dir, id + ext);
  };
  const size = p => { try { return fs.statSync(p).size; } catch { return -1; } };
  const half = () => Math.max(512, Math.floor(Number(getMaxBytes()) / 2));
  const lastBytes = (p, n) => {
    const total = size(p);
    if (total <= 0) return Buffer.alloc(0);
    const len = Math.min(n, total);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(p, 'r');
    try { fs.readSync(fd, buf, 0, len, total - len); } finally { fs.closeSync(fd); }
    return buf;
  };

  return {
    dir,
    path: id => file(id),
    // Each chunk also adds one line "<ms>\t<bytes>\t<o|e>" to <id>.idx (stream and time for replay and timestamps).
    // shortcut: the index stops at 4 MB, and replay falls back to untimed stdout once the cap trims the log.
    append(id, chunk, { stream = 'stdout', ts = Date.now() } = {}) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8');
      if (!data.length) return;
      const idxPath = file(id, '.idx');
      if (size(idxPath) < 4194304) fs.appendFileSync(idxPath, `${ts}\t${data.length}\t${stream === 'stderr' ? 'e' : 'o'}\n`);
      const logPath = file(id);
      const tailPath = file(id, '.tail');
      const h = half();
      if (size(tailPath) >= 0) {
        fs.appendFileSync(tailPath, data);
        if (size(tailPath) > 2 * h) fs.writeFileSync(tailPath, lastBytes(tailPath, h));
        return;
      }
      const logSize = Math.max(0, size(logPath));
      if (logSize + data.length <= 2 * h) { fs.appendFileSync(logPath, data); return; }
      // First overflow: keep the head in .log, move everything after it into .tail.
      const all = Buffer.concat([logSize ? fs.readFileSync(logPath) : Buffer.alloc(0), data]);
      fs.writeFileSync(tailPath, all.subarray(Math.max(h, all.length - h)));
      fs.truncateSync(logPath, Math.min(logSize, h));
      if (logSize < h) fs.appendFileSync(logPath, all.subarray(logSize, h));
    },
    finish(id) {
      const tailPath = file(id, '.tail');
      if (size(tailPath) < 0) return;
      fs.appendFileSync(file(id), Buffer.concat([Buffer.from(MARKER), lastBytes(tailPath, half())]));
      fs.unlinkSync(tailPath);
    },
    read(id) {
      const logPath = file(id);
      const tailPath = file(id, '.tail');
      const head = size(logPath) >= 0 ? fs.readFileSync(logPath, 'utf8') : '';
      if (size(tailPath) < 0) return head;
      return head + MARKER + lastBytes(tailPath, half()).toString('utf8');
    },
    // The log as the reader sees it (head, marker, tail) as one Buffer.
    readBuffer(id) {
      const logPath = file(id);
      const tailPath = file(id, '.tail');
      const head = size(logPath) >= 0 ? fs.readFileSync(logPath) : Buffer.alloc(0);
      if (size(tailPath) < 0) return head;
      return Buffer.concat([head, Buffer.from(MARKER), lastBytes(tailPath, half())]);
    },
    // Replay entries {stream, ts, chunk, end} from byte offset `from`, always covering every byte of the log.
    // The index only adds stream and time: records are used while they fit the log, the rest is one untimed stdout
    // entry, and an index longer than the log (the cap trimmed it) is ignored. `end` is the byte offset after the entry.
    // One decoder runs across entries, so a UTF-8 character split between two records stays whole.
    replay(id, from = 0, buf = this.readBuffer(id)) {
      let recs = [];
      try {
        recs = fs.readFileSync(file(id, '.idx'), 'utf8').split('\n').filter(Boolean).map(l => {
          const [ts, len, s] = l.split('\t');
          return { ts: Number(ts), len: Number(len), stream: s === 'e' ? 'stderr' : 'stdout' };
        });
      } catch { /* no index */ }
      const out = [];
      from = Math.max(0, Math.min(buf.length, Number(from) || 0));
      if (recs.some(r => !(r.len > 0)) || recs.reduce((n, r) => n + r.len, 0) > buf.length) recs = [];
      const dec = new StringDecoder('utf8');
      const push = (stream, ts, start, end) => {
        if (end <= from) return;
        const chunk = dec.write(buf.subarray(Math.max(start, from), end));
        if (chunk) out.push({ stream, ts, chunk, end });
        else if (out.length) out[out.length - 1].end = end; // bytes held for the next character still count as read
      };
      let pos = 0;
      for (const r of recs) { push(r.stream, r.ts, pos, pos + r.len); pos += r.len; }
      push('stdout', null, pos, buf.length);
      const rest = dec.end(); // an incomplete character at the very end
      if (rest) { if (out.length) out[out.length - 1].chunk += rest; else out.push({ stream: 'stdout', ts: null, chunk: rest, end: buf.length }); }
      return out;
    },
    // Absolute path(s) of the stored output, in reading order (for streaming searches).
    files(id) { return [file(id), file(id, '.tail')].filter(p => size(p) >= 0); },
    tail(id, bytes = 4096) {
      const tailPath = file(id, '.tail');
      return lastBytes(size(tailPath) >= 0 ? tailPath : file(id), bytes).toString('utf8');
    },
    write(id, text) { fs.writeFileSync(file(id), String(text ?? '')); },
    remove(id) {
      for (const ext of ['.log', '.tail', '.idx']) { try { fs.unlinkSync(file(id, ext)); } catch { /* absent */ } }
    },
    // Delete log files not modified for `days`. Returns the number removed.
    prune(days) {
      const cutoff = Date.now() - days * 86400000;
      let n = 0;
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        try { if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); n++; } } catch { /* raced */ }
      }
      return n;
    }
  };
}

module.exports = { createJobLog, MARKER };
