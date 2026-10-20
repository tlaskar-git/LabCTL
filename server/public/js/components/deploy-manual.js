import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { html } from '../ui.js';

const ROWS = [['linux', 'Linux'], ['mac', 'Mac'], ['windows', 'Windows (elevated PowerShell)']];

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

// Manual fallback: makes a fresh enrolment token and shows one install line per OS. The token value is shown once.
export function ManualInstall({ addToast, serverUrl }) {
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try { setRes(await api('/api/deploy/manual-commands', { method: 'POST', body: serverUrl ? { server_url: serverUrl } : {} })); } catch (e) { addToast(e.message, 'error'); }
    setBusy(false);
  };
  return html`<div>
    <div class="page-desc" style=${{ marginBottom: 12 }}>Run one line on the target as root (Linux, Mac) or in an elevated PowerShell (Windows). Each set of lines uses a new enrolment token that is shown only now.</div>
    ${!res && html`<button class="btn btn-primary" onClick=${make} disabled=${busy}>${busy ? 'Working...' : 'Generate commands'}</button>`}
    ${res && ROWS.map(([id, label]) => html`<div key=${id} class="form-group">
      <label class="form-label">${label}</label>
      <div style=${{ display: 'flex', gap: 8 }}>
        <input class="input" readonly value=${res.commands[id]} onFocus=${e => e.target.select()} aria-label=${`${label} install command`}/>
        <button class="btn" onClick=${async () => addToast((await copy(res.commands[id])) ? 'Copied' : 'Copy failed', 'success')}>Copy</button>
      </div>
    </div>`)}
    ${res && html`<div class="page-desc">The token is listed under Tokens as ${res.token_id.slice(0, 8)}. Revoke it there if you do not use it.</div>`}
  </div>`;
}
