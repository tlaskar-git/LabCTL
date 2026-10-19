import { html, StubPage } from '../ui.js';

export default function SettingsPage() {
  return html`<${StubPage} title="Settings" description="Server settings: retention, time zone and job logs." icon="Settings"/>`;
}
