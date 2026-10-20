# LabCTL architecture (v2)

LabCTL is one Node.js server plus a single-file Python agent on each managed host.
The server keeps its state in SQLite and job output in plain log files under `data/`.

## Server modules

| File | Purpose |
|---|---|
| `server/server.js` | Thin entry. Calls `src/app.js` `start()`. |
| `server/src/app.js` | Builds `ctx`, the Express app and the HTTP server. Loads every file in `src/routes/`. Refuses to start without a valid `LABCTL_MASTER_KEY`. |
| `server/src/db.js` | Opens `data/labctl.db` (better-sqlite3, WAL). Numbered migrations recorded in `schema_version`. `ensureColumn()` lets a feature add a column without editing this file. |
| `server/src/crypto.js` | AES-256-GCM `seal`/`open` (`base64(iv|tag|ct)`), `sha256`, `randomToken`. `npm run genkey` prints a new key to stdout. |
| `server/src/settings.js` | Settings as JSON values with defaults and validation. |
| `server/src/audit.js` | `audit(actor, action, hostId, detail)`, redaction, query, and the middleware that records every state-changing `/api` request. |
| `server/src/joblog.js` | Append-only `data/job-logs/<job_id>.log` with a head and tail cap. |
| `server/src/tokens.js` | Enrolment tokens: create, list, rotate, revoke, verify (SHA-256 hash only). |
| `server/src/auth.js` | Sessions, password hashing, roles, `requireRole`, `requireConfirm`. |
| `server/src/agents.js` | `/ws/agent` upgrade (token check), blocklist, host registry, `send(hostId, msg)`. |
| `server/src/jobs.js` | Job lifecycle, dispatch to an agent or a registered dispatcher, output to log files, v1 chains. |
| `server/src/scheduler.js` | cron-parser schedules in the `timezone` setting, missed-run detection. |
| `server/src/retention.js` | Daily pruning of jobs, job logs, metrics and audit rows. |
| `server/src/migrate.js` | One-time import of the v1 `labctl-data.json`. |
| `server/src/builtin-scripts.js` | Built-in saved scripts seeded into the `scripts` table. |
| `server/src/routes/*.js` | One file per feature area. Each exports `(app, ctx) => void`. |

### Further modules (added after Phase 0)

| File | Purpose |
|---|---|
| `server/src/hostops.js` | Host helpers: host data blob, kinds, remove host (blocklist rules), version compare. |
| `server/src/ssh.js` | Agentless `ssh` hosts: job execution over `ssh2`, 60 s state poll, host key recorded on first connect. |
| `server/src/deploy/` | Add host engine: `engine.js` (validation, pre-flight, phases, live log), `unix.js`, `windows.js`, `winrm.js`, `relay.js` with `relay.sh`, `conn.js`. |
| `server/src/templates/` | `manifest.json`, `_lib.sh`, `_lib.ps1`, the scripts and `runbooks/*.json`. `index.js` loads the catalogue. |
| `server/src/runbooks.js` | Runbook engine (step kinds, waits, `when` conditions, parameters). |
| `server/src/guards.js` | Typed-confirmation rules for template runs. |
| `server/src/github.js` | GitHub client, 60 s poller, sealed token, runner cache. |
| `server/src/alerting/` | `engine.js` (30 s evaluation tick), `rules.js` (metrics and default rule pack), `notify.js` (SMTP, webhook, Telegram), `maintenance.js`. |
| `server/src/patching.js` | Patch policies and ring runs. |
| `server/src/builtin-schedules.js` | One-click recurring schedules. |
| `server/src/compliance.js`, `compliance-eol.js` | Compliance report and end-of-life table. |
| `server/src/health-report.js` | Daily health report body. |
| `server/src/backup.js` | Backups, nightly timer, server lock, restore CLI. |
| `server/src/configio.js` | Config export and import. |
| `server/src/updater-client.js` | Calls the update sidecar. |
| `server/src/metrics.js` | Metric points, series and fleet trend. |
| `updater/` | The update sidecar (no npm dependencies). See `updater/README.md`. |

### Route files

`auth`, `users`, `hosts` (hosts, groups, tags, blocklist), `jobs`, `jobs-stream`, `schedules` (and built-in
schedules), `scripts`, `credentials`, `settings`, `metrics`, `install`, `tokens`, `audit`, `health`, `events`,
`deploy`, `templates`, `actions-panel`, `runbooks`, `alerts`, `channels`, `maintenance`, `patching`, `compliance`,
`github`, `runners`, `updates`, `backup`, `fleet`.

