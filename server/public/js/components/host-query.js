// Hosts page filters from the URL hash query (#/hosts?status=offline&reboot=1). No imports, so node can test it.
// status, os, kind, tag, group and outdated=1 are server filters. reboot=1, disk=high, runners=offline and patches=behind
// are answered by GET /api/fleet/summary, the same lists the fleet tiles count.
const SERVER_KEYS = ['status', 'os', 'kind', 'tag', 'group'];
export const FLEET_FILTERS = {
  reboot: { value: '1', list: 'pending_reboots', label: 'Pending reboot' },
  disk: { value: 'high', list: 'disks_over_80', label: 'Disk above 80%' },
  runners: { value: 'offline', list: 'runners_offline', label: 'Runner offline' },
  patches: { value: 'behind', list: 'behind_on_patches', label: 'Behind on patches' }
};

// -> { filters: {...empty, status, os, ..., outdated_agent}, fleet: ['reboot', ...] }
export function filtersFromQuery(query, empty) {
  const q = query || {};
  const filters = { ...empty };
  for (const k of SERVER_KEYS) if (q[k]) filters[k] = String(q[k]);
  if (q.outdated === '1' || q.outdated === 'true') filters.outdated_agent = 'true';
  return { filters, fleet: Object.keys(FLEET_FILTERS).filter(k => q[k] === FLEET_FILTERS[k].value) };
}

// Host ids that satisfy every fleet filter, or null when none is active.
export function fleetHostIds(fleet, summary) {
  if (!fleet.length) return null;
  let ids = null;
  for (const k of fleet) {
    const set = new Set(((summary || {})[FLEET_FILTERS[k].list] || []).map(r => r.host_id));
    ids = ids ? new Set([...ids].filter(id => set.has(id))) : set;
  }
  return ids;
}
