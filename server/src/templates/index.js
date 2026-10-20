// Job action template catalogue: manifest.json, the script files, validation, and parameter handling.
// A template is a script run through the normal job path. Parameters become LABCTL_P_<NAME> environment variables
// and secrets become LABCTL_SECRET_<NAME>. Nothing is ever interpolated into script text.
const fs = require('fs');
const path = require('path');

const OS = ['linux', 'darwin', 'windows'];
const KINDS = ['agent', 'ssh', 'vps', 'proxmox', 'runner'];
const CATEGORIES = ['mac', 'runner', 'vps', 'proxmox'];
const SHELLS = { bash: '.sh', powershell: '.ps1' };
const PARAM_TYPES = ['string', 'int', 'bool', 'enum'];
const STEP_KINDS = ['script', 'wait_agent', 'github_runner_online'];
const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const ID_RE = /^[a-z][a-z0-9_]{1,63}$/;
// Set by the server from the request body, never by the manifest.
const RESERVED = ['DRAIN', 'FORCE'];
const DRAIN_TIMEOUT = { name: 'DRAIN_TIMEOUT_MIN', type: 'int', default: 120, label: 'Drain timeout (minutes)' };

// Python scripts (custom templates only) get no prelude.
const libFor = shell => (shell === 'powershell' ? '_lib.ps1' : shell === 'python' ? null : '_lib.sh');

function validateManifest(manifest, dir = __dirname) {
  const errors = [];
  const err = (id, msg) => errors.push(`${id}: ${msg}`);
  if (!manifest || !Array.isArray(manifest.templates)) return ['manifest.json needs a templates array'];
  const seen = new Set();
  for (const t of manifest.templates) {
    const id = t && t.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) { err(String(id), 'invalid id'); continue; }
    if (seen.has(id)) err(id, 'duplicate id');
    seen.add(id);
    if (!t.name || typeof t.name !== 'string') err(id, 'name missing');
    if (typeof t.description !== 'string' || !t.description) err(id, 'description missing');
    if (!CATEGORIES.includes(t.category)) err(id, 'invalid category');
    if (!Array.isArray(t.os) || !t.os.length || t.os.some(o => !OS.includes(o))) err(id, 'invalid os');
    if (!Array.isArray(t.kinds) || !t.kinds.length || t.kinds.some(k => !KINDS.includes(k))) err(id, 'invalid kinds');
    if (!SHELLS[t.shell]) err(id, 'invalid shell');
    if (typeof t.guard !== 'boolean') err(id, 'guard must be a boolean');
    if (typeof t.drain !== 'boolean') err(id, 'drain must be a boolean');
    if (t.admin !== undefined && typeof t.admin !== 'boolean') err(id, 'admin must be a boolean');
    if (t.timeout_s !== undefined && !(Number.isInteger(t.timeout_s) && t.timeout_s > 0)) err(id, 'invalid timeout_s');
    if (typeof t.file !== 'string' || t.file.includes('..') || path.isAbsolute(t.file)) err(id, 'invalid file path');
    else {
      if (SHELLS[t.shell] && !t.file.endsWith(SHELLS[t.shell])) err(id, `file must end in ${SHELLS[t.shell]}`);
      if (!fs.existsSync(path.join(dir, t.file))) err(id, `file ${t.file} does not exist`);
    }
    if (!Array.isArray(t.params)) { err(id, 'params must be an array'); continue; }
    const names = new Set();
    for (const p of t.params) {
      if (!p || !NAME_RE.test(p.name || '')) { err(id, `invalid param name ${p && p.name}`); continue; }
      if (RESERVED.includes(p.name)) err(id, `param ${p.name} is reserved`);
      if (names.has(p.name)) err(id, `duplicate param ${p.name}`);
      names.add(p.name);
      if (!PARAM_TYPES.includes(p.type)) err(id, `param ${p.name}: invalid type`);
      if (typeof p.label !== 'string' || !p.label) err(id, `param ${p.name}: label missing`);
      if (p.type === 'enum' && (!Array.isArray(p.options) || !p.options.length)) err(id, `param ${p.name}: options missing`);
      const dv = p.default;
      const ok = p.type === 'bool' ? typeof dv === 'boolean'
        : p.type === 'int' ? Number.isInteger(dv)
          : typeof dv === 'string' && (p.type !== 'enum' || (p.options || []).includes(dv));
      if (!ok) err(id, `param ${p.name}: default does not match type`);
    }
    if (t.secrets !== undefined) {
      if (!Array.isArray(t.secrets)) err(id, 'secrets must be an array');
      else for (const s of t.secrets) {
        if (!s || !NAME_RE.test(s.name || '') || !s.label || typeof s.required !== 'boolean') err(id, `invalid secret ${s && s.name}`);
      }
    }
  }
  return errors;
}

