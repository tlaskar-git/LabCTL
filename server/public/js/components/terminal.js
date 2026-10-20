import { useState, useEffect, useRef } from 'preact/hooks';
import { AnsiUp } from '../../vendor/ansi_up/ansi_up.js';
import { API, downloadBlob } from '../api.js';
import { html } from '../ui.js';

// Live terminal for one job. It opens GET /api/jobs/:id/stream (SSE), keeps the output as lines in memory and paints
// only a window of them (the last LIVE_MAX lines while following, more on demand), so a 20 MB log does not freeze the page.
// Output is HTML-escaped by ansi_up before colour codes become spans; stderr lines get their own colour.
const TAIL_BYTES = 1048576;   // first load: only the last 1 MB, earlier output on demand
const EARLIER_BYTES = 1048576;
const LIVE_MAX = 4000;        // lines painted while following
const STEP = 2000;            // lines revealed per "show earlier lines"
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[c]));
const shown = t => (t.includes('\r') ? (t.split('\r').filter(Boolean).pop() || '') : t); // carriage return: last overwrite wins
const plain = l => l.p ?? (l.p = shown(l.t).replace(ANSI_RE, '').toLowerCase());
const pad = (n, w = 2) => String(n).padStart(w, '0');
const clock = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };

// Wraps matches of the (escaped) query inside text parts of an HTML string, never inside tags.
function mark(h, q) {
  const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return h.split(/(<[^>]*>)/).map(p => (p.startsWith('<') ? p : p.replace(re, m => `<mark>${m}</mark>`))).join('');
}

// Appends streamed text to the model, joining a partial last line when the stream matches.
function addText(m, stream, ts, text) {
  const s = stream === 'stderr' ? 'e' : 'o';
  const parts = text.split('\n');
  parts.forEach((piece, i) => {
    const ended = i < parts.length - 1;
    let cur = m.lines[m.lines.length - 1];
    if (!(cur && cur.open && cur.s === s)) {
      if (!ended && piece === '') return;
      if (cur) cur.open = false;
      cur = { t: '', s, ts, open: true };
      m.lines.push(cur);
    }
    cur.t += piece; cur.p = undefined;
    if (ended) cur.open = false;
  });
}

const CSS = `
.term{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:8px;background:var(--bg-primary);overflow:hidden;min-width:0}
.term-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--border);background:var(--bg-secondary)}
.term-bar .input{width:170px;padding:4px 8px;font-size:12px}
.term-bar label{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--text-secondary);cursor:pointer}
.term-info{margin-left:auto;font-size:11px;color:var(--text-dim)}
.term-scroll{height:var(--term-h,calc(100vh - 360px));min-height:240px;overflow:auto;position:relative;font-family:'Geist Mono',ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;padding:6px 0;color:var(--text-primary)}
.term-scroll .tl{padding:0 10px;white-space:pre;border-left:3px solid transparent;min-height:1.5em}
.term.wrap .tl{white-space:pre-wrap;word-break:break-all}
.term .tl.e{color:var(--orange);border-left-color:var(--orange);background:rgba(251,146,60,.08)}
.term .tl.cur{background:rgba(6,182,212,.2)}
.term mark{background:var(--yellow);color:#111;border-radius:2px}
.term .tt{color:var(--text-dim);margin-right:8px;user-select:none}
.term-more{display:block;width:100%;padding:6px;text-align:center;font-size:12px;color:var(--accent);background:transparent;border:0;cursor:pointer}
.ansi-black-fg{color:#6b7280}.ansi-red-fg{color:#ef4444}.ansi-green-fg{color:#22c55e}.ansi-yellow-fg{color:#eab308}
.ansi-blue-fg{color:#60a5fa}.ansi-magenta-fg{color:#d946ef}.ansi-cyan-fg{color:#06b6d4}.ansi-white-fg{color:#d1d5db}
.ansi-bright-black-fg{color:#9ca3af}.ansi-bright-red-fg{color:#f87171}.ansi-bright-green-fg{color:#4ade80}.ansi-bright-yellow-fg{color:#facc15}
.ansi-bright-blue-fg{color:#93c5fd}.ansi-bright-magenta-fg{color:#e879f9}.ansi-bright-cyan-fg{color:#22d3ee}.ansi-bright-white-fg{color:#f9fafb}
.ansi-black-bg{background:#374151}.ansi-red-bg{background:#b91c1c}.ansi-green-bg{background:#15803d}.ansi-yellow-bg{background:#a16207}
.ansi-blue-bg{background:#1d4ed8}.ansi-magenta-bg{background:#a21caf}.ansi-cyan-bg{background:#0e7490}.ansi-white-bg{background:#9ca3af}
.ansi-bright-black-bg{background:#4b5563}.ansi-bright-red-bg{background:#dc2626}.ansi-bright-green-bg{background:#16a34a}.ansi-bright-yellow-bg{background:#ca8a04}
.ansi-bright-blue-bg{background:#2563eb}.ansi-bright-magenta-bg{background:#c026d3}.ansi-bright-cyan-bg{background:#0891b2}.ansi-bright-white-bg{background:#e5e7eb}
[data-theme="light"] .ansi-black-fg,[data-theme="light"] .ansi-white-fg,[data-theme="light"] .ansi-bright-white-fg{color:#374151}
[data-theme="light"] .ansi-green-fg,[data-theme="light"] .ansi-bright-green-fg{color:#15803d}
[data-theme="light"] .ansi-yellow-fg,[data-theme="light"] .ansi-bright-yellow-fg{color:#a16207}
[data-theme="light"] .ansi-cyan-fg,[data-theme="light"] .ansi-bright-cyan-fg{color:#0e7490}
[data-theme="light"] .ansi-blue-fg,[data-theme="light"] .ansi-bright-blue-fg{color:#1d4ed8}
`;
function injectCss() {
  if (document.getElementById('term-css')) return;
  const el = document.createElement('style');
  el.id = 'term-css';
  el.textContent = CSS;
  document.head.appendChild(el);
}

