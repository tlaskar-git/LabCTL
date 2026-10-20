import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons } from '../ui.js';
import { GithubCard } from './github.js';
import { SectionHeader, Skeleton } from '../components/ui-kit.js';

// Each field: key, label, type (number, text, channels), optional hint. Saved with PUT /api/settings (admin).
const SECTIONS = [
  { title: 'General', desc: 'Time zone and how this server is reached.', fields: [
    { key: 'timezone', label: 'Time zone (IANA name)', type: 'text', hint: 'Schedules, patch policies and maintenance windows use this zone.' },
    { key: 'public_url', label: 'Public URL of this server', type: 'text', hint: 'Used for links in notifications. Leave empty if unknown.' },
    { key: 'poll_interval_seconds', label: 'Poll interval for agentless hosts (seconds)', type: 'number' }] },
  { title: 'Retention', desc: 'How long history is kept. Older rows are removed each night.', fields: [
    { key: 'jobs_days', label: 'Keep jobs (days)', type: 'number' }, { key: 'job_logs_days', label: 'Keep job logs (days)', type: 'number' },
    { key: 'metrics_days', label: 'Keep metrics (days)', type: 'number' }, { key: 'audit_days', label: 'Keep audit log (days)', type: 'number' },
    { key: 'job_log_max_bytes', label: 'Largest job log (bytes)', type: 'number', hint: 'Over this size a log keeps its first and last half.' }] },
  { title: 'Patching and compliance', desc: 'Patch speed and the thresholds the Compliance page flags.', fields: [
    { key: 'patch_concurrency', label: 'Hosts patched at once within a ring', type: 'number' },
    { key: 'compliance_patch_days', label: 'Flag patch age over (days)', type: 'number' },
    { key: 'compliance_backup_days', label: 'Flag hosts with no successful backup job in (days)', type: 'number' },
    { key: 'compliance_eol_warn_days', label: 'Warn before end of life (days)', type: 'number' },
    { key: 'backup_job_pattern', label: 'Backup job pattern (regular expression)', type: 'text', hint: 'Matched against job type, template id and script name.' },
    { key: 'cert_domains', label: 'Certificate check domains (comma separated, host or host:port)', type: 'text' }] },
  { title: 'Daily health report', desc: 'A summary of the fleet, sent once a day.', fields: [{ key: 'health_report_channels', label: 'Send the report through these channels', type: 'channels', hint: 'Empty uses the default alert channels.' }] }
];

function Section({ title, desc, children }) {
  const id = `sec-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return html`<section class="card" aria-labelledby=${id}>
    <${SectionHeader} id=${id} title=${title}/>${desc && html`<p class="hint" style=${{ margin: '-4px 0 14px' }}>${desc}</p>`}${children}</section>`;
}

export default function SettingsPage({ addToast }) {
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState({});
  const [channels, setChannels] = useState([]);
  const [saving, setSaving] = useState(false);

  const load = () => api('/api/settings').then(s => { setSaved(s); setForm({}); }).catch(e => addToast(e.message, 'error'));
  useEffect(() => { load(); api('/api/channels').then(setChannels).catch(() => {}); }, []);

  const value = key => (form[key] !== undefined ? form[key] : saved[key]);
  const dirty = Object.keys(form);
  const save = async () => {
    setSaving(true);
    try { await api('/api/settings', { method: 'PUT', body: form }); addToast('Settings saved'); await load(); } catch (e) { addToast(e.message, 'error'); } finally { setSaving(false); }
  };
  const toggleChannel = id => {
    const cur = value('health_report_channels') || [];
    setForm(f => ({ ...f, health_report_channels: cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id] }));
  };

  const header = html`<div class="page-header"><div><div class="page-title">Settings</div><div class="page-desc">Server behaviour, retention and the GitHub connection.</div></div></div>`;
  if (!saved) return html`<div>${header}<${Skeleton} rows=${4}/></div>`;
  return html`<div>
    ${header}
    <div class="page-stack">
    ${SECTIONS.map(sec => html`<${Section} key=${sec.title} title=${sec.title} desc=${sec.desc}>
      <div class="settings-grid">
        ${sec.fields.map(f => {
          const id = `set-${f.key}`;
          const changed = form[f.key] !== undefined;
          return html`<div key=${f.key} class="form-group">
            <label class="form-label" for=${id}>${f.label}${changed ? html` <span class="chip chip-info" style=${{ textTransform: 'none', letterSpacing: 0 }}>changed</span>` : null}</label>
            ${f.type === 'channels'
              ? html`<div id=${id} role="group" aria-label=${f.label} class="chip-row">${channels.map(c => html`<label key=${c.id} class="checkbox-row"><input type="checkbox"
                  checked=${(value(f.key) || []).includes(c.id)} onChange=${() => toggleChannel(c.id)}/> ${c.name}</label>`)}
                  ${channels.length === 0 && html`<div class="hint" style=${{ margin: 0 }}>No channels yet. Add one on the <a href="#/channels">Channels</a> page.</div>`}</div>`
              : html`<input id=${id} class="input" type=${f.type === 'number' ? 'number' : 'text'} value=${value(f.key) ?? ''}
                  aria-describedby=${f.hint ? `${id}-hint` : undefined} onInput=${e => setForm(x => ({ ...x, [f.key]: e.target.value }))}/>`}
            ${f.hint && html`<div id=${`${id}-hint`} class="hint" style=${{ marginTop: 4 }}>${f.hint}</div>`}
          </div>`;
        })}
      </div>
    <//>`)}
    <${Section} title="LabCTL updates" desc="Server and agent updates have their own page.">
      <a class="btn" href="#/updates"><${Icons.RefreshCw}/> Open Updates</a>
    <//>
    <${Section} title="GitHub"><${GithubCard} addToast=${addToast}/><//>
    </div>
    ${dirty.length > 0 && html`<div class="savebar" role="region" aria-label="Unsaved changes">
      <span>${dirty.length} unsaved ${dirty.length === 1 ? 'change' : 'changes'}</span>
      <button class="btn" onClick=${() => setForm({})}>Discard</button>
      <button class="btn btn-primary" onClick=${save} disabled=${saving}>${saving ? 'Saving' : 'Save changes'}</button>
    </div>`}
  </div>`;
}
