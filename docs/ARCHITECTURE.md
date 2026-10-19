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

### Route files

Working in Phase 0: `auth`, `users`, `hosts` (hosts and groups), `jobs` (jobs and v1 chains), `schedules`,
`scripts`, `credentials`, `settings`, `metrics`, `install`, `tokens`, `audit`, `health`, `events`.

Stubs for later items: `deploy`, `runbooks`, `alerts`, `channels`, `maintenance`, `patching`, `compliance`,
`github`, `runners`, `updates`, `backup`, `templates`, `fleet`.

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
Phase 0 guards host removal (`DELETE /api/hosts/:id`).

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
