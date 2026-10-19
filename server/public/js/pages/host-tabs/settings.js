import { html, StubPage } from '../../ui.js';

// Props: host (record from the hosts list, may be undefined), hostId, addToast.
export default function SettingsTab() {
  return html`<${StubPage} bare title="Settings" icon="Settings"/>`;
}
