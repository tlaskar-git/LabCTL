import { useState, useEffect } from 'preact/hooks';
import { html, Icons, StubPage } from './ui.js';

// Job drawer stub. Any module calls openJobDrawer(jobId). A later item fills the body.
let current = null;
const listeners = new Set();

function set(jobId) {
  current = jobId;
  listeners.forEach(fn => fn(current));
}

export const openJobDrawer = jobId => set(jobId);
export const closeJobDrawer = () => set(null);

export function JobDrawer() {
  const [jobId, setJobId] = useState(current);
  useEffect(() => {
    listeners.add(setJobId);
    const onKey = e => { if (e.key === 'Escape') closeJobDrawer(); };
    window.addEventListener('keydown', onKey);
    return () => { listeners.delete(setJobId); window.removeEventListener('keydown', onKey); };
  }, []);
  if (jobId == null) return null;
  return html`<div class="drawer-overlay" onClick=${closeJobDrawer}>
    <aside class="drawer" onClick=${e => e.stopPropagation()}>
      <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div class="modal-title">${`Job ${jobId}`}</div>
        <button class="btn-close" onClick=${closeJobDrawer} aria-label="Close"><${Icons.X}/></button>
      </div>
      <${StubPage} bare title="Job details" icon="Activity"/>
    </aside>
  </div>`;
}
