import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons, Modal } from '../ui.js';
import { Chip, CopyField, EmptyState, KitIcons, SectionHeader, Segmented, Skeleton, relTime, absTime } from '../components/ui-kit.js';

// The token value is only shown when a token is created or rotated, or when the operator pastes one.
// It lives in component state only (never in storage) and is used to build the install commands.
const TOKEN_OK = /^[A-Za-z0-9_-]{16,200}$/;
const OS = [
  { id: 'linux', label: 'Linux', cmd: t => `curl -fsSL "${window.location.origin}/install/linux.sh?token=${t}" | sudo bash`,
    note: html`Debian, Ubuntu, RHEL family and SUSE. Installs a systemd service and a watchdog timer. Without systemd, end the command with <code>sudo bash -s -- --no-service</code>.` },
  { id: 'mac', label: 'macOS', cmd: t => `curl -fsSL "${window.location.origin}/install/mac.sh?token=${t}" | sudo bash`, note: 'Run it in Terminal on the Mac.' },
  { id: 'windows', label: 'Windows', cmd: t => `irm "${window.location.origin}/install/windows.ps1?token=${t}" | iex`,
    note: 'Run it in PowerShell as Administrator. Installs Python if it is missing, then registers the LabCTL-Agent and LabCTL-Agent-Watchdog tasks as SYSTEM.' },
];

function InstallCard({ value, setValue, fresh, isAdmin, addToast, cardRef }) {
  const [os, setOs] = useState('linux');
  const o = OS.find(x => x.id === os);
  const valid = TOKEN_OK.test(value.trim());
  return html`<section class="card" ref=${cardRef} tabindex="-1" aria-labelledby="install-h">
    <${SectionHeader} id="install-h" title="Install command"
      right=${html`<${Segmented} label="Operating system" value=${os} onChange=${setOs} options=${OS.map(x => [x.id, x.label])}/>`}/>
    <${CopyField} text=${o.cmd(valid ? value.trim() : '<token>')} addToast=${addToast}/>
    <p class="hint">${o.note}</p>
    ${fresh
      ? html`<div class="callout ok" style=${{ marginTop: 12 }}><${KitIcons.Check}/><div>The command uses the new token <b>${fresh}</b>.</div></div>`
      : html`<details class="disclose" open=${!!value} style=${{ marginTop: 12 }}>
          <summary><${KitIcons.Chevron}/>${valid ? 'Token value pasted' : 'Paste a token value'}</summary>
          <input class="input" type="password" autocomplete="off" aria-label="Token value" style=${{ marginTop: 8 }}
            placeholder="Kept in this page only, never stored" value=${value} onInput=${e => setValue(e.target.value)}/>
          ${value && !valid ? html`<div class="row-err" style=${{ marginTop: 6 }}>This does not look like a token value.</div>` : null}
          <p class="hint">${isAdmin ? 'A token value is shown once, when you create or rotate it below.' : 'Ask an administrator for a token value.'}</p>
        </details>`}
  </section>`;
}

const tokenSub = t => (t.revoked
  ? `Revoked ${relTime(t.revoked_at)}`
  : `Created ${relTime(t.created_at)}${t.created_by ? ` by ${t.created_by}` : ''} · ${t.last_used ? `last used ${relTime(t.last_used)}` : 'never used'}`);

