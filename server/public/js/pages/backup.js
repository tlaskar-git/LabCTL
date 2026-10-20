import { useState, useEffect, useRef } from 'preact/hooks';
import { api, API, downloadBlob } from '../api.js';
import { html, Icons, Modal } from '../ui.js';

const fmtSize = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n === 0 ? '0 KB' : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtTime = (iso, timeZone) => (iso ? new Date(iso).toLocaleString('en-IE', { timeZone }) : 'never');
const RESTORE = 'docker compose stop labctl\ndocker compose run --rm --no-deps labctl node src/backup.js restore <backup file name> --force\ndocker compose start labctl';
const SECTION_LABELS = { settings: 'Settings', groups: 'Groups', tags: 'Tags', scripts: 'Scripts', hosts: 'Host details', channels: 'Notification channels', alert_rules: 'Alert rules',
  schedules: 'Schedules', runbooks: 'Runbooks', maintenance_windows: 'Maintenance windows', patch_policies: 'Patch policies', builtin_schedules: 'Built-in schedules', users: 'Users' };
const OP_BADGE = { create: 'completed', update: 'running', delete: 'failed', conflicts: 'failed', skip: 'pending' };

function TypedConfirm({ title, word, action, busy, onClose, onConfirm, children }) {
  const [typed, setTyped] = useState('');
  return html`<${Modal} title=${title} onClose=${onClose}>
    ${children}
    <div class="form-group" style=${{ margin: '12px 0' }}>
      <label class="form-label">Type <code>${word}</code> to confirm</label>
      <input class="input" autofocus value=${typed} onInput=${e => setTyped(e.target.value)} placeholder=${word}/>
    </div>
    <div class="btn-group" style=${{ justifyContent: 'flex-end' }}>
      <button class="btn" onClick=${onClose}>Cancel</button>
      <button class="btn btn-danger" disabled=${busy || typed !== word} onClick=${() => onConfirm(typed)}>${action}</button>
    </div>
  <//>`;
}

