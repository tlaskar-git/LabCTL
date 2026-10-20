// Built-in host icons (SVG files in public/vendor/icons/<id>.svg) and the automatic pick from OS, distro and role.
// Plain functions so node:test can check them. The UI list with labels is public/js/components/os-icon.js.
const { parseJson } = require('./db');

const ICON_IDS = ['server', 'vps', 'router', 'database', 'shield', 'box', 'dc', 'windows', 'linux', 'debian', 'ubuntu',
  'proxmox', 'apple', 'raspberrypi', 'docker', 'fedora', 'archlinux', 'centos', 'redhat', 'suse', 'opensuse', 'alpinelinux',
  'truenas', 'synology', 'vmware', 'kubernetes', 'homeassistant', 'pihole', 'adguard', 'nginx', 'traefikproxy', 'wireguard', 'github'];

// First match wins. Tested against the OS name, version, platform and model text the agent or ssh poll sent.
const DISTROS = [[/raspbian|raspberry/, 'raspberrypi'], [/truenas/, 'truenas'], [/ubuntu/, 'ubuntu'], [/debian/, 'debian'],
  [/fedora/, 'fedora'], [/centos/, 'centos'], [/red ?hat|rhel/, 'redhat'], [/opensuse/, 'opensuse'], [/suse|sles/, 'suse'],
  [/alpine/, 'alpinelinux'], [/arch ?linux|manjaro/, 'archlinux'], [/synology|dsm/, 'synology'], [/esxi|vmware/, 'vmware']];

// row: a hosts table row (inventory and system_info as JSON text or objects). tags: lower-case tag names.
function autoIcon(row, tags = []) {
  const obj = v => (typeof v === 'string' ? parseJson(v, null) : v) || {};
  const inv = obj(row.inventory);
  const si = obj(row.system_info);
  const oi = inv.os_info || {};
  const win = inv.windows || {};
  const os = String(row.os || inv.os || '').toLowerCase();
  const text = [oi.name, oi.version, oi.pretty, oi.model, row.os_version, si.platform, si.os, si.distro].filter(Boolean).join(' ').toLowerCase();
  if (os === 'windows' || text.includes('windows')) {
    const dc = win.domain_controller === true || [4, 5].includes(Number(win.domain_role)) || tags.includes('domain-controller');
    return dc ? 'dc' : 'windows';
  }
  if (row.kind === 'proxmox' || inv.proxmox || /proxmox|pve-manager/.test(text) || tags.includes('proxmox')) return 'proxmox';
  if (os === 'darwin' || /mac ?os|darwin/.test(text)) return 'apple';
  if (row.kind === 'vps') return 'vps';
  const hit = DISTROS.find(([re]) => re.test(text));
  if (hit) return hit[1];
  if (inv.docker || Number(si.docker_total) > 0) return 'docker';
  return os === 'linux' ? 'linux' : 'server';
}

module.exports = { ICON_IDS, autoIcon };
