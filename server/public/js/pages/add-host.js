import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Modal } from '../ui.js';
import { DeployLog, useDeployClose } from '../components/deploy-log.js';
import { ManualInstall } from '../components/deploy-manual.js';

const STEPS = ['Target', 'Credentials', 'Pre-flight', 'Install', 'Result'];
const OSES = [['linux', 'Linux'], ['mac', 'Mac'], ['windows', 'Windows']];
const field = (label, input, extra = {}) => html`<div class="form-group" style=${extra.style}><label class="form-label">${label}</label>${input}</div>`;
const mark = c => (!c.ok ? ['FAIL', 'var(--red)'] : c.warn ? ['WARN', 'var(--yellow)'] : ['PASS', 'var(--green)']);

// Modal page for route #/add-host: installs the LabCTL agent over the network (SSH, OpenSSH or WinRM), or shows one-line commands.
// Credentials are used for the install only. They are stored (sealed) only when "Save credential" is ticked (admin).
export default function AddHost({ onClose, addToast, currentUser }) {
  const isAdmin = currentUser?.role === 'admin';
  const [tab, setTab] = useState('network');
  const [step, setStep] = useState(0);
  const [f, setF] = useState({ address: '', port: '', os: 'linux', name: '', user: '', auth: 'password', password: '', private_key: '', passphrase: '',
    sudo_password: '', save_credential: false, relay_host_id: '', no_service: false });
  const [relays, setRelays] = useState([]);
  const [pre, setPre] = useState(null);
  const [busy, setBusy] = useState(false);
  const [deployId, setDeployId] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const text = (k, extra = {}) => ({ class: 'input', value: f[k], onInput: e => set(k, e.target.value), ...extra });

  useEffect(() => { api('/api/deploy/relays').then(setRelays).catch(() => {}); }, []);

  const windows = f.os === 'windows';
  const body = () => ({ address: f.address.trim(), port: f.port ? Number(f.port) : undefined, os: f.os, name: f.name || f.address,
    relay_host_id: f.relay_host_id || undefined, no_service: f.no_service,
    auth: { user: f.user.trim(), ...(f.auth === 'key' ? { private_key: f.private_key, passphrase: f.passphrase } : { password: f.password }),
      ...(f.sudo_password && !windows ? { sudo_password: f.sudo_password } : {}) } });

  const runPreflight = async () => {
    setStep(2); setBusy(true); setPre(null); setError('');
    try { setPre(await api('/api/deploy/preflight', { method: 'POST', body: body() })); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const install = async () => {
    setStep(3); setBusy(true); setError(''); setResult(null);
    try {
      const r = await api('/api/deploy/start', { method: 'POST', body: { ...body(), host_key: pre?.host_key || undefined, save_credential: f.save_credential } });
      setDeployId(r.deploy_id);
    } catch (e) { setError(e.message); setBusy(false); setStep(2); }
  };
  const finish = d => { setBusy(false); setResult(d); setStep(4); };

  const canNext = [!!f.address.trim() && !!f.os, !!f.user.trim() && (f.auth === 'key' ? !!f.private_key.trim() : !!f.password), !!pre?.ok, false, true][step];
  const loadKey = e => { const file = e.target.files?.[0]; if (file) file.text().then(v => set('private_key', v)); };

  const targetStep = html`<div>
    <div class="form-group"><label class="form-label">Operating system</label>
      <div class="btn-group">${OSES.map(([id, label]) => html`<button key=${id} class=${`btn ${f.os === id ? 'btn-primary' : ''}`} onClick=${() => set('os', id)}>${label}</button>`)}</div></div>
    <div class="form-row">
      ${field('Address', html`<input ...${text('address', { placeholder: '192.0.2.10 or host.example.test', autofocus: true })}/>`, { style: { flex: 2 } })}
      ${field(windows ? 'Port (blank: 22, then 5986, 5985)' : 'SSH port', html`<input class="input" type="number" min="1" max="65535" placeholder=${windows ? 'auto' : '22'} value=${f.port} onInput=${e => set('port', e.target.value)}/>`)}
    </div>
    ${field('Display name (optional)', html`<input ...${text('name', { placeholder: 'used in the token label' })}/>`)}
    <div class="page-desc">${windows ? 'Windows: OpenSSH on port 22 is tried first. If it is closed, WinRM with NTLM (5986 HTTPS, then 5985 HTTP).' : 'The server connects over SSH, uploads the agent and runs the setup with sudo.'}</div>
  </div>`;

  const credStep = html`<div>
    <div class="form-row">
      ${field(windows ? 'User (an administrator)' : 'User', html`<input ...${text('user', { placeholder: windows ? 'Administrator or DOMAIN\\name' : 'ubuntu' })}/>`)}
      ${field('Sign in with', html`<select class="select" value=${f.auth} onChange=${e => set('auth', e.target.value)}>
        <option value="password">Password</option><option value="key">Private key</option></select>`)}
    </div>
    ${f.auth === 'password'
      ? field('Password', html`<input ...${text('password', { type: 'password', autocomplete: 'new-password' })}/>`)
      : html`${field('Private key', html`<textarea class="textarea" rows="4" placeholder="Paste the private key (PEM)" value=${f.private_key} onInput=${e => set('private_key', e.target.value)}/>`)}
        <div class="form-row">
          ${field('Or load a key file', html`<input type="file" onChange=${loadKey}/>`)}
          ${field('Key passphrase (if any)', html`<input ...${text('passphrase', { type: 'password', autocomplete: 'new-password' })}/>`)}
        </div>`}
    ${!windows && field('sudo password (blank: same as the login password)', html`<input ...${text('sudo_password', { type: 'password', autocomplete: 'new-password' })}/>`)}
    ${!windows && field('Relay (optional)', html`<select class="select" value=${f.relay_host_id} onChange=${e => set('relay_host_id', e.target.value)}>
      <option value="">None, connect directly from the server</option>
      ${relays.map(r => html`<option key=${r.id} value=${r.id}>${r.hostname} (${r.os})</option>`)}</select>`)}
    ${!windows && f.relay_host_id && html`<div class="page-desc" style=${{ marginBottom: 8 }}>The relay runs ssh to the target for you. It needs OpenSSH 8.4 or newer, curl and tar. Host keys are not pinned. The agent still connects to this server from the target.</div>`}
    ${!windows && html`<label class="checkbox-row"><input type="checkbox" checked=${f.no_service} onChange=${e => set('no_service', e.target.checked)}/> No service: run the agent in the background (containers without systemd)</label>`}
    ${isAdmin && html`<label class="checkbox-row"><input type="checkbox" checked=${f.save_credential} onChange=${e => set('save_credential', e.target.checked)}/> Save credential (sealed on the server, used for Redeploy and Remove agent). Off: used for this install only.</label>`}
  </div>`;

  const preStep = html`<div>
    ${busy && html`<div class="page-desc">Checking ${f.address}...</div>`}
    ${pre && html`<table class="data-table" style=${{ width: '100%' }}><tbody>
      ${pre.checks.map(c => { const [label, colour] = mark(c); return html`<tr key=${c.name}>
        <td style=${{ width: 60, fontWeight: 700, color: colour }}>${label}</td><td style=${{ width: 220 }}>${c.name}</td><td>${c.detail}</td></tr>`; })}
    </tbody></table>`}
    ${pre && !pre.ok && html`<div style=${{ color: 'var(--red)', fontSize: 13, marginTop: 8 }}>Fix the failed checks, then check again. Or use the manual command tab.</div>`}
    ${pre?.host_key && html`<div class="page-desc" style=${{ marginTop: 8 }}>Host key ${pre.host_key}. It is pinned for the install.</div>`}
    ${error && html`<div style=${{ color: 'var(--red)', fontSize: 13 }}>${error}</div>`}
    <div style=${{ marginTop: 8 }}><button class="btn" onClick=${runPreflight} disabled=${busy}>Check again</button></div>
  </div>`;

  const resultStep = result && (result.state === 'done'
    ? html`<div>
        <div style=${{ color: 'var(--green)', fontWeight: 700, marginBottom: 8 }}>The agent is installed and registered.</div>
        <a class="btn btn-primary" href=${`#/host/${encodeURIComponent(result.host_id)}`} style=${{ textDecoration: 'none' }} onClick=${onClose}>Open the host</a>
      </div>`
    : html`<div>
        <div style=${{ color: 'var(--red)', fontWeight: 700, marginBottom: 4 }}>The install failed.</div>
        <div class="output-log" style=${{ marginBottom: 12 }}>${result.error}</div>
        <div class="page-desc">The deploy token was revoked. Nothing is left on the target except what the failed script did.</div>
        <div class="btn-group" style=${{ marginTop: 12 }}>
          <button class="btn btn-primary" onClick=${runPreflight}>Retry</button>
          <button class="btn" onClick=${() => setTab('manual')}>Use the manual command</button>
        </div>
      </div>`);

  const back = () => setStep(s => Math.max(0, s - 1));
  const next = () => (step === 1 ? runPreflight() : step === 2 ? install() : setStep(s => s + 1));
  const locked = step >= 3 && !result;
  const close = useDeployClose(locked && !!deployId, onClose, addToast);

  return html`<${Modal} title="Add host" onClose=${close}>
    <div class="tabs" style=${{ marginBottom: 12 }}>
      <button class=${`tab ${tab === 'network' ? 'active' : ''}`} onClick=${() => setTab('network')} disabled=${locked}>Install over the network</button>
      <button class=${`tab ${tab === 'manual' ? 'active' : ''}`} onClick=${() => setTab('manual')} disabled=${locked}>Manual command</button>
    </div>
    ${tab === 'manual' ? html`<${ManualInstall} addToast=${addToast}/>` : html`<div>
      <div class="btn-group" style=${{ marginBottom: 12, flexWrap: 'wrap' }} aria-label="Steps">
        ${STEPS.map((s, i) => html`<span key=${s} class=${`badge ${i === step ? 'badge-running' : i < step ? 'badge-online' : 'badge-pending'}`}>${i + 1}. ${s}</span>`)}
      </div>
      ${step === 0 && targetStep}
      ${step === 1 && credStep}
      ${step === 2 && preStep}
      ${step === 3 && deployId && html`<${DeployLog} deployId=${deployId} onDone=${finish}/>`}
      ${locked && html`<div class="btn-group" style=${{ justifyContent: 'flex-end', marginTop: 12 }}><button class="btn" onClick=${close}>Hide (the deploy goes on)</button></div>`}
      ${step === 4 && resultStep}
      ${error && step < 2 && html`<div style=${{ color: 'var(--red)', fontSize: 13 }}>${error}</div>`}
      ${step < 3 && html`<div class="btn-group" style=${{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button class="btn" onClick=${onClose}>Cancel</button>
        ${step > 0 && html`<button class="btn" onClick=${back} disabled=${busy}>Back</button>`}
        <button class="btn btn-primary" onClick=${next} disabled=${!canNext || busy}>${step === 1 ? 'Run pre-flight' : step === 2 ? 'Install' : 'Next'}</button>
      </div>`}
    </div>`}
  <//>`;
}
