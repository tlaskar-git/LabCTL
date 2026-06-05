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
        "ip": get_local_ip(),
        "drives": [],
        "services": [],
        "domain": ""
    }

    if IS_LINUX:
        # Memory
        try:
            with open('/proc/meminfo') as f:
                for line in f:
                    if line.startswith('MemTotal:'):
                        info['ram_mb'] = int(line.split()[1]) // 1024
                    elif line.startswith('MemAvailable:'):
                        info['ram_available_mb'] = int(line.split()[1]) // 1024
        except:
            pass

        # All drives/partitions
        try:
            result = subprocess.run(['df', '-BG', '--output=source,size,used,avail,pcent,target'],
                                  capture_output=True, text=True, timeout=10)
            if result.returncode == 0:
                drives = []
                skip_mounts = ('/snap', '/boot/efi', '/run', '/sys', '/proc', '/dev/shm')
                skip_sources = ('tmpfs', 'devtmpfs', 'overlay', 'shm', 'udev', 'none')
                for line in result.stdout.strip().split('\n')[1:]:
                    parts = line.split()
                    if len(parts) >= 6:
                        source = parts[0]
                        mount = parts[5]
                        if mount.startswith(skip_mounts):
                            continue
                        if source in skip_sources:
                            continue
                        total = float(parts[1].rstrip('G'))
                        if total < 1:
                            continue
                        drives.append({
                            'device': source,
                            'mount': mount,
                            'total_gb': total,
                            'used_gb': float(parts[2].rstrip('G')),
                            'free_gb': float(parts[3].rstrip('G')),
                            'percent': int(parts[4].rstrip('%'))
                        })
                info['drives'] = drives
                # Keep legacy fields from first drive
                if drives:
                    root = next((d for d in drives if d['mount'] == '/'), drives[0])
                    info['disk_total_gb'] = root['total_gb']
                    info['disk_free_gb'] = root['free_gb']
        except:
            pass

        # Uptime
        try:
            with open('/proc/uptime') as f:
                info['uptime_hours'] = round(float(f.read().split()[0]) / 3600, 1)
        except:
            pass

        # Docker containers with details, including stopped/unhealthy containers
        try:
            result = subprocess.run(
                ['docker', 'ps', '-a', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode == 0:
                containers = []
                names = []
                running = 0
                problem_count = 0
                for line in result.stdout.strip().split('\n'):
                    if not line:
                        continue
                    parts = line.split('\t')
                    name = parts[0] if len(parts) > 0 else ''
                    status = parts[2] if len(parts) > 2 else ''
                    status_l = status.lower()
                    names.append(name)
                    containers.append({
                        'name': name,
                        'image': parts[1] if len(parts) > 1 else '',
                        'status': status,
                        'ports': parts[3] if len(parts) > 3 else ''
                    })
                    if status_l.startswith('up'):
                        running += 1
                    if status_l and (not status_l.startswith('up') or 'unhealthy' in status_l or 'exited' in status_l):
                        problem_count += 1
                info['docker_containers'] = names
                info['docker_details'] = containers
                info['docker_running'] = running
                info['docker_total'] = len(containers)
                info['docker_problem_count'] = problem_count
        except:
            pass

        # Domain
        try:
            result = subprocess.run(['hostname', '-d'], capture_output=True, text=True, timeout=5)
            if result.returncode == 0 and result.stdout.strip():
                info['domain'] = result.stdout.strip()
        except:
            pass

        # Services (top running services)
        try:
            result = subprocess.run(
                ['systemctl', 'list-units', '--type=service', '--state=running', '--no-pager', '--no-legend'],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode == 0:
                svcs = []
                for line in result.stdout.strip().split('\n'):
                    parts = line.split()
                    if parts:
                        svc_name = parts[0].replace('.service', '')
                        svcs.append(svc_name)
                info['services'] = svcs
        except:
            pass

        try:
            result = subprocess.run(
                ['systemctl', '--failed', '--type=service', '--no-pager', '--no-legend'],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode == 0:
                failed = []
                for line in result.stdout.strip().split('\n'):
                    parts = line.split()
                    if parts:
                        failed.append({'name': parts[0], 'state': ' '.join(parts[1:4])})
                info['critical_services'] = failed
        except:
            pass

    elif IS_WINDOWS:
        # Memory - use PowerShell for both total and available
        try:
            result = subprocess.run(
                ['powershell', '-Command',
                 "$os = Get-CimInstance Win32_OperatingSystem; "
                 "@{Total=[math]::Round($os.TotalVisibleMemorySize/1024); "
                 "Available=[math]::Round($os.FreePhysicalMemory/1024)} | ConvertTo-Json"],
                capture_output=True, text=True, timeout=10, shell=False
            )
            if result.returncode == 0:
                mem = json.loads(result.stdout)
                info['ram_mb'] = mem.get('Total', 0)
                info['ram_available_mb'] = mem.get('Available', 0)
        except:
            pass

        # Uptime
        try:
            result = subprocess.run(
                ['powershell', '-Command',
                 "((Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime).TotalHours"],
                capture_output=True, text=True, timeout=10, shell=False
            )
            if result.returncode == 0:
                info['uptime_hours'] = round(float(result.stdout.strip()), 1)
        except:
            pass

        # All drives
        try:
            result = subprocess.run(
                ['powershell', '-Command',
                 "Get-PSDrive -PSProvider FileSystem | Where-Object {$_.Used -ne $null} | "
                 "Select-Object Name, @{N='Total';E={[math]::Round(($_.Used+$_.Free)/1GB,1)}}, "
                 "@{N='Used';E={[math]::Round($_.Used/1GB,1)}}, "
                 "@{N='Free';E={[math]::Round($_.Free/1GB,1)}}, "
                 "@{N='Percent';E={[math]::Round($_.Used/($_.Used+$_.Free)*100)}} | ConvertTo-Json"],
                capture_output=True, text=True, timeout=10, shell=False
            )
            if result.returncode == 0:
                raw = result.stdout.strip()
                if raw:
                    data = json.loads(raw)
                    if isinstance(data, dict):
                        data = [data]
                    drives = []
                    for d in data:
                        drives.append({
                            'device': d.get('Name', '?') + ':',
                            'mount': d.get('Name', '?') + ':\\',
                            'total_gb': d.get('Total', 0),
                            'used_gb': d.get('Used', 0),
                            'free_gb': d.get('Free', 0),
                            'percent': d.get('Percent', 0)
                        })
                    info['drives'] = drives
                    if drives:
                        info['disk_total_gb'] = drives[0]['total_gb']
                        info['disk_free_gb'] = drives[0]['free_gb']
        except:
            pass

        # Domain
        try:
            result = subprocess.run(
                ['powershell', '-Command',
                 "(Get-CimInstance Win32_ComputerSystem).Domain"],
                capture_output=True, text=True, timeout=10, shell=False
            )
            if result.returncode == 0:
                domain = result.stdout.strip()
                if domain and domain != 'WORKGROUP':
                    info['domain'] = domain
        except:
            pass

        # Services (running)
        try:
            result = subprocess.run(
                ['powershell', '-Command',
                 "Get-Service | Where-Object {$_.Status -eq 'Running'} | "
                 "Select-Object -ExpandProperty Name | Sort-Object"],
                capture_output=True, text=True, timeout=15, shell=False
            )
            if result.returncode == 0:
                info['services'] = [s.strip() for s in result.stdout.strip().split('\n') if s.strip()]
        except:
            pass

        try:
            result = subprocess.run(
                ['powershell', '-Command',
                 "Get-Service | Where-Object {$_.StartType -eq 'Automatic' -and $_.Status -ne 'Running'} | "
                 "Select-Object Name,DisplayName,Status | ConvertTo-Json -Depth 2"],
                capture_output=True, text=True, timeout=15, shell=False
            )
            if result.returncode == 0 and result.stdout.strip():
                data = json.loads(result.stdout)
                if isinstance(data, dict):
                    data = [data]
                info['critical_services'] = data
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
    containers = params.get('containers', [])
    compose_dir = params.get('compose_dir', None)
    output_parts = []

    if compose_dir:
        # Docker Compose update
        rc, stdout, stderr = run_command(
            f"cd {compose_dir} && docker compose pull 2>&1 && docker compose up -d 2>&1",
            timeout=600
        )
        output_parts.append(f"Compose update in {compose_dir}:\n{stdout}\n{stderr}")
    elif containers and len(containers) > 0:
        # Multiple selected containers - pull then restart
        restart = params.get('restart', True)
        for c in containers:
            rc, stdout, stderr = run_command(
                f"docker inspect --format='{{{{.Config.Image}}}}' {c}", timeout=30
            )
            image = stdout.strip()
            if image:
                rc2, stdout2, stderr2 = run_command(f"docker pull {image}", timeout=300)
                output_parts.append(f"[{c}] Pulled {image}:\n{stdout2.strip()}")

                if restart:
                    # Try compose restart first (finds compose project from labels)
                    rc3, proj, _ = run_command(
                        f"docker inspect --format='{{{{index .Config.Labels \"com.docker.compose.project.working_dir\"}}}}' {c}",
                        timeout=10
                    )
                    compose_path = proj.strip()
                    if compose_path and rc3 == 0:
                        svc_rc, svc_name, _ = run_command(
                            f"docker inspect --format='{{{{index .Config.Labels \"com.docker.compose.service\"}}}}' {c}",
                            timeout=10
                        )
                        svc = svc_name.strip()
                        if svc:
                            rc4, out4, err4 = run_command(
                                f"cd {compose_path} && docker compose up -d {svc} 2>&1",
                                timeout=120
                            )
                            output_parts.append(f"[{c}] Restarted via compose:\n{out4.strip()}")
                        else:
                            rc4, out4, err4 = run_command(f"docker restart {c}", timeout=60)
                            output_parts.append(f"[{c}] Restarted: {out4.strip()}")
                    else:
                        rc4, out4, err4 = run_command(f"docker restart {c}", timeout=60)
                        output_parts.append(f"[{c}] Restarted: {out4.strip()}")
            else:
                output_parts.append(f"[{c}] Could not find image")
    elif container:
        # Single container (legacy)
        rc, stdout, stderr = run_command(
            f"docker inspect --format='{{{{.Config.Image}}}}' {container}", timeout=30
        )
        image = stdout.strip()
        if image:
            run_command(f"docker pull {image}", timeout=300)
            output_parts.append(f"Pulled latest {image}")
            rc3, stdout3, stderr3 = run_command(
                f"docker stop {container} && docker rm {container}",
                timeout=60
            )
            output_parts.append(f"Stopped and removed {container}")
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
    """Run disk cleanup with selectable options."""
    options = params.get('options', [])
    output_parts = []

    if IS_WINDOWS:
        if not options or 'temp' in options:
            rc, s, e = run_command(['powershell', '-Command',
                'Remove-Item -Path "$env:TEMP\\*" -Recurse -Force -ErrorAction SilentlyContinue; '
                'Remove-Item -Path "C:\\Windows\\Temp\\*" -Recurse -Force -ErrorAction SilentlyContinue; '
                'Write-Output "Temp files cleared"'], shell=False, timeout=120)
            output_parts.append(s.strip())
        if not options or 'windows_update_cache' in options:
            rc, s, e = run_command(['powershell', '-Command',
                'Stop-Service -Name wuauserv -Force -ErrorAction SilentlyContinue; '
                'Remove-Item -Path "C:\\Windows\\SoftwareDistribution\\Download\\*" -Recurse -Force -ErrorAction SilentlyContinue; '
                'Start-Service -Name wuauserv; Write-Output "Windows Update cache cleared"'], shell=False, timeout=120)
            output_parts.append(s.strip())
        if not options or 'recycle_bin' in options:
            rc, s, e = run_command(['powershell', '-Command',
                'Clear-RecycleBin -Force -ErrorAction SilentlyContinue; Write-Output "Recycle bin emptied"'],
                shell=False, timeout=60)
            output_parts.append(s.strip())
        if not options or 'event_logs' in options:
            rc, s, e = run_command(['powershell', '-Command',
                'Get-EventLog -LogName * | ForEach-Object { Clear-EventLog $_.Log -ErrorAction SilentlyContinue }; '
                'Write-Output "Event logs cleared"'], shell=False, timeout=60)
            output_parts.append(s.strip())
        # Show disk space after
        rc, s, e = run_command(['powershell', '-Command',
            "Get-PSDrive -PSProvider FileSystem | Where-Object {$_.Used -ne $null} | "
            "Format-Table Name, @{N='Free(GB)';E={[math]::Round($_.Free/1GB,1)}}, "
            "@{N='Used(GB)';E={[math]::Round($_.Used/1GB,1)}} -AutoSize | Out-String"],
            shell=False, timeout=30)
        output_parts.append(f"\nDisk space:\n{s}")
    else:
        if not options or 'apt_cache' in options:
            rc, s, e = run_command("apt-get autoremove -y 2>&1 && apt-get autoclean -y 2>&1", timeout=120)
            output_parts.append(f"APT cleanup:\n{s}")
        if not options or 'journal' in options:
            rc, s, e = run_command("journalctl --vacuum-time=7d 2>&1", timeout=60)
            output_parts.append(f"Journal vacuum:\n{s}")
        if not options or 'docker_prune' in options:
            rc, s, e = run_command("docker system prune -f 2>&1 || echo 'Docker not available'", timeout=120)
            output_parts.append(f"Docker prune:\n{s}")
        if not options or 'tmp' in options:
            rc, s, e = run_command("rm -rf /tmp/* 2>&1 || true", timeout=30)
            output_parts.append("Temp files cleared")
        rc, s, e = run_command("df -h 2>&1", timeout=10)
        output_parts.append(f"\nDisk space:\n{s}")

    return "\n".join(output_parts)


def job_file_browse(params):
    """Browse files and directories."""
    path = params.get('path', '/' if IS_LINUX else 'C:\\')
    action = params.get('action', 'list')  # list, read

    if action == 'list':
        if IS_LINUX:
            rc, stdout, stderr = run_command(f"ls -lah '{path}' 2>&1", timeout=10)
        else:
            rc, stdout, stderr = run_command(
                ['powershell', '-Command', f"Get-ChildItem -Path '{path}' | Format-Table Mode, Length, LastWriteTime, Name -AutoSize | Out-String"],
                shell=False, timeout=10
            )
        return stdout + stderr
    elif action == 'read':
        max_size = params.get('max_size', 50000)
        try:
            with open(path, 'r', errors='replace') as f:
                content = f.read(max_size)
            return content
        except Exception as e:
            return f"ERROR: {e}"
    return "Unknown action"


def job_list_task_folders(params):
    """List Windows Task Scheduler folders."""
    if not IS_WINDOWS:
        return "Only available on Windows"
    rc, stdout, stderr = run_command(
        ['powershell', '-Command',
         "function Get-TaskFolders($path='\\') { "
         "$folder = (New-Object -ComObject Schedule.Service); $folder.Connect(); "
         "$root = $folder.GetFolder($path); "
         "foreach($f in $root.GetFolders(0)) { $f.Path; Get-TaskFolders $f.Path } }; "
         "Get-TaskFolders"],
        shell=False, timeout=15
    )
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
    'file_browse': job_file_browse,
    'list_task_folders': job_list_task_folders,
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