### ctx

Every route file receives `ctx`:

| Key | What it is |
|---|---|
| `db` | better-sqlite3 database |
| `crypto` | `seal`, `open`, `sealJson`, `openJson`, `sha256`, `randomToken` |
| `audit` | `audit(actor, action, hostId, detail)`, plus `audit.redact`, `audit.query` |
| `joblog` | `append`, `finish`, `read`, `tail`, `write`, `remove`, `prune`, `path` |
| `agents` | `send(hostId, msg)`, `isOnline`, `onlineIds`, `disconnect`, `disconnectToken`, `hostOut` |
| `jobs` | `create`, `dispatch`, `get`, `list`, `out`, `cancel`, `complete`, `output`, `registerDispatcher(kind, fn)` |
| `events` | EventEmitter: `job`, `job_output`, `host`, `agent_message` |
| `settings` | `get`, `set`, `all`, `update` |
| `scheduler` | `nextRun`, `validate`, `recomputeAll`, `tick` |
| `tokens` | enrolment token store |
| `retention` | `run()` |
| `templates` | `{ catalogue, run, resolveHosts }`. `run` creates one job per host for a template. |
| `templateSecrets` | `take(jobId)` returns and forgets the `LABCTL_SECRET_*` environment of a template job. Agent and SSH dispatchers both call it, so secrets reach agent and SSH hosts and are never stored. |
| `runbooks`, `patching`, `github`, `deploy`, `ssh`, `backups` | Engines created by their route files. |
| `alerting`, `maintenance` | Alert engine and maintenance windows (`ctx.maintenance` is `ctx.alerting.maintenance`). |
| `requireRole(role)` | middleware, `operator` allows operator and admin |
| `requireConfirm(expected)` | middleware, `req.body.confirm` must equal `expected` (a string or `req => string`) |
| `allowPublic(prefix)` | marks an `/api` path prefix as public (no session) |
| `logger` | `info`, `warn`, `error` |
| `paths`, `version`, `startedAt` | server dir, data dir, public dir; VERSION file content; start time |

New tables: a feature runs `CREATE TABLE IF NOT EXISTS` in its own route file, or uses `ensureColumn()`.

## Tables

`schema_version`, `settings`, `users`, `sessions` (SHA-256 of the session token), `hosts` (with `kind`, `token_id`,
`system_info`, `inventory`, `heartbeat` as JSON), `jobs` (no output column), `metrics` (JSON `data`), `schedules`
(with `last_missed`, `missed_count`), `scripts`, `credentials` (`sealed` only), `groups`, `tags`, `host_tags`,
`host_groups`, `alerts`, `alert_rules`, `channels` (`config_sealed`), `maintenance_windows`, `patch_policies`,
`runbooks`, `audit_log`, `blocklist`, `enrolment_tokens` (hash only).

Added by later features:

| Table or column | Purpose |
|---|---|
| `job_groups`, `jobs.group_id` | One group per multi-host run. Each child job carries `group_id`. |
| `jobs.bytes_received` | Bytes of output received, used for the cap marker and resume. |
| `runbook_runs` | One row per runbook run with step results. |
| `alert_facts` | Small key/value facts the alert engine remembers between ticks. |
| `channel_errors` | Last delivery errors per channel. `channels` also has `last_error`, `last_error_at`, `last_ok_at`. |
| `alerts.silenced_until`, `alerts.suppressed` | Silence and maintenance suppression. |
| `patch_runs` | One row per patch policy run with per-host, per-ring results. |
| `patch_policies.enabled`, `cron`, `next_run`, `last_run` | Scheduling of a policy. |
| `builtin_schedules` | One row per built-in schedule key (state, last run, `last_detail`). |
| `metric_points`, `metric_series` | Time series for charts and CPU averages. |
| `runbooks.params` | Runbook parameter definitions. |

The job log side file `data/job-logs/<job_id>.idx` holds one line per output chunk (`<ms>\t<bytes>\t<o|e>`). It lets
the live view replay a log with time stamps and resume at a byte offset.

## Agent protocol

JSON text frames over `wss://<server>/ws/agent?token=<enrolment token>`.

Agent to server:

