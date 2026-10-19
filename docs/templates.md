# Job action templates

A template is a script that LabCTL runs on a host through the normal job path. The agent does not know about
templates: it receives a `run_job` frame with the script text and an environment.

Files are under `server/src/templates/`:

| Path | Content |
|---|---|
| `manifest.json` | One entry per template: `id, name, description, category, os, kinds, shell, file, params, secrets, guard, drain, admin, timeout_s`. |
| `_lib.sh`, `_lib.ps1` | Prelude put in front of every script of that shell (parameters, dry run, drain gate, runner helpers). |
| `darwin/`, `linux/`, `unix/`, `windows/` | The scripts. `unix/` is shared by Linux and macOS. Windows scripts end in `_win` where a Unix twin exists. |
| `runbooks/*.json` | Runbook definitions that chain templates. |

## Parameters and secrets

Parameters reach the script as `LABCTL_P_<NAME>`. Secrets reach it as `LABCTL_SECRET_<NAME>`. Scripts read them with
quoted expansion only. They never put a value into `eval`, `bash -c`, `Invoke-Expression` or a `-Command` string.
Scripts validate every value with a pattern before use.

Secrets come from stored credentials. The run request names a credential id per declared secret. The server opens it
and puts the value into the job environment when the `run_job` frame is sent. It is not written to the jobs table, the
job log or the audit log.

## API

| Call | Purpose |
|---|---|
| `GET /api/templates?os=&kind=&category=&host_id=` | List templates (host_id filters by the host's OS). |
| `GET /api/templates/:id?script=1` | One template, optionally with the script text. |
| `GET /api/templates/runbooks` | Runbook definitions. |
| `POST /api/templates/:id/run` | `{ host_ids \| group \| tag, params, secrets: {NAME: credential_id}, drain, force, confirm }`. Returns one job per host. |

Rules: operator or admin. `admin: true` templates (runner removal) need admin. A template with `guard: true`, and any
run with `force: true`, needs `confirm` to equal the host name. A run over several hosts needs the template id instead.
`drain` and `force` exist only on templates with `drain: true`.

## Drain and force

With `drain` the script waits until no `Runner.Worker` process runs, waits 5 s, checks again, and records in the log
when a job started in that gap. Without `drain` or `force` a running build stops the script with a non-zero exit.
`force` continues with a build running.

## Result lines

A script prints `LABCTL_RESULT key=value` for facts a runbook needs, for example `reboot_required=yes`.

## Runbook step kinds

| Kind | Fields | Meaning |
|---|---|---|
| `script` | `template` (an id, or an object keyed by `linux`, `darwin`, `windows`), `params`, `drain`, `optional` | Runs a template. An OS missing from the object skips the step. `optional` records a failure and continues. |
| `wait_agent` | `after` (step id), `timeout_s` | Waits for the host's agent to disconnect and register again after the named step. |
| `github_runner_online` | `runner`, `scope`, `timeout_s` | Server side. Polls GitHub until the runner shows online, or fails at the timeout. |

Any step can carry `when: { "reboot_required": true }`, which runs it only when an earlier step printed
`reboot_required=yes`. `{{NAME}}` in a field is replaced by a runbook parameter.

`runbooks/ci_host_patch_cycle.json` is the CI host cycle: drain and stop the runner, OS updates, cleanup, reboot if
required, wait for the agent, start the runner, confirm it online in GitHub, report.

## Runner update and rollback

`runner_update` verifies the SHA-256 from the release notes, replaces the files, keeps `.runner`, `.credentials`,
`.credentials_rsaparams` and `_work`, and starts the service. It stops with the old folder kept as `<folder>.labctl-prev`.
If the service does not start it rolls back at once. The server step `github_runner_online` is the three minute
check against GitHub: on failure, run `runner_rollback`. After the update is proven, run `runner_rollback` with
`ACTION=discard`.