// props: jobId, initialSearch, onEvent({type:'meta'|'status'|'done'|'bytes', ...}), name (download file name)
export function Terminal({ jobId, initialSearch = '', onEvent, name = 'job' }) {
  const box = useRef(null);
  const body = useRef(null);
  const model = useRef(null);
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [times, setTimes] = useState(false);
  const [q, setQ] = useState(initialSearch);
  const [count, setCount] = useState({ n: 0, at: 0 });
  const [info, setInfo] = useState({ live: true, earlier: false, hidden: 0 });
  const [copied, setCopied] = useState(false);
  // Latest values for code that runs outside Preact's render cycle.
  const opt = useRef({});
  opt.current = { follow, times, q, onEvent };

  function newModel() { return { lines: [], start: 0, earliest: null, cur: -1, matches: [], jump: !!initialSearch, timer: null, lastPaint: 0, bytesAt: 0 }; }

  function paint() {
    const m = model.current;
    const el = body.current;
    if (!m || !el) return;
    const { follow: f, times: t, q: query } = opt.current;
    if (f && !m.pinned && m.lines.length - m.start > LIVE_MAX) m.start = m.lines.length - LIVE_MAX;
    const needle = query.trim().toLowerCase();
    m.matches = [];
    if (needle.length > 0) for (let i = 0; i < m.lines.length; i++) if (plain(m.lines[i]).includes(needle)) m.matches.push(i);
    if (m.jump && m.matches.length) { m.jump = false; m.cur = m.matches[0]; m.start = Math.min(m.start, Math.max(0, m.cur - 200)); setFollow(false); opt.current.follow = false; }
    const ansi = new AnsiUp();
    ansi.use_classes = true;
    const out = [];
    for (let i = m.start; i < m.lines.length; i++) {
      const l = m.lines[i];
      let h = ansi.ansi_to_html(shown(l.t));
      if (needle) h = mark(h, query.trim());
      out.push(`<div class="tl ${l.s}${i === m.cur ? ' cur' : ''}" data-i="${i}">${t && l.ts ? `<span class="tt">${clock(l.ts)}</span>` : ''}${h || '&#8203;'}</div>`);
    }
    m.lastPaint = performance.now();
    el.innerHTML = out.join('');
    if (opt.current.follow) box.current.scrollTop = box.current.scrollHeight;
    setCount(c => (c.n === m.matches.length && c.at === m.matches.indexOf(m.cur) ? c : { n: m.matches.length, at: m.matches.indexOf(m.cur) }));
    setInfo(i => (i.earlier === (m.earliest > 0) && i.hidden === m.start ? i : { ...i, earlier: m.earliest > 0, hidden: m.start }));
  }
  function schedule() {
    const m = model.current;
    if (!m || m.timer) return;
    m.timer = setTimeout(() => { m.timer = null; paint(); }, 120);
  }

  function goTo(line) {
    const m = model.current;
    m.cur = line;
    if (line < m.start) m.start = Math.max(0, line - 200);
    setFollow(false); opt.current.follow = false;
    paint();
    const el = body.current.querySelector(`[data-i="${line}"]`);
    if (el) box.current.scrollTop = Math.max(0, el.offsetTop - box.current.clientHeight / 2);
  }
  function step(dir) {
    const m = model.current;
    if (!m.matches.length) return;
    const at = m.matches.indexOf(m.cur);
    goTo(m.matches[(at + dir + m.matches.length) % m.matches.length]);
  }

  async function loadEarlier() {
    const m = model.current;
    setFollow(false); opt.current.follow = false;
    m.pinned = true; // reading history: keep what was revealed instead of trimming to the newest lines
    if (m.start > 0) { // lines already in memory
      const h = box.current.scrollHeight;
      m.start = Math.max(0, m.start - STEP);
      paint();
      box.current.scrollTop += box.current.scrollHeight - h;
      return true;
    }
    if (!(m.earliest > 0)) return false;
    const to = m.earliest;
    const from = Math.max(0, to - EARLIER_BYTES);
    const res = await fetch(`${API}/api/jobs/${encodeURIComponent(jobId)}/log?from=${from}&to=${to}`, { credentials: 'same-origin' });
    if (!res.ok || model.current !== m) return false;
    const textPart = await res.text();
    const lines = textPart.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    m.earliest = Number(res.headers.get('X-Log-Start')) || 0;
    const add = lines.map(t => ({ t, s: 'o', ts: null, open: false }));
    m.lines = add.concat(m.lines);
    m.cur = m.cur >= 0 ? m.cur + add.length : m.cur;
    const h = box.current.scrollHeight;
    m.start = Math.max(0, add.length - STEP);
    paint();
    box.current.scrollTop += box.current.scrollHeight - h;
    return add.length > 0;
  }

  useEffect(() => {
    injectCss();
    const m = newModel();
    model.current = m;
    setInfo({ live: true, earlier: false, hidden: 0 });
    const es = new EventSource(`${API}/api/jobs/${encodeURIComponent(jobId)}/stream?tail=${TAIL_BYTES}`);
    const emit = e => opt.current.onEvent && opt.current.onEvent(e);
    es.addEventListener('meta', e => {
      const d = JSON.parse(e.data);
      if (m.earliest === null) m.earliest = d.start;
      emit({ type: 'meta', ...d });
    });
    es.addEventListener('chunk', e => {
      const d = JSON.parse(e.data);
      addText(m, d.stream, d.ts, d.chunk);
      schedule();
      if (e.lastEventId && Date.now() - m.bytesAt > 250) { m.bytesAt = Date.now(); emit({ type: 'bytes', value: Number(e.lastEventId) }); }
    });
    es.addEventListener('status', e => emit({ type: 'status', ...JSON.parse(e.data) }));
    es.addEventListener('done', async e => {
      es.close();
      setInfo(i => ({ ...i, live: false }));
      paint();
      emit({ type: 'done', ...JSON.parse(e.data) });
      // A search opened from the log search results: load earlier output until the first match appears.
      for (let i = 0; i < 25 && m.jump && !m.matches.length && model.current === m && await loadEarlier(); i++);
    });
    es.onerror = () => { if (es.readyState === 2) setInfo(i => ({ ...i, live: false })); }; // closed for good (404, 401)
    return () => { es.close(); clearTimeout(m.timer); };
  }, [jobId]);

  useEffect(() => { paint(); }, [times, q, wrap]);

  const onScroll = () => {
    const el = box.current;
    const m = model.current;
    if (!el || !m || performance.now() - m.lastPaint < 80) return; // scroll caused by our own repaint
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== opt.current.follow) { opt.current.follow = atBottom; setFollow(atBottom); }
  };
  const toggleFollow = () => {
    const next = !follow;
    opt.current.follow = next; setFollow(next);
    if (next) paint();
  };

  const allText = () => model.current.lines.map(l => shown(l.t).replace(ANSI_RE, '')).join('\n');
  const copy = async () => {
    try { await navigator.clipboard.writeText(allText()); } catch {
      const ta = document.createElement('textarea'); ta.value = allText(); document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } finally { ta.remove(); }
    }
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  const download = async () => { // the whole stored log from the server, not only what is loaded here
    const res = await fetch(`${API}/api/jobs/${encodeURIComponent(jobId)}/log`, { credentials: 'same-origin' });
    if (res.ok) downloadBlob(await res.text(), `${name}.log`);
  };

  return html`<div class=${`term ${wrap ? 'wrap' : ''}`}>
    <div class="term-bar">
      <button class="btn btn-sm" onClick=${toggleFollow} title="Pause or resume auto-scroll">${follow ? 'Pause' : 'Follow'}</button>
      <label><input type="checkbox" checked=${times} onChange=${e => setTimes(e.target.checked)}/> Time</label>
      <label><input type="checkbox" checked=${wrap} onChange=${e => setWrap(e.target.checked)}/> Wrap</label>
      <input class="input" type="search" placeholder="Search log" value=${q} aria-label="Search log"
        onInput=${e => setQ(e.target.value)}
        onKeyDown=${e => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); } }}/>
      <button class="btn btn-sm" onClick=${() => step(-1)} disabled=${!count.n} aria-label="Previous match">Prev</button>
      <button class="btn btn-sm" onClick=${() => step(1)} disabled=${!count.n} aria-label="Next match">Next</button>
      <span class="term-info">${q.trim() ? `${count.n ? count.at + 1 : 0}/${count.n}  ` : ''}${info.live ? 'live' : 'ended'}</span>
      <button class="btn btn-sm" onClick=${copy}>${copied ? 'Copied' : 'Copy'}</button>
      <button class="btn btn-sm" onClick=${download}>Download .log</button>
    </div>
    <div class="term-scroll" ref=${box} onScroll=${onScroll}>
      ${(info.hidden > 0 || info.earlier) && html`<button class="term-more" onClick=${loadEarlier}>
        ${info.hidden > 0 ? `Show earlier lines (${info.hidden} hidden)` : 'Load earlier output from the server'}
      </button>`}
      <div ref=${body}></div>
    </div>
  </div>`;
}