- `register` `{type:"register", host_id, hostname, os:"linux|darwin|windows", os_version, arch, agent_version, kind:"agent", info:{...}}`
- `heartbeat` `{type:"heartbeat", host_id, agent_version, ts, cpu, ram, load:[1,5,15], uptime}` every 30 s
- `inventory` `{type:"inventory", host_id, ts, data:{...}}` every 5 min and on request
- `job_output` `{type:"job_output", job_id, seq, stream:"stdout|stderr", chunk}` flushed at most every 1 s or 4 KB
- `job_complete` `{type:"job_complete", job_id, status:"success|failed|cancelled", exit_code, duration_ms}`
- `pong`, and `agent_gone` `{type:"agent_gone", host_id}` after an uninstall job

Server to agent:

- `run_job` `{type:"run_job", job_id, shell:"bash|powershell|python", script, env:{}, timeout_s, stdin?}`
- `cancel_job` `{type:"cancel_job", job_id}`
- `update_agent` `{type:"update_agent", version, source, sha256}`
- `uninstall` `{type:"uninstall"}`
- `collect` `{type:"collect"}` (force inventory)
- `ping` `{type:"ping"}`

Rejection: a missing, invalid or revoked token gets HTTP 401 on upgrade. A blocklisted host gets close code 4403
with reason `blocked`. Tokens are never logged. Audit and log lines redact tokens, passwords, Authorization headers
and private keys.

Other close codes the server uses: 4401 token revoked or rotated, 4409 replaced by a newer connection for the same
host, 4400 `register` without `host_id`.

## Roles

| Role | Can do |
|---|---|
| viewer | Read everything except users, tokens and credentials. |
| operator | Viewer, plus every state-changing route that is not admin only. |
| admin | Everything. Admin only: users, tokens, credentials, settings writes, updates, remove-agent, runner_remove. |

Every non-GET `/api` request needs operator or admin (sign-in and sign-out excepted). Guarded actions need the
typed confirmation: the request body field `confirm` must equal the host name (or the word the route states).
Guarded routes: host removal (`DELETE /api/hosts/:id`, `POST /api/hosts/bulk-remove`), remove-agent, guarded templates and forced runs, LabCTL update (`UPDATE`), config import (`IMPORT`) and backup deletion (the file name).

## Enrolment tokens

Random 32 bytes, base64url. Only the SHA-256 hash is stored. The value is returned once, by
`POST /api/tokens` (create) or `POST /api/tokens/:id/rotate`. `GET /api/tokens` returns id, label, created,
last used and revoked only. On first start with no tokens the server creates one default token and prints only its
id. To get a value, rotate it in the UI. Revoking or rotating a token closes the agents connected with it.
Each host row records the `token_id` it registered with.

## Jobs and job logs

Output never goes into the database. It is appended to `data/job-logs/<job_id>.log`. Over `job_log_max_bytes`
(default 20971520) the file keeps the first half and the last half with a marker line between them. While the job
runs, the tail lives in `<job_id>.tail`; completion folds it into the `.log`.
`GET /api/jobs/:id` returns the whole log as `result`, `GET /api/jobs` returns the last 4 KB, and
`GET /api/jobs/:id/log` returns plain text.

## Scheduler

Standard 5-field cron (`*/N`, ranges, lists, day-of-month and day-of-week) through cron-parser, evaluated in the
`timezone` setting (default Europe/Dublin). Times are stored in UTC. The scheduler ticks every 60 s. A run found
more than 2 minutes late (for example after downtime) is not run: it is recorded as a job with status `missed`,
the schedule's `last_missed` and `missed_count` are updated, and an audit row `schedule.missed` is written.
An invalid cron expression is refused with HTTP 400.

## Audit

Every POST, PUT, PATCH and DELETE under `/api` is recorded after the response: actor, `METHOD /route/:pattern`,
host id, status, route params and the redacted body. Feature code adds explicit `ctx.audit(...)` calls for system
events. `GET /api/audit?actor=&action=&host_id=&since=&until=&limit=&offset=` returns `{ total, limit, offset, rows }`.

## Retention

Daily, and at start-up, and when a `*_days` setting changes:

| Setting | Default | Prunes |
|---|---|---|
| `jobs_days` | 90 | finished jobs and their log files |
| `job_logs_days` | 90 | log files not modified for that long |
| `metrics_days` | 30 | metrics rows (`retention_days` is the v1 alias) |
| `audit_days` | 365 | audit rows |

## Secrets

`LABCTL_MASTER_KEY` is 32 bytes, as base64 or 64 hex characters. The server exits with code 1 and a clear message
when it is missing or the wrong length. Keep the key in a secrets manager and pass it as an environment variable.
Losing the key makes stored credentials unreadable.

