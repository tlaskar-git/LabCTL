// Deploy through an online LabCTL agent (the relay) for targets the server cannot reach. Linux and Mac targets over SSH only.
// The relay runs relay.sh as a job. Secrets travel in the run_job env (LABCTL_SECRET_*) and are never stored: the job row
// holds the script text only. Limits: the relay needs OpenSSH 8.4 or newer, curl and tar; host keys are not pinned.
const fs = require('fs');
const path = require('path');
const unix = require('./unix');

const SCRIPT = fs.readFileSync(path.join(__dirname, 'relay.sh'), 'utf8');
const OPEN = ['pending', 'sent', 'running', 'waiting'];

function runOnRelay(ctx, relayId, { env, actor, onLine = () => {}, timeoutS = 1800 }) {
  const relay = ctx.db.prepare('SELECT * FROM hosts WHERE id = ?').get(relayId);
  if (!relay || relay.kind === 'ssh' || !ctx.agents.isOnline(relayId)) return Promise.reject(new Error('The relay host is not online.'));
  if (!['linux', 'darwin'].includes(relay.os)) return Promise.reject(new Error('The relay host must run Linux or macOS.'));
  const job = ctx.jobs.create({ host_id: relayId, type: 'deploy-relay', shell: 'bash', script: SCRIPT, params: {},
    status: 'sent', dispatchNow: false, timeout_s: timeoutS, actor });
  return new Promise((resolve, reject) => {
    let partial = '';
    const lines = [];
    const feed = chunk => {
      const parts = (partial + chunk).split(/\r?\n/);
      partial = parts.pop();
      for (const l of parts) { lines.push(l); onLine(l); }
    };
    const off = () => { ctx.events.off('job_output', onOut); ctx.events.off('job', onJob); };
    const onOut = e => { if (e.job_id === job.id) feed(e.chunk); };
    const onJob = j => {
      if (j.id !== job.id || OPEN.includes(j.status)) return;
      off();
      if (partial) { lines.push(partial); onLine(partial); }
      resolve({ code: j.status === 'completed' ? (j.exit_code ?? 0) : (j.exit_code || 1), lines, error: j.error });
    };
    ctx.events.on('job_output', onOut);
    ctx.events.on('job', onJob);
    if (!ctx.agents.send(relayId, { type: 'run_job', job_id: job.id, shell: 'bash', script: SCRIPT, env, timeout_s: timeoutS })) {
      off();
      ctx.jobs.complete(job.id, 'failed', { error: 'Relay went offline' });
      reject(new Error('The relay host went offline.'));
    }
  });
}

function relayEnv(t, h, mode, extra = {}) {
  const dir = `/tmp/labctl-deploy-${h.id}`;
  const files = t.os === 'darwin' ? 'mac.sh:setup-mac.sh' : 'linux.sh:setup-linux.sh';
  return { T_MODE: mode, T_ADDR: t.address, T_PORT: String(t.port), T_USER: t.user, T_DIR: dir, T_SERVER: h.server,
    LABCTL_SECRET_PASSWORD: t.password || '', LABCTL_SECRET_KEY: t.private_key || '', LABCTL_SECRET_PASSPHRASE: t.passphrase || '',
    LABCTL_SECRET_SUDO: unix.sudoPassword(t), LABCTL_SECRET_TOKEN: h.token || '', ...extra, _files: files };
}

async function inspect(t, h) {
  const out = [];
  const env = relayEnv(t, h, 'probe', { T_PROBE: unix.probeScript(h.server) });
  delete env._files;
  const r = await runOnRelay(h.ctx, t.relay_host_id, { env, actor: h.actor, onLine: l => out.push(l) });
  const kv = unix.parseKv(out.join('\n'));
  const checks = [];
  if (kv.ssh_error !== undefined || r.code !== 0) {
    const text = kv.ssh_error || out.slice(-3).join(' ') || r.error || `The relay job failed (${r.code})`;
    if (/Permission denied/i.test(text)) {
      checks.push({ name: 'Port reachability', ok: true, detail: `${t.address}:${t.port} reached from the relay` });
      checks.push({ name: 'SSH sign-in', ok: false, detail: `Authentication failed for ${t.user} on ${t.address} (through the relay). ${text}` });
    } else checks.push({ name: 'Port reachability', ok: false, detail: `From the relay: ${text}` });
    return { checks };
  }
  checks.push({ name: 'Port reachability', ok: true, detail: `${t.address}:${t.port} reached from the relay` });
  checks.push({ name: 'SSH sign-in', ok: true, detail: `Signed in as ${t.user} through the relay` });
  checks.push(...unix.unixChecks(kv, t));
  return { checks, transport: 'relay', uid: Number(kv.uid) };
}

async function install(t, h) {
  const sudo = h.uid !== undefined ? h.uid !== 0 : t.user !== 'root';
  const dir = `/tmp/labctl-deploy-${h.id}`;
  const env = relayEnv(t, h, h.mode, { T_SUDO: sudo ? '1' : '0',
    T_CMD: unix.installCommand(t, dir, { sudo, noService: t.no_service, uninstall: h.mode === 'uninstall' }) });
  env.T_FILES = h.mode === 'uninstall' ? (t.os === 'darwin' ? '' : env._files) : `${env._files} agent.py:labctl-agent.py`;
  delete env._files;
  if (h.mode === 'uninstall' && t.os === 'darwin') env.T_UNINSTALL = unix.uploadFiles(t, h)[0].content;
  h.phase('upload');
  h.log(`Running the install through relay host ${t.relay_host_id}`);
  let installing = false;
  const r = await runOnRelay(h.ctx, t.relay_host_id, { env, actor: h.actor, onLine: l => {
    h.out(l + '\n');
    if (!installing && /^Uploading the setup files/.test(l)) { installing = true; h.phase('install'); }
  } });
  if (r.code !== 0) throw new Error(h.lastLine() || `The relay job exited with code ${r.code}`);
  return {};
}

module.exports = { inspect, install, runOnRelay };
