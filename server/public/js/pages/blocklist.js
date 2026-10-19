import { html, StubPage } from '../ui.js';

export default function BlocklistPage() {
  return html`<${StubPage} title="Blocklist" description="Hosts the server refuses to accept." icon="Stop"/>`;
}