## Upgrade from v1

On first start the server finds `data/labctl-data.json`, copies it to `labctl-data.json.bak-<timestamp>`, imports
everything in one transaction, then renames it to `labctl-data.json.migrated-<timestamp>`. A setting records the
import, so a second copy of the file is ignored. Details: `readonly` users become `viewer`; credential passwords are
sealed; job results move to job log files; jobs still open in v1 are closed as `cancelled`; schedule next runs are
recomputed; `retention_days` becomes `metrics_days`.

The v2 image runs as the non-root `node` user (uid 1000). Before the first v2 start, make the data directory
writable by that user, for example `sudo chown -R 1000:1000 data`.

## Host kinds

`hosts.kind` is one of `agent`, `ssh`, `vps`, `proxmox`, `runner`. Agents register as `agent`. An operator can set
`vps`, `proxmox` or `runner`, and the choice (`kind_pref`) survives the agent registering again. `ssh` hosts are created
by `POST /api/hosts` and are never switched to or from an agent kind. Agentless `ssh` hosts run jobs through
`ssh2` and are polled every 60 s (uptime, load, memory, disk).

SSH secrets: the dispatcher calls `ctx.templateSecrets.take(jobId)`. For a Python job over SSH, the `LABCTL_SECRET_*`
values travel in a prelude on standard input and never appear on the command line. Credentials are opened in memory per
connection. A credential typed into the form and not saved lives in server memory until restart.

## Templates

`server/src/templates/manifest.json` lists the actions. `ctx.templates.run` resolves hosts, checks the guard, and creates
one job per host with type `template:<id>`. The script is the shell prelude (`_lib.sh` or `_lib.ps1`) plus the template
file. Parameters arrive as `LABCTL_P_<NAME>`, secrets as `LABCTL_SECRET_<NAME>`. A script prints
`LABCTL_RESULT key=value` for facts a runbook needs (for example `reboot_required=yes`). Details, runbook step kinds and
drain semantics are in `docs/templates.md`.

Domain controller rule: a Windows host counts as a domain controller when the agent inventory says so
(`windows.domain_controller`, or `domain_role` 4 or 5) or when it carries the tag `domain-controller`. Only then do
`win_dc_health`, `win_dns_check` and `win_dns_restart` apply, and the run needs the typed confirmation.

## Job flow

```text
Browser / schedule / runbook / patch run / alert action
        |  POST /api/templates/:id/run  (or /api/jobs, /api/jobs/batch, /api/runbooks/:id/run)
        v
   routes/*  --> requireRole --> guard (typed confirm) --> ctx.templates.run / ctx.jobs.create
        |                                   |
        |                          maintenance gate (skipped job when the host is in a window)
        v
   jobs.create: row in `jobs` (pending), optional job_group, ctx.events 'job'
        v
   jobs.dispatch
        |-- agent host:  agents.send(host, run_job {script, env incl. LABCTL_SECRET_*})  --> agent runs it
        |                   agent --> job_output (<= 1 s or 4 KB) --> job_complete
        |-- ssh host:    ssh.js exec over ssh2 (secrets via ctx.templateSecrets.take)
        v
   jobs.output --> joblog.append (<id>.log or <id>.tail, <id>.idx) --> ctx.events 'job_output'
        v
   jobs.complete --> status, exit_code, duration, fold tail into log, ctx.events 'job'
        v
   Browser: SSE /api/jobs/:id/stream and /api/events (notices) ; polling every 3 s while SSE is down
```

## Streaming and the job drawer

`GET /api/jobs/:id/stream` is server-sent events: `meta`, `chunk` (id is the byte offset after the chunk), `status`,
then `done`. `Last-Event-ID` resumes. `GET /api/job-groups/:id/stream` does the same for a group. `GET /api/events`
sends only small notices (host online or offline, job status). Each notice makes the open UI topics re-fetch. While the
stream is down, topics poll every 3 s. With the stream up they still poll every 15 s as a safety net.

## Updates

The server never touches Docker. The `labctl-updater` sidecar does. It shares the default Compose network with
`labctl`, answers only with the correct `X-Updater-Secret` header, and publishes no port.

