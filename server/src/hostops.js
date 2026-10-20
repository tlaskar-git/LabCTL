// Host helpers shared by routes/hosts.js and ssh.js: per-host JSON data, API shape, filters, tags, groups, removal.
const { randomUUID } = require('crypto');
const { parseJson } = require('./db');

const config = { uninstallWaitMs: 30000 }; // tests shorten it
const KINDS = ['agent', 'ssh', 'vps', 'proxmox', 'runner'];
const now = () => new Date().toISOString();

// hosts.data holds the fields that have no column: kind_pref, notes, provider, region, plan, runner_folders, ssh{...}.
function getData(db, hostId) {
  return parseJson(db.prepare('SELECT data FROM hosts WHERE id = ?').get(hostId)?.data, {});
}
function saveData(db, hostId, patch) {
  const data = { ...getData(db, hostId), ...patch };
  db.prepare('UPDATE hosts SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(data), now(), hostId);
  return data;
}

// Dotted numeric compare, ignores any suffix after the numbers. Returns -1, 0 or 1.
function compareVersions(a, b) {
  const n = v => String(v || '0').split(/[^0-9.]/)[0].split('.').map(x => Number(x) || 0);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Latest agent version known to this server: the highest one any agent host reported.
function latestAgentVersion(db) {
  return db.prepare("SELECT agent_version AS v FROM hosts WHERE kind != 'ssh' AND agent_version IS NOT NULL").all()
    .reduce((max, r) => (!max || compareVersions(r.v, max) > 0 ? r.v : max), null);
}

function tagsOf(db, hostId) {
  return db.prepare('SELECT t.id, t.name, t.color FROM tags t JOIN host_tags ht ON ht.tag_id = t.id WHERE ht.host_id = ? ORDER BY t.name').all(hostId);
}
function groupsOf(db, hostId) {
  return db.prepare('SELECT g.id, g.name, g.color FROM groups g JOIN host_groups hg ON hg.group_id = g.id WHERE hg.host_id = ? ORDER BY g.ord').all(hostId);
}

// API shape: the agents.hostOut shape plus tags, groups, notes, VPS fields and the outdated-agent flag.
function hostView(ctx, row, latest) {
  const out = ctx.agents.hostOut(row);
  const d = out.data || {};
  const ssh = d.ssh ? { ...d.ssh, saved_credential: !!d.ssh.credential_id } : null;
  if (out.kind === 'ssh') out.online = out.status === 'online';
  return { ...out, ssh, tags: tagsOf(ctx.db, row.id), groups: groupsOf(ctx.db, row.id),
    notes: d.notes || '', provider: d.provider || '', region: d.region || '', plan: d.plan || '',
    runner_folders: d.runner_folders || [],
    agent_outdated: !!(out.kind !== 'ssh' && row.agent_version && latest && compareVersions(row.agent_version, latest) < 0),
    latest_agent_version: latest };
}

function matches(h, f) {
  const has = (list, v) => list.some(x => x.id === v || x.name.toLowerCase() === String(v).toLowerCase());
  if (f.os && String(h.os || '').toLowerCase() !== String(f.os).toLowerCase()) return false;
  if (f.kind && h.kind !== f.kind) return false;
  if (f.status && (h.online ? 'online' : (h.status === 'gone' ? 'gone' : 'offline')) !== f.status) return false;
  if (f.group && !has(h.groups, f.group)) return false;
  if (f.tag && !has(h.tags, f.tag)) return false;
  if (f.outdated_agent !== undefined && f.outdated_agent !== '' && h.agent_outdated !== (f.outdated_agent === 'true' || f.outdated_agent === '1')) return false;
  if (f.q) {
    const hay = [h.id, h.hostname, h.ip, h.os, h.os_version, h.notes, h.provider, h.region, h.plan,
      ...h.tags.map(t => t.name), ...h.groups.map(g => g.name)].join('\n').toLowerCase();
    if (!hay.includes(String(f.q).toLowerCase())) return false;
  }
  return true;
}

// Tag names to ids, creating missing tags.
function tagIds(db, names) {
  const sel = db.prepare('SELECT id FROM tags WHERE name = ?');
  const ins = db.prepare('INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?)');
  return [...new Set(names.map(n => String(n).trim()).filter(Boolean))].map(name => {
    const found = sel.get(name);
    if (found) return found.id;
    const id = randomUUID();
    ins.run(id, name.slice(0, 40), '#64748b', now());
    return id;
  });
}

// hosts.group_id stays the primary group (first of the list) for the v1 UI; host_groups holds them all.
function setGroups(db, hostId, groupIds) {
  const ids = [...new Set(groupIds)].filter(id => db.prepare('SELECT 1 FROM groups WHERE id = ?').get(id));
  db.prepare('DELETE FROM host_groups WHERE host_id = ?').run(hostId);
  for (const id of ids) db.prepare('INSERT INTO host_groups (host_id, group_id) VALUES (?, ?)').run(hostId, id);
  db.prepare('UPDATE hosts SET group_id = ? WHERE id = ?').run(ids[0] || null, hostId);
}
function setTags(db, hostId, ids) {
  db.prepare('DELETE FROM host_tags WHERE host_id = ?').run(hostId);
  for (const id of ids) db.prepare('INSERT OR IGNORE INTO host_tags (host_id, tag_id) VALUES (?, ?)').run(hostId, id);
}

// Waits for the agent to say agent_gone. Resolves 'confirmed', or 'timeout'.
function waitAgentGone(ctx, hostId, ms) {
  return new Promise(resolve => {
    const done = v => { clearTimeout(timer); ctx.events.off('agent_message', on); resolve(v); };
    const on = ({ host_id, msg }) => { if (host_id === hostId && msg.type === 'agent_gone') done('confirmed'); };
    const timer = setTimeout(() => done('timeout'), ms);
    ctx.events.on('agent_message', on);
  });
}

// Removes one host. mode: remove | uninstall_and_remove. Agent hosts go on the blocklist so a reconnecting agent
// is refused (4403). Agentless ssh hosts have nothing that reconnects, so they are only deleted.
async function removeHost(ctx, host, mode, actor) {
  const { db } = ctx;
  let uninstall = 'not_requested';
  if (mode === 'uninstall_and_remove') {
    if (host.kind === 'ssh') uninstall = 'not_applicable';
    else if (!ctx.agents.isOnline(host.id)) uninstall = 'agent_offline';
    else {
      const gone = waitAgentGone(ctx, host.id, config.uninstallWaitMs);
      ctx.agents.send(host.id, { type: 'uninstall' });
      uninstall = await gone;
    }
  }
  if (host.kind !== 'ssh') {
    db.prepare('INSERT OR REPLACE INTO blocklist (host_id, hostname, reason, actor, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(host.id, host.hostname, mode, actor, now());
  }
  for (const j of db.prepare("SELECT id FROM jobs WHERE host_id = ? AND status IN ('pending','sent','running','waiting')").all(host.id)) ctx.jobs.cancel(j.id);
  db.transaction(() => {
    for (const t of ['host_tags', 'host_groups']) db.prepare(`DELETE FROM ${t} WHERE host_id = ?`).run(host.id);
    db.prepare('DELETE FROM schedules WHERE host_id = ?').run(host.id);
    db.prepare('DELETE FROM credentials WHERE host_id = ?').run(host.id);
    db.prepare('DELETE FROM hosts WHERE id = ?').run(host.id);
  })();
  ctx.agents.disconnect(host.id, 4403, 'blocked');
  ctx.ssh?.forget(host.id);
  ctx.audit(actor, 'host.remove', host.id, { hostname: host.hostname, mode, uninstall });
  return { id: host.id, hostname: host.hostname, ok: true, uninstall };
}

module.exports = { config, KINDS, getData, saveData, compareVersions, latestAgentVersion, hostView, matches,
  tagIds, setTags, setGroups, removeHost, now };
