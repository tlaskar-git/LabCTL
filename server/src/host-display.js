// Display name and icon of a host, and the icon of a group. The real hostname stays the key for matching, deploys and
// typed confirmations; `name` (display_name or hostname) is what every screen shows and sorts by.
const { ensureColumn } = require('./db');
const { ICON_IDS, autoIcon } = require('./host-icon');

function ensureDisplayColumns(db) {
  ensureColumn(db, 'hosts', 'display_name', 'TEXT');
  ensureColumn(db, 'hosts', 'icon', 'TEXT');
  ensureColumn(db, 'groups', 'icon', 'TEXT');
}

// null or '' clears. Returns { value } or { error }.
function cleanDisplayName(v) {
  if (v === null || v === undefined) return { value: null };
  if (typeof v !== 'string') return { error: 'display_name must be a string' };
  const s = v.trim();
  if (/[\u0000-\u001f\u007f-\u009f]/.test(s)) return { error: 'display_name must not contain control characters' };
  if (s.length > 64) return { error: 'display_name must be 64 characters or fewer' };
  return { value: s || null };
}

function cleanIcon(v) {
  if (v === null || v === undefined || v === '') return { value: null };
  return ICON_IDS.includes(v) ? { value: v } : { error: `icon must be one of: ${ICON_IDS.join(', ')}` };
}

// Fields added to every host in the API. tags: [{ name }].
function displayFields(row, tags = []) {
  return { display_name: row.display_name || null, icon: row.icon || null,
    icon_auto: autoIcon(row, tags.map(t => String(t.name).toLowerCase())), name: row.display_name || row.hostname || row.id };
}

module.exports = { ensureDisplayColumns, cleanDisplayName, cleanIcon, displayFields };
