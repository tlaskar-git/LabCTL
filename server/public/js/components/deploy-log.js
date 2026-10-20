import { useState, useEffect, useRef } from 'preact/hooks';
import { API } from '../api.js';
import { html } from '../ui.js';

const PHASES = [['preflight', 'Pre-flight'], ['upload', 'Upload'], ['install', 'Install'], ['wait_for_agent', 'Wait for agent']];

// Live log of one deploy: opens GET /api/deploy/:id/stream (SSE, the server strips ANSI codes and redacts secrets).
// onDone({ state, error, host_id }) runs once when the deploy ends.
export function DeployLog({ deployId, onDone }) {
  const [lines, setLines] = useState([]);
  const [phase, setPhase] = useState('preflight');
  const [end, setEnd] = useState(null);
  const box = useRef(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const es = new EventSource(`${API}/api/deploy/${encodeURIComponent(deployId)}/stream`);
    es.addEventListener('log', e => setLines(l => [...l, JSON.parse(e.data).line]));
    es.addEventListener('phase', e => setPhase(JSON.parse(e.data).phase));
    es.addEventListener('done', e => { const d = JSON.parse(e.data); setEnd(d); es.close(); done.current?.(d); });
    es.onerror = () => { if (es.readyState === 2) es.close(); }; // the browser retries by itself otherwise
    return () => es.close();
  }, [deployId]);

  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines]);

  const at = PHASES.findIndex(p => p[0] === phase);
  return html`<div>
    <div class="btn-group" style=${{ marginBottom: 8, flexWrap: 'wrap' }}>
      ${PHASES.map(([id, label], i) => html`<span key=${id} class=${`badge ${end ? (end.state === 'done' ? 'badge-online' : (i <= at ? 'badge-offline' : 'badge-pending'))
        : (i < at ? 'badge-online' : i === at ? 'badge-running' : 'badge-pending')}`}>${label}</span>`)}
    </div>
    <div class="output-log" ref=${box} style=${{ height: 260, maxHeight: 260 }} role="log" aria-live="polite">${lines.length ? lines.join('\n') : 'Starting...'}</div>
    ${end && end.state === 'failed' && html`<div style=${{ color: 'var(--red)', fontSize: 13, marginTop: 8 }}>${end.error}</div>`}
  </div>`;
}
