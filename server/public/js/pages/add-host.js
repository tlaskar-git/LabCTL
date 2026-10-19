import { html, Modal, StubPage } from '../ui.js';

// Modal page for route #/add-host. The shell draws it over the Hosts page. onClose returns to #/hosts.
export default function AddHost({ onClose }) {
  return html`<${Modal} title="Add host" onClose=${onClose}>
    <${StubPage} bare title="Add host wizard" icon="Server"/>
  <//>`;
}
