import { useState } from 'preact/hooks';
import { api } from '../../api.js';
import { html } from '../../ui.js';
import { useAppState } from '../../state.js';
import { Section, KV, fmtDate } from '../../components/chart-kit.js';
import { Chips } from '../../components/host-chips.js';

// Props: host (record from the hosts list, may be undefined), hostId, addToast.
// Read-only summary. Editing uses the HostSettings dialog from components/host-settings.js (owned by the hosts page item),
// loaded on click so this tab still opens if that component changes.
export default function SettingsTab({ host, hostId, addToast }) {
  const { user } = useAppState();
  const [dialog, setDialog] = useState(null);
  if (!host) return html`<div class="page-desc">Host ${hostId} is not in the list.</div>`;

  const edit = async () => {
    try {
      const [{ HostSettings }, groups] = await Promise.all([import('../../components/host-settings.js'), api('/api/groups')]);
      setDialog({ HostSettings, groups });
    } catch (e) { addToast(e.message, 'error'); }
  };
  const close = () => setDialog(null);
  const none = html`<span class="page-desc">None</span>`;
  return html`<div>
    <${Section} title="Host settings" right=${user?.role !== 'viewer' && html`<button class="btn btn-sm" onClick=${edit}>Edit</button>`}>
      <${KV} rows=${[['Name', host.hostname], ['Host id', host.id], ['Kind', host.kind], ['Operating system', [host.os, host.os_version].filter(Boolean).join(' ') || null],
        ['Address', host.ip ?? null], ['Registered', fmtDate(host.created_at)],
        ['Tags', host.tags?.length ? html`<${Chips} items=${host.tags}/>` : none], ['Groups', host.groups?.length ? html`<${Chips} items=${host.groups}/>` : none],
        ['Notes', host.notes || null], ['Provider', host.provider || undefined], ['Region', host.region || undefined], ['Plan', host.plan || undefined],
        ['Runner folders', host.runner_folders?.length ? host.runner_folders.join(', ') : undefined],
        ['SSH', host.ssh ? `${host.ssh.username}@${host.ssh.address}:${host.ssh.port}` : undefined]]}/>
    <//>
    ${dialog && html`<${dialog.HostSettings} host=${host} groups=${dialog.groups} isAdmin=${user?.role === 'admin'} addToast=${addToast}
      onClose=${close} onSaved=${close}/>`}
  </div>`;
}
