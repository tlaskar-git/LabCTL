import { useState, useEffect } from 'preact/hooks';
import { html, Modal, StubPage } from './ui.js';

// Command palette stub. Ctrl+K (Cmd+K on macOS) toggles an empty modal. A later item fills the body.
export function Palette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(o => !o); }
      else if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!open) return null;
  return html`<${Modal} title="Command palette" onClose=${() => setOpen(false)}>
    <${StubPage} bare title="Command palette" icon="Terminal"/>
  <//>`;
}
