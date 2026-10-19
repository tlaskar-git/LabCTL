import { useState, useEffect } from 'preact/hooks';
import { html, Icons, useToasts, Footer } from './ui.js';
import { api, subscribe } from './api.js';
import { pages, groups } from './pages/index.js';
import { buildRoutes, matchRoute, parseHash, navigate, onRoute } from './router.js';
import { getTheme, applyTheme } from './theme.js';
import { useAppState, setState } from './state.js';
import { Palette } from './palette.js';
import { JobDrawer } from './job-drawer.js';

const routes = buildRoutes(pages);
const byId = id => pages.find(p => p.id === id);
const modules = new Map();

// Imports a page module once and returns it (or an error) for the given manifest entry.
function usePageModule(entry) {
  const [res, setRes] = useState({ id: null });
  useEffect(() => {
    let live = true;
    if (!modules.has(entry.id)) modules.set(entry.id, entry.load());
    modules.get(entry.id).then(
      mod => live && setRes({ id: entry.id, mod }),
      error => { modules.delete(entry.id); live && setRes({ id: entry.id, error }); },
    );
    return () => { live = false; };
  }, [entry.id]);
  return res.id === entry.id ? res : {};
}

function PageView({ entry, ...props }) {
  const { mod, error } = usePageModule(entry);
  if (error) return html`<div class="card">Failed to load ${entry.title}: ${error.message}</div>`;
  if (!mod) return html`<div class="page-desc">Loading...</div>`;
  return html`<${mod.default} ...${props}/>`;
}

function Notice({ title, text }) {
  return html`<div class="card empty-state"><div class="empty-state-title">${title}</div><div class="empty-state-desc">${text}</div></div>`;
}

function useRoute() {
  const [loc, setLoc] = useState(parseHash());
  useEffect(() => onRoute(() => setLoc(parseHash())), []);
  return loc;
}

function Toasts({ toasts }) {
  return html`<div class="toast-container">
    ${toasts.map(t => html`<div key=${t.id} class=${`toast toast-${t.type}`}>${t.message}</div>`)}
  </div>`;
}

export function App() {
  const { user, hosts } = useAppState();
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [theme, setTheme] = useState(getTheme());
  const { toasts, addToast } = useToasts();
  const { path, query } = useRoute();

  useEffect(() => { applyTheme(theme); }, [theme]);

  useEffect(() => {
    api('/api/auth/me', { allowUnauthorized: true })
      .then(res => setState({ user: res.user || null }))
      .finally(() => setLoadingAuth(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    return subscribe('hosts', list => setState({ hosts: list }));
  }, [user]);

  useEffect(() => { if (path === '/') navigate('/hosts'); }, [path]);

  const logout = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* session may already be gone */ }
    localStorage.removeItem('labctl_token');
    setState({ user: null, hosts: [] });
    navigate('/hosts');
  };

  const match = matchRoute(routes, path);
  const entry = match && match.entry;
  const allowed = !!user && !!entry && entry.roles.includes(user.role);
  const base = entry && entry.modal ? byId('hosts') : entry;
  const activeId = entry && (entry.parent || base.id);
  const pageProps = { hosts, addToast, currentUser: user, params: match ? match.params : {}, query };
  const { mod: baseMod } = usePageModule(user ? base || byId('hosts') : byId('login'));
  const Toolbar = allowed && baseMod && baseMod.Toolbar;

  if (loadingAuth) return html`<div class="login-shell"><div class="metric-card"><div class="metric-value">LabCTL</div><div class="page-desc">Loading session...</div></div></div>`;
  if (!user) return html`
    <${PageView} entry=${byId('login')} onLogin=${u => setState({ user: u })} addToast=${addToast}/>
    <div class="login-foot"><${Footer}/></div>
    <${Toasts} toasts=${toasts}/>
  `;


  const navItems = group => pages.filter(p => p.group === group && p.nav !== false && p.roles.includes(user.role));

  return html`<div class="app">
    <div class="sidebar">
      <div class="sidebar-logo">
        <img class="brand-img" src="/labctl-logo.svg" alt="LabCTL"/>
        <span>${user.username} · ${user.role}</span>
      </div>
      ${groups.map(group => navItems(group).length > 0 && html`<div key=${group}>
        <div class="nav-section">${group}</div>
        ${navItems(group).map(item => {
          const Icon = Icons[item.icon] || Icons.Box;
          return html`<a key=${item.id} class=${`nav-item nav-link ${activeId === item.id ? 'active' : ''}`} href=${`#/${item.id}`}>
            <${Icon}/> ${item.title}
          </a>`;
        })}
      </div>`)}
      <div class="nav-section">Status</div>
      <div style=${{ padding: '4px 20px' }}>
        ${hosts.map(h => html`<div key=${h.id} style=${{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12 }}>
          <span class="badge-dot" style=${{ color: h.online ? 'var(--green)' : 'var(--red)', width: 6, height: 6, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }}/>
          <span style=${{ color: h.online ? 'var(--text-secondary)' : 'var(--text-dim)' }}>${h.hostname}</span>
        </div>`)}
      </div>
    </div>

    <div class="main">
      <div class="top-actions">
        <button
          class="theme-button"
          title=${`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          aria-label=${`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          onClick=${() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          ${theme === 'dark' ? html`<${Icons.Moon}/>` : html`<${Icons.Sun}/>`}
        </button>
        ${Toolbar && html`<${Toolbar}/>`}
        <button class="btn top-logout" onClick=${logout} title="Logout" aria-label="Logout">
          <${Icons.Power}/> Logout
        </button>
      </div>
      ${!entry && html`<${Notice} title="Page not found" text=${`There is no page at #${path}.`}/>`}
      ${entry && !allowed && html`<${Notice} title="Not permitted" text="Your role cannot open this page."/>`}
      ${allowed && html`<${PageView} key=${base.id} entry=${base} ...${pageProps}/>`}
      ${allowed && entry.modal && html`<${PageView} key=${entry.id} entry=${entry} ...${pageProps} onClose=${() => navigate('/hosts')}/>`}
      <${Footer}/>
    </div>

    <${Palette}/>
    <${JobDrawer}/>
    <${Toasts} toasts=${toasts}/>
  </div>`;
}
