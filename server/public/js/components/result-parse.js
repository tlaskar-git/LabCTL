// Parsers for the log text of the VPS, Windows and Proxmox templates. Plain functions, no imports, so node can test them.
// A template prints "LABCTL_RESULT key=value" for facts and "== Title ==" before each section (see server/src/templates/_lib.*).

export function parseResults(log) {
  const out = {};
  for (const m of String(log || '').matchAll(/^LABCTL_RESULT ([A-Za-z0-9_]+)=(.*)$/gm)) out[m[1]] = m[2].trim();
  return out;
}

// { 'Section title': [lines] }. Lines before the first title are kept under ''.
export function sections(log) {
  const out = { '': [] };
  let cur = '';
  for (const line of String(log || '').split(/\r?\n/)) {
    const m = /^== (.+) ==$/.exec(line.trim());
    if (m) { cur = m[1]; out[cur] = []; } else if (line.trim() !== '') out[cur].push(line.trim());
  }
  return out;
}

const sectionLines = (log, re) => {
  const s = sections(log);
  const key = Object.keys(s).find(k => re.test(k));
  return key === undefined ? [] : s[key].filter(l => !/^LABCTL_RESULT /.test(l) && !/^WARNING: /.test(l));
};

// Whitespace table with a header row (qm list, pct list, zpool list, pvesm status). Extra words join the last column.
export function table(lines) {
  if (!lines.length) return [];
  const head = lines[0].split(/\s+/).map(h => h.toLowerCase());
  return lines.slice(1).map(l => {
    const p = l.split(/\s+/);
    const cells = p.slice(0, head.length - 1).concat(p.slice(head.length - 1).join(' '));
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? '']));
  });
}

// vps_apt_upgrade: packages still held back after the upgrade, and the reboot flag.
export function heldBack(log) {
  const lines = sectionLines(log, /^Held back after/);
  if (!lines.length || lines[0] === 'none') return [];
  return lines.join(' ').split(/\s+/).filter(Boolean);
}

// vps_fail2ban_status: "name: banned now N, banned in total M".
export function jails(log) {
  return [...String(log || '').matchAll(/^(\S+): banned now (\d+), banned in total (\d+)$/gm)].map(m => ({ jail: m[1], now: Number(m[2]), total: Number(m[3]) }));
}

// vps_listening_ports: sockets ("tcp 0.0.0.0:22 users:(...)") and the externally reachable port list.
export function ports(log) {
  const sockets = sectionLines(log, /^Listening sockets/).map(l => l.split(/\s+/)).filter(p => p.length >= 2).map(p => ({ proto: p[0], local: p[1], process: p.slice(2).join(' ') }));
  const open = (/^Ports:\s*(.*)$/m.exec(String(log || '')) || [])[1];
  return { sockets, open: open ? open.split(/\s+/).filter(Boolean).map(Number) : [] };
}

// vps_cert_expiry: "domain: valid until <date>" and "domain: expires within N days or is expired (<date>)".
// now is a Date, for tests. days is whole days left (negative when expired), null when unknown.
export function certs(log, now = new Date()) {
  const days = text => { const t = Date.parse(text); return Number.isNaN(t) ? null : Math.floor((t - now.getTime()) / 86400000); };
  const out = [];
  for (const m of String(log || '').matchAll(/^(?:WARNING: )?(\S+): (valid until (.+)|expires within \d+ days or is expired \((.+)\)|no certificate returned)$/gm)) {
    const until = m[3] || m[4] || null;
    out.push({ domain: m[1], until, days: until ? days(until) : null, ok: !!m[3] });
  }
  return out;
}

// vps_wireguard_status and win_wireguard_state: "iface peer...: 42 s ago" or "...: never". age_s is null for never.
export function wgPeers(log) {
  return [...String(log || '').matchAll(/^(\S+) (\S+)\.\.\.: (never|(\d+) s ago)$/gm)]
    .map(m => ({ iface: m[1], peer: m[2], age_s: m[4] === undefined ? null : Number(m[4]) }));
}

// vps_post_reboot_check: "service: active" or "service: not active", plus post_reboot_failures.
export function postReboot(log) {
  const services = [...String(log || '').matchAll(/^(?:WARNING: )?([A-Za-z0-9_.@:-]+): (active|not active)$/gm)].map(m => ({ service: m[1], active: m[2] === 'active' }));
  const r = parseResults(log);
  return { services, failures: r.post_reboot_failures === undefined ? null : Number(r.post_reboot_failures),
    handshake: /At least one peer completed a handshake/.test(log || '') ? true : /No peer handshake/.test(log || '') ? false : null };
}

// vps_unattended_status: "enabled: x" and "active: y".
export function unattended(log) {
  const get = k => (new RegExp(`^${k}: (.+)$`, 'm').exec(String(log || '')) || [])[1] || null;
  return { enabled: get('enabled'), active: get('active') };
}

// pve_status
export function pveStatus(log) {
  const text = String(log || '');
  const r = parseResults(text);
  const pend = sectionLines(text, /^Pending updates/);
  return {
    version: (/^(pve-manager\/\S+.*)$/m.exec(text) || [])[1] || (sectionLines(text, /^Version/)[0] || null),
    pending: r.pve_updates_pending === undefined ? null : Number(r.pve_updates_pending),
    pending_items: pend[0] === 'none' ? [] : pend.map(l => l.split('/')[0]),
    pools: table(sectionLines(text, /^ZFS pools/).filter(l => /^NAME\s/.test(l) || /^\S+\s+\d/.test(l))),
    arc: { size: (/^ARC size:\s*(.+)$/m.exec(text) || [])[1] || null, max: (/^ARC max:\s*(.+)$/m.exec(text) || [])[1] || null },
    storage: table(sectionLines(text, /^Storage usage/))
  };
}

// pve_guests
export function pveGuests(log) {
  const text = String(log || '');
  // pct list leaves the Lock column empty, so a lone trailing word is the name.
  const cts = table(sectionLines(text, /^Containers/)).map(c => (c.name ? c : { ...c, name: c.lock, lock: '' }));
  return { vms: table(sectionLines(text, /^Virtual machines/)), containers: cts,
    down_onboot: Number(parseResults(text).guests_down_with_onboot ?? 0) };
}

// pve_backup_report: "2026-10-01 02:00  OK  100" rows, then failures count.
export function pveBackups(log) {
  const rows = [...String(log || '').matchAll(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+(\S+)\s+(.*)$/gm)].map(m => ({ at: m[1], status: m[2], id: m[3].trim() }));
  const r = parseResults(log);
  return { rows, failures: r.recent_backup_failures === undefined ? null : Number(r.recent_backup_failures) };
}

export const lastLines = (log, n = 25) => String(log || '').split(/\r?\n/).filter(l => l.trim() !== '').slice(-n).join('\n');
