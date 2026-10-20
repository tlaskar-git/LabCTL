// End-of-life table for the compliance view. Dates are the end of standard security support, as known in 2026-10.
// REVIEW THIS TABLE EVERY YEAR (each October): add new releases, check the dates against the vendors' lifecycle pages.
// macOS and Proxmox VE dates are approximate because the vendors publish no fixed date: macOS drops a release when the
// release three versions newer ships (about September); Proxmox VE follows the Debian release it is based on.
const DAY = 86400000;

// match(name, version, build) -> true for the product release. name and version are lower-case strings.
const PRODUCTS = [
  { product: 'Ubuntu 16.04 LTS', eol: '2021-04-30', match: (n, v) => n.includes('ubuntu') && v === '16.04' },
  { product: 'Ubuntu 18.04 LTS', eol: '2023-05-31', match: (n, v) => n.includes('ubuntu') && v === '18.04' },
  { product: 'Ubuntu 20.04 LTS', eol: '2025-05-31', match: (n, v) => n.includes('ubuntu') && v === '20.04' },
  { product: 'Ubuntu 22.04 LTS', eol: '2027-04-30', match: (n, v) => n.includes('ubuntu') && v === '22.04' },
  { product: 'Ubuntu 24.04 LTS', eol: '2029-04-30', match: (n, v) => n.includes('ubuntu') && v === '24.04' },
  { product: 'Ubuntu 26.04 LTS', eol: '2031-04-30', match: (n, v) => n.includes('ubuntu') && v === '26.04' },
  // Interim Ubuntu releases live nine months.
  { product: 'Ubuntu 25.04', eol: '2026-01-31', match: (n, v) => n.includes('ubuntu') && v === '25.04' },
  { product: 'Ubuntu 25.10', eol: '2026-07-31', match: (n, v) => n.includes('ubuntu') && v === '25.10' },
  // Debian: end of the LTS period.
  { product: 'Debian 10', eol: '2024-06-30', match: (n, v) => n.includes('debian') && v === '10' },
  { product: 'Debian 11', eol: '2026-08-31', match: (n, v) => n.includes('debian') && v === '11' },
  { product: 'Debian 12', eol: '2028-06-30', match: (n, v) => n.includes('debian') && v === '12' },
  { product: 'Debian 13', eol: '2030-06-30', match: (n, v) => n.includes('debian') && v === '13' },
  // Windows Server: end of extended support.
  { product: 'Windows Server 2016', eol: '2027-01-12', match: n => /server 2016/.test(n) },
  { product: 'Windows Server 2019', eol: '2029-01-09', match: n => /server 2019/.test(n) },
  { product: 'Windows Server 2022', eol: '2031-10-14', match: n => /server 2022/.test(n) },
  { product: 'Windows Server 2025', eol: '2034-10-10', match: n => /server 2025/.test(n) },
  // Windows clients (Home and Pro dates). Windows 11 is matched by build number.
  { product: 'Windows 10', eol: '2025-10-14', match: (n, v, b) => /windows 10/.test(n) || (/windows/.test(n) && !/server/.test(n) && b > 0 && b < 22000) },
  { product: 'Windows 11 21H2', eol: '2023-10-10', match: (n, v, b) => b === 22000 },
  { product: 'Windows 11 22H2', eol: '2024-10-08', match: (n, v, b) => b === 22621 },
  { product: 'Windows 11 23H2', eol: '2025-11-11', match: (n, v, b) => b === 22631 },
  { product: 'Windows 11 24H2', eol: '2026-10-13', match: (n, v, b) => b === 26100 && !/server/.test(n) },
  { product: 'Windows 11 25H2', eol: '2027-10-12', match: (n, v, b) => b === 26200 },
  // macOS (approximate, see the note at the top).
  { product: 'macOS 11 Big Sur', eol: '2023-09-30', match: (n, v) => isMac(n) && major(v) === 11 },
  { product: 'macOS 12 Monterey', eol: '2024-09-30', match: (n, v) => isMac(n) && major(v) === 12 },
  { product: 'macOS 13 Ventura', eol: '2025-09-30', match: (n, v) => isMac(n) && major(v) === 13 },
  { product: 'macOS 14 Sonoma', eol: '2026-09-30', match: (n, v) => isMac(n) && major(v) === 14 },
  { product: 'macOS 15 Sequoia', eol: '2027-09-30', match: (n, v) => isMac(n) && major(v) === 15 },
  { product: 'macOS 26 Tahoe', eol: '2028-09-30', match: (n, v) => isMac(n) && major(v) === 26 },
  // Proxmox VE (approximate, follows Debian).
  { product: 'Proxmox VE 6', eol: '2022-07-31', match: (n, v) => n.includes('proxmox') && major(v) === 6 },
  { product: 'Proxmox VE 7', eol: '2024-07-31', match: (n, v) => n.includes('proxmox') && major(v) === 7 },
  { product: 'Proxmox VE 8', eol: '2026-08-31', match: (n, v) => n.includes('proxmox') && major(v) === 8 },
  { product: 'Proxmox VE 9', eol: '2028-08-31', match: (n, v) => n.includes('proxmox') && major(v) === 9 }
];

function isMac(n) { return n.includes('macos') || n.includes('mac os') || n.includes('darwin'); }
function major(v) { const m = /^(\d+)/.exec(String(v || '')); return m ? Number(m[1]) : null; }

// lookup({ name, version, build }, now, warnDays) -> { status, product, eol_date, days_left }
// status: eol (support ended), eol_soon (ends within warnDays), supported (a known release with a later date), unknown.
function lookup({ name = '', version = '', build = '' } = {}, now = new Date(), warnDays = 180) {
  const n = String(name).toLowerCase();
  const v = String(version).trim().toLowerCase();
  const b = Number(String(build).match(/\d{4,6}/)?.[0]) || Number(/\.(\d{4,6})$/.exec(v)?.[1]) || 0;
  const hit = PRODUCTS.find(p => p.match(n, v, b));
  if (!hit) return { status: 'unknown', product: null, eol_date: null, days_left: null };
  const days = Math.floor((Date.parse(hit.eol) - now.getTime()) / DAY);
  return { status: days < 0 ? 'eol' : days <= warnDays ? 'eol_soon' : 'supported', product: hit.product, eol_date: hit.eol, days_left: days };
}

module.exports = { lookup, PRODUCTS };
