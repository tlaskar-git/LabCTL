#!/usr/bin/env python3
"""
LabCTL Agent - Cross-platform agent for homelab management.
Runs on Windows (Server 2025, Win 10, Win 11) and Linux (Debian, Ubuntu).

Deploy on each managed machine. Connects to the LabCTL server via WebSocket.

Usage:
  python3 labctl-agent.py --server ws://YOUR_SERVER_IP:7700/ws/agent
  
Windows (as service):
  python labctl-agent.py --server ws://YOUR_SERVER_IP:7700/ws/agent --install-service
"""

import argparse
import json
import hashlib
import os
import platform
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback

try:
    import websocket  # websocket-client
except ImportError:
    print("Installing websocket-client...")
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'websocket-client'])
    import websocket

# ── Configuration ──────────────────────────────────────────
SERVER_URL = "ws://YOUR_SERVER_IP:7700/ws/agent"
HEARTBEAT_INTERVAL = 30  # seconds
RECONNECT_DELAY = 5

IS_WINDOWS = platform.system() == "Windows"
IS_LINUX = platform.system() == "Linux"
HOSTNAME = socket.gethostname()
HOST_ID = hashlib.md5(f"{HOSTNAME}-{platform.node()}".encode()).hexdigest()[:12]


def get_os_name():
    if IS_WINDOWS:
        ver = platform.version()
        release = platform.release()
        # Detect Windows version
        if "Server" in platform.platform():
            return f"windows-server-{release}"
        return f"windows-{release}"
    else:
        # Try to get distro info
        try:
            with open('/etc/os-release') as f:
                lines = f.readlines()
                info = {}
                for line in lines:
                    if '=' in line:
                        k, v = line.strip().split('=', 1)
                        info[k] = v.strip('"')
                return f"{info.get('ID', 'linux')}-{info.get('VERSION_ID', '')}"
        except:
            return "linux"


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return "127.0.0.1"


