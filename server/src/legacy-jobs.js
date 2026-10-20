// Typed v1 jobs (list_crons, custom_command, reboot ...) translated at send time into a v2 run_job script.
// The scripts live in legacy-jobs/<type>.sh (Linux and macOS) and <type>.ps1 (Windows), ported from the v1 agent.
// Parameters become LABCTL_P_<NAME> environment variables and are never put into script text.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'legacy-jobs');
const read = f => fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\r\n/g, '\n'); // bash fails on CRLF checkouts
const ENV_NAME = /^LABCTL_P_[A-Z][A-Z0-9_]*$/;

// type -> label and timeout (seconds, from the v1 handlers). The script files decide which OS families run it.
const TYPES = {
  windows_update: { label: 'Windows Update', timeout_s: 7200 },
  linux_update: { label: 'Linux Update', timeout_s: 3600 },
  docker_update: { label: 'Docker Update', timeout_s: 1800 },
  backup: { label: 'Run Backup', timeout_s: 14400 },
  reboot: { label: 'Reboot', timeout_s: 120 },
  autologin: { label: 'Set Auto-Login', timeout_s: 120 },
  disable_autologin: { label: 'Disable Auto-Login', timeout_s: 120 },
  list_crons: { label: 'List Crons', timeout_s: 300 },
  custom_command: { label: 'Custom Command', timeout_s: 300 },
  service_control: { label: 'Service Control', timeout_s: 300 },
  disk_cleanup: { label: 'Disk Cleanup', timeout_s: 1800 },
  file_browse: { label: 'File Browser', timeout_s: 60 },
  list_task_folders: { label: 'List Task Folders', timeout_s: 60 }
};
// Types whose output the UI reads back as job.result (stored at completion, see jobs.complete).
const RESULT_TYPES = ['list_crons', 'file_browse', 'list_task_folders'];

const osFamily = os => (/windows/i.test(os || '') ? 'windows' : /darwin|mac/i.test(os || '') ? 'darwin' : 'linux');

// v1 params -> environment. Lists become one item per line, booleans 1 or 0. Keys starting with _ are server-only,
// and credential_id and password never reach the environment (secrets go in as LABCTL_SECRET_* by the caller).
function paramEnv(params = {}) {
  const env = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (k.startsWith('_') || ['env', 'credential_id', 'password'].includes(k) || v === null || v === undefined) continue;
    const name = `LABCTL_P_${k.toUpperCase()}`;
    if (!ENV_NAME.test(name)) continue;
    env[name] = Array.isArray(v) ? v.map(String).join('\n') : typeof v === 'boolean' ? (v ? '1' : '0') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return env;
}

const supports = type => Object.prototype.hasOwnProperty.call(TYPES, type);

// { shell, script, env, timeout_s } for a typed job on a host OS, or null for a type this module does not know.
function translate(type, params = {}, os = 'linux') {
  if (!supports(type)) return null;
  const fam = osFamily(os);
  const shell = fam === 'windows' ? 'powershell' : 'bash';
  const ext = shell === 'powershell' ? '.ps1' : '.sh';
  const file = `${type}${ext}`;
  const t = TYPES[type];
  const env = paramEnv(params);
  const timeout = type === 'custom_command' && Number(params.timeout) > 0 ? Math.round(Number(params.timeout)) : t.timeout_s;
  if (!fs.existsSync(path.join(DIR, file))) {
    const other = fam === 'windows' ? 'Linux and macOS' : 'Windows';
    const msg = `ERROR: ${t.label} is only supported on ${other}.`;
    const script = shell === 'powershell' ? `[Console]::Error.WriteLine('${msg}')\nexit 1\n` : `echo '${msg}' >&2\nexit 1\n`;
    return { shell, script, env, timeout_s: 60 };
  }
  return { shell, script: `${read(`_common${ext}`)}\n${read(file)}`, env, timeout_s: timeout };
}

// The value job.result carries for RESULT_TYPES: the JSON after the last "LABCTL_RESULT_JSON " line, else the
// output (first 50000 characters, the v1 cap). null for other types.
function resultText(type, log) {
  if (!RESULT_TYPES.includes(type)) return null;
  const text = String(log || '');
  const m = [...text.matchAll(/^LABCTL_RESULT_JSON (.*)$/gm)].pop();
  return m ? m[1].trim() : text.slice(0, 50000);
}

module.exports = { TYPES, RESULT_TYPES, translate, supports, paramEnv, resultText, osFamily };
