// Hash router. No imports, so node can test it.
// Routes come from the pages manifest: entry.route (default "/<id>"), "/host/:id" style params.

export function parseHash(hash = globalThis.location?.hash || '') {
  const raw = hash.replace(/^#/, '') || '/';
  const [p, qs = ''] = raw.split('?');
  return { path: p.startsWith('/') ? p : `/${p}`, query: Object.fromEntries(new URLSearchParams(qs)) };
}

export function buildRoutes(manifest) {
  return manifest
    .filter(entry => entry.route !== false)
    .map(entry => ({ entry, segments: (entry.route || `/${entry.id}`).split('/').filter(Boolean) }));
}

export function matchRoute(routes, path) {
  const parts = path.split('/').filter(Boolean);
  for (const { entry, segments } of routes) {
    if (segments.length !== parts.length) continue;
    const params = {};
    const ok = segments.every((seg, i) => {
      if (seg.startsWith(':')) { params[seg.slice(1)] = decodeURIComponent(parts[i]); return true; }
      return seg === parts[i];
    });
    if (ok) return { entry, params };
  }
  return null;
}

export function navigate(path) {
  globalThis.location.hash = `#${path}`;
}

export function onRoute(fn) {
  globalThis.addEventListener('hashchange', fn);
  return () => globalThis.removeEventListener('hashchange', fn);
}