function TokensCard({ addToast, onValue, onShowCommand }) {
  const [tokens, setTokens] = useState(null);
  const [label, setLabel] = useState('');
  const [reveal, setReveal] = useState(null);
  const [ask, setAsk] = useState(null);
  const [showRevoked, setShowRevoked] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef(null);
  useEffect(() => { if (ask) setTimeout(() => cancelRef.current?.focus(), 0); }, [ask]);
  const load = () => api('/api/tokens').then(setTokens).catch(e => { setTokens([]); addToast(e.message, 'error'); });
  useEffect(() => { load(); }, []);

  const shown = (t, kind) => { setReveal({ ...t, kind }); onValue(t.value, t.label); };
  const create = async e => {
    e.preventDefault();
    setBusy(true);
    try { shown(await api('/api/tokens', { method: 'POST', body: { label: label.trim() || 'Agent enrolment' } }), 'created'); setLabel(''); await load(); }
    catch (err) { addToast(err.message, 'error'); } finally { setBusy(false); }
  };
  const confirm = async () => {
    const { t, action } = ask;
    setAsk(null);
    try {
      const r = await api(`/api/tokens/${t.id}/${action}`, { method: 'POST' });
      if (action === 'rotate') shown(r, 'rotated');
      else { if (reveal?.id === t.id) { setReveal(null); onValue('', ''); } addToast(`Token ${t.label} revoked`); }
      await load();
    } catch (err) { addToast(err.message, 'error'); }
  };

  const active = (tokens || []).filter(t => !t.revoked), revoked = (tokens || []).filter(t => t.revoked);
  const row = t => html`<div class="row" key=${t.id}>
    <div class="row-main"><div class="row-title">${t.label}</div><div class="row-sub" title=${absTime(t.revoked ? t.revoked_at : t.created_at)}>${tokenSub(t)}</div></div>
    <${Chip} status=${t.revoked ? 'revoked' : 'active'} dot>${t.revoked ? 'Revoked' : 'Active'}<//>
    ${!t.revoked && html`<div class="row-actions">
      <button class="btn btn-sm" onClick=${() => setAsk({ t, action: 'rotate' })} aria-label=${`Rotate ${t.label}`}><${Icons.RefreshCw}/> Rotate</button>
      <button class="btn btn-sm" onClick=${() => setAsk({ t, action: 'revoke' })} aria-label=${`Revoke ${t.label}`}><${Icons.Stop}/> Revoke</button>
    </div>`}
  </div>`;

  return html`<section aria-labelledby="tokens-h">
    <${SectionHeader} id="tokens-h" title="Enrolment tokens" count=${tokens ? active.length : null}/>
    ${reveal && html`<div class="callout ok" style=${{ marginBottom: 12 }} role="status">
      <${Icons.Key}/>
      <div style=${{ flex: 1, minWidth: 0 }}>
        <b>Token ${reveal.label} ${reveal.kind}.</b> Copy the value now. It is not shown again.
        <div style=${{ margin: '8px 0' }}><${CopyField} text=${reveal.value} addToast=${addToast}/></div>
        <div class="btn-group">
          <button class="btn btn-sm btn-primary" onClick=${onShowCommand}>Show the install command</button>
          <button class="btn btn-sm" onClick=${() => setReveal(null)}>Done</button>
        </div>
      </div>
    </div>`}
    ${!tokens ? html`<${Skeleton} rows=${2}/>`
      : !active.length && !revoked.length ? html`<${EmptyState} icon="Key" title="No enrolment tokens yet" text="Create a token, then run the install command on a host."/>`
      : html`<div class="rows">${active.map(row)}${showRevoked && revoked.map(row)}
          ${!active.length && !showRevoked && html`<div class="row"><div class="row-sub">No active tokens. Create one below.</div></div>`}</div>
        ${revoked.length > 0 && html`<button class="btn btn-sm" style=${{ marginTop: 8 }} onClick=${() => setShowRevoked(s => !s)}>
          ${showRevoked ? 'Hide' : 'Show'} ${revoked.length} revoked</button>`}`}
    <form class="filter-bar" style=${{ marginTop: 12, marginBottom: 0 }} onSubmit=${create}>
      <input class="input grow" aria-label="Label for the new token" placeholder="Label, for example Site A (optional)" maxLength="100" value=${label} onInput=${e => setLabel(e.target.value)}/>
      <button class="btn btn-primary" type="submit" disabled=${busy}><${KitIcons.Plus}/> Create token</button>
    </form>
    ${ask && html`<${Modal} title=${ask.action === 'rotate' ? `Rotate ${ask.t.label}?` : `Revoke ${ask.t.label}?`} onClose=${() => setAsk(null)}>
      <p class="hint" style=${{ marginTop: 0 }}>${ask.action === 'rotate'
        ? 'You get a new value, shown once. Agents that use the old value are disconnected and need the new value to connect again.'
        : 'Agents that use this token are disconnected and cannot connect again. Hosts that use other tokens are not affected.'}</p>
      <div class="btn-group" style=${{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button class="btn" ref=${cancelRef} onClick=${() => setAsk(null)}>Cancel</button>
        <button class="btn btn-danger" onClick=${confirm}>${ask.action === 'rotate' ? 'Rotate token' : 'Revoke token'}</button>
      </div>
    <//>`}
  </section>`;
}

export default function AgentsPage({ addToast, currentUser }) {
  const [value, setValue] = useState('');
  const [fresh, setFresh] = useState('');
  const card = useRef(null);
  const isAdmin = currentUser?.role === 'admin';
  const onValue = (v, label) => { setValue(v || ''); setFresh(v ? label : ''); };
  const showCommand = () => { card.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); card.current?.focus({ preventScroll: true }); };
  return html`<div class="page-stack">
    <div class="page-header" style=${{ marginBottom: 0 }}><div><div class="page-title">Agents</div>
      <div class="page-desc">Install the agent on a host with one command.</div></div></div>
    <${InstallCard} value=${value} setValue=${v => { setValue(v); setFresh(''); }} fresh=${fresh} isAdmin=${isAdmin} addToast=${addToast} cardRef=${card}/>
    ${isAdmin && html`<${TokensCard} addToast=${addToast} onValue=${onValue} onShowCommand=${showCommand}/>`}
  </div>`;
}
