import { useState, useEffect, useRef } from 'preact/hooks';
import { API, api } from '../api.js';
import { html } from '../ui.js';

const PHASES = [['preflight', 'Pre-flight'], ['upload', 'Upload'], ['install', 'Install'], ['wait_for_agent', 'Wait for agent']];
const OPEN_WAIT_MS = 5000;
const POLL_MS = 2000;

// Close handler for a dialog that shows a deploy: always closes, Escape included. Closing while the deploy runs only hides it:
// the run goes on in the server, and a toast says so.
export function useDeployClose(running, onClose, addToast) {
  const close = () => {
    if (running) addToast?.('The deploy goes on in the server. Its result shows in the host list and the audit log.');
    onClose();
  };
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') ref.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return close;
}

// Live log of one deploy: GET /api/deploy/:id/stream (SSE, the server strips ANSI codes and redacts secrets).
// When the stream does not open within 5 s or breaks, it falls back to polling GET /api/deploy/:id every 2 s.
// onDone({ state, error, host_id }) runs once when the deploy ends.
export function DeployLog({ deployId, onDone }) {
  const [lines, setLines] = useState([]);
  const [phase, setPhase] = useState('preflight');
  const [end, setEnd] = useState(null);
  const [note, setNote] = useState('Connecting to the live log...');
  const box = useRef(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const url = `/api/deploy/${encodeURIComponent(deployId)}`;
    let stopped = false;
    let live = false;
    let poll = null;
    let wait = null;
    const es = new EventSource(`${API}${url}/stream`);
    const stop = () => { stopped = true; es.close(); clearInterval(poll); clearTimeout(wait); };
    const finish = d => { if (stopped) return; stop(); setNote(''); setEnd(d); done.current?.(d); };
    const tick = async () => {
      try {
        const v = await api(url);
        if (stopped) return;
        setLines(v.lines || []);
        setPhase(v.phase);
        if (v.state !== 'running') finish({ state: v.state, error: v.error, host_id: v.host_id });
      } catch (e) {
        if (/not found/i.test(e.message)) finish({ state: 'failed', error: 'The server no longer knows this deploy (it restarted during the run). Check the host list and the audit log.' });
        else if (!stopped) setNote(`Lost the live stream, polling every 2 s. Last poll failed: ${e.message}`);
      }
    };
    const fallback = why => {
      if (stopped || poll) return;
      es.close();
      setNote(why);
      tick();
      poll = setInterval(tick, POLL_MS);
    };
    wait = setTimeout(() => { if (!live) fallback('The live log did not open within 5 s, polling every 2 s.'); }, OPEN_WAIT_MS);
    es.addEventListener('snapshot', () => { live = true; setNote(''); });
    es.addEventListener('log', e => setLines(l => [...l, JSON.parse(e.data).line]));
    es.addEventListener('phase', e => { live = true; setPhase(JSON.parse(e.data).phase); });
    es.addEventListener('done', e => finish(JSON.parse(e.data)));
    es.onerror = () => fallback('Lost the live stream, polling every 2 s.');
    return stop;
  }, [deployId]);

  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines]);

  const at = PHASES.findIndex(p => p[0] === phase);
  return html`<div>
    <div class="btn-group" style=${{ marginBottom: 8, flexWrap: 'wrap' }}>
      ${PHASES.map(([id, label], i) => html`<span key=${id} class=${`badge ${end ? (end.state === 'done' ? 'badge-online' : (i <= at ? 'badge-offline' : 'badge-pending'))
        : (i < at ? 'badge-online' : i === at ? 'badge-running' : 'badge-pending')}`}>${label}</span>`)}
    </div>
    ${note && lines.length > 0 && html`<div class="page-desc" style=${{ marginBottom: 6 }} role="status">${note}</div>`}
    <div class="output-log" ref=${box} style=${{ height: 260, maxHeight: 260 }} role="log" aria-live="polite">${lines.length ? lines.join('\n') : note || 'Waiting for the first line...'}</div>
    ${end && end.state === 'failed' && html`<div style=${{ color: 'var(--red)', fontSize: 13, marginTop: 8 }} role="alert">${end.error}</div>`}
  </div>`;
}
