import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { html, Modal } from '../ui.js';
import { KV, DataTable, toneBadge, useInventory } from './chart-kit.js';
import { ActionPanel, ResultSection, useActions, useResults } from './action-panel.js';
import { pveStatus, pveGuests, pveBackups } from './result-parse.js';
import { openJobDrawer } from '../job-drawer.js';

// Proxmox panel for the host detail tabs. view: 'overview' | 'updates'.
// Cards read the latest job per template. The snapshot button opens a guest picker instead of the generic parameter form.
const VIEWS = { overview: { title: 'Proxmox actions', groups: ['Health'] }, updates: { title: 'Proxmox patching', groups: ['Patch'] } };
const up = s => (s === 'running' ? 'ok' : 'warn');

function SnapshotDialog({ host, guests, onClose, onStarted, addToast }) {
  const [picked, setPicked] = useState(new Set());
  const [name, setName] = useState('prepatch');
  const [ram, setRam] = useState(false);
  const [dry, setDry] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toggle = id => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const params = { VMIDS: picked.size ? [...picked].join(',') : 'running', SNAPSHOT_NAME: name, APPEND_DATE: true, INCLUDE_RAM: ram, DRY_RUN: dry };
      const r = await api('/api/templates/pve_snapshot/run', { method: 'POST', body: { host_ids: [host.id], params } });
      addToast?.('Snapshot job started');
      onStarted?.();
      if (r.jobs?.[0]) openJobDrawer(r.jobs[0].job_id);
      onClose();
    } catch (e) { setError(e.message); setBusy(false); }
  };
  return html`<${Modal} title="Pre-patch snapshot" onClose=${busy ? () => {} : onClose}>
    <p class="page-desc">Snapshots the chosen guests before patching. With none chosen, every running guest is snapshotted. The date and time are added to the name. LabCTL never rolls back.</p>
    <div class="form-group" style=${{ margin: '10px 0' }}>
      <label class="form-label">Guests</label>
      ${guests.length === 0 && html`<div class="page-desc">No guest list yet. Run the guest list action first, or leave empty for all running guests.</div>`}
      ${guests.map(g => html`<label key=${g.id} class="checkbox-row" style=${{ display: 'flex', gap: 8 }}>
        <input type="checkbox" checked=${picked.has(g.id)} onChange=${() => toggle(g.id)}/> ${g.kind} ${g.id} ${g.name} ${toneBadge(up(g.status), g.status)}</label>`)}
    </div>
    <div class="form-group"><label class="form-label">Snapshot name</label><input class="input" value=${name} onInput=${e => setName(e.target.value)}/></div>
    <label class="checkbox-row" style=${{ display: 'flex', gap: 8, margin: '8px 0' }}><input type="checkbox" checked=${ram} onChange=${e => setRam(e.target.checked)}/> Include VM memory</label>
    <label class="checkbox-row" style=${{ display: 'flex', gap: 8, margin: '8px 0' }}><input type="checkbox" checked=${dry} onChange=${e => setDry(e.target.checked)}/> Dry run (report only, change nothing)</label>
    ${error && html`<div style=${{ color: 'var(--red)', margin: '8px 0' }}>${error}</div>`}
    <div class="btn-group" style=${{ justifyContent: 'flex-end' }}>
      <button class="btn" disabled=${busy} onClick=${onClose}>Cancel</button>
      <button class="btn btn-primary" disabled=${busy || !/^[A-Za-z][A-Za-z0-9_-]{0,22}$/.test(name)} onClick=${submit}>${busy ? 'Starting' : 'Snapshot'}</button>
    </div>
  <//>`;
}

