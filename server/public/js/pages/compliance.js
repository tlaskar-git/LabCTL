import { useState, useEffect, useMemo } from 'preact/hooks';
import { api, downloadBlob } from '../api.js';
import { html, Icons } from '../ui.js';
import { rank } from '../components/palette-search.js';

const FILTERS = [['all', 'All hosts'], ['issues', 'With findings'], ['eol', 'End of life'], ['eol_soon', 'End of life soon'], ['patch_old', 'Patch age'], ['pending_updates', 'Pending updates'],
  ['reboot_pending', 'Reboot pending'], ['agent_outdated', 'Agent out of date'], ['no_backup', 'No recent backup'], ['offline', 'Offline']];
const ISSUE_TEXT = { eol: 'End of life', eol_soon: 'End of life soon', patch_old: 'Patch age', pending_updates: 'Pending updates', reboot_overdue: 'Reboot overdue', agent_outdated: 'Agent out of date',
  no_backup: 'No recent backup', offline: 'Offline', disk_over_90: 'Disk over 90%', smart_failing: 'Disk failing', firewall_off: 'Firewall off', filevault_off: 'FileVault off', defender_off: 'Defender off' };
const EOL_BADGE = { eol: ['failed', 'End of life'], eol_soon: ['waiting', 'Ends soon'], supported: ['completed', 'Supported'], unknown: ['pending', 'Unknown'] };
const day = iso => (iso ? iso.slice(0, 10) : '-');

function Tile({ label, value, bad }) {
  return html`<div class="metric-card"><div class="metric-value" style=${{ color: bad && value ? 'var(--red)' : undefined }}>${value}</div><div class="page-desc">${label}</div></div>`;
}

export default function CompliancePage({ addToast }) {
  const [report, setReport] = useState(null);
  const [filter, setFilter] = useState('all');
  const [os, setOs] = useState('');
  const [query, setQuery] = useState('');

  const load = () => api('/api/compliance').then(setReport).catch(e => addToast(e.message, 'error'));
  useEffect(() => { load(); }, []);

  const rows = useMemo(() => {
    if (!report) return [];
    const base = report.hosts.filter(h => (!os || h.os === os)
      && (filter === 'all' || (filter === 'issues' ? !h.compliant : filter === 'reboot_pending' ? h.reboot_pending : h.issues.includes(filter))));
    return rank(base, query, h => `${h.hostname} ${h.os_name || ''} ${h.os_version || ''} ${h.eol_product || ''}`, 1000);
  }, [report, filter, os, query]);

  // The CSV route needs the session token, so it is fetched and saved from here.
  const exportCsv = async () => {
    try {
      const token = localStorage.getItem('labctl_token');
      const res = await fetch('/api/compliance.csv', { headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: 'same-origin' });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      downloadBlob(await res.text(), 'labctl-compliance.csv', 'text/csv');
    } catch (e) { addToast(e.message, 'error'); }
  };

  const s = report && report.summary;
  return html`<div>
    <div class="page-header">
      <div><div class="page-title">Compliance</div>
        <div class="page-desc">OS versions, end-of-life warnings, patch age, agent versions and backup jobs, from the latest inventory of each host.</div></div>
      <div class="btn-group"><button class="btn" onClick=${load}><${Icons.RefreshCw}/> Refresh</button><button class="btn btn-primary" onClick=${exportCsv}><${Icons.Download}/> Export CSV</button></div>
    </div>
    ${s && html`<div class="metric-grid" style=${{ marginBottom: 16 }}>
      <${Tile} label="Hosts" value=${s.hosts}/><${Tile} label="No findings" value=${s.compliant}/><${Tile} label="End of life" value=${s.eol} bad/>
      <${Tile} label="Ends within ${report.thresholds.eol_warn_days} days" value=${s.eol_soon} bad/><${Tile} label=${`Patch age over ${report.thresholds.patch_days} days`} value=${s.patch_old} bad/>
      <${Tile} label="Pending updates" value=${s.pending_updates}/><${Tile} label="Reboot pending" value=${s.reboot_pending}/><${Tile} label="Agent out of date" value=${s.agent_outdated} bad/>
      <${Tile} label=${`No backup in ${report.thresholds.backup_days} days`} value=${s.no_backup} bad/>
    </div>`}
    <div class="form-row">
      <input class="input" type="search" aria-label="Search hosts" placeholder="Search hosts and OS" value=${query} onInput=${e => setQuery(e.target.value)}/>
      <select class="select input" aria-label="Filter" value=${filter} onChange=${e => setFilter(e.target.value)} style=${{ maxWidth: 220 }}>${FILTERS.map(([k, l]) => html`<option key=${k} value=${k}>${l}</option>`)}</select>
      <select class="select input" aria-label="Operating system" value=${os} onChange=${e => setOs(e.target.value)} style=${{ maxWidth: 160 }}>
        <option value="">All systems</option><option value="linux">Linux</option><option value="darwin">macOS</option><option value="windows">Windows</option></select>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Host</th><th>OS</th><th>Support</th><th>Patch age</th><th>Pending</th><th>Reboot</th><th>Agent</th><th>Last backup</th><th>Findings</th></tr></thead>
      <tbody>
        ${rows.map(h => {
          const [cls, text] = EOL_BADGE[h.eol_status] || EOL_BADGE.unknown;
          return html`<tr key=${h.host_id}>
            <td style=${{ fontWeight: 600 }}>${h.hostname}</td>
            <td>${h.os_name || h.os || '-'} ${h.os_version || ''}</td>
            <td><span class=${`badge badge-${cls}`} title=${h.eol_product ? `${h.eol_product}, support ends ${h.eol_date}` : 'Not in the end-of-life table'}>${text}</span> <span class="page-desc">${day(h.eol_date)}</span></td>
            <td>${h.patch_age_days === null ? '-' : `${h.patch_age_days} days`}</td>
            <td>${h.pending_updates}${h.security_updates ? ` (${h.security_updates} security)` : ''}</td>
            <td>${h.reboot_pending ? `${h.reboot_pending_days || 0} days` : '-'}</td>
            <td>${h.agent_version || '-'}${h.agent_outdated ? html` <span class="badge badge-waiting">old</span>` : ''}</td>
            <td><span class=${`badge badge-${h.no_recent_backup ? 'failed' : 'completed'}`}>${h.last_backup_at ? day(h.last_backup_at) : 'none'}</span></td>
            <td style=${{ fontSize: 12 }}>${h.issues.length ? h.issues.map(i => ISSUE_TEXT[i] || i).join(', ') : html`<span class="badge badge-completed">None</span>`}</td>
          </tr>`;
        })}
        ${report && rows.length === 0 && html`<tr><td colSpan="9" style=${{ textAlign: 'center', padding: 30, color: 'var(--text-dim)' }}>No host matches.</td></tr>`}
      </tbody></table></div>
  </div>`;
}
