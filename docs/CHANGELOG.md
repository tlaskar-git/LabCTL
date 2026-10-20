# Changelog

All notable changes to LabCTL are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [2.0.1] - 2026-10-20

### Fixed
- Jobs of the types Linux Update, Docker Update, Run Backup, Reboot, List Crons, Custom Command, Service Control, Disk Cleanup, File Browser, Windows Update and Auto-Login ran nothing on v2 agents and stayed in "sent". The server now turns each into a script job, and a job that gets no reply fails after 120 s with a clear message.
- The Actions page job cards were blank because they read a v1 field. They now show the live output, status line, and a full download.
- The Linux agent service did not start because systemd rejects a quoted WorkingDirectory. The installers also now fail when the service does not start.
- Redeploy: hosts migrated from v1 are recognised, every step has a time limit, the dialog can always be closed, and Address, OS, Port and Server URL are editable.
- Windows remote install over WinRM now uses a Python WinRM client with Negotiate and message encryption.
- SSH deploy adapts to the sign-in methods a host offers and explains publickey-only hosts.

### Added
- Shared credentials that are not tied to a host, and a credential picker in the deploy dialogs.
- Ephemeral runner support: replacement of finished runners, per-runner switch, stuck flag and alert rule.
- Updater sidecar on an internal-only network, git mode through a remote build context.

## [2.0.0] - 2026-10-20

### Migration from 1.x

- LabCTL 2 stores its state in SQLite (`data/labctl.db`). On first start it finds `data/labctl-data.json`, copies it to
  `labctl-data.json.bak-<timestamp>`, imports everything in one transaction and renames the original to
  `labctl-data.json.migrated-<timestamp>`. The v1 JSON is migrated once and backed up.
- The image runs as the non-root `node` user (uid 1000). Make the data folder writable by that user before the first
  start, for example `sudo chown -R 1000:1000 data`.
- `LABCTL_MASTER_KEY` is required. The server refuses to start without a 32 byte key (base64 or 64 hex characters).
  Generate one with `npm run genkey` and supply it from the environment. Keep a copy outside the host. v1 passwords for
  stored credentials are sealed during the import.
- v1 agents send no enrolment token and are refused until re-enrolled. Install the v2 agent on each host.
- `readonly` users become `viewer`. The `retention_days` setting is now `metrics_days`.
- `GET /api/health` is now a public liveness check. The per-host rows moved to `GET /api/health/hosts`.
- The compose file now includes the `labctl-updater` sidecar and needs `LABCTL_UPDATER_SECRET`.

### Added

- Server: modular layout, SQLite with WAL, numbered migrations, AES-256-GCM sealed credentials, three roles, audit log
  with redaction, retention settings, cron scheduler with time zone and missed-run records, enrolment tokens
  (create, rotate, revoke, shown once).
- Agent: rewritten as one Python file for Linux, macOS and Windows with a full inventory (disks, network, processes,
  services, updates, security, Docker, runners, Proxmox, Mac and Windows extras), self-update with roll back, watchdog,
  and a diagnostics mode.
- Installers: `setup-linux.sh`, `setup-mac.sh` and `setup-windows.ps1`, each self-contained and served from the server
  with the token, with a private virtual environment and an uninstall option.
- Add host wizard: install over SSH, OpenSSH, WinRM or a relay agent, with pre-flight checks, live log, redeploy,
  remove-agent and manual one-line commands.
- Hosts: kinds (`agent`, `ssh`, `vps`, `proxmox`, `runner`), tags, groups, filters, host detail pages with charts,
  agentless SSH hosts, removal with a blocklist and typed confirmation.
- Jobs: live output over server-sent events, job groups, retry of failed hosts, log search, command palette (Ctrl+K).
- Templates and runbooks: Mac, runner, cleanup, VPS, Proxmox and Windows domain controller actions, with drain, dry run,
  guards and `LABCTL_RESULT` lines. The `ci_host_patch_cycle` runbook.
- GitHub Actions runners: detection, GitHub API view and token settings, queue and latest-version checks, update,
  rollback, clean-up, re-register, add and remove.
- Monitoring and alerting: default rule pack, alert history, acknowledge and silence, SMTP, webhook and Telegram
  channels, daily health report.
- Patching and compliance: patch rings (`ring0`, `ring1`, `ring2`) with stop on failure, maintenance windows, built-in
  weekly and monthly schedules, compliance report with CSV and end-of-life checks.
- Operations: nightly SQLite backup with retention, restore command, config export and import, update check, one-click
  update through the `labctl-updater` sidecar, fleet-wide agent update by ring.
- Release: `VERSION` file, GHCR images (`ghcr.io/tlaskar-git/labctl` and `labctl-updater`), release and CI workflows with
  ShellCheck, PSScriptAnalyzer and a Docker smoke test.
- Documentation: new README, `docs/ARCHITECTURE.md`, `docs/templates.md` and this changelog.

### Changed

- The dashboard is Preact with htm and ES modules, vendored with no build step. The old page compiled React in the
  browser from a CDN. There is no CDN call now.
- Job output no longer lives in the database. It is appended to `data/job-logs/<job_id>.log`.
- Monitoring history is stored as time series (`metric_points`, `metric_series`) next to the v1 snapshots.
- Session tokens are stored as SHA-256 hashes. Migrated v1 sessions keep working.
- The `uuid` dependency was replaced by the built-in `crypto.randomUUID()`.
- Unknown `/api` paths return JSON 404 instead of the UI page.
- Lint is `node --check` over every server file.

### Fixed

- Setup failed when the agent file was downloaded alone. The setup scripts are now self-contained and fetch
  `labctl-agent.py` from the server with the token when it is not next to them.
- The macOS branch of the installer did not work. There is now a dedicated `setup-mac.sh` with launchd daemons.
- The host delete button did nothing useful and a deleted host re-registered at once. Removal now works, needs a typed
  confirmation and puts agent hosts on a blocklist.
- Job output had no cap and no streaming, so one noisy job filled the disk and the page only showed output at the
  end. Logs are capped (head and tail kept) and stream live.
- The Windows service install was unreliable. The agent now runs as two SYSTEM scheduled tasks with a watchdog.
- Agents had no version and no way to update. They report their version and update themselves with roll back.
- The WebSocket accepted unauthenticated connections and credentials were stored in plain text. Agents now need an
  enrolment token and credentials are sealed with AES-256-GCM.
- The cron parser mishandled ranges, lists and day fields. It now uses `cron-parser` in the configured time zone.
- The data file was one unbounded JSON document, rewritten on every change. SQLite replaces it, with retention.

### Security

- Credentials, channel secrets and the GitHub token are encrypted at rest. The key comes from the environment only.
- Agent connections need a revocable enrolment token. Tokens and sessions are stored as hashes.
- The audit log redacts passwords, tokens, bearer headers and private keys. Destructive actions need a typed word.
- SSH host keys use trust on first use. The agent never reads runner `.credentials` files.
- The update sidecar publishes no port and requires a shared secret.
- The browser loads no third-party code.

Not verified on real systems at release time: macOS, Windows (OpenSSH and WinRM), live GitHub runners, a real VPS,
Proxmox, a domain controller, SMTP and Telegram delivery, the Docker image build and the in-place update. See
the Verification status section in the README.

[2.0.0]: https://github.com/tlaskar-git/LabCTL/releases/tag/v2.0.0