function validateRunbook(rb, templateIds) {
  const errors = [];
  const err = msg => errors.push(`${rb && rb.id}: ${msg}`);
  if (!rb || !ID_RE.test(rb.id || '')) return ['runbook id invalid'];
  if (!Array.isArray(rb.steps) || !rb.steps.length) return [`${rb.id}: steps missing`];
  const ids = new Set();
  for (const s of rb.steps) {
    if (!s.id || ids.has(s.id)) err(`duplicate or missing step id ${s.id}`);
    ids.add(s.id);
    if (!STEP_KINDS.includes(s.kind)) { err(`step ${s.id}: unknown kind ${s.kind}`); continue; }
    if (s.kind === 'script') {
      const refs = typeof s.template === 'string' ? [s.template] : Object.values(s.template || {});
      if (!refs.length) err(`step ${s.id}: template missing`);
      for (const r of refs) if (!templateIds.has(r)) err(`step ${s.id}: unknown template ${r}`);
      if (s.template && typeof s.template === 'object') {
        for (const k of Object.keys(s.template)) if (!OS.includes(k)) err(`step ${s.id}: unknown os ${k}`);
      }
    }
    if (s.kind === 'github_runner_online' && !(s.runner && s.scope)) err(`step ${s.id}: runner and scope are required`);
  }
  return errors;
}

function load(dir = __dirname) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const errors = validateManifest(manifest, dir);
  if (errors.length) throw new Error(`Invalid template manifest:\n${errors.join('\n')}`);
  const templates = manifest.templates.map(t => ({
    ...t,
    params: t.drain ? [...t.params, DRAIN_TIMEOUT] : t.params,
    secrets: t.secrets || [],
    admin: !!t.admin
  }));
  const byId = new Map(templates.map(t => [t.id, t]));
  const runbooks = [];
  const rbDir = path.join(dir, 'runbooks');
  if (fs.existsSync(rbDir)) {
    for (const f of fs.readdirSync(rbDir).filter(x => x.endsWith('.json')).sort()) {
      const rb = JSON.parse(fs.readFileSync(path.join(rbDir, f), 'utf8'));
      const rbErrors = validateRunbook(rb, new Set(byId.keys()));
      if (rbErrors.length) throw new Error(`Invalid runbook definition:\n${rbErrors.join('\n')}`);
      runbooks.push(rb);
    }
  }
  return { templates, byId, runbooks, dir };
}

const readText = (catalogue, f) => fs.readFileSync(path.join(catalogue.dir, f), 'utf8').replace(/\r\n/g, '\n');

// The editable script text: an operator edit (tpl.text, from template-store.js) or the template file.
const body = (catalogue, tpl) => (tpl.text !== undefined ? tpl.text.replace(/\r\n/g, '\n') : readText(catalogue, tpl.file));

// The script the agent receives: the shared prelude followed by the template script.
function script(catalogue, tpl) {
  const lib = libFor(tpl.shell);
  return lib ? `${readText(catalogue, lib)}\n${body(catalogue, tpl)}` : body(catalogue, tpl);
}

// Public view of a template (no file path, no script text).
function describe(tpl) {
  const { file, text, ...rest } = tpl; // eslint-disable-line no-unused-vars
  return rest;
}

class ParamError extends Error {}

// buildEnv: validates the request values against the manifest and returns the LABCTL_P_ environment.
function buildEnv(tpl, input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ParamError('params must be an object');
  const defs = new Map(tpl.params.map(p => [p.name, p]));
  const env = {};
  for (const [rawName, raw] of Object.entries(input)) {
    const name = String(rawName).toUpperCase();
    const def = defs.get(name);
    if (!def) throw new ParamError(`Unknown parameter ${rawName}`);
    let value;
    if (def.type === 'bool') {
      if (![true, false, 1, 0, '1', '0', 'true', 'false'].includes(raw)) throw new ParamError(`${name} must be true or false`);
      value = raw === true || raw === 1 || raw === '1' || raw === 'true' ? '1' : '0';
    } else if (def.type === 'int') {
      const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
      if (!Number.isInteger(n) || n < 0 || n > 1e9) throw new ParamError(`${name} must be a whole number`);
      value = String(n);
    } else {
      if (typeof raw !== 'string' && typeof raw !== 'number') throw new ParamError(`${name} must be text`);
      value = String(raw);
      if (value.length > 1000 || /[\u0000-\u001f]/.test(value)) throw new ParamError(`${name} has an invalid value`);
      if (def.type === 'enum' && !def.options.includes(value)) throw new ParamError(`${name} must be one of ${def.options.join(', ')}`);
    }
    env[`LABCTL_P_${name}`] = value;
  }
  for (const p of tpl.params) {
    if (p.required && (env[`LABCTL_P_${p.name}`] ?? String(p.default ?? '')) === '') throw new ParamError(`${p.name} is required`);
  }
  return env;
}

module.exports = { load, validateManifest, validateRunbook, script, body, describe, buildEnv, ParamError, libFor,
  OS, KINDS, STEP_KINDS, CATEGORIES, PARAM_TYPES, RESERVED, DRAIN_TIMEOUT };
