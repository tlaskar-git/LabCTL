import { html } from '../ui.js';

// Built-in host icons (vendor/icons/<id>.svg, drawn through css/icons.css). Same ids as server/src/host-icon.js.
export const ICONS = [
  ['server', 'Server'], ['vps', 'VPS or cloud'], ['router', 'Router'], ['database', 'Database'], ['shield', 'Firewall or security'],
  ['box', 'Appliance'], ['dc', 'Domain controller'], ['windows', 'Windows'], ['linux', 'Linux'], ['debian', 'Debian'],
  ['ubuntu', 'Ubuntu'], ['proxmox', 'Proxmox'], ['apple', 'macOS'], ['raspberrypi', 'Raspberry Pi'], ['docker', 'Docker host'],
  ['fedora', 'Fedora'], ['archlinux', 'Arch Linux'], ['centos', 'CentOS'], ['redhat', 'Red Hat'], ['suse', 'SUSE'],
  ['opensuse', 'openSUSE'], ['alpinelinux', 'Alpine Linux'], ['truenas', 'TrueNAS'], ['synology', 'Synology'], ['vmware', 'VMware'],
  ['kubernetes', 'Kubernetes'], ['homeassistant', 'Home Assistant'], ['pihole', 'Pi-hole'], ['adguard', 'AdGuard'],
  ['nginx', 'nginx'], ['traefikproxy', 'Traefik'], ['wireguard', 'WireGuard'], ['github', 'GitHub runner']
].map(([id, label]) => ({ id, label }));
const LABEL = Object.fromEntries(ICONS.map(i => [i.id, i.label]));

// The explicit icon wins, then the automatic one from the server, then a generic server.
export const iconOf = h => (h && (h.icon || h.icon_auto)) || 'server';
export const iconLabel = id => LABEL[id] || 'Server';

// <${OsIcon} host=${h} size=${40}/> or <${OsIcon} id="debian"/>. Colour follows `color` of the parent.
export function OsIcon({ host, id, size = 24, label }) {
  const icon = id || iconOf(host);
  return html`<span class="os-icon" data-icon=${icon} role="img" aria-label=${label || iconLabel(icon)} title=${label || iconLabel(icon)}
    style=${{ width: size, height: size }}/>`;
}
