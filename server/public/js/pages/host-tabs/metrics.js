import { html, StubPage } from '../../ui.js';

// Props: host (record from the hosts list, may be undefined), hostId, addToast.
export default function MetricsTab() {
  return html`<${StubPage} bare title="Metrics" icon="Activity"/>`;
}
