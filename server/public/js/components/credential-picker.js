import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html } from '../ui.js';

// Picks a saved (shared) credential by name. Secrets never reach the browser: the list holds names only.
//   <CredentialPicker value=${id} onChange=${v => ...} allowInline/>
// onChange gets {credential_id: '<id>'} for a saved credential, or {credential_id: '', manual: true} for "Enter manually".
// value is the chosen credential id, or '' for manual entry. With allowInline=false the manual choice is not offered.
let seq = 0;
export function CredentialPicker({ value = '', onChange, allowInline = true, label = 'Saved credential', disabled = false }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [id] = useState(() => `cred-picker-${++seq}`);

  useEffect(() => {
    let live = true;
    api('/api/credentials/names').then(r => live && setItems(r)).catch(e => { if (live) { setError(e.message); setItems([]); } });
    return () => { live = false; };
  }, []);

  const change = e => {
    const v = e.target.value;
    onChange?.(v ? { credential_id: v } : { credential_id: '', manual: true });
  };
  const empty = items && items.length === 0 && !error;

  return html`<div class="form-group">
    <label class="form-label" for=${id}>${label}</label>
    <select id=${id} class="select" value=${value} onChange=${change} disabled=${disabled || !items} aria-describedby=${`${id}-hint`}>
      <option value="">${allowInline ? 'Enter manually' : 'Choose a saved credential'}</option>
      ${(items || []).map(c => html`<option key=${c.id} value=${c.id}>${c.name} (${c.kind === 'ssh_key' ? 'key' : 'password'}${c.domain ? `, ${c.domain}` : ''})</option>`)}
    </select>
    <div id=${`${id}-hint`} class="page-desc" role="status" style=${{ marginTop: 4, color: error ? 'var(--red)' : undefined }}>
      ${error ? `Saved credentials are not available: ${error}`
        : empty ? html`No saved credentials yet. An admin can add one on the <a href="#/credentials">Credentials</a> page.`
        : 'Saved credentials are encrypted. Their secrets are never shown.'}
    </div>
  </div>`;
}