| Route (admin only) | Purpose |
|---|---|
| `GET /api/updates/check` | Latest GitHub release, cached 15 minutes (`?refresh=1` skips the cache). |
| `POST /api/updates/apply` | `{confirm:"UPDATE", version?}`. Calls the sidecar. |
| `GET /api/updates/status` | Sidecar progress and steps. |
| `PUT /api/updates/mode` | `{mode:"image"\|"git"}`, stored in the setting `update_mode`. |
| `GET /api/updates/agents` | Agents older than the bundled agent. |
| `POST /api/updates/agents/run` | `{ring:"ring0"\|"ring1"\|"ring2"\|"all"}`: ring by ring agent self-update. `GET` returns progress. |

`GET /api/agent/version` (session required) returns the bundled agent version and SHA-256. The agent update sends
`update_agent {version, source, sha256}`. The agent verifies the hash, keeps `labctl-agent.py.bak`, writes
`update-pending.json`, exits with code 75 and is restarted by its service manager. The watchdog (`--watchdog`) restores
the `.bak` copy when the new agent has not connected within 60 s.

Windows task names are `LabCTL-Agent` and `LabCTL-Agent-Watchdog` (watchdog every minute, two checks 30 s apart). On
Linux a systemd timer runs the watchdog. On macOS launchd runs `com.labctl.agent.watchdog` every 30 s.

## Deployment (Add host)

`/api/deploy/*` runs an install from the server. Methods: SSH (Linux, macOS), OpenSSH (Windows), WinRM (Windows) and a
relay. Pre-flight checks reachability, host key, privilege and Python. A run goes through named phases, streams a live
log over SSE, mints a dedicated enrolment token and waits for the agent to register (default 120 s).

- Redeploy (`POST /api/hosts/:id/redeploy`) and remove-agent (`POST /api/hosts/:id/remove-agent`, admin, typed
  confirmation) use the target saved by the last deploy.
- Relay: an online Linux or macOS agent runs `relay.sh` as a job, with the target secrets in `LABCTL_SECRET_*`. The relay
  needs OpenSSH 8.4 or newer, `curl` and `tar`. Linux and macOS targets over SSH only. Host keys are not pinned.
- WinRM uses `winrm-client@0.0.12` (pure JavaScript, NTLM). Over HTTP (5985) the target must allow unencrypted WinRM.
  Over 5986 certificates are not verified. Scripts travel as `-EncodedCommand`.
- Credentials saved from the wizard have purpose `deploy`. Saving needs admin. Resetting a stored host key needs admin.
- Secrets live in the in-memory deploy object only for the run and are redacted from every log line.

## GitHub runners

The agent reports runners in the inventory (`runners[]`). The server adds the GitHub view (`github.js`, 60 s poller).
Routes: `/api/github/status`, `/api/github/queued`, `/api/github/latest`, `PUT/DELETE /api/github/token`,
`/api/github/check-permissions`, `/api/github/poll`, `PUT /api/github/settings`, `GET /api/runners`,
`PUT /api/runners/prefs`, `POST /api/runners/action`, `GET /api/hosts/:id/runners`, `POST /api/hosts/:id/ci-patch-cycle`.

Settings keys: `github_poll_s`, `github_repos`, `github_verify_timeout_s`, `github_verify_interval_s`,
`github_busy_hours`, `github_runner_prefs`, `github_api_base`. Cache keys (not edited by hand): `github_runners`,
`github_queued`, `github_queued_repos`, `github_latest_runner`. The token is stored sealed under a hidden setting key
(`_github_token`). On the first save with no body token, the server reads `LABCTL_GITHUB_TOKEN` from its environment.

## Alerting, channels and maintenance

`ctx.alerting` evaluates rules on a 30 s tick. A metric is registered in `alerting/rules.js` with a scope (`host` or
`fleet`). A rule has a metric, operator, threshold, severity (`info`, `warning`, `critical`) and duration. The default
pack is seeded once. The engine keeps small remembered facts in `alert_facts`. Metrics for hosts that are offline are
skipped when the data would be stale. Alerts can be acknowledged and silenced.

Channels: `smtp` (built-in client, no dependency), `webhook` (optional HMAC and headers) and `telegram`. Secrets are
sealed in `config_sealed` and masked in API replies. Delivery errors go to `channel_errors`.

Maintenance windows (`ctx.maintenance`) suppress alerts for covered hosts. A scheduled job created for a host in a
window is stored as skipped.

## Patch rings, compliance and built-in schedules

- Ring tags are `ring0`, `ring1` and `ring2`. A policy (`/api/patch-policies`) walks its rings in order. Hosts in a ring
  run in parallel up to the setting `patch_concurrency` (default 3). A failed host stops the later rings
  (`stopped_at_ring`). Runs and results are in `patch_runs` (`/api/patch-runs`).
