import { html, StubPage } from '../ui.js';

export default function PatchingPage() {
  return html`<${StubPage} title="Patching" description="Plan and track OS and package updates across hosts." icon="Download"/>`;
}