function StatusCard({ status, files, busy, onRun, onSaved, addToast }) {
  const [form, setForm] = useState(null);
  useEffect(() => { if (status) setForm({ backup_enabled: status.enabled, backup_time: status.time, backup_keep_days: status.keep_days }); }, [status?.enabled, status?.time, status?.keep_days]);
  const save = async () => {
    try {
      await api('/api/backup/settings', { method: 'PUT', body: { ...form, backup_keep_days: Number(form.backup_keep_days) } });
      addToast('Backup settings saved');
      onSaved();
    } catch (e) { addToast(e.message, 'error'); }
  };
  const last = status?.last;
  return html`<div class="card">
    <div class="card-header"><div class="card-title">Database backup</div>
      <button class="btn btn-primary" disabled=${busy} onClick=${onRun}><${Icons.HardDrive}/> ${busy ? 'Backing up' : 'Run backup now'}</button></div>
    <div class="form-row">
      <div class="form-group"><div class="form-label">Last backup</div>
        <div>${last ? html`<span class=${`badge badge-${last.ok ? 'completed' : 'failed'}`}>${last.ok ? 'ok' : 'failed'}</span> ${fmtTime(last.at)}` : 'never'}</div>
        ${last?.ok && html`<div class="form-label mono">${last.file} (${fmtSize(last.size)}), integrity check passed</div>`}
        ${last && !last.ok && html`<div class="form-label" style=${{ color: 'var(--red)' }}>${last.error}</div>`}</div>
      <div class="form-group"><div class="form-label">Next scheduled</div>
        <div>${status?.next ? fmtTime(status.next, status.timezone) : 'switched off'}</div>
        <div class="form-label">${status?.timezone || ''}</div></div>
      <div class="form-group"><div class="form-label">Stored</div>
        <div>${files.length} ${files.length === 1 ? 'file' : 'files'}, ${fmtSize(files.reduce((n, f) => n + f.size, 0))}</div>
        <div class="form-label mono">${status?.directory}</div></div>
    </div>
    ${form && html`<div class="form-row" style=${{ marginTop: 12, alignItems: 'flex-end' }}>
      <label class="checkbox-row" style=${{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked=${form.backup_enabled} onChange=${e => setForm({ ...form, backup_enabled: e.target.checked })}/> Nightly backup</label>
      <div class="form-group"><label class="form-label">Time (${status?.timezone})</label>
        <input class="input" type="time" value=${form.backup_time} onInput=${e => setForm({ ...form, backup_time: e.target.value })}/></div>
      <div class="form-group"><label class="form-label">Keep for (days)</label>
        <input class="input" type="number" min="1" max="3650" value=${form.backup_keep_days} onInput=${e => setForm({ ...form, backup_keep_days: e.target.value })}/></div>
      <button class="btn" onClick=${save}>Save</button>
    </div>`}
    <div class="form-label" style=${{ marginTop: 12 }}>The newest backup is never deleted and at least 3 files are always kept. A backup holds credentials only as sealed values.
      They stay encrypted with LABCTL_MASTER_KEY, so keep that key somewhere safe and apart from the backups. Without it a restored database cannot open its credentials.</div>
  </div>`;
}

function BackupList({ files, addToast, onChanged }) {
  const [del, setDel] = useState(null);
  const download = async (file) => {
    try {
      const token = localStorage.getItem('labctl_token');
      const res = await fetch(`${API}/api/backups/${encodeURIComponent(file)}/download`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: 'same-origin' });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      downloadBlob(await res.blob(), file, 'application/octet-stream');
    } catch (e) { addToast(e.message, 'error'); }
  };
  const remove = async (confirm) => {
    try { await api(`/api/backups/${encodeURIComponent(del)}`, { method: 'DELETE', body: { confirm } }); addToast('Backup deleted'); setDel(null); onChanged(); }
    catch (e) { addToast(e.message, 'error'); }
  };
  return html`<div class="card">
    <div class="card-header"><div class="card-title">Backups</div></div>
    <div class="table-wrap"><table>
      <thead><tr><th>File</th><th>Created</th><th>Size</th><th></th></tr></thead>
      <tbody>${files.map(f => html`<tr key=${f.file}>
        <td class="mono">${f.file}</td><td>${fmtTime(f.created)}</td><td>${fmtSize(f.size)}</td>
        <td><div class="btn-group">
          <button class="btn btn-sm" title="Download" onClick=${() => download(f.file)}><${Icons.Download}/></button>
          <button class="btn btn-sm btn-danger" title="Delete" onClick=${() => setDel(f.file)}><${Icons.Trash}/></button></div></td>
      </tr>`)}</tbody>
    </table></div>
    ${files.length === 0 && html`<div style=${{ textAlign: 'center', color: 'var(--text-dim)', padding: 30 }}>No backups yet.</div>`}
    ${del && html`<${TypedConfirm} title="Delete backup" word=${del} action="Delete" onClose=${() => setDel(null)} onConfirm=${remove}>
      <p>This deletes the file from the server. It cannot be undone.</p><//>`}
  </div>`;
}

function RestoreCard({ addToast }) {
  const copy = async () => {
    try { await navigator.clipboard.writeText(RESTORE); addToast('Copied'); } catch { addToast('Copy failed. Select the text and copy it by hand.', 'error'); }
  };
  return html`<div class="card">
    <div class="card-header"><div class="card-title">Restore from a backup</div>
      <button class="btn btn-sm" onClick=${copy}>Copy</button></div>
    <div class="form-label">Run these in the folder that holds docker-compose.yml. Replace the placeholder with a file name from the list above.
      The restore refuses to run while LabCTL is running. It keeps the replaced database as labctl.db.before-restore-(time).</div>
    <pre class="mono" style=${{ margin: '8px 0', padding: 10, whiteSpace: 'pre-wrap', userSelect: 'all' }}>${RESTORE}</pre>
  </div>`;
}

function ConfigCard({ addToast, onImported }) {
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [picked, setPicked] = useState({});
  const [mode, setMode] = useState('merge');
  const [users, setUsers] = useState(false);
  const [result, setResult] = useState(null);
  const [showSkips, setShowSkips] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);

  const exportConfig = async () => {
    try {
      const data = await api('/api/config/export');
      downloadBlob(JSON.stringify(data, null, 2), `labctl-config-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
      addToast('Config exported. It holds no passwords, tokens or channel secrets');
    } catch (e) { addToast(e.message, 'error'); }
  };

  const pick = async (e) => {
    const f = e.target.files[0];
    setResult(null); setParsed(null); setFile(null);
    if (!f) return;
    try {
      const doc = JSON.parse(await f.text());
      if (doc.format !== 'labctl-config' || doc.version !== 1 || !doc.data || typeof doc.data !== 'object') throw new Error('This is not a LabCTL config export (version 1).');
      setParsed(doc); setFile(f.name);
      setPicked(Object.fromEntries(Object.keys(doc.data).map(k => [k, true])));
    } catch (err) { addToast(err.message, 'error'); if (input.current) input.current.value = ''; }
  };
  const body = (dry, typed) => ({ format: parsed.format, version: parsed.version, data: parsed.data, mode, include_users: users,
    sections: Object.keys(picked).filter(k => picked[k]), dry_run: dry, ...(dry ? {} : { confirm: typed }) });

  const dryRun = async () => {
    setBusy(true);
    try { setResult(await api('/api/config/import', { method: 'POST', body: body(true) })); } catch (e) { addToast(e.message, 'error'); }
    setBusy(false);
  };
  const apply = async (typed) => {
    setBusy(true);
    try {
      const r = await api('/api/config/import', { method: 'POST', body: body(false, typed) });
      addToast(`Imported: ${r.counts.create} created, ${r.counts.update} updated, ${r.counts.delete} deleted`);
      setConfirm(false); setResult(null); setParsed(null); setFile(null);
      if (input.current) input.current.value = '';
      onImported();
    } catch (e) { addToast(e.message, 'error'); }
    setBusy(false);
  };

  const rows = result ? Object.entries(result.plan).flatMap(([op, list]) => list.map(r => ({ op, ...r }))).filter(r => showSkips || r.op !== 'skip') : [];
  const changes = result ? result.counts.create + result.counts.update + result.counts.delete : 0;
  return html`<div class="card">
    <div class="card-header"><div class="card-title">Config export and import</div>
      <button class="btn" onClick=${exportConfig}><${Icons.Download}/> Export config</button></div>
    <div class="form-label">The export is a JSON file of settings, groups, tags, scripts, schedules, runbooks, alert rules, channels, maintenance windows, patch policies,
      users (name and role) and host details. It never holds passwords, tokens, credentials, channel secrets or password hashes.</div>

    <div class="form-group" style=${{ marginTop: 16 }}>
      <label class="form-label">Import: choose an export file</label>
      <input ref=${input} class="input" type="file" accept=".json,application/json" onChange=${pick}/>
    </div>
    ${parsed && html`<div>
      <div class="form-label">${file}, exported ${fmtTime(parsed.exported_at)} from LabCTL ${parsed.labctl_version || '?'}</div>
      <div class="form-row" style=${{ margin: '8px 0', flexWrap: 'wrap' }}>
        ${Object.keys(parsed.data).map(k => html`<label key=${k} class="checkbox-row" style=${{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked=${!!picked[k]} onChange=${e => { setPicked({ ...picked, [k]: e.target.checked }); setResult(null); }}/> ${SECTION_LABELS[k] || k}</label>`)}
      </div>
      <div class="form-row" style=${{ alignItems: 'center' }}>
        <select class="select" value=${mode} onChange=${e => { setMode(e.target.value); setResult(null); }}>
          <option value="merge">Merge: add new, update matching names</option>
          <option value="replace_sections">Replace sections: also delete rows that are not in the file</option>
        </select>
        <label class="checkbox-row" style=${{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked=${users} onChange=${e => { setUsers(e.target.checked); setResult(null); }}/> Add missing users (created disabled, an admin sets the password)</label>
        <button class="btn btn-primary" disabled=${busy} onClick=${dryRun}>Dry run</button>
      </div>
      <div class="form-label">Matching is by name, so importing the same file twice changes nothing. Hosts are never created or deleted. Existing users are never changed.
        Replace sections applies to groups, tags, scripts, schedules, runbooks, alert rules and maintenance windows only. Channels are created disabled until their secrets are entered.</div>
    </div>`}

    ${result && html`<div style=${{ marginTop: 12 }}>
      <div class="card-title">Plan: ${result.counts.create} create, ${result.counts.update} update, ${result.counts.delete} delete, ${result.counts.skip} skip, ${result.counts.conflicts} conflicts</div>
      <label class="checkbox-row" style=${{ display: 'flex', gap: 6, margin: '6px 0' }}>
        <input type="checkbox" checked=${showSkips} onChange=${e => setShowSkips(e.target.checked)}/> Show skipped rows</label>
      <div class="table-wrap"><table>
        <thead><tr><th>Action</th><th>Section</th><th>Name</th><th>Note</th></tr></thead>
        <tbody>${rows.map((r, i) => html`<tr key=${i}><td><span class=${`badge badge-${OP_BADGE[r.op]}`}>${r.op === 'conflicts' ? 'conflict' : r.op}</span></td>
          <td>${SECTION_LABELS[r.section] || r.section}</td><td>${r.name}</td><td>${r.reason || ''}</td></tr>`)}</tbody>
      </table></div>
      ${rows.length === 0 && html`<div style=${{ color: 'var(--text-dim)', padding: 12 }}>Nothing to show.</div>`}
      ${result.counts.conflicts > 0 && html`<div style=${{ color: 'var(--red)', margin: '8px 0' }}>Fix the conflicts in the file before applying.</div>`}
      <button class="btn btn-danger" style=${{ marginTop: 8 }} disabled=${busy || result.counts.conflicts > 0 || changes === 0} onClick=${() => setConfirm(true)}>Apply import</button>
    </div>`}
    ${confirm && html`<${TypedConfirm} title="Apply import" word="IMPORT" action="Import" busy=${busy} onClose=${() => setConfirm(false)} onConfirm=${apply}>
      <p>${result.counts.create} created, ${result.counts.update} updated, ${result.counts.delete} deleted. All changes run in one transaction.
        Take a backup first if you are unsure.</p><//>`}
  </div>`;
}

export default function BackupPage({ addToast }) {
  const [status, setStatus] = useState(null);
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try { setStatus(await api('/api/backup/status')); setFiles(await api('/api/backups')); } catch (e) { addToast(e.message, 'error'); }
  };
  useEffect(() => { load(); }, []);
  const run = async () => {
    setBusy(true);
    try { const r = await api('/api/backup/run', { method: 'POST', body: {} }); addToast(`Backup written: ${r.file}`); } catch (e) { addToast(e.message, 'error'); }
    setBusy(false);
    load();
  };
  return html`<div>
    <div class="page-header"><div><div class="page-title">Backup</div>
      <div class="page-desc">Nightly database backups, restore steps, and config export and import.</div></div>
      <button class="btn" onClick=${load}><${Icons.RefreshCw}/> Refresh</button></div>
    <${StatusCard} status=${status} files=${files} busy=${busy} onRun=${run} onSaved=${load} addToast=${addToast}/>
    <${BackupList} files=${files} addToast=${addToast} onChanged=${load}/>
    <${RestoreCard} addToast=${addToast}/>
    <${ConfigCard} addToast=${addToast} onImported=${load}/>
  </div>`;
}