- Compliance (`/api/compliance`, `/api/compliance.csv`, `/api/compliance/eol`) reads the latest inventory. Settings:
  `compliance_patch_days` (35), `compliance_backup_days` (8), `compliance_eol_warn_days` (180), `backup_job_pattern`.
- Built-in schedules (`/api/builtin-schedules`): `patch_weekly`, `cleanup_weekly`, `mac_monthly`, `health_report`,
  `cert_expiry`. Enabling twice never duplicates. Other settings used: `cert_domains`, `health_report_channels`.

## Backup, restore and config

- `src/backup.js` writes `data/backups/labctl-<timestamp>.db` with the SQLite online backup API, prunes by
  `backup_keep_days` (always keeping the newest files), and runs nightly at `backup_time` (settings `backup_enabled`,
  `backup_time`, `backup_keep_days`, `backup_last`).
- Routes (admin): `GET /api/backup/status`, `PUT /api/backup/settings`, `GET /api/backups`,
  `GET /api/backups/:file/download`, `DELETE /api/backups/:file` (confirm = file name), `POST /api/backup/run`.
  `POST /api/backup/run` also accepts `X-Updater-Secret` equal to `LABCTL_UPDATER_SECRET` (constant-time compare), so the
  updater can take a backup before an update without a session.
- The server touches `data/labctl.lock` every 15 s and removes it on a clean stop. A lock younger than 60 s blocks a restore.
- Restore CLI: `node src/backup.js restore <backup file> [--data-dir <dir>] --force`. Wrapper: `node server/scripts/restore.js`.
  It runs `PRAGMA integrity_check`, checks the file has `schema_version`, keeps the old database as
  `labctl.db.before-restore-<timestamp>` and moves the `-wal` and `-shm` files alongside.
- `GET /api/config/export` and `POST /api/config/import` use format `labctl-config` version 1 (limit 5 MiB). Import is
  a dry run unless `dry_run:false`, which needs `confirm:"IMPORT"`. Modes `merge` and `replace_sections`. Natural keys make
  re-imports idempotent. Import never creates or deletes hosts, never changes an existing user, and applies in one
  transaction. Secrets never leave: no credentials, tokens, channel secrets, GitHub token or password hashes.

## API surface

All routes need a session unless noted. Role is the minimum. Roles: V viewer, O operator, A admin. Non-GET needs O unless A.

