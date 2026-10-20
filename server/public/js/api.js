// ── API helper ────────────────────────────────────────────
export const API = window.location.origin;

export async function api(path, opts = {}) {
  const token = localStorage.getItem('labctl_token');
  const { headers: optHeaders, ...fetchOpts } = opts;
  const res = await fetch(`${API}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(optHeaders || {})
    },
    credentials: 'same-origin',
    ...fetchOpts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !opts.allowUnauthorized) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export async function apiDownload(path, filename) {
  const token = localStorage.getItem('labctl_token');
  const res = await fetch(`${API}${path}`, {
    method: 'HEAD',
    headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    credentials: 'same-origin'
  });
  if (!res.ok) throw new Error('Download failed');
  const a = document.createElement('a');
  a.href = `${API}${path}`;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function downloadBlob(content, filename, type = 'text/plain') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ── Live updates ─────────────────────────────────────────
// subscribe(topic, fn) calls fn(data) now (if cached) and on every refresh. The topic is the path after /api/,
// so 'jobs?limit=50' works. One shared EventSource on /api/events sends small change notices (host online/offline,
// job status); each notice re-fetches every active topic. While the stream is down, topics poll every 3 s.
// With the stream up they still poll every 15 s as a safety net.
const POLL_MS = 3000;
const SAFETY_MS = 15000;
const feeds = new Map();
let source = null;
let live = false;
let burst = null;

function refreshAll() {
  clearTimeout(burst);
  burst = setTimeout(() => feeds.forEach(f => f.tick()), 150);
}

function retime() {
  feeds.forEach(f => { clearInterval(f.timer); f.timer = setInterval(f.tick, live ? SAFETY_MS : POLL_MS); });
}

function connect() {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource(`${API}/api/events`);
  source.onopen = () => { live = true; retime(); };
  source.onerror = () => { live = false; retime(); }; // the browser reconnects by itself
  source.addEventListener('host', refreshAll);
  source.addEventListener('job', refreshAll);
}

function disconnect() {
  if (source) source.close();
  source = null; live = false;
}

function start(topic, feed) {
  feed.tick = async () => {
    try {
      feed.data = await api(`/api/${topic}`);
      feed.subs.forEach(fn => fn(feed.data));
    } catch (e) { console.error(e); }
  };
  feed.tick();
  feed.timer = setInterval(feed.tick, live ? SAFETY_MS : POLL_MS);
  connect();
}

export function subscribe(topic, fn) {
  let feed = feeds.get(topic);
  if (!feed) { feed = { subs: new Set(), data: undefined, timer: null, tick: null }; feeds.set(topic, feed); }
  feed.subs.add(fn);
  if (feed.data !== undefined) fn(feed.data);
  if (!feed.timer) start(topic, feed);
  return () => {
    feed.subs.delete(fn);
    if (!feed.subs.size) {
      clearInterval(feed.timer); feed.timer = null; feed.data = undefined; feeds.delete(topic);
      if (!feeds.size) disconnect();
    }
  };
}
