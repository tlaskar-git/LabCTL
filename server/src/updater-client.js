// Client for the labctl-updater sidecar. The shared secret comes from the environment variable
// LABCTL_UPDATER_SECRET and is read on each call. It is sent only in the X-Updater-Secret header.
// The base URL is the service name on the internal Compose network (labctl-internal), set by LABCTL_UPDATER_URL.
function createUpdaterClient({ fetchFn = (...a) => fetch(...a), env = process.env } = {}) {
  const base = () => (env.LABCTL_UPDATER_URL || 'http://labctl-updater:8080').replace(/\/$/, '');
  const configured = () => !!env.LABCTL_UPDATER_SECRET;
  async function call(method, path, body) {
    let r;
    try {
      r = await fetchFn(base() + path, { method, signal: AbortSignal.timeout(10000),
        headers: { 'X-Updater-Secret': env.LABCTL_UPDATER_SECRET || '', 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined });
    } catch (err) { throw new Error(`The updater cannot be reached (${err.cause?.code || err.message}). Check that the labctl-updater service is running.`); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || `updater returned ${r.status}`); e.status = r.status; throw e; }
    return data;
  }
  return {
    configured,
    status: () => call('GET', '/status'),
    update: tag => call('POST', '/update', { image_tag: tag }),
    updateGit: (repo, ref) => call('POST', '/update-git', { repo, ref }),
    rollback: () => call('POST', '/rollback', {})
  };
}

module.exports = { createUpdaterClient };
