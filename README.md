# LabCTL

Central dashboard and agent system for managing homelab infrastructure. Supports Windows (Server 2025, Win 10/11) and Linux (Debian, Ubuntu, Proxmox).

![Dashboard](docs/screenshot-placeholder.png)

## Features

- **Windows Update** - Install updates, optionally reboot after
- **Linux Update** - apt update/upgrade/autoremove
- **Docker Update** - Pull and recreate containers (single, compose, or all)
- **Backup** - Run custom .sh backup scripts on any host
- **Reboot** - Scheduled reboot with configurable delay
- **Auto-Login** - Set Windows auto-login credentials from dashboard, chain with reboot
- **Backup + Reboot + Autologin chain** - Full maintenance workflow in one click
- **List Crons/Tasks** - Pull all crontabs, systemd timers, Windows scheduled tasks
- **Service Control** - Start/stop/restart services on any host
- **Disk Cleanup** - Temp files, package cache, Docker prune, journal vacuum
- **Custom Commands** - Run anything on any host
- **Scheduling** - Cron-based scheduling for any job type with enable/disable toggle
- **Live Status** - Real-time host health (CPU, RAM, disk, uptime, Docker containers)
- **Batch Operations** - Run any job across multiple hosts at once

## Architecture

```
┌─────────────────────────────────────────────┐
│          LabCTL Server (Node.js)            │
│   Express API + WebSocket + JSON Storage    │
│   React Dashboard served on :7700           │
├──────────────┬──────────────┬───────────────┤
│  WebSocket   │   REST API   │  SSE Events   │
└──────┬───────┴──────┬───────┴───────┬───────┘
       │              │               │
  ┌────┴────┐   ┌─────┴─────┐   ┌────┴─────┐
  │ Agent   │   │  Agent    │   │  Agent   │
  │ Linux   │   │  Linux    │   │  Windows │
  │ (Python)│   │  (Python) │   │  (Python)│
  └─────────┘   └───────────┘   └──────────┘
```

**Server**: Node.js API + WebSocket hub + React dashboard. Zero external database dependencies (JSON file storage).

**Agent**: Single Python file. Runs on every managed machine. Connects outbound to the server via WebSocket. Auto-reconnects on disconnect.

## Quick Start

### 1. Deploy the Server

The server runs as a Docker container.

```bash
# Clone the repo
git clone https://github.com/YOUR_USER/LabCTL.git
cd LabCTL/server

# Create data directory
mkdir -p data

# Build and start
docker compose up -d --build

# Verify
docker logs labctl
```

Dashboard available at `http://YOUR_SERVER_IP:7700`

### 2. Deploy Agent on Linux

```bash
# Copy the agent
mkdir -p /opt/labctl/agent
cp agent/labctl-agent.py /opt/labctl/agent/

# Install dependency
pip3 install websocket-client --break-system-packages

# Install as systemd service
python3 /opt/labctl/agent/labctl-agent.py --server ws://SERVER_IP:7700/ws/agent --install-service

# Check status
systemctl status labctl-agent
journalctl -u labctl-agent -f
```

### 3. Deploy Agent on Windows

1. Copy `agent/labctl-agent.py` to `C:\labctl\agent\` on the target machine
2. Install Python system-wide to `C:\Python312\` (or copy an existing install there)
3. Install the dependency:

```powershell
C:\Python312\python.exe -m pip install websocket-client
```

4. Create the scheduled task (run as Administrator):

```powershell
$action = New-ScheduledTaskAction -Execute "C:\Python312\python.exe" -Argument "C:\labctl\agent\labctl-agent.py --server ws://SERVER_IP:7700/ws/agent" -WorkingDirectory "C:\labctl\agent"; $trigger = New-ScheduledTaskTrigger -AtStartup; $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 365); $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest; Register-ScheduledTask -TaskName "LabCTL-Agent" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force; Start-ScheduledTask -TaskName "LabCTL-Agent"
```

**Important**: Python must be installed system-wide (e.g. `C:\Python312\`) for the SYSTEM account to access it. Per-user Python installs under `AppData` will not work with SYSTEM scheduled tasks.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 7700 | HTTP and WebSocket port |

Data is stored in `server/data/labctl-data.json` (auto-created). Mount this as a Docker volume to persist across container rebuilds.

## Agent Configuration

| Flag | Default | Description |
|------|---------|-------------|
| --server | ws://10.20.1.1:7700/ws/agent | Server WebSocket URL |
| --install-service | - | Install as systemd service (Linux) |

The agent auto-generates a stable host ID from the hostname. Heartbeat interval is 30 seconds. Auto-reconnect delay is 5 seconds.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/hosts | List all hosts with status |
| DELETE | /api/hosts/:id | Remove a host |
| GET | /api/jobs | List jobs (filter: host_id, status, limit) |
| POST | /api/jobs | Create a job |
| POST | /api/jobs/batch | Create job across multiple hosts |
| POST | /api/jobs/:id/cancel | Cancel a pending job |
| GET | /api/schedules | List all schedules |
| POST | /api/schedules | Create a schedule |
| PUT | /api/schedules/:id | Update a schedule |
| DELETE | /api/schedules/:id | Delete a schedule |
| GET | /api/credentials | List credentials (passwords hidden) |
| POST | /api/credentials | Upsert a credential |
| DELETE | /api/credentials/:id | Delete a credential |
| POST | /api/chains/proxmox-backup-all | Backup across multiple hosts |
| POST | /api/chains/backup-reboot-autologin | Full maintenance chain |
| GET | /api/events | SSE stream for live updates |

## Job Types

| Type | OS | Description |
|------|-----|-------------|
| windows_update | Windows | Install updates via PSWindowsUpdate |
| linux_update | Linux | apt update + upgrade + autoremove |
| docker_update | Linux | Pull and recreate Docker containers |
| backup | Linux | Run a backup shell script |
| reboot | All | Reboot with configurable delay |
| autologin | Windows | Set auto-login via registry |
| disable_autologin | Windows | Remove auto-login config |
| list_crons | All | List crontabs/systemd timers/scheduled tasks |
| custom_command | All | Run any command |
| service_control | All | Start/stop/restart a service |
| disk_cleanup | All | Clean temp files, caches, Docker prune |

## Networking

- Server listens on port 7700 (TCP)
- Agents connect outbound to the server. No inbound ports needed on agent machines
- For cross-subnet agents (e.g. DMZ), add a firewall rule allowing the agent IP to reach the server IP on port 7700 TCP

## Security Notes

- Credentials are stored in plaintext in the JSON file. This is a homelab tool.
- The agent runs as root (Linux) or SYSTEM (Windows) to execute system commands
- Restrict dashboard access to your management network
- For external access, put behind Tailscale, WireGuard, or a reverse proxy with auth

## Uninstall

**Linux agent:**
```bash
systemctl stop labctl-agent
systemctl disable labctl-agent
rm /etc/systemd/system/labctl-agent.service
systemctl daemon-reload
rm -rf /opt/labctl
```

**Windows agent:**
```powershell
Unregister-ScheduledTask -TaskName "LabCTL-Agent" -Confirm:$false
Remove-Item -Recurse -Force C:\labctl
```

**Server:**
```bash
docker compose down
rm -rf /path/to/labctl
```

## License

MIT
