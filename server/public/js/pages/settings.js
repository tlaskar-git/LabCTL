import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html } from '../ui.js';
import { UpdatesCard } from './updates.js';
import { GithubCard } from './github.js';

// Each field: key, label, type (number, text, channels), optional hint. Saved with PUT /api/settings (admin).
const SECTIONS = [
  { title: 'General', fields: [
    { key: 'timezone', label: 'Time zone (IANA name)', type: 'text', hint: 'Schedules, patch policies and maintenance windows use this zone.' },
    { key: 'public_url', label: 'Public URL of this server', type: 'text', hint: 'Used for links in notifications. Leave empty if unknown.' },
    { key: 'poll_interval_seconds', label: 'Poll interval for agentless hosts (seconds)', type: 'number' }] },
  { title: 'Retention', fields: [
    { key: 'jobs_days', label: 'Keep jobs (days)', type: 'number' }, { key: 'job_logs_days', label: 'Keep job logs (days)', type: 'number' },
    { key: 'metrics_days', label: 'Keep metrics (days)', type: 'number' }, { key: 'audit_days', label: 'Keep audit log (days)', type: 'number' },
    { key: 'job_log_max_bytes', label: 'Largest job log (bytes)', type: 'number', hint: 'Over this size a log keeps its first and last half.' }] },
  { title: 'Patching and compliance', fields: [
    { key: 'patch_concurrency', label: 'Hosts patched at once within a ring', type: 'number' },
    { key: 'compliance_patch_days', label: 'Flag patch age over (days)', type: 'number' },
    { key: 'compliance_backup_days', label: 'Flag hosts with no successful backup job in (days)', type: 'number' },
    { key: 'compliance_eol_warn_days', label: 'Warn before end of life (days)', type: 'number' },
    { key: 'backup_job_pattern', label: 'Backup job pattern (regular expression)', type: 'text', hint: 'Matched against job type, template id and script name.' },
    { key: 'cert_domains', label: 'Certificate check domains (comma separated, host or host:port)', type: 'text' }] },
  { title: 'Daily health report', fields: [{ key: 'health_report_channels', label: 'Send the report through these channels', type: 'channels', hint: 'Empty uses the default alert channels.' }] }
];

function Section({ title, children }) {
  return html`<div class="card" style=${{ marginBottom: 20 }} role="region" aria-label=${title}><div class="card-header"><div class="card-title">${title}</div></div>${children}</div>`;
}

export default function SettingsPage({ addToast }) {
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState({});
  const [channels, setChannels] = useState([]);

  const load = () => api('/api/settings').then(s => { setSaved(s); setForm({}); }).catch(e => addToast(e.message, 'error'));
  useEffect(() => { load(); api('/api/channels').then(setChannels).catch(() => {}); }, []);

  const value = key => (form[key] !== undefined ? form[key] : saved[key]);
  const dirty = Object.keys(form);
  const save = async () => {
    try { await api('/api/settings', { method: 'PUT', body: form }); addToast('Settings saved'); load(); } catch (e) { addToast(e.message, 'error'); }
  };
  const toggleChannel = id => {
    const cur = value('health_report_channels') || [];
    setForm(f => ({ ...f, health_report_channels: cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id] }));
  };

  if (!saved) return html`<div class="page-desc">Loading...</div>`;
  return html`<div>
    <div class="page-header">
      <div><div class="page-title">Settings</div><div class="page-desc">Server settings, LabCTL updates and the GitHub connection.</div></div>
      <button class="btn btn-primary" disabled=${!dirty.length} onClick=${save}>Save ${dirty.length ? `(${dirty.length})` : ''}</button>
    </div>
    ${SECTIONS.map(sec => html`<${Section} key=${sec.title} title=${sec.title}>
      <div style=${{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
        ${sec.fields.map(f => {
          const id = `set-${f.key}`;
          return html`<div key=${f.key} class="form-group" style=${{ marginBottom: 0 }}>
            <label class="form-label" for=${id}>${f.label}</label>
            ${f.type === 'channels'
              ? html`<div id=${id} role="group" aria-label=${f.label}>${channels.map(c => html`<label key=${c.id} class="checkbox-row"><input type="checkbox" class="checkbox"
                  checked=${(value(f.key) || []).includes(c.id)} onChange=${() => toggleChannel(c.id)}/> ${c.name}</label>`)}
                  ${channels.length === 0 && html`<div class="page-desc">No channels yet. Add one on the Channels page.</div>`}</div>`
              : html`<input id=${id} class="input" type=${f.type === 'number' ? 'number' : 'text'} value=${value(f.key) ?? ''}
                  onInput=${e => setForm(x => ({ ...x, [f.key]: f.type === 'number' ? e.target.value : e.target.value }))}/>`}
            ${f.hint && html`<div class="page-desc" style=${{ fontSize: 11, marginTop: 4 }}>${f.hint}</div>`}
          </div>`;
        })}
      </div>
    <//>`)}
    <${Section} title="LabCTL updates"><${UpdatesCard} addToast=${addToast}/><//>
    <${Section} title="GitHub"><${GithubCard} addToast=${addToast}/><//>
  </div>`;
}
