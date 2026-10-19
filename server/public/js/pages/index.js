// Pages manifest. The shell builds routes and the sidebar from this list, so a page never edits shared files.
//   id      route is #/<id> unless `route` is set (":name" segments become params)
//   group   sidebar section: Operate, Monitor, Automate, Admin (nav: false hides it from the sidebar)
//   icon    key of Icons in ui.js
//   roles   roles allowed to open the page
//   load    lazy import. The module default export is the page component.
//           Optional named export Toolbar draws extra buttons in the top bar.
//   modal   page is drawn as a modal over the Hosts page
//   parent  sidebar item to highlight for pages that are not in the sidebar
const ALL = ['admin', 'operator', 'viewer'];
const OPS = ['admin', 'operator'];
const ADMIN = ['admin'];

export const groups = ['Operate', 'Monitor', 'Automate', 'Admin'];

export const pages = [
  { id: 'login', title: 'Sign in', icon: 'Key', roles: ALL, route: false, nav: false, load: () => import('./login.js') },

  { id: 'fleet', title: 'Fleet overview', icon: 'HardDrive', group: 'Operate', roles: ALL, load: () => import('./fleet.js') },
  { id: 'hosts', title: 'Hosts', icon: 'Server', group: 'Operate', roles: ALL, load: () => import('./hosts.js') },
  { id: 'host-detail', title: 'Host', icon: 'Server', roles: ALL, route: '/host/:id', nav: false, parent: 'hosts', load: () => import('./host-detail.js') },
  { id: 'add-host', title: 'Add host', icon: 'Server', roles: OPS, route: '/add-host', nav: false, modal: true, load: () => import('./add-host.js') },
  { id: 'actions', title: 'Actions', icon: 'Play', group: 'Operate', roles: ALL, load: () => import('./actions.js') },
  { id: 'scripts', title: 'Scripts', icon: 'Terminal', group: 'Operate', roles: ALL, load: () => import('./scripts.js') },
  { id: 'jobs', title: 'Jobs', icon: 'Activity', group: 'Operate', roles: ALL, load: () => import('./jobs.js') },
  { id: 'runbooks', title: 'Runbooks', icon: 'List', group: 'Operate', roles: ALL, load: () => import('./runbooks.js') },
  { id: 'patching', title: 'Patching', icon: 'Download', group: 'Operate', roles: OPS, load: () => import('./patching.js') },

  { id: 'monitoring', title: 'Monitoring', icon: 'Activity', group: 'Monitor', roles: ALL, load: () => import('./monitoring.js') },
  { id: 'alerts', title: 'Alerts', icon: 'Eye', group: 'Monitor', roles: ALL, load: () => import('./alerts.js') },
  { id: 'compliance', title: 'Compliance', icon: 'Shield', group: 'Monitor', roles: ALL, load: () => import('./compliance.js') },
  { id: 'audit', title: 'Audit log', icon: 'List', group: 'Monitor', roles: OPS, load: () => import('./audit.js') },

  { id: 'schedules', title: 'Schedules', icon: 'Clock', group: 'Automate', roles: ALL, load: () => import('./schedules.js') },
  { id: 'maintenance', title: 'Maintenance', icon: 'Pause', group: 'Automate', roles: OPS, load: () => import('./maintenance.js') },
  { id: 'templates', title: 'Templates', icon: 'Box', group: 'Automate', roles: OPS, load: () => import('./templates.js') },

  { id: 'credentials', title: 'Credentials', icon: 'Key', group: 'Admin', roles: ALL, load: () => import('./credentials.js') },
  { id: 'agents', title: 'Agents', icon: 'Download', group: 'Admin', roles: ALL, load: () => import('./agents.js') },
  { id: 'tokens', title: 'Tokens', icon: 'Key', group: 'Admin', roles: ADMIN, load: () => import('./tokens.js') },
  { id: 'blocklist', title: 'Blocklist', icon: 'Stop', group: 'Admin', roles: ADMIN, load: () => import('./blocklist.js') },
  { id: 'channels', title: 'Channels', icon: 'RefreshCw', group: 'Admin', roles: ADMIN, load: () => import('./channels.js') },
  { id: 'github', title: 'GitHub', icon: 'Terminal', group: 'Admin', roles: ADMIN, load: () => import('./github.js') },
  { id: 'updates', title: 'Updates', icon: 'RefreshCw', group: 'Admin', roles: ADMIN, load: () => import('./updates.js') },
  { id: 'backup', title: 'Backup', icon: 'HardDrive', group: 'Admin', roles: ADMIN, load: () => import('./backup.js') },
  { id: 'users', title: 'Users', icon: 'User', group: 'Admin', roles: ADMIN, load: () => import('./users.js') },
  { id: 'settings', title: 'Settings', icon: 'Settings', group: 'Admin', roles: ADMIN, load: () => import('./settings.js') },
];