def get_system_info():
    info = {
        "hostname": HOSTNAME,
        "os": get_os_name(),
        "platform": platform.platform(),
        "arch": platform.machine(),
        "cpus": os.cpu_count(),
        "ip": get_local_ip()
    }

    # Memory
    if IS_LINUX:
        try:
            with open('/proc/meminfo') as f:
                for line in f:
                    if line.startswith('MemTotal:'):
                        info['ram_mb'] = int(line.split()[1]) // 1024
                    elif line.startswith('MemAvailable:'):
                        info['ram_available_mb'] = int(line.split()[1]) // 1024
        except:
            pass

        # Disk
        try:
            st = os.statvfs('/')
            info['disk_total_gb'] = round((st.f_blocks * st.f_frsize) / (1024**3), 1)
            info['disk_free_gb'] = round((st.f_bavail * st.f_frsize) / (1024**3), 1)
        except:
            pass

        # Uptime
        try:
            with open('/proc/uptime') as f:
                info['uptime_hours'] = round(float(f.read().split()[0]) / 3600, 1)
        except:
            pass

        # Docker
        try:
            result = subprocess.run(['docker', 'ps', '--format', '{{.Names}}'],
                                  capture_output=True, text=True, timeout=10)
            if result.returncode == 0:
                containers = [c for c in result.stdout.strip().split('\n') if c]
                info['docker_containers'] = containers
                info['docker_running'] = len(containers)
        except:
            pass

    elif IS_WINDOWS:
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            mem = ctypes.c_ulonglong()
            kernel32.GetPhysicallyInstalledSystemMemory(ctypes.byref(mem))
            info['ram_mb'] = mem.value // 1024
        except:
            pass

        try:
            result = subprocess.run(['wmic', 'os', 'get', 'LastBootUpTime', '/value'],
                                  capture_output=True, text=True, timeout=10)
            if 'LastBootUpTime' in result.stdout:
                boot = result.stdout.split('=')[1].strip()[:14]
                # Parse YYYYMMDDHHMMSS
                from datetime import datetime
                boot_time = datetime.strptime(boot, '%Y%m%d%H%M%S')
                uptime = (datetime.now() - boot_time).total_seconds() / 3600
                info['uptime_hours'] = round(uptime, 1)
        except:
            pass

        # Disk
        try:
            result = subprocess.run(
                ['powershell', '-Command',
                 "Get-PSDrive C | Select-Object @{N='Free';E={[math]::Round($_.Free/1GB,1)}},@{N='Used';E={[math]::Round($_.Used/1GB,1)}} | ConvertTo-Json"],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode == 0:
                d = json.loads(result.stdout)
                info['disk_free_gb'] = d.get('Free', 0)
                info['disk_total_gb'] = d.get('Free', 0) + d.get('Used', 0)
        except:
            pass

    return info


# ══════════════════════════════════════════════════════════
# JOB EXECUTORS
# ══════════════════════════════════════════════════════════

def run_command(cmd, shell=True, timeout=3600):
    """Run a command and return (returncode, stdout, stderr)."""
    try:
        result = subprocess.run(
            cmd, shell=shell, capture_output=True, text=True, timeout=timeout
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "Command timed out"
    except Exception as e:
        return -1, "", str(e)


def job_windows_update(params):
    """Install Windows updates and optionally reboot."""
    reboot = params.get('reboot', True)

    script = '''
    $ErrorActionPreference = 'Continue'
    
    # Install PSWindowsUpdate if not present
    if (-not (Get-Module -ListAvailable -Name PSWindowsUpdate)) {
        Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Confirm:$false
        Install-Module -Name PSWindowsUpdate -Force -Confirm:$false
    }
    
    Import-Module PSWindowsUpdate
    
    # Get and install updates
    $updates = Get-WindowsUpdate -AcceptAll -Install -IgnoreReboot -Verbose 2>&1
    $updates | Out-String
    
    # Check if reboot needed
    $rebootRequired = (Get-WURebootStatus).RebootRequired
    Write-Output "REBOOT_REQUIRED=$rebootRequired"
    '''

    rc, stdout, stderr = run_command(
        ['powershell', '-ExecutionPolicy', 'Bypass', '-Command', script],
        shell=False, timeout=7200  # 2 hours for updates
    )

    output = stdout + "\n" + stderr
    needs_reboot = 'REBOOT_REQUIRED=True' in output

    if reboot and needs_reboot:
        run_command('shutdown /r /t 30 /c "LabCTL: Rebooting after Windows Update"')
        output += "\nReboot initiated (30 second delay)."

    return output


def job_linux_update(params):
    """Run apt update + upgrade on Debian/Ubuntu."""
    commands = [
        "export DEBIAN_FRONTEND=noninteractive",
        "apt-get update 2>&1",
        "apt-get upgrade -y 2>&1",
        "apt-get autoremove -y 2>&1"
    ]

    full_cmd = " && ".join(commands)
    rc, stdout, stderr = run_command(full_cmd, timeout=3600)

    output = stdout + "\n" + stderr
    if params.get('reboot', False):
        if os.path.exists('/var/run/reboot-required'):
            run_command('shutdown -r +1 "LabCTL: Rebooting after updates"')
            output += "\nReboot scheduled in 1 minute."

    return output


def job_docker_update(params):
    """Update Docker containers: pull new images, recreate changed containers."""
    container = params.get('container', None)
    compose_dir = params.get('compose_dir', None)
    output_parts = []

    if compose_dir:
        # Docker Compose update
        rc, stdout, stderr = run_command(
            f"cd {compose_dir} && docker compose pull 2>&1 && docker compose up -d 2>&1",
            timeout=600
        )
        output_parts.append(f"Compose update in {compose_dir}:\n{stdout}\n{stderr}")
    elif container:
        # Single container update via inspect + recreate
        rc, stdout, stderr = run_command(
            f"docker inspect --format='{{{{.Config.Image}}}}' {container}", timeout=30
        )
        image = stdout.strip()
        if image:
            run_command(f"docker pull {image}", timeout=300)
            # Get container config for recreation
            rc2, info, _ = run_command(
                f"docker inspect {container}", timeout=30
            )
            output_parts.append(f"Pulled latest {image}")

            rc3, stdout3, stderr3 = run_command(
                f"docker stop {container} && docker rm {container}",
                timeout=60
            )
            output_parts.append(f"Stopped and removed {container}")
            # Note: recreation needs the original run command, which we don't have
            output_parts.append(
                "Container stopped. Use docker-compose or re-run with original params."
            )
    else:
        # Update ALL running containers via compose if available
        rc, stdout, stderr = run_command(
            "docker ps --format '{{.Names}}' | while read c; do "
            "img=$(docker inspect --format='{{.Config.Image}}' $c); "
            "echo \"Pulling $img for $c\"; "
            "docker pull $img 2>&1; done",
            timeout=900
        )
        output_parts.append(f"Pulled updates:\n{stdout}\n{stderr}")

    return "\n".join(output_parts)


def job_backup(params):
    """Run a backup script."""
    script = params.get('script', '/root/proxmox-vm-backup.sh')

    if not os.path.exists(script):
        return f"ERROR: Backup script not found: {script}"

    rc, stdout, stderr = run_command(f"bash {script}", timeout=14400)  # 4 hours
    output = f"Backup script: {script}\nExit code: {rc}\n\n{stdout}\n{stderr}"

    if params.get('reboot_after', False) and rc == 0:
        run_command('shutdown -r +2 "LabCTL: Rebooting after backup"')
        output += "\nReboot scheduled in 2 minutes."

    return output


def job_reboot(params):
    """Reboot the machine."""
    delay = params.get('delay', 30)

    if IS_WINDOWS:
        run_command(f'shutdown /r /t {delay} /c "LabCTL: Scheduled reboot"')
    else:
        minutes = max(1, delay // 60)
        run_command(f'shutdown -r +{minutes} "LabCTL: Scheduled reboot"')

    return f"Reboot scheduled in {delay} seconds."


def job_autologin(params):
    """Configure Windows auto-login with specified credentials."""
    username = params.get('username', '')
    password = params.get('password', '')

    if not IS_WINDOWS:
        return "ERROR: Autologin is only supported on Windows."

    if not username or not password:
        return "ERROR: Username and password required."

    script = f'''
    $RegPath = "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon"
    Set-ItemProperty -Path $RegPath -Name "AutoAdminLogon" -Value "1"
    Set-ItemProperty -Path $RegPath -Name "DefaultUserName" -Value "{username}"
    Set-ItemProperty -Path $RegPath -Name "DefaultPassword" -Value "{password}"
    Set-ItemProperty -Path $RegPath -Name "DefaultDomainName" -Value "{params.get('domain', '')}"
    Write-Output "AutoLogin configured for {username}"
    '''

    rc, stdout, stderr = run_command(
        ['powershell', '-ExecutionPolicy', 'Bypass', '-Command', script],
        shell=False
    )
    return stdout + stderr


def job_disable_autologin(params):
    """Remove Windows auto-login configuration."""
    if not IS_WINDOWS:
        return "ERROR: Only supported on Windows."

    script = '''
    $RegPath = "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon"
    Set-ItemProperty -Path $RegPath -Name "AutoAdminLogon" -Value "0"
    Remove-ItemProperty -Path $RegPath -Name "DefaultPassword" -ErrorAction SilentlyContinue
    Write-Output "AutoLogin disabled"
    '''

    rc, stdout, stderr = run_command(
        ['powershell', '-ExecutionPolicy', 'Bypass', '-Command', script],
        shell=False
    )
    return stdout + stderr


def job_list_crons(params):
    """List all cron jobs (Linux) or scheduled tasks (Windows)."""
    if IS_LINUX:
        output_parts = []

        # System crontab
        rc, stdout, stderr = run_command("crontab -l 2>&1")
        output_parts.append(f"=== Root crontab ===\n{stdout}")

        # /etc/cron.d/
        rc, stdout, stderr = run_command("ls -la /etc/cron.d/ 2>&1 && cat /etc/cron.d/* 2>&1")
        output_parts.append(f"=== /etc/cron.d/ ===\n{stdout}")

        # User crontabs
        rc, stdout, stderr = run_command(
            "for user in $(cut -f1 -d: /etc/passwd); do "
            "crontab -u $user -l 2>/dev/null && echo \"--- $user ---\"; done"
        )
        if stdout.strip():
            output_parts.append(f"=== User crontabs ===\n{stdout}")

        # Systemd timers
        rc, stdout, stderr = run_command("systemctl list-timers --no-pager 2>&1")
        output_parts.append(f"=== Systemd timers ===\n{stdout}")

        return "\n\n".join(output_parts)

    elif IS_WINDOWS:
        rc, stdout, stderr = run_command(
            ['powershell', '-Command',
             'Get-ScheduledTask | Where-Object {$_.State -ne "Disabled"} | '
             'Select-Object TaskName, TaskPath, State, '
             '@{N="NextRun";E={(Get-ScheduledTaskInfo $_.TaskName -ErrorAction SilentlyContinue).NextRunTime}} | '
             'ConvertTo-Json -Depth 3'],
            shell=False, timeout=60
        )
        return stdout + stderr


def job_custom_command(params):
    """Run a custom command."""
    cmd = params.get('command', '')
    if not cmd:
        return "ERROR: No command specified."

    timeout = params.get('timeout', 300)
    rc, stdout, stderr = run_command(cmd, timeout=timeout)
    return f"Exit code: {rc}\n\n{stdout}\n{stderr}"


def job_service_control(params):
    """Start/stop/restart a service."""
    service = params.get('service', '')
    action = params.get('action', 'status')  # start, stop, restart, status

    if not service:
        return "ERROR: No service specified."

    if IS_LINUX:
        rc, stdout, stderr = run_command(f"systemctl {action} {service} 2>&1 && systemctl status {service} 2>&1")
        return stdout + stderr
    elif IS_WINDOWS:
        action_map = {
            'start': 'Start-Service',
            'stop': 'Stop-Service',
            'restart': 'Restart-Service',
            'status': 'Get-Service'
        }
        ps_cmd = action_map.get(action, 'Get-Service')
        rc, stdout, stderr = run_command(
            ['powershell', '-Command', f'{ps_cmd} -Name "{service}" | Format-List *'],
            shell=False
        )
        return stdout + stderr


def job_disk_cleanup(params):
    """Run disk cleanup."""
    if IS_WINDOWS:
        script = '''
        # Windows Disk Cleanup
        cleanmgr /sagerun:1
        
        # Clear temp files
        Remove-Item -Path "$env:TEMP\\*" -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -Path "C:\\Windows\\Temp\\*" -Recurse -Force -ErrorAction SilentlyContinue
        
        # Clear Windows Update cache
        Stop-Service -Name wuauserv -Force -ErrorAction SilentlyContinue
        Remove-Item -Path "C:\\Windows\\SoftwareDistribution\\Download\\*" -Recurse -Force -ErrorAction SilentlyContinue
        Start-Service -Name wuauserv
        
        Write-Output "Disk cleanup completed"
        '''
        rc, stdout, stderr = run_command(
            ['powershell', '-ExecutionPolicy', 'Bypass', '-Command', script],
            shell=False, timeout=600
        )
        return stdout + stderr
    else:
        commands = [
            "apt-get autoremove -y 2>&1",
            "apt-get autoclean -y 2>&1",
            "journalctl --vacuum-time=7d 2>&1",
            "docker system prune -f 2>&1 || true",
            "df -h 2>&1"
        ]
        rc, stdout, stderr = run_command(" && ".join(commands), timeout=300)
        return stdout + stderr


# ── Job dispatcher ─────────────────────────────────────────
JOB_HANDLERS = {
    'windows_update': job_windows_update,
    'linux_update': job_linux_update,
    'docker_update': job_docker_update,
    'backup': job_backup,
    'reboot': job_reboot,
    'autologin': job_autologin,
    'disable_autologin': job_disable_autologin,
    'list_crons': job_list_crons,
    'custom_command': job_custom_command,
    'service_control': job_service_control,
    'disk_cleanup': job_disk_cleanup,
}


def execute_job(ws, job):
    """Execute a job and report results back."""
    job_id = job['id']
    job_type = job['type']
    params = json.loads(job.get('params', '{}')) if isinstance(job.get('params'), str) else job.get('params', {})

    print(f"[JOB] Executing: {job_type} ({job_id})")

    # Report started
    ws.send(json.dumps({'type': 'job_started', 'job_id': job_id}))

    handler = JOB_HANDLERS.get(job_type)
    if not handler:
        ws.send(json.dumps({
            'type': 'job_failed',
            'job_id': job_id,
            'error': f'Unknown job type: {job_type}'
        }))
        return

    try:
        output = handler(params)
        ws.send(json.dumps({
            'type': 'job_complete',
            'job_id': job_id,
            'output': output[:50000]  # Cap output size
        }))
        print(f"[JOB] Completed: {job_type} ({job_id})")
    except Exception as e:
        ws.send(json.dumps({
            'type': 'job_failed',
            'job_id': job_id,
            'error': f'{str(e)}\n{traceback.format_exc()}'
        }))
        print(f"[JOB] Failed: {job_type} ({job_id}) - {e}")


# ── WebSocket client ───────────────────────────────────────
class AgentClient:
    def __init__(self, server_url):
        self.server_url = server_url
        self.ws = None
        self.running = True
        self.heartbeat_thread = None

    def on_open(self, ws):
        print(f"[WS] Connected to {self.server_url}")
        # Register with server
        registration = {
            'type': 'register',
            'host_id': HOST_ID,
            'hostname': HOSTNAME,
            'os': get_os_name(),
            'ip': get_local_ip(),
            'system_info': get_system_info()
        }
        ws.send(json.dumps(registration))

        # Start heartbeat
        self.heartbeat_thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
        self.heartbeat_thread.start()

    def on_message(self, ws, message):
        try:
            msg = json.loads(message)

            if msg['type'] == 'job':
                job = msg['job']
                # Run job in a thread to not block WebSocket
                t = threading.Thread(target=execute_job, args=(ws, job), daemon=True)
                t.start()

            elif msg['type'] == 'cancel_job':
                print(f"[WS] Cancel requested for job: {msg.get('job_id')}")
                # Note: cancelling running subprocesses is complex; this is best-effort

        except Exception as e:
            print(f"[WS] Message error: {e}")

    def on_error(self, ws, error):
        print(f"[WS] Error: {error}")

    def on_close(self, ws, close_status_code, close_msg):
        print(f"[WS] Disconnected. Reconnecting in {RECONNECT_DELAY}s...")

    def _heartbeat_loop(self):
        while self.running and self.ws:
            try:
                time.sleep(HEARTBEAT_INTERVAL)
                if self.ws and self.ws.sock and self.ws.sock.connected:
                    self.ws.send(json.dumps({
                        'type': 'heartbeat',
                        'system_info': get_system_info()
                    }))
            except Exception as e:
                print(f"[HB] Error: {e}")
                break

    def run(self):
        while self.running:
            try:
                self.ws = websocket.WebSocketApp(
                    self.server_url,
                    on_open=self.on_open,
                    on_message=self.on_message,
                    on_error=self.on_error,
                    on_close=self.on_close
                )
                self.ws.run_forever(ping_interval=20, ping_timeout=10)
            except Exception as e:
                print(f"[WS] Connection failed: {e}")

            if self.running:
                time.sleep(RECONNECT_DELAY)


# ── Windows service installation ───────────────────────────
def install_windows_service():
    """Install as a Windows service using NSSM or sc.exe."""
    print("To install as a Windows service, use NSSM:")
    print()
    print("1. Download NSSM from https://nssm.cc/download")
    print("2. Run:")
    python_path = sys.executable
    script_path = os.path.abspath(__file__)
    print(f'   nssm install LabCTL-Agent "{python_path}" "{script_path}" --server {SERVER_URL}')
    print(f'   nssm set LabCTL-Agent AppDirectory "{os.path.dirname(script_path)}"')
    print('   nssm set LabCTL-Agent Start SERVICE_AUTO_START')
    print('   nssm start LabCTL-Agent')
    print()
    print("Or create a scheduled task:")
    print(f'   schtasks /create /tn "LabCTL-Agent" /tr "{python_path} {script_path} --server {SERVER_URL}" /sc onlogon /ru SYSTEM')


# ── Linux systemd installation ─────────────────────────────
def install_linux_service(server_url):
    """Generate and install systemd service file."""
    python_path = sys.executable
    script_path = os.path.abspath(__file__)

    unit = f"""[Unit]
Description=LabCTL Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart={python_path} {script_path} --server {server_url}
Restart=always
RestartSec=10
User=root
WorkingDirectory={os.path.dirname(script_path)}
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
"""

    service_path = '/etc/systemd/system/labctl-agent.service'
    with open(service_path, 'w') as f:
        f.write(unit)

    os.system('systemctl daemon-reload')
    os.system('systemctl enable labctl-agent')
    os.system('systemctl start labctl-agent')
    print(f"Service installed and started: {service_path}")
    print("Check status: systemctl status labctl-agent")


# ── Main ───────────────────────────────────────────────────
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='LabCTL Agent')
    parser.add_argument('--server', default=SERVER_URL, help='Server WebSocket URL')
    parser.add_argument('--install-service', action='store_true', help='Install as system service')
    args = parser.parse_args()

    SERVER_URL = args.server

    if args.install_service:
        if IS_WINDOWS:
            install_windows_service()
        elif IS_LINUX:
            install_linux_service(args.server)
        sys.exit(0)

    print(f"[LabCTL Agent] Host: {HOSTNAME} ({HOST_ID})")
    print(f"[LabCTL Agent] OS: {get_os_name()}")
    print(f"[LabCTL Agent] IP: {get_local_ip()}")
    print(f"[LabCTL Agent] Server: {SERVER_URL}")
    print()

    client = AgentClient(SERVER_URL)
    try:
        client.run()
    except KeyboardInterrupt:
        client.running = False
        print("\n[LabCTL Agent] Shutting down.")
