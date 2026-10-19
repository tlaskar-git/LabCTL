import { html, StubPage } from '../../ui.js';

// Props: host (record from the hosts list, may be undefined), hostId, addToast.
export default function OverviewTab() {
  return html`<${StubPage} bare title="Overview" icon="Server"/>`;
}