export function ProxmoxPanel({ host, view = 'overview', addToast }) {
  const data = useActions(host.id);
  const [results, reload] = useResults(host.id);
  const inv = useInventory(host.id).data;
  const [snap, setSnap] = useState(false);
  if (!data || !data.roles.includes('proxmox')) return null;

  const st = results.pve_status;
  const gu = results.pve_guests;
  const bk = results.pve_backup_report;
  const s = st && pveStatus(st.log);
  const g = gu && pveGuests(gu.log);
  const b = bk && pveBackups(bk.log);
  const px = inv?.proxmox;
  const guests = px ? [...(px.vms || []).map(v => ({ kind: 'VM', id: String(v.vmid), name: v.name, status: v.status })),
    ...(px.containers || []).map(v => ({ kind: 'CT', id: String(v.vmid), name: v.name, status: v.status }))]
    : g ? [...g.vms.map(v => ({ kind: 'VM', id: v.vmid, name: v.name, status: v.status })), ...g.containers.map(v => ({ kind: 'CT', id: v.vmid, name: v.name || '', status: v.status }))] : [];

  const pending = html`<${ResultSection} title="Proxmox version and pending updates" res=${st}>
    ${s && html`<div><${KV} rows=${[['Version', s.version], ['Pending updates', s.pending === null ? null : toneBadge(s.pending ? 'warn' : 'ok', String(s.pending))]]}/>
      ${s.pending_items.length > 0 && html`<div class="mono" style=${{ marginTop: 6 }}>${s.pending_items.join(', ')}</div>`}</div>`}
  <//>`;

  return html`<div>
    ${view === 'updates' ? pending : html`<div>
      ${pending}
      <${ResultSection} title="ZFS pools, ARC and storage" res=${st}>
        ${s && html`<div>
          <${KV} rows=${[['ARC size', s.arc.size], ['ARC max', s.arc.max]]}/>
          <${DataTable} empty="No ZFS pools reported" rows=${s.pools} cols=${[{ h: 'Pool', f: z => z.name }, { h: 'Size', num: true, f: z => z.size }, { h: 'Used', num: true, f: z => z.alloc },
            { h: 'Free', num: true, f: z => z.free }, { h: 'Health', f: z => toneBadge(z.health === 'ONLINE' ? 'ok' : 'bad', z.health) }]}/>
          <div style=${{ height: 10 }}/>
          <${DataTable} empty="No storage reported" rows=${s.storage} cols=${[{ h: 'Storage', f: r => r.name }, { h: 'Type', f: r => r.type }, { h: 'Status', f: r => toneBadge(r.status === 'active' ? 'ok' : 'warn', r.status) },
            { h: 'Used %', num: true, f: r => r['%'] }]}/>
        </div>`}
      <//>
      <${ResultSection} title="Guests (qm and pct list)" res=${gu}>
        ${g && html`<div>
          <${KV} rows=${[['Set to start at boot but not running', toneBadge(g.down_onboot ? 'bad' : 'ok', String(g.down_onboot))]]}/>
          <${DataTable} empty="No virtual machines" rows=${g.vms} cols=${[{ h: 'VM', f: v => v.vmid }, { h: 'Name', f: v => v.name }, { h: 'State', f: v => toneBadge(up(v.status), v.status) }]}/>
          <div style=${{ height: 10 }}/>
          <${DataTable} empty="No containers" rows=${g.containers} cols=${[{ h: 'CT', f: v => v.vmid }, { h: 'State', f: v => toneBadge(up(v.status), v.status) }, { h: 'Name', f: v => v.name || '-' }]}/>
        </div>`}
      <//>
      <${ResultSection} title="Last vzdump and Backup Server tasks" res=${bk}>
        ${b && html`<div><${KV} rows=${[['Failures in the list', b.failures === null ? null : toneBadge(b.failures ? 'bad' : 'ok', String(b.failures))]]}/>
          <${DataTable} empty="No backup tasks" rows=${b.rows} cols=${[{ h: 'Started', f: r => r.at }, { h: 'Result', f: r => toneBadge(r.status === 'OK' ? 'ok' : 'bad', r.status) }, { h: 'Guest', f: r => r.id }]}/></div>`}
      <//>
    </div>`}
    <${ActionPanel} host=${host} data=${data} title=${VIEWS[view].title} groups=${VIEWS[view].groups} categories=${['proxmox']}
      custom=${{ pve_snapshot: () => setSnap(true) }} onStarted=${reload} addToast=${addToast}/>
    ${snap && html`<${SnapshotDialog} host=${host} guests=${guests} onClose=${() => setSnap(false)} onStarted=${reload} addToast=${addToast}/>`}
  </div>`;
}
