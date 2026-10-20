import { Icons } from './ui.js';

// ── Job type metadata ─────────────────────────────────────
export const JOB_TYPES = {
  windows_update: { label: 'Windows Update', icon: Icons.Shield, os: 'windows' },
  linux_update: { label: 'Linux Update', icon: Icons.Download, os: 'linux' },
  docker_update: { label: 'Docker Update', icon: Icons.Box, os: 'linux' },
  backup: { label: 'Run Backup', icon: Icons.HardDrive, os: 'linux' },
  reboot: { label: 'Reboot', icon: Icons.Power, os: 'all' },
  autologin: { label: 'Set Auto-Login', icon: Icons.Key, os: 'windows' },
  disable_autologin: { label: 'Disable Auto-Login', icon: Icons.Key, os: 'windows' },
  list_crons: { label: 'List Crons/Scheduled Tasks', icon: Icons.List, os: 'all' },
  custom_command: { label: 'Custom Command', icon: Icons.Terminal, os: 'all' },
  service_control: { label: 'Service Control', icon: Icons.Settings, os: 'all' },
  disk_cleanup: { label: 'Disk Cleanup', icon: Icons.Trash, os: 'all' },
  file_browse: { label: 'File Browser', icon: Icons.HardDrive, os: 'all' },
};
