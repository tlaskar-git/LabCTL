import { html, StubPage } from '../ui.js';

export default function MaintenancePage() {
  return html`<${StubPage} title="Maintenance" description="Maintenance windows that pause alerts and schedules." icon="Pause"/>`;
}
