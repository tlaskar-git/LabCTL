import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html } from '../ui.js';

// The token value is only shown when a token is created or rotated. The operator pastes it here.
// It lives in component state only (never in storage) and is used to build the install commands.
const TOKEN_OK = /^[A-Za-z0-9_-]{16,200}$/;

function CopyBlock({ text, addToast }) {
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); addToast('Copied', 'success'); } catch { addToast('Copy failed. Select the text and copy it.', 'error'); }
  };
  return html`<div class="copy-block"><code>${text}</code><button class="btn btn-sm" onClick=${copy}>Copy</button></div>`;
}

export default function AgentsPage({ addToast }) {
  const [tokens, setTokens] = useState(null);
  const [denied, setDenied] = useState(false);
  const [tokenId, setTokenId] = useState('');
  const [value, setValue] = useState('');
  const load = () => api('/api/tokens').then(t => {
    setTokens(t);
    setTokenId(id => id || (t.find(x => !x.revoked) || {}).id || '');
  }).catch(() => setDenied(true));
  useEffect(() => { load(); }, []);

  const act = async (fn) => { try { await fn(); await load(); } catch (e) { addToast(e.message, 'error'); } };
  const create = () => act(async () => {
    const t = await api('/api/tokens', { method: 'POST', body: { label: 'Agent enrolment' } });
    setTokenId(t.id); setValue(t.value); addToast('Token created. The value is filled in below and is not shown again.', 'success');
  });
  const rotate = () => act(async () => {
    if (!window.confirm('Rotate this token? Agents using the old value are disconnected.')) return;
    const t = await api(`/api/tokens/${tokenId}/rotate`, { method: 'POST' });
    setValue(t.value); addToast('Token rotated. The new value is filled in below and is not shown again.', 'success');
  });
  const revoke = () => act(async () => {
    if (!window.confirm('Revoke this token? Agents using it are disconnected.')) return;
    await api(`/api/tokens/${tokenId}/revoke`, { method: 'POST' });
    setValue(''); addToast('Token revoked', 'success');
  });

  const base = window.location.origin;
  const valid = TOKEN_OK.test(value.trim());
  const tok = valid ? value.trim() : '<token>';
  const linux = `curl -fsSL "${base}/install/linux.sh?token=${tok}" | sudo bash`;
  const mac = `curl -fsSL "${base}/install/mac.sh?token=${tok}" | sudo bash`;
  const windows = `irm "${base}/install/windows.ps1?token=${tok}" | iex`;
  return (
    html`<div>
      <div class="page-header"><div><div class="page-title">Install Agents</div><div class="page-desc">Run one command on the target host. The command downloads the setup script from this server with an enrolment token.</div></div></div>
      <div class="card">
        <div class="card-title" style=${{ marginBottom: 12 }}>Enrolment token</div>
        ${denied
          ? html`<div class="page-desc">Only administrators can manage enrolment tokens. Ask an administrator for a token value, paste it below and copy the commands.</div>`
          : html`<div style=${{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <select class="select input" style=${{ maxWidth: 360 }} value=${tokenId} onChange=${e => setTokenId(e.target.value)}>
                ${(tokens || []).map(t => html`<option key=${t.id} value=${t.id}>${t.label}${t.revoked ? ' (revoked)' : ''}</option>`)}
              </select>
              <button class="btn btn-sm" onClick=${create}>New token</button>
              <button class="btn btn-sm" disabled=${!tokenId} onClick=${rotate}>Rotate</button>
              <button class="btn btn-sm btn-danger" disabled=${!tokenId} onClick=${revoke}>Revoke</button>
            </div>`}
        <input class="input" type="password" autocomplete="off" placeholder="Paste the token value (kept in memory only)"
          value=${value} onInput=${e => setValue(e.target.value)} />
        ${value && !valid ? html`<div class="page-desc" style=${{ marginTop: 8 }}>This does not look like a token value.</div>` : null}
        <div class="page-desc" style=${{ marginTop: 8 }}>The value is shown once, when you create or rotate a token. Rotate a token to get a new value.</div>
      </div>
      <div class="card">
        <div class="card-title" style=${{ marginBottom: 12 }}>Linux</div>
        <${CopyBlock} text=${linux} addToast=${addToast} />
        <div class="page-desc" style=${{ marginTop: 8 }}>Debian, Ubuntu, RHEL family and SUSE. Installs a systemd service and a watchdog timer. For a host without systemd, end the command with <code>sudo bash -s -- --no-service</code>.</div>
      </div>
      <div class="card">
        <div class="card-title" style=${{ marginBottom: 12 }}>macOS</div>
        <${CopyBlock} text=${mac} addToast=${addToast} />
      </div>
      <div class="card">
        <div class="card-title" style=${{ marginBottom: 12 }}>Windows PowerShell as Administrator</div>
        <${CopyBlock} text=${windows} addToast=${addToast} />
        <div class="page-desc" style=${{ marginTop: 8 }}>Installs Python if it is missing, then registers the LabCTL-Agent and LabCTL-Agent-Watchdog tasks as SYSTEM.</div>
      </div>
    </div>`
  );
}
