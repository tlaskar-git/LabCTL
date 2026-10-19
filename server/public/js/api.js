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
// subscribe(topic, fn) calls fn(data) now (if cached) and on every refresh.
// Transport today: poll GET /api/<topic> every 3 s while at least one listener exists.
// Replace the body of start() to move to another transport; callers do not change.
const POLL_MS = 3000;
const feeds = new Map();

function start(topic, feed) {
  const tick = async () => {
    try {
      feed.data = await api(`/api/${topic}`);
      feed.subs.forEach(fn => fn(feed.data));
    } catch (e) { console.error(e); }
  };
  tick();
  feed.timer = setInterval(tick, POLL_MS);
}

export function subscribe(topic, fn) {
  let feed = feeds.get(topic);
  if (!feed) { feed = { subs: new Set(), data: undefined, timer: null }; feeds.set(topic, feed); }
  feed.subs.add(fn);
  if (feed.data !== undefined) fn(feed.data);
  if (!feed.timer) start(topic, feed);
  return () => {
    feed.subs.delete(fn);
    if (!feed.subs.size) { clearInterval(feed.timer); feed.timer = null; feed.data = undefined; }
  };
}
