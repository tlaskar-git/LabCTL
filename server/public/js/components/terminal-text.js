// Plain text helpers for the job terminal (no DOM, so node:test can import them).
// Lines keep their raw text without the '\n'; a '\r' stays in the text and is applied when the line is shown.
export const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[c]));

// A carriage return moves to the start of the line and the next text overwrites it, as a terminal does.
// "a\r\n" (CRLF) and a trailing "\r" leave the line as it was.
export function crText(t) {
  if (!t.includes('\r')) return t;
  const parts = t.split('\r');
  // shortcut: with colour codes the column count is unclear, so the last non-empty segment wins; upgrade if coloured progress bars look wrong.
  if (t.includes('\x1b')) return parts.filter(Boolean).pop() || '';
  let line = parts[0];
  for (const p of parts.slice(1)) line = p + line.slice(p.length);
  return line;
}

export const plainText = t => crText(t).replace(ANSI_RE, '');

// Appends streamed text to the model ({lines:[{t, s, ts, open}]}), joining a partial last line when the stream matches.
export function addText(m, stream, ts, text) {
  const s = stream === 'stderr' ? 'e' : 'o';
  const parts = String(text).split('\n');
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

// Incremental Server-Sent Events parser: feed it decoded text, it calls onEvent({type, data, id}) per event.
export function sseParser(onEvent) {
  let buf = '';
  let ev = { type: 'message', data: [], id: null };
  return text => {
    buf += text;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        if (ev.data.length) onEvent({ type: ev.type, data: ev.data.join('\n'), id: ev.id });
        ev = { type: 'message', data: [], id: null };
        continue;
      }
      if (line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      let value = i < 0 ? '' : line.slice(i + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') ev.type = value;
      else if (field === 'data') ev.data.push(value);
      else if (field === 'id') ev.id = value;
    }
  };
}

// The session token as a header. EventSource cannot send it and the session cookie can expire before the token,
// so every job output request goes through fetch with this header.
export function authHeaders(extra = {}) {
  let token = null;
  try { token = globalThis.localStorage?.getItem('labctl_token'); } catch { /* storage blocked */ }
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

// Reads one SSE response through fetch. Resolves with {status, events} when the server ends the stream;
// rejects on a network error or abort. onEvent gets every event as it arrives.
export async function readSse(url, onEvent, { signal, fetchFn = fetch } = {}) {
  const res = await fetchFn(url, { headers: authHeaders({ Accept: 'text/event-stream' }), credentials: 'same-origin', signal, cache: 'no-store' });
  if (!res.ok || !res.body) return { status: res.status, events: 0 };
  let events = 0;
  const parse = sseParser(e => { events++; onEvent(e); });
  const reader = res.body.getReader();
  const dec = new TextDecoder(); // stream mode keeps a UTF-8 character split across network packets whole
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parse(dec.decode(value, { stream: true }));
  }
  parse(dec.decode());
  return { status: res.status, events };
}