| Area | Routes |
|---|---|
| Auth (public sign-in) | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` |
| Health (public) | `GET /api/health` (liveness), `GET /api/health/hosts` |
| Users (A) | `GET/POST /api/users`, `PUT/DELETE /api/users/:id` |
| Tokens (A) | `GET/POST /api/tokens`, `POST /api/tokens/:id/rotate`, `POST /api/tokens/:id/revoke` |
| Credentials (A) | `GET/POST /api/credentials`, `DELETE /api/credentials/:id` |
| Settings | `GET /api/settings`, `PUT /api/settings` (A) |
| Hosts | `GET/POST /api/hosts`, `PATCH/DELETE /api/hosts/:id`, `POST /api/hosts/bulk-remove`, `PUT /api/hosts/:id/group`, `GET /api/blocklist`, `DELETE /api/blocklist/:id` (A) |
| Tags, groups | `/api/tags`, `/api/groups` (GET, POST, PUT, DELETE) |
| Host data | `GET /api/hosts/:id/metrics`, `/inventory`, `/:slice`, `GET /api/metrics`, `GET /api/fleet/summary` |
| Deploy | `GET /api/deploy/relays`, `POST /api/deploy/preflight`, `/start`, `/manual-commands`, `GET /api/deploy/:id`, `/:id/stream`, `POST /api/hosts/:id/redeploy`, `POST /api/hosts/:id/remove-agent` (A) |
| Install | `GET /install/agent.py`, `GET /install/:script` (token gate), `GET /api/agents/info`, `GET /api/agents/download/:file` |
| Jobs | `GET/POST /api/jobs`, `GET /api/jobs/:id`, `/:id/log`, `/:id/stream`, `POST /api/jobs/batch`, `/:id/retry`, `/:id/cancel`, `GET /api/job-groups`, `/:id`, `/:id/stream`, `POST /api/job-groups/:id/retry-failed`, `GET /api/logs/search` |
| Scripts, schedules | `/api/scripts` (+ `POST /:id/run`), `/api/schedules`, `/api/builtin-schedules` (+ `enable`, `disable`, `run`) |
| Templates | `GET /api/templates`, `/api/templates/runbooks`, `/api/templates/:id`, `POST /api/templates/:id/run`, `GET /api/hosts/:id/actions`, `/api/hosts/:id/action-results` |
| Runbooks | `/api/runbooks` (CRUD, `POST /:id/run`), `GET /api/runbook-runs`, `/:id`, `POST /:id/rerun` |
| Runners | see GitHub runners above |
| Alerts | `GET /api/alerts`, `/history`, `/:id`, `POST /:id/ack`, `/:id/silence`, `GET /api/alert-metrics`, `GET/PUT /api/alert-config` (A), `/api/alert-rules` (CRUD, test, silence) |
| Channels (A) | `/api/channels` (CRUD), `POST /:id/test`, `GET /:id/errors` |
| Maintenance | `/api/maintenance` (CRUD), `GET /api/maintenance/check` |
| Patching | `/api/patch-policies` (CRUD, `POST /:id/run`, `GET /:id/runs`), `GET /api/patch-runs`, `/:id` |
| Compliance | `GET /api/compliance`, `/api/compliance.csv`, `/api/compliance/eol` |
| Updates (A) | see Updates above |
| Backup (A) | see Backup above. `POST /api/backup/run` also takes `X-Updater-Secret`. |
| Audit, events | `GET /api/audit`, `GET /api/events` (SSE notices) |
| v1 chains | `POST /api/chains/proxmox-backup-all`, `POST /api/chains/backup-reboot-autologin` (A) |

Agents use the WebSocket `/ws/agent`, not the REST API.

## Security model

- Authentication: local users, PBKDF2-SHA-256 passwords, session tokens stored as SHA-256 hashes. Roles are checked by
  `requireRole` on each route. `ctx.allowPublic(prefix)` is the only way to exempt a path from the session gate, and
  today only `/backup/run` (which checks its own secret or admin session) uses it, besides sign-in and health.
- Agents: enrolment token on the WebSocket upgrade. Tokens are hashed at rest, revocable, rotatable and tied to hosts.
  Outbound connections only. A message about a job is accepted only for a job that belongs to that agent's host.
- Secrets at rest: AES-256-GCM with `LABCTL_MASTER_KEY` from the environment. Sealed: credentials, channel configs, the
  GitHub token. The database never holds a plain secret. The key is never logged or stored.
- Secrets in motion: template secrets in the job environment only, never in the jobs table, log or audit.
- Audit: every state-changing `/api` request, with redaction of passwords, tokens, bearer headers, query secrets and
  private keys.
- Typed confirmation on destructive routes, enforced on the server by `requireConfirm`.
- SSH: host key recorded on first connect and compared after (trust on first use). Relay deploys do not pin host keys.
- Agent file access: the agent reads `.runner` and `_diag` of a runner. It never opens `.credentials`.
- Browser: all assets are local (`server/public/vendor`). No CDN. No inline third-party script.
- Updater: holds the Docker socket, publishes no port, requires a shared secret on every request except `/healthz`.
- Process: the image runs as uid 1000. `trust proxy` is `loopback`.

## Decisions

Taken in the shared contract:

- Job actions are script templates run through the normal job path; the agent only collects and runs jobs.
- The agent stays a single file. Parsers are plain functions in it so unittest can import it.
- SQLite via better-sqlite3, WAL mode. Tests use node:test and a temp data dir.
- Credentials sealed with AES-256-GCM as base64(iv|tag|ct). Key from LABCTL_MASTER_KEY, server refuses to start without it.
- Enrolment tokens: random 32 bytes base64url, stored as SHA-256 hash only, shown once at creation.
- Retention settings: jobs_days (90), metrics_days (30), job_logs_days (90), audit_days (365).
- Time zone setting `timezone` default Europe/Dublin.
- No docker, shellcheck or pwsh may exist on the dev machine: tests that need them skip with a clear message and CI runs them.

Taken in Phase 0 (simpler option chosen each time):

1. `GET /api/health` is now public liveness (`status`, `version`, `uptime_s`, `db`) for Docker and monitors.
   The v1 per-host health rows moved to `GET /api/health/hosts` (signed in). The UI must call the new path.
2. The default enrolment token's value is never printed, because logs must not hold secrets. The operator rotates
   it in the UI to read a value once.
3. v1 typed jobs (`{type:"job", job}` frames) still dispatch for jobs without a script, so v1 agents keep working
   until the v2 agent ships. Jobs with a `script` use the v2 `run_job` frame. v1 `job_started`, `job_failed` and
   `job_complete` with `output` are still accepted. v1 agents send no token, so they are refused until re-enrolled.
4. Agent `success` is stored as job status `completed`, so v1 job states stay unchanged in the API and UI.
5. Missed schedule runs are recorded, not caught up. Catching up after downtime could reboot hosts at a bad time.
6. Autologin chain: the job stores only `credential_id`. The password is opened at send time and never sits in the
   jobs table. The chained autologin job waits for the host to re-register after its reboot, as in v1.
7. `POST /api/chains/backup-reboot-autologin` is admin only because it stores a credential.
8. `hosts.group_id` stays the primary group for the v1 UI; `host_groups` mirrors it for many-to-many groups.
9. Session tokens are stored as SHA-256 hashes. Migrated v1 sessions keep working.
10. `uuid` was dropped for the built-in `crypto.randomUUID()`; `uuid@10` is deprecated.
11. The compose file keeps the v1 mount (`../data`, the repo-root `data/`) so existing installs migrate in place.
12. A job message from an agent is accepted only for a job that belongs to that agent's host.
13. Unknown `/api` paths return JSON 404 instead of the UI page.
14. Lint is `node --check` over every server file (no eslint install, no build step).
15. Feature modules hook in without editing core files: `ctx.events`, `ctx.jobs.registerDispatcher(kind, fn)`,
    `ctx.allowPublic(prefix)` and `ensureColumn()`.

Taken in the feature phases (1 to 12):

16. SQLite with WAL, through better-sqlite3. One file, online backup API, no database server to run. A homelab fleet fits
    in one writer.
17. Actions are script templates run through the normal job path. The agent has no action code, so adding an action
    needs no agent release.
18. The agent is a single Python file with the standard library plus `websocket-client`. One file is easy to serve,
    hash and self-update.
19. The UI is Preact with htm, vendored under `server/public/vendor`, with no build step. The old UI was React compiled
    in the browser by Babel from a CDN. That meant a CDN call on every page load and a slow first paint. Vendored ES
    modules need no compile and no network.
20. uPlot draws charts and ansi_up renders ANSI colour in job output. Both are small and vendored.
21. The UI polls every 3 s while server-sent events are down, and every 15 s as a safety net when they are up. Polling
    keeps working behind proxies that buffer SSE.
22. WinRM uses `winrm-client` (pure JavaScript, NTLM). It adds no native code. The cost is that HTTP on 5985 needs
    unencrypted WinRM allowed on the target, and certificates on 5986 are not verified.
23. Relay design: an online Linux or macOS agent runs the SSH install for targets the server cannot reach. This avoids a
    VPN or inbound rule. Secrets travel in the job environment, never in the stored script. Host keys are not pinned,
    because the relay has no store for them.
24. Ephemeral runners are not built. Persistent runners start jobs faster and keep warm caches, which suits a homelab.
    Ephemeral runners give a clean machine per job but start slower, lose caches and need a registration step per job.
    The add and re-register actions carry an `EPHEMERAL` parameter that passes GitHub's flag to the runner. LabCTL does
    not re-create an ephemeral runner after its job, so that toggle only suits a runner you replace yourself.
25. GitHub has no cordon API. A runner cannot be told to stop accepting jobs. Drain first waits for `Runner.Worker` to
    end, waits 5 s and checks again, and logs a job that started in the gap. This narrows the race and does not close it.
26. The updater sidecar uses the default Compose network, so git mode can reach GitHub (outbound). It is protected by a
    shared secret and publishes no port, because it holds the Docker socket.
27. Ring tags are `ring0`, `ring1` and `ring2`. Tags already exist, need no new schema and are visible in the host list.
28. A Windows domain controller is detected from the inventory (domain role) or from the tag `domain-controller`. The
    tag covers hosts where the role cannot be read.
29. Config import skips users by default and never changes an existing user. Passwords and roles are too sensitive for a
    bulk file. Include users on purpose.
30. A removed SSH host is not blocklisted. It has no agent to refuse. Removed agent hosts are blocklisted.
31. ShellCheck is skipped on the development machine and runs in CI. PSScriptAnalyzer also runs in CI (Windows runner)
    and fails the job on errors. Warnings are listed and do not fail it. Neither tool has run against the final scripts
    yet, so the first CI run decides.
32. Template secrets are held in memory by `ctx.templateSecrets` from job creation to dispatch, so the database holds
    nothing sensitive.
