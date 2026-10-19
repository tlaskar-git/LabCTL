import { html, StubPage } from '../../ui.js';

// Props: host (record from the hosts list, may be undefined), hostId, addToast.
export default function ServicesTab() {
  return html`<${StubPage} bare title="Services" icon="Settings"/>`;
}
