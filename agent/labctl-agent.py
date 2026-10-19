#!/usr/bin/env python3
"""
LabCTL agent v2. One file, Python 3.8+ standard library plus websocket-client.
Runs on Linux (Debian, Ubuntu, RHEL family, Proxmox), macOS and Windows.

The agent connects to wss://<server>/ws/agent?token=<enrolment token>, registers,
sends a light heartbeat every 30 s and a full inventory every 5 min, and runs jobs
that the server sends. Protocol: docs/ARCHITECTURE.md (shared contract).

Entry points
  labctl-agent.py [--config PATH] [--server URL] [--token TOKEN]
      Run the agent. --server and --token are saved into the config file.
  labctl-agent.py --install-service [--server URL] [--token TOKEN]
      Linux: write the systemd unit plus a watchdog timer and start them.
      macOS uses setup-mac.sh. Windows uses setup-windows.ps1.
  labctl-agent.py --watchdog
      One-shot self-update check. Run it every 30 s (systemd timer, launchd
      StartInterval, Windows scheduled task). If update-pending.json exists and the
      new agent did not connect within 60 s, it restores labctl-agent.py.bak and
      restarts the agent service.
  labctl-agent.py --restore-bak
      Put labctl-agent.py.bak back in place and clear the update marker. No restart.
  labctl-agent.py --collect
      Print one full inventory as JSON and exit (diagnostics).

Exit codes: 0 normal stop, 2 configuration error, 75 restart requested (after a
self-update). systemd Restart=always and launchd KeepAlive restart on any exit.

Config file: agent.json next to this script (override with --config or the
LABCTL_CONFIG environment variable). Keys:
  server_url        https://labctl.example.test (ws/wss URLs also accepted)
  token             enrolment token (never logged)
  host_id           stable id, derived from the host name on first run
  runner_folders    extra GitHub Actions runner folders to report
  windows_task_name scheduled task or service name on Windows (default LabCTL-Agent)
Environment LABCTL_SERVER_URL and LABCTL_TOKEN override the file. CLI overrides both.

Inventory keys (inventory.data). Sizes are bytes, times are ISO 8601 UTC strings,
rates are bytes per second. A value is null when the host cannot report it.
  schema (2), agent_version, os (linux|darwin|windows), hostname, errors{collector: message}
  os_info     {name, version, build, kernel, arch, model, domain, ip, boot_time, uptime_s}
  cpu         {count, percent, load[1,5,15]}
  memory      {total, used, available, percent, swap_total, swap_used, swap_percent}
  disks[]     {device, mount, fstype, total, used, free, percent, inodes_total, inodes_used, inodes_percent}
  net[]       {iface, rx_bytes, tx_bytes, rx_bytes_per_s, tx_bytes_per_s}
  temps[]     {sensor, celsius}
  smart[]     {device, health (ok|failing|unknown), detail}
  procs       {top_cpu[], top_mem[]} each {pid, user, name, cpu, mem_percent, rss}
  services    {failed[] {name, state, detail}}
  updates     {pending, security, restart_required, reboot_required, reboot_pending_days, last_patch, items[]}
  time        {drift_s, source, synced}
  docker      {running, total, containers[] {id, name, image, state, status, health, restart_count,
               cpu_percent, mem_bytes, mem_percent, image_created, image_age_days, repo_digests, newer_image}}
  security    linux {firewall}; darwin {filevault, firewall, gatekeeper, sip}; windows {defender}
  runners[]   {path, name, url, pool, level (repo|org|enterprise), labels, service, service_state, run_as,
               source, version, busy, job, sizes{work, diag, temp, tool_cache}, sizes_partial, log_tail[]}
  darwin      {softwareupdate, brew{formulae, casks, items}, xcode{apps[], clt{path, version},
               derived_data_bytes, simulators{count, unavailable, bytes}}, time_machine{latest, age_days},
               pmset{}, launchd_failed[]}
  windows     {pending_reboot{cbs, wu, file_rename, any}, failed_tasks[], last_update{result, date, title}}
  proxmox     {version, zpool_healthy, zpools[], arc_bytes, arc_max_bytes, vms[], containers[]}
"""

import argparse
import base64
import codecs
import glob
import hashlib
import json
import os
import platform
import plistlib
import py_compile
import queue
import random
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

try:
    import websocket  # websocket-client, installed in the venv inside the install folder
except ImportError:  # tests import this file without it
    websocket = None

VERSION = "2.0.0"
HEARTBEAT_S = 30
INVENTORY_S = 300
FLUSH_BYTES = 4096
FLUSH_S = 1.0
UPDATE_GRACE_S = 60
SLOW_CACHE_S = 3600  # softwareupdate, brew and Windows Update searches hit the network
EXIT_CONFIG = 2
EXIT_RESTART = 75
OUTBOX_MAX_BYTES = 8 * 1024 * 1024

SYSTEM = platform.system()
IS_WINDOWS = SYSTEM == "Windows"
IS_DARWIN = SYSTEM == "Darwin"
IS_LINUX = SYSTEM == "Linux"
OS_NAME = "windows" if IS_WINDOWS else "darwin" if IS_DARWIN else "linux"
SCRIPT_PATH = os.path.abspath(__file__)
INSTALL_DIR = os.path.dirname(SCRIPT_PATH)
LINUX_UNIT = "labctl-agent"
MAC_LABEL = "com.labctl.agent"
MAC_WATCHDOG_LABEL = "com.labctl.agent.watchdog"
DEFAULT_WINDOWS_TASK = "LabCTL-Agent"
CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_PROCESS_GROUP = 0x00000200
DETACHED_PROCESS = 0x00000008
CREATE_BREAKAWAY_FROM_JOB = 0x01000000


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

_REDACT = re.compile(r"((?:token|password|secret)=|Authorization:\s*\w+\s+)[^&\s\"']+", re.I)


def redact(text):
    return _REDACT.sub(r"\1***", str(text))


def log(*parts):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), redact(" ".join(str(p) for p in parts)), flush=True)


def iso(ts):
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now_iso():
    return iso(time.time())


def to_int(v, default=None):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


def to_float(v, default=None):
    try:
        return float(str(v).strip().rstrip("%"))
    except (TypeError, ValueError):
        return default


def pct(part, whole):
    return round(part * 100.0 / whole, 1) if whole else None


def _popen_flags():
    return {"creationflags": CREATE_NO_WINDOW} if IS_WINDOWS else {}


def run(cmd, timeout=30, env=None, input_text=None):
    """Run argv. Return (rc, stdout, stderr). rc is None when it could not run. Never raises."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=timeout, env=env, input=input_text,
                           stdin=None if input_text is not None else subprocess.DEVNULL, **_popen_flags())
        return p.returncode, p.stdout or "", p.stderr or ""
    except subprocess.TimeoutExpired:
        return None, "", "timed out after %s s" % timeout
    except (OSError, ValueError) as e:
        return None, "", str(e)


def out(cmd, timeout=30, **kw):
    """stdout when the command exits 0, else None."""
    rc, o, _ = run(cmd, timeout, **kw)
    return o if rc == 0 else None


def which(name):
    return shutil.which(name)


def read_text(path, default=""):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return default


def read_bytes(path):
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return None


def tail_text(path, nbytes=65536):
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - nbytes))
            data = f.read()
    except OSError:
        return ""
    text = data.decode("utf-8", "replace")
    if size > nbytes and "\n" in text:
        text = text.split("\n", 1)[1]  # drop the partial first line
    return text


def dir_size(path, deadline):
    """Sum file sizes under path without following links. Return (bytes, partial).
    Stats entries only; never opens a file."""
    if not os.path.isdir(path):
        return None, False
    total, stack = 0, [path]
    while stack:
        if time.monotonic() > deadline:
            return total, True
        try:
            it = os.scandir(stack.pop())
        except OSError:
            continue
        with it:
            for e in it:
                try:
                    if e.is_dir(follow_symlinks=False):
                        stack.append(e.path)
                    elif e.is_file(follow_symlinks=False):
                        total += e.stat(follow_symlinks=False).st_size
                except OSError:
                    pass
    return total, False


def parse_kv_lines(text, sep=":"):
    d = {}
    for line in (text or "").splitlines():
        if sep in line:
            k, v = line.split(sep, 1)
            d[k.strip()] = v.strip()
    return d


_SIZE_UNITS = {"b": 1, "k": 1024, "kb": 1000, "kib": 1024, "m": 1024 ** 2, "mb": 1000 ** 2, "mib": 1024 ** 2,
               "g": 1024 ** 3, "gb": 1000 ** 3, "gib": 1024 ** 3, "t": 1024 ** 4, "tb": 1000 ** 4, "tib": 1024 ** 4}


def parse_size(text):
    """'12.3MiB' / '2048.00M' / '1.5GB' -> bytes (int) or None."""
    m = re.match(r"^\s*([\d.]+)\s*([A-Za-z]*)\s*$", str(text or ""))
    if not m:
        return None
    mult = _SIZE_UNITS.get(m.group(2).lower() or "b")
    return int(float(m.group(1)) * mult) if mult else None


def parse_iso_ts(text):
    """ISO 8601 with optional nanoseconds and zone -> epoch seconds or None."""
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?", str(text or ""))
    if not m:
        return None
    y, mo, d, h, mi, s = (int(x) for x in m.groups()[:6])
    tz = m.group(8)
    offset = 0
    if tz and tz != "Z":
        sign = -1 if tz[0] == "-" else 1
        digits = tz[1:].replace(":", "")
        offset = sign * (int(digits[:2]) * 3600 + int(digits[2:]) * 60)
    frac = float(m.group(7)) if m.group(7) else 0.0
    return datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc).timestamp() + frac - offset


def parse_ps_date(v):
    """PowerShell ConvertTo-Json dates: '/Date(ms)/', {'value': '/Date(ms)/', ...} or ISO -> ISO UTC."""
    if isinstance(v, dict):
        v = v.get("value") or v.get("DateTime")
    if v is None:
        return None
    m = re.search(r"/Date\((-?\d+)", str(v))
    if m:
        ms = int(m.group(1))
        return iso(ms / 1000.0) if ms > 0 else None
    ts = parse_iso_ts(v)
    return iso(ts) if ts else None


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def default_config_path():
    return os.environ.get("LABCTL_CONFIG") or os.path.join(INSTALL_DIR, "agent.json")


def derive_host_id(hostname=None, node=None):
    # Same derivation as agent v1 so existing hosts keep their id.
    hostname = hostname or socket.gethostname()
    node = node or platform.node()
    return hashlib.md5(("%s-%s" % (hostname, node)).encode()).hexdigest()[:12]


def load_config(path, overrides=None, env=None):
    env = os.environ if env is None else env
    cfg = {}
    try:
        with open(path, encoding="utf-8-sig") as f:
            cfg = json.load(f)
    except FileNotFoundError:
        pass
    for key, var in (("server_url", "LABCTL_SERVER_URL"), ("token", "LABCTL_TOKEN")):
        if env.get(var):
            cfg[key] = env[var]
    for k, v in (overrides or {}).items():
        if v:
            cfg[k] = v
    cfg.setdefault("host_id", derive_host_id())
    cfg.setdefault("runner_folders", [])
    return cfg


def save_config(path, cfg):
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".agent-", suffix=".json", dir=d)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    if not IS_WINDOWS:
        os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def build_ws_url(server, token):
    """https://host -> wss://host/ws/agent?token=...; ws(s) URLs keep their scheme."""
    s = (server or "").strip()
    if "://" not in s:
        s = "wss://" + s
    u = urllib.parse.urlsplit(s)
    scheme = {"http": "ws", "https": "wss"}.get(u.scheme, u.scheme)
    path = u.path.rstrip("/")
    if not path.endswith("/ws/agent"):
        path += "/ws/agent"
    q = [(k, v) for k, v in urllib.parse.parse_qsl(u.query) if k != "token"]
    if token:
        q.append(("token", token))
    return urllib.parse.urlunsplit((scheme, u.netloc, path, urllib.parse.urlencode(q), ""))


# ---------------------------------------------------------------------------
# Parsers (pure functions, unit tested against agent/tests/fixtures)
# ---------------------------------------------------------------------------

def parse_os_release(text):
    d = {}
    for line in (text or "").splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            d[k.strip()] = v.strip().strip('"').strip("'")
    return d


def parse_sw_vers(text):
    d = parse_kv_lines(text)
    return {"name": d.get("ProductName"), "version": d.get("ProductVersion"), "build": d.get("BuildVersion")}


_SU_SPLIT = re.compile(r",\s*(?=[A-Z][A-Za-z ]*:)")


def parse_softwareupdate(text):
    """softwareupdate -l (macOS 10.15 to 15) -> {pending, restart_required, items[]}."""
    items, cur = [], None
    for line in (text or "").splitlines():
        s = line.strip()
        if s.startswith("* Label:") or (s.startswith("* ") and ":" not in s[:8]):
            label = s[len("* Label:"):] if s.startswith("* Label:") else s[2:]
            cur = {"label": label.strip(), "title": None, "version": None, "size_kb": None,
                   "recommended": False, "restart": False}
            items.append(cur)
        elif cur is not None and s.startswith("Title:"):
            fields = {}
            for part in _SU_SPLIT.split(s.rstrip(", ")):
                if ":" in part:
                    k, v = part.split(":", 1)
                    fields[k.strip().lower()] = v.strip()
            cur["title"] = fields.get("title")
            cur["version"] = fields.get("version")
            size = re.match(r"(\d+)", fields.get("size", ""))
            cur["size_kb"] = int(size.group(1)) if size else None
            cur["recommended"] = fields.get("recommended", "").upper() == "YES"
            cur["restart"] = fields.get("action", "").lower() in ("restart", "shut down")
        elif cur is not None and "[restart]" in s:  # pre-10.15 layout
            cur["restart"] = True
            cur["recommended"] = "[recommended]" in s
    return {"pending": len(items), "restart_required": any(i["restart"] for i in items), "items": items}


def parse_vm_stat(text, memsize):
    m = re.search(r"page size of (\d+) bytes", text or "")
    page = int(m.group(1)) if m else 4096
    pages = {}
    for line in (text or "").splitlines():
        mm = re.match(r'^"?([^":]+)"?:\s+(\d+)\.?\s*$', line.strip())
        if mm:
            pages[mm.group(1).strip().lower()] = int(mm.group(2))
    if "anonymous pages" in pages:  # same idea as Activity Monitor: app + wired + compressed
        app = pages["anonymous pages"] - pages.get("pages purgeable", 0)
    else:
        app = pages.get("pages active", 0)
    used = (app + pages.get("pages wired down", 0) + pages.get("pages occupied by compressor", 0)) * page
    if memsize:
        used = min(used, memsize)
    return {"total": memsize, "used": used, "available": (memsize - used) if memsize else None,
            "percent": pct(used, memsize), "page_size": page}


_DF_LINE = re.compile(r"^(?P<dev>.+?)\s+(?P<total>\d+)\s+(?P<used>\d+)\s+(?P<avail>\d+)\s+(?P<cap>\d+%|-)\s+"
                      r"(?:(?P<iused>\d+)\s+(?P<ifree>\d+)\s+(?P<ipct>\d+%|-)\s+)?(?P<mount>/.*)$")


def parse_df(text, block=1024):
    """df -k (macOS, with inode columns) or df -kP (Linux). Mount points can hold spaces."""
    rows = []
    for line in (text or "").splitlines()[1:]:
        m = _DF_LINE.match(line.rstrip())
        if not m:
            continue
        total, used, avail = (int(m.group(k)) * block for k in ("total", "used", "avail"))
        row = {"device": m.group("dev").strip(), "mount": m.group("mount"), "fstype": None,
               "total": total, "used": used, "free": avail, "percent": pct(used, used + avail),
               "inodes_total": None, "inodes_used": None, "inodes_percent": None}
        if m.group("iused") is not None:
            iu, ifree = int(m.group("iused")), int(m.group("ifree"))
            row.update(inodes_total=iu + ifree, inodes_used=iu, inodes_percent=pct(iu, iu + ifree))
        rows.append(row)
    return rows


def filter_mac_disks(disks):
    """Keep real volumes: /, /System/Volumes/Data, /Volumes/*. Skip devfs, autofs maps,
    snapshots, Time Machine mounts and the other /System/Volumes/* helpers."""
    keep = []
    for d in disks:
        dev, mnt = d["device"], d["mount"]
        if not dev.startswith("/dev/") or "@" in dev:
            continue
        if ".timemachine" in mnt or "localsnapshots" in mnt:
            continue
        if mnt.startswith("/System/Volumes/") and mnt != "/System/Volumes/Data":
            continue
        keep.append(d)
    return keep


_LINUX_SKIP_FS = {"tmpfs", "devtmpfs", "overlay", "squashfs", "proc", "sysfs", "cgroup", "cgroup2", "autofs",
                  "efivarfs", "ramfs", "nsfs", "tracefs", "debugfs", "devpts", "fuse.lxcfs", "fusectl",
                  "securityfs", "pstore", "bpf", "mqueue", "hugetlbfs", "configfs", "binfmt_misc", "rpc_pipefs"}


def filter_linux_disks(disks, fstypes):
    keep = []
    for d in disks:
        d["fstype"] = fstypes.get(d["mount"])
        if d["fstype"] in _LINUX_SKIP_FS or d["total"] == 0:
            continue
        if any(d["mount"] == p or d["mount"].startswith(p + "/") for p in ("/snap", "/run", "/sys", "/proc", "/dev")):
            continue
        keep.append(d)
    return keep


def parse_proc_mounts(text):
    types = {}
    for line in (text or "").splitlines():
        parts = line.split()
        if len(parts) >= 3:
            types[parts[1].replace("\\040", " ")] = parts[2]
    return types


def parse_sysctl_boottime(text):
    m = re.search(r"sec\s*=\s*(\d+)", text or "")
    return int(m.group(1)) if m else None


def parse_swapusage(text):
    vals = dict(re.findall(r"(total|used|free)\s*=\s*([\d.]+[KMGT]?)", text or ""))
    total, used = parse_size(vals.get("total")), parse_size(vals.get("used"))
    return {"swap_total": total, "swap_used": used, "swap_percent": pct(used or 0, total),
            "encrypted": "(encrypted)" in (text or "")}


def parse_fdesetup(text):
    t = text or ""
    return True if "FileVault is On" in t else False if "FileVault is Off" in t else None


def parse_socketfilterfw(text):
    m = re.search(r"State\s*=\s*(\d)", text or "")
    if m:
        return int(m.group(1)) >= 1
    t = (text or "").lower()
    return True if "enabled" in t else False if "disabled" in t else None


def parse_spctl(text):
    t = (text or "").lower()
    return True if "assessments enabled" in t else False if "assessments disabled" in t else None


def parse_csrutil(text):
    m = re.search(r"status:\s*(\w+)", text or "")
    if not m:
        return None
    return {"enabled": True, "disabled": False}.get(m.group(1).lower())


def parse_brew_outdated(text):
    data = json.loads(text or "{}")
    formulae, casks = data.get("formulae") or [], data.get("casks") or []
    items = [{"name": f.get("name"), "kind": "formula", "installed": (f.get("installed_versions") or [None])[-1],
              "current": f.get("current_version"), "pinned": bool(f.get("pinned"))} for f in formulae]
    items += [{"name": c.get("name"), "kind": "cask", "installed": (c.get("installed_versions") or [None])[-1],
               "current": c.get("current_version"), "pinned": False} for c in casks]
    return {"formulae": len(formulae), "casks": len(casks), "items": items}


def parse_simctl(text):
    """xcrun simctl list devices --json -> {count, unavailable, bytes (from dataPathSize when present)}."""
    data = json.loads(text or "{}")
    count = unavailable = size = 0
    have_size = False
    for devices in (data.get("devices") or {}).values():
        for d in devices:
            count += 1
            if not d.get("isAvailable", True):
                unavailable += 1
            if isinstance(d.get("dataPathSize"), int):
                size += d["dataPathSize"]
                have_size = True
    return {"count": count, "unavailable": unavailable, "bytes": size if have_size else None}


def parse_launchctl_list(text):
    rows = []
    for line in (text or "").splitlines()[1:]:
        parts = line.split("\t") if "\t" in line else line.split(None, 2)
        if len(parts) != 3:
            continue
        pid, status, label = (p.strip() for p in parts)
        rows.append({"label": label, "pid": to_int(pid), "status": to_int(status, 0)})
    return rows


def launchd_failed(rows):
    return [{"name": r["label"], "state": "exit %d" % r["status"], "detail": None}
            for r in rows if r["status"] != 0 and r["pid"] is None]


def parse_tmutil_latest(text):
    """tmutil latestbackup -> local time ISO string (no zone) of the newest backup, or None."""
    m = re.findall(r"(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})", text or "")
    if not m:
        return None
    y, mo, d, h, mi, s = m[-1]
    return "%s-%s-%sT%s:%s:%s" % (y, mo, d, h, mi, s)


def parse_pmset(text):
    settings, active = {}, False
    for line in (text or "").splitlines():
        if line.strip().startswith("Currently in use"):
            active = True
            continue
        if not active or not line.startswith((" ", "\t")):
            continue
        m = re.match(r"^\s+(.+?)\s+(\S+)(?:\s+\((.*)\))?\s*$", line)
        if m:
            key = m.group(1).strip()
            settings[key] = to_int(m.group(2), m.group(2))
            if m.group(3):
                settings[key + "_note"] = m.group(3)
    return settings


def parse_time_offset(text):
    """Clock offset in seconds (positive = local clock ahead) from sntp, chronyc tracking or w32tm."""
    t = text or ""
    m = re.search(r"System time\s*:\s*([\d.]+)\s+seconds\s+(fast|slow)", t)
    if m:
        v = float(m.group(1))
        return v if m.group(2) == "fast" else -v
    m = re.search(r",\s*([+-]?\d+\.\d+)s\s*$", t, re.M)  # w32tm /stripchart reports remote minus local
    if m:
        return -float(m.group(1))
    m = re.search(r"([+-]\d+\.\d+)\s+\+/-", t)  # sntp reports the correction to apply
    if m:
        return -float(m.group(1))
    return None


def parse_runner_file(raw):
    """.runner JSON (written with a UTF-8 BOM by the runner) -> dict."""
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8-sig")
    return json.loads(raw.lstrip("﻿"))


def runner_level(url):
    parts = [p for p in urllib.parse.urlsplit(url or "").path.split("/") if p]
    if not parts:
        return None
    if parts[0] == "enterprises":
        return "enterprise"
    return "org" if len(parts) == 1 else "repo"


def newest_log(names, prefix):
    """Runner logs are named <prefix>YYYYMMDD-HHMMSS-utc.log, so the name order is time order."""
    logs = sorted(n for n in names if n.startswith(prefix) and n.endswith(".log"))
    return logs[-1] if logs else None


def parse_worker_job_name(text):
    names = re.findall(r'"jobDisplayName"\s*:\s*"((?:[^"\\]|\\.)*)"', text or "")
    if names:
        return json.loads('"%s"' % names[-1])
    m = re.findall(r"Running job:\s*(.+)", text or "")
    return m[-1].strip() if m else None


def parse_unit_file(text):
    d = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if "=" in line and not line.startswith(("#", ";", "[")):
            k, v = line.split("=", 1)
            d.setdefault(k.strip(), v.strip())
    return d


def parse_meminfo(text):
    kv = {}
    for line in (text or "").splitlines():
        parts = line.split()
        if len(parts) >= 2:
            kv[parts[0].rstrip(":")] = int(parts[1]) * 1024
    total = kv.get("MemTotal")
    avail = kv.get("MemAvailable", kv.get("MemFree"))
    used = total - avail if total is not None and avail is not None else None
    st, sf = kv.get("SwapTotal"), kv.get("SwapFree")
    su = st - sf if st is not None and sf is not None else None
    return {"total": total, "used": used, "available": avail, "percent": pct(used or 0, total),
            "swap_total": st, "swap_used": su, "swap_percent": pct(su or 0, st)}


def parse_proc_stat_cpu(text):
    for line in (text or "").splitlines():
        if line.startswith("cpu "):
            vals = [int(x) for x in line.split()[1:]]
            idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
            return idle, sum(vals[:8])
    return None


def cpu_percent_from(prev, cur):
    if not prev or not cur:
        return None
    didle, dtotal = cur[0] - prev[0], cur[1] - prev[1]
    return round(max(0.0, min(100.0, 100.0 * (1 - didle / dtotal))), 1) if dtotal > 0 else None


def parse_top_cpu(text):
    lines = re.findall(r"CPU usage:.*?([\d.]+)% idle", text or "")
    return round(100.0 - float(lines[-1]), 1) if lines else None


def parse_proc_net_dev(text):
    counters = {}
    for line in (text or "").splitlines()[2:]:
        if ":" not in line:
            continue
        name, rest = line.split(":", 1)
        f = rest.split()
        if len(f) >= 9:
            counters[name.strip()] = (int(f[0]), int(f[8]))
    return counters


def parse_netstat_ibn(text):
    """netstat -ibn (macOS): link rows carry the byte counters; read columns from the right."""
    counters = {}
    for line in (text or "").splitlines()[1:]:
        f = line.split()
        if len(f) < 8 or "<Link#" not in line:
            continue
        name = f[0].rstrip("*")
        try:
            counters[name] = (int(f[-5]), int(f[-2]))
        except ValueError:
            continue
    return counters


def net_rates(prev, cur, dt):
    rows = []
    for iface, (rx, tx) in sorted(cur.items()):
        if iface == "lo" or iface.startswith("lo0") or iface.lower().startswith("loopback"):
            continue
        row = {"iface": iface, "rx_bytes": rx, "tx_bytes": tx, "rx_bytes_per_s": None, "tx_bytes_per_s": None}
        p = (prev or {}).get(iface)
        if p and dt and dt > 0 and rx >= p[0] and tx >= p[1]:
            row["rx_bytes_per_s"] = round((rx - p[0]) / dt)
            row["tx_bytes_per_s"] = round((tx - p[1]) / dt)
        rows.append(row)
    return rows


def parse_ps(text):
    """ps -o pid=,user=,pcpu=,pmem=,rss=,comm= output."""
    procs = []
    for line in (text or "").splitlines():
        parts = line.split(None, 5)
        if len(parts) < 6 or not parts[0].isdigit():
            continue
        pid, user, cpu, mem, rss, comm = parts
        comm = comm.strip()
        procs.append({"pid": int(pid), "user": user, "name": os.path.basename(comm) or comm,
                      "cpu": to_float(cpu, 0.0), "mem_percent": to_float(mem, 0.0), "rss": to_int(rss, 0) * 1024})
    return procs


def top_procs(procs, n=10):
    return {"top_cpu": sorted(procs, key=lambda p: p["cpu"] or 0, reverse=True)[:n],
            "top_mem": sorted(procs, key=lambda p: p["rss"] or 0, reverse=True)[:n]}


def parse_systemctl_failed(text):
    rows = []
    for line in (text or "").splitlines():
        f = line.replace("●", "").split(None, 4)
        if len(f) >= 4:
            rows.append({"name": f[0], "state": "%s/%s" % (f[2], f[3]), "detail": f[4] if len(f) > 4 else None})
    return rows


def parse_apt_simulate(text):
    inst = [line for line in (text or "").splitlines() if line.startswith("Inst ")]
    return {"pending": len(inst), "security": sum(1 for line in inst if "-security" in line),
            "items": [line.split()[1] for line in inst][:200]}


def parse_apt_history_last(text):
    dates = re.findall(r"^End-Date:\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})", text or "", re.M)
    if not dates:
        return None
    d, t = dates[-1]
    return "%sT%s" % (d, t)  # local time as apt writes it


def parse_smartctl_health(text):
    t = text or ""
    m = re.search(r"overall-health self-assessment test result:\s*(\w+)", t)
    if m:
        return "ok" if m.group(1).upper() == "PASSED" else "failing"
    m = re.search(r"SMART Health Status:\s*(\w+)", t)
    if m:
        return "ok" if m.group(1).upper() == "OK" else "failing"
    return "unknown"


def parse_diskutil_smart(text):
    m = re.search(r"SMART Status:\s*(.+)", text or "")
    if not m:
        return None
    v = m.group(1).strip()
    return {"health": "ok" if v == "Verified" else "failing" if "fail" in v.lower() else "unknown", "detail": v}


def parse_arcstats(text):
    vals = {}
    for line in (text or "").splitlines()[2:]:
        f = line.split()
        if len(f) == 3 and f[2].isdigit():
            vals[f[0]] = int(f[2])
    return {"arc_bytes": vals.get("size"), "arc_max_bytes": vals.get("c_max")}


def parse_qm_list(text):
    rows = []
    for line in (text or "").splitlines()[1:]:
        f = line.split()
        if len(f) >= 3 and f[0].isdigit():
            rows.append({"vmid": int(f[0]), "name": f[1], "status": f[2],
                         "mem_mb": to_int(f[3]) if len(f) > 3 else None})
    return rows


def parse_pct_list(text):
    rows = []
    for line in (text or "").splitlines()[1:]:
        f = line.split()
        if len(f) < 3 or not f[0].isdigit():
            continue
        lock, name = (f[2], f[3]) if len(f) >= 4 else (None, f[2])
        rows.append({"vmid": int(f[0]), "status": f[1], "lock": lock, "name": name})
    return rows


def parse_zpool_list(text):
    rows = []
    for line in (text or "").splitlines():
        f = line.split("\t")
        if len(f) >= 5:
            rows.append({"name": f[0], "size": to_int(f[1]), "alloc": to_int(f[2]), "free": to_int(f[3]),
                         "health": f[4].strip()})
    return rows


def parse_docker(ps, stats, inspect, images, now=None):
    now = now or time.time()
    st = {}
    for s in stats or []:
        st[s.get("ID", "")] = s
        st[s.get("Name", "")] = s
    ins = {c.get("Id", ""): c for c in inspect or []}
    img = {i.get("Id"): i for i in images or []}
    rows = []
    for p in ps or []:
        cid = p.get("ID", "")
        c = ins.get(cid) or next((v for k, v in ins.items() if k.startswith(cid)), {})
        s = st.get(cid) or st.get(p.get("Names")) or {}
        image = img.get(c.get("Image"), {})
        created = parse_iso_ts(image.get("Created"))
        mem = (s.get("MemUsage") or "").split("/")[0]
        rows.append({
            "id": cid[:12], "name": p.get("Names"), "image": p.get("Image"), "state": p.get("State"),
            "status": p.get("Status"), "health": ((c.get("State") or {}).get("Health") or {}).get("Status"),
            "restart_count": c.get("RestartCount"), "cpu_percent": to_float(s.get("CPUPerc")),
            "mem_bytes": parse_size(mem) if mem else None, "mem_percent": to_float(s.get("MemPerc")),
            "image_created": iso(created), "image_age_days": int((now - created) // 86400) if created else None,
            "repo_digests": image.get("RepoDigests"),
            # shortcut: a newer image needs a registry query per image; left null until a cheap source exists
            "newer_image": None,
        })
    return {"running": sum(1 for r in rows if r["state"] == "running"), "total": len(rows), "containers": rows}


def _as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def parse_hotfixes(v):
    rows = [h for h in _as_list(v) if isinstance(h, dict)]
    dated = sorted(((parse_ps_date(h.get("InstalledOn")), h.get("HotFixID")) for h in rows),
                   key=lambda x: x[0] or "")
    last = dated[-1] if dated and dated[-1][0] else (None, None)
    return {"count": len(rows), "last_patch": last[0], "last_id": last[1]}


def parse_defender(v):
    if not isinstance(v, dict) or "error" in v:
        return None
    return {"service_enabled": v.get("AMServiceEnabled"), "antivirus_enabled": v.get("AntivirusEnabled"),
            "realtime": v.get("RealTimeProtectionEnabled"), "tamper_protected": v.get("IsTamperProtected"),
            "signature_updated": parse_ps_date(v.get("AntivirusSignatureLastUpdated")),
            "signature_age_days": v.get("AntivirusSignatureAge"), "quick_scan_age_days": v.get("QuickScanAge"),
            "full_scan_age_days": v.get("FullScanAge")}


_WU_RESULTS = {0: "not_started", 1: "in_progress", 2: "succeeded", 3: "succeeded_with_errors", 4: "failed",
               5: "aborted"}


def parse_wu_history(v):
    rows = [h for h in _as_list(v) if isinstance(h, dict)]
    if not rows:
        return None
    rows.sort(key=lambda h: parse_ps_date(h.get("Date")) or "", reverse=True)
    h = rows[0]
    return {"result": _WU_RESULTS.get(to_int(h.get("ResultCode")), str(h.get("ResultCode"))),
            "date": parse_ps_date(h.get("Date")), "title": h.get("Title")}


# 0 ok, 0x41301 running, 0x41303 not yet run, 0x41325 queued, 0x41306 terminated by user
_TASK_OK = {0, 0x41301, 0x41303, 0x41325, 0x41306}


def parse_failed_tasks(v):
    rows = []
    for t in _as_list(v):
        if not isinstance(t, dict):
            continue
        code = to_int(t.get("LastTaskResult"))
        if code is not None and code not in _TASK_OK:
            rows.append({"name": (t.get("path") or "") + (t.get("name") or ""), "result": code,
                         "result_hex": "0x%08X" % (code & 0xFFFFFFFF), "last_run": parse_ps_date(t.get("last_run"))})
    return rows


def parse_install_history(entries):
    """/Library/Receipts/InstallHistory.plist entries -> newest Apple update install time (ISO UTC)."""
    dates = [e.get("date") for e in entries or []
             if isinstance(e, dict) and e.get("processName") in ("softwareupdated", "Software Update")
             and isinstance(e.get("date"), datetime)]
    if not dates:
        return None
    d = max(dates)
    return iso((d if d.tzinfo else d.replace(tzinfo=timezone.utc)).timestamp())


# ---------------------------------------------------------------------------
# Collection
# ---------------------------------------------------------------------------

class CollectorState:
    """Holds samples between calls (CPU, network) and slow-command caches."""

    def __init__(self, cfg=None):
        self.cfg = cfg or {}
        self.prev_cpu = None
        self.prev_net = None
        self.cache = {}
        self.runner_versions = {}
        self._memsize = None

    def cached(self, key, ttl, fn):
        hit = self.cache.get(key)
        if hit and time.monotonic() - hit[0] < ttl:
            return hit[1]
        val = fn()
        self.cache[key] = (time.monotonic(), val)
        return val

    def _cpu_sample(self):
        if IS_LINUX:
            return parse_proc_stat_cpu(read_text("/proc/stat"))
        if IS_WINDOWS:
            return _win_cpu_times()
        return None

    def cpu_percent(self):
        if IS_DARWIN:
            return parse_top_cpu(out(["top", "-l", "2", "-n", "0", "-s", "1"], 20))
        cur = self._cpu_sample()
        prev, self.prev_cpu = self.prev_cpu, cur
        if prev is None:
            time.sleep(0.5)
            prev, cur = cur, self._cpu_sample()
            self.prev_cpu = cur
        return cpu_percent_from(prev, cur)

    def net(self, counters):
        now = time.monotonic()
        prev = self.prev_net
        self.prev_net = (now, counters)
        return net_rates(prev[1] if prev else None, counters, now - prev[0] if prev else None)

    def memsize(self):
        if self._memsize is None and IS_DARWIN:
            self._memsize = to_int(out(["sysctl", "-n", "hw.memsize"]))
        return self._memsize

    def runner_version(self, listener):
        try:
            key = (listener, os.stat(listener).st_mtime)
        except OSError:
            return None
        if key not in self.runner_versions:
            o = out([listener, "--version"], 20)
            self.runner_versions[key] = o.strip().splitlines()[-1] if o and o.strip() else None
        return self.runner_versions[key]


def _win_cpu_times():
    import ctypes
    from ctypes import wintypes
    idle, kernel, user = wintypes.FILETIME(), wintypes.FILETIME(), wintypes.FILETIME()
    if not ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)):
        return None

    def ft(t):
        return (t.dwHighDateTime << 32) | t.dwLowDateTime
    return ft(idle), ft(kernel) + ft(user)  # kernel time includes idle time


def _win_memory():
    import ctypes

    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
    m = MEMORYSTATUSEX()
    m.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    used = m.ullTotalPhys - m.ullAvailPhys
    return {"total": m.ullTotalPhys, "used": used, "available": m.ullAvailPhys, "percent": pct(used, m.ullTotalPhys)}


def _win_uptime():
    import ctypes
    ctypes.windll.kernel32.GetTickCount64.restype = ctypes.c_ulonglong
    return int(ctypes.windll.kernel32.GetTickCount64() // 1000)


def _loadavg():
    try:
        return [round(x, 2) for x in os.getloadavg()]
    except (AttributeError, OSError):
        return None


def uptime_s():
    if IS_LINUX:
        v = to_float(read_text("/proc/uptime").split(" ")[0])
        return int(v) if v is not None else None
    if IS_DARWIN:
        boot = parse_sysctl_boottime(out(["sysctl", "-n", "kern.boottime"]))
        return int(time.time() - boot) if boot else None
    return _win_uptime()


def memory_quick(state):
    if IS_LINUX:
        return parse_meminfo(read_text("/proc/meminfo"))
    if IS_DARWIN:
        return parse_vm_stat(out(["vm_stat"]) or "", state.memsize())
    return _win_memory()


def local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("192.0.2.1", 80))  # no packet is sent; this only picks the outbound interface
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


def os_version():
    if IS_LINUX:
        d = parse_os_release(read_text("/etc/os-release"))
        return d.get("PRETTY_NAME") or "%s %s" % (d.get("ID", "linux"), d.get("VERSION_ID", ""))
    if IS_DARWIN:
        v = parse_sw_vers(out(["sw_vers"]) or "")
        return "%s %s (%s)" % (v["name"] or "macOS", v["version"], v["build"])
    try:
        import winreg
        k = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")

        def q(name):
            try:
                return winreg.QueryValueEx(k, name)[0]
            except OSError:
                return None
        build = to_int(q("CurrentBuild"))
        name = q("ProductName") or "Windows"
        if build and build >= 22000 and "Windows 10" in name and "Server" not in name:
            name = name.replace("Windows 10", "Windows 11")  # the registry still says 10 on 11
        return "%s %s (build %s.%s)" % (name, q("DisplayVersion") or "", build, q("UBR") or 0)
    except (ImportError, OSError):
        return platform.platform()


def heartbeat(state, host_id):
    mem = memory_quick(state) or {}
    return {"type": "heartbeat", "host_id": host_id, "agent_version": VERSION, "ts": now_iso(),
            "cpu": state.cpu_percent(), "ram": mem.get("percent"), "load": _loadavg(), "uptime": uptime_s(),
            "ram_total": mem.get("total"), "ram_used": mem.get("used")}


def _step(data, key, fn, *args, errors=None):
    try:
        data[key] = fn(*args)
    except Exception as e:  # one collector never breaks the inventory
        data.setdefault(key, None)
        (data["errors"] if errors is None else errors)[key] = ("%s: %s" % (type(e).__name__, e))[:300]


def collect_procs():
    fmt = "pid=,user=,pcpu=,pmem=,rss=,comm="
    o = out(["ps", "-axo", fmt] if IS_DARWIN else ["ps", "-eo", fmt], 20)
    if o is None:
        raise RuntimeError("ps failed")
    return top_procs(parse_ps(o))


def process_cmdlines(win=None):
    if IS_WINDOWS:
        return [c for c in _as_list((win or {}).get("workers")) if isinstance(c, str)]
    if IS_DARWIN:
        return (out(["ps", "-axo", "command="], 20) or "").splitlines()
    rows = []
    for p in glob.glob("/proc/[0-9]*/cmdline"):
        b = read_bytes(p)
        if b:
            rows.append(b.replace(b"\0", b" ").decode("utf-8", "replace"))
    return rows


def collect_docker():
    exe = which("docker")
    if not exe:
        return None
    rc, o, e = run([exe, "ps", "-a", "--no-trunc", "--format", "{{json .}}"], 20)
    if rc != 0:
        raise RuntimeError((e.strip() or "docker ps failed")[:200])
    ps = [json.loads(line) for line in o.splitlines() if line.strip()]
    if not ps:
        return {"running": 0, "total": 0, "containers": []}
    _, so, _ = run([exe, "stats", "--no-stream", "--no-trunc", "--format", "{{json .}}"], 40)
    stats = [json.loads(line) for line in so.splitlines() if line.strip().startswith("{")]
    _, io, _ = run([exe, "inspect"] + [p["ID"] for p in ps], 30)
    inspect = json.loads(io or "[]")
    image_ids = sorted({c.get("Image") for c in inspect if c.get("Image")})
    _, imo, _ = run([exe, "image", "inspect"] + image_ids, 30)
    images = json.loads(imo) if imo.strip().startswith("[") else []
    return parse_docker(ps, stats, inspect, images)


def collect_smart():
    if IS_DARWIN:
        rows = []
        for disk in ("disk0", "disk1"):
            r = parse_diskutil_smart(out(["diskutil", "info", disk], 15))
            if r:
                rows.append(dict(device=disk, **r))
        return rows or None
    exe = which("smartctl")
    if not exe:
        return None
    rows = []
    for line in (out([exe, "--scan"], 20) or "").splitlines()[:16]:
        f = line.split("#")[0].split()
        if f and f[0].startswith("/dev/"):
            _, o, _ = run([exe, "-H"] + f, 30)
            rows.append({"device": f[0], "health": parse_smartctl_health(o), "detail": None})
    return rows


def collect_linux_temps():
    temps = []
    for f in sorted(glob.glob("/sys/class/hwmon/hwmon*/temp*_input")):
        v = to_int(read_text(f))
        if v is None:
            continue
        d = os.path.dirname(f)
        label = read_text(f.replace("_input", "_label")).strip() or os.path.basename(f).split("_")[0]
        temps.append({"sensor": "%s/%s" % (read_text(os.path.join(d, "name")).strip(), label),
                      "celsius": round(v / 1000.0, 1)})
    if not temps:
        for z in sorted(glob.glob("/sys/class/thermal/thermal_zone*")):
            v = to_int(read_text(os.path.join(z, "temp")))
            if v is not None:
                temps.append({"sensor": read_text(os.path.join(z, "type")).strip(), "celsius": round(v / 1000.0, 1)})
    return temps or None


def discover_runners(cfg, win=None):
    found = {}

    def add(path, **kw):
        path = os.path.normpath(path)
        e = found.setdefault(os.path.normcase(path), {"path": path, "service": None, "service_state": None,
                                                      "run_as": None, "source": None})
        e.update({k: v for k, v in kw.items() if v is not None})

    if IS_LINUX:
        for unit in glob.glob("/etc/systemd/system/actions.runner.*.service"):
            u = parse_unit_file(read_text(unit))
            if u.get("WorkingDirectory"):
                name = os.path.basename(unit)
                _, o, _ = run(["systemctl", "is-active", name], 10)
                add(u["WorkingDirectory"], service=name, service_state=o.strip() or None,
                    run_as=u.get("User") or "root", source="systemd")
    elif IS_DARWIN:
        plists = [(p, "system") for p in glob.glob("/Library/LaunchDaemons/actions.runner.*.plist")]
        plists += [(p, "user") for p in glob.glob("/Users/*/Library/LaunchAgents/actions.runner.*.plist")]
        for p, kind in plists:
            try:
                with open(p, "rb") as f:
                    pl = plistlib.load(f)
            except Exception:
                continue
            args = pl.get("ProgramArguments") or []
            wd = pl.get("WorkingDirectory") or (os.path.dirname(args[0]) if args else None)
            if not wd:
                continue
            label = pl.get("Label") or os.path.basename(p)[:-6]
            user = pl.get("UserName") or "root" if kind == "system" else p.split("/")[2]
            domain = "system"
            if kind == "user":
                try:
                    import pwd
                    domain = "gui/%d" % pwd.getpwnam(user).pw_uid
                except (ImportError, KeyError):
                    pass
            rc, o, _ = run(["launchctl", "print", "%s/%s" % (domain, label)], 10)
            m = re.search(r"^\s*state = (\S+)", o, re.M)
            add(wd, service=label, service_state=m.group(1) if m else ("not loaded" if rc else None),
                run_as=user, source="launchd")
    elif IS_WINDOWS:
        for s in _as_list((win or {}).get("runners")):
            exe = str(s.get("path") or "").strip().strip('"')
            if exe:
                add(os.path.dirname(os.path.dirname(exe)), service=s.get("name"), service_state=s.get("state"),
                    run_as=s.get("run_as"), source="service")
    for folder in cfg.get("runner_folders") or []:
        add(folder, source="config")
    return list(found.values())


def describe_runner(entry, cmdlines, state, budget_s=5.0):
    """Report one runner. Reads only .runner and _diag logs; never opens .credentials files."""
    d = entry["path"]
    r = dict(entry)
    r.update(name=None, url=None, pool=None, level=None, labels=None, version=None, busy=False, job=None,
             sizes={}, sizes_partial=False, log_tail=[])
    raw = read_bytes(os.path.join(d, ".runner"))
    if raw is None:
        r["error"] = ".runner not found"
        return r
    info = parse_runner_file(raw)
    r.update(name=info.get("agentName"), url=info.get("gitHubUrl"), pool=info.get("poolName"),
             level=runner_level(info.get("gitHubUrl")), labels=info.get("labels"))
    bin_dir = os.path.join(d, "bin")
    r["version"] = state.runner_version(os.path.join(bin_dir, "Runner.Listener" + (".exe" if IS_WINDOWS else "")))
    worker = os.path.normcase(os.path.join(bin_dir, "Runner.Worker"))
    r["busy"] = any(worker in os.path.normcase(c) for c in cmdlines)
    diag = os.path.join(d, "_diag")
    try:
        names = os.listdir(diag)
    except OSError:
        names = []
    wl = newest_log(names, "Worker_")
    if wl:
        r["job"] = parse_worker_job_name(tail_text(os.path.join(diag, wl), 262144))
    rl = newest_log(names, "Runner_")
    if rl:
        r["log_tail"] = tail_text(os.path.join(diag, rl), 65536).splitlines()[-40:]
    work = os.path.join(d, info.get("workFolder") or "_work")
    deadline = time.monotonic() + budget_s
    for key, path in (("work", work), ("diag", diag), ("temp", os.path.join(work, "_temp")),
                      ("tool_cache", os.path.join(work, "_tool"))):
        size, partial = dir_size(path, deadline)
        r["sizes"][key] = size
        r["sizes_partial"] = r["sizes_partial"] or partial
    return r


def collect_runners(state, win=None):
    entries = discover_runners(state.cfg, win)
    if not entries:
        return []
    cmdlines = process_cmdlines(win)
    rows = []
    for e in entries:
        try:
            rows.append(describe_runner(e, cmdlines, state))
        except Exception as ex:
            rows.append(dict(e, error=("%s: %s" % (type(ex).__name__, ex))[:300]))
    return rows


# ----- Linux -----

def _linux_updates():
    u = {"pending": None, "security": None, "restart_required": None, "reboot_required": False,
         "reboot_pending_days": None, "last_patch": None, "items": []}
    if which("apt-get"):
        o = out(["apt-get", "-s", "-o", "Debug::NoLocking=1", "upgrade"], 120)
        if o is not None:
            u.update(parse_apt_simulate(o))
        u["last_patch"] = parse_apt_history_last(read_text("/var/log/apt/history.log"))
    elif which("dnf") or which("yum"):
        rc, o, _ = run([which("dnf") or which("yum"), "-q", "check-update"], 180)
        if rc in (0, 100):
            lines = [line for line in o.splitlines() if line and not line.startswith((" ", "Obsoleting"))]
            u["pending"] = len(lines)
            u["items"] = [line.split()[0] for line in lines][:200]
    for flag in ("/var/run/reboot-required", "/run/reboot-required"):
        if os.path.exists(flag):
            u["reboot_required"] = True
            u["reboot_pending_days"] = int((time.time() - os.path.getmtime(flag)) // 86400)
            break
    else:
        if which("needs-restarting"):
            rc, _, _ = run(["needs-restarting", "-r"], 60)
            u["reboot_required"] = rc == 1
    if not u["last_patch"]:
        for p in ("/var/lib/dpkg/status", "/var/lib/rpm"):
            if os.path.exists(p):
                u["last_patch"] = iso(os.path.getmtime(p))
                break
    return u


def _linux_time():
    if which("chronyc"):
        o = out(["chronyc", "tracking"], 10)
        if o:
            return {"drift_s": parse_time_offset(o), "source": "chrony", "synced": "Not synchronised" not in o}
    o = out(["timedatectl", "show", "-p", "NTPSynchronized", "--value"], 10)
    return {"drift_s": None, "source": "timedatectl", "synced": (o or "").strip() == "yes" if o else None}


def _linux_security():
    fw = None
    if which("ufw"):
        o = out(["ufw", "status"], 10)
        fw = "Status: active" in o if o else None
    elif which("firewall-cmd"):
        fw = (out(["firewall-cmd", "--state"], 10) or "").strip() == "running"
    return {"firewall": fw}


def _proxmox():
    if not which("pveversion"):
        return None
    p = {"version": (out(["pveversion"], 15) or "").strip() or None}
    if which("zpool"):
        p["zpool_healthy"] = "all pools are healthy" in (out(["zpool", "status", "-x"], 20) or "")
        p["zpools"] = parse_zpool_list(out(["zpool", "list", "-H", "-p", "-o", "name,size,alloc,free,health"], 20))
    p.update(parse_arcstats(read_text("/proc/spl/kstat/zfs/arcstats")))
    p["vms"] = parse_qm_list(out(["qm", "list"], 30)) if which("qm") else []
    p["containers"] = parse_pct_list(out(["pct", "list"], 30)) if which("pct") else []
    return p


def _inv_linux(state, data):
    osr = parse_os_release(read_text("/etc/os-release"))
    up = uptime_s()
    data["os_info"] = {"name": osr.get("NAME"), "version": osr.get("VERSION_ID"), "build": osr.get("VERSION"),
                       "pretty": osr.get("PRETTY_NAME"), "kernel": platform.release(), "arch": platform.machine(),
                       "model": read_text("/sys/devices/virtual/dmi/id/product_name").strip() or None,
                       "domain": (out(["hostname", "-d"], 5) or "").strip() or None, "ip": local_ip(),
                       "boot_time": iso(time.time() - up) if up else None, "uptime_s": up}
    _step(data, "cpu", lambda: {"count": os.cpu_count(), "percent": state.cpu_percent(), "load": _loadavg()})
    _step(data, "memory", lambda: parse_meminfo(read_text("/proc/meminfo")))

    def disks():
        rows = parse_df(out(["df", "-kP"], 30))
        inodes = {r["mount"]: r for r in parse_df(out(["df", "-iP"], 30), block=1)}
        for r in rows:
            i = inodes.get(r["mount"])
            if i:
                r.update(inodes_total=i["total"] or None, inodes_used=i["used"],
                         inodes_percent=pct(i["used"], i["total"]))
        return filter_linux_disks(rows, parse_proc_mounts(read_text("/proc/mounts")))
    _step(data, "disks", disks)
    _step(data, "net", lambda: state.net(parse_proc_net_dev(read_text("/proc/net/dev"))))
    _step(data, "temps", collect_linux_temps)
    _step(data, "smart", collect_smart)
    _step(data, "procs", collect_procs)
    _step(data, "services", lambda: {"failed": parse_systemctl_failed(
        out(["systemctl", "--failed", "--no-legend", "--plain", "--type=service"], 15))})
    _step(data, "updates", _linux_updates)
    _step(data, "time", _linux_time)
    _step(data, "security", _linux_security)
    _step(data, "proxmox", _proxmox)


# ----- macOS -----

def mac_console_user():
    u = (out(["stat", "-f", "%Su", "/dev/console"], 5) or "").strip()
    return None if u in ("", "root", "loginwindow", "_mbsetupuser") else u


def _as_user(user, argv):
    if user and hasattr(os, "geteuid") and os.geteuid() == 0:
        return ["sudo", "-u", user, "-H", "--"] + argv
    return argv


def _user_home(user):
    try:
        import pwd
        return pwd.getpwnam(user).pw_dir
    except (ImportError, KeyError):
        return None


def _mac_brew():
    user = mac_console_user()
    brew = next((b for b in ("/opt/homebrew/bin/brew", "/usr/local/bin/brew") if os.path.exists(b)), None)
    if not brew:
        return None
    if not user:
        return {"formulae": None, "casks": None, "items": [], "note": "no console user"}
    rc, o, e = run(_as_user(user, ["/usr/bin/env", "HOMEBREW_NO_AUTO_UPDATE=1", "HOMEBREW_NO_ANALYTICS=1",
                                   brew, "outdated", "--json=v2"]), 180)
    if rc not in (0, 1) or not o.strip():
        raise RuntimeError((e.strip() or "brew outdated failed")[:200])
    return parse_brew_outdated(o)


def _mac_xcode():
    x = {"apps": [], "clt": None, "derived_data_bytes": None, "simulators": None}
    for app in sorted(glob.glob("/Applications/Xcode*.app")):
        try:
            with open(os.path.join(app, "Contents", "version.plist"), "rb") as f:
                v = plistlib.load(f)
            x["apps"].append({"path": app, "version": v.get("CFBundleShortVersionString"),
                              "build": v.get("ProductBuildVersion")})
        except (OSError, ValueError, plistlib.InvalidFileException):
            x["apps"].append({"path": app, "version": None, "build": None})
    path = (out(["xcode-select", "-p"], 10) or "").strip() or None
    pkg = parse_kv_lines(out(["pkgutil", "--pkg-info=com.apple.pkg.CLTools_Executables"], 10) or "")
    x["clt"] = {"path": path, "installed": bool(pkg.get("version")), "version": pkg.get("version")}
    user = mac_console_user()
    home = _user_home(user) if user else None
    if home:
        deadline = time.monotonic() + 10
        x["derived_data_bytes"] = dir_size(os.path.join(home, "Library/Developer/Xcode/DerivedData"), deadline)[0]
    if path and which("xcrun"):
        o = out(_as_user(user, ["xcrun", "simctl", "list", "devices", "--json"]), 60)
        if o:
            sims = parse_simctl(o)
            if sims["bytes"] is None and home:
                sims["bytes"] = dir_size(os.path.join(home, "Library/Developer/CoreSimulator/Devices"),
                                         time.monotonic() + 10)[0]
            x["simulators"] = sims
    return x


def _mac_updates(state):
    def su():
        _, o, e = run(["softwareupdate", "-l"], 300)
        return parse_softwareupdate(o + "\n" + e)
    s = state.cached("softwareupdate", SLOW_CACHE_S, su)
    last = None
    try:
        with open("/Library/Receipts/InstallHistory.plist", "rb") as f:
            last = parse_install_history(plistlib.load(f))
    except (OSError, ValueError, plistlib.InvalidFileException):
        pass
    return {"pending": s["pending"], "security": None, "restart_required": s["restart_required"],
            "reboot_required": None, "reboot_pending_days": None, "last_patch": last,
            "items": [i["label"] for i in s["items"]]}, s


def _inv_darwin(state, data):
    sv = parse_sw_vers(out(["sw_vers"], 10) or "")
    boot = parse_sysctl_boottime(out(["sysctl", "-n", "kern.boottime"], 5))
    data["os_info"] = {"name": sv["name"], "version": sv["version"], "build": sv["build"],
                       "kernel": platform.release(), "arch": platform.machine(),
                       "model": (out(["sysctl", "-n", "hw.model"], 5) or "").strip() or None, "domain": None,
                       "ip": local_ip(), "boot_time": iso(boot), "uptime_s": int(time.time() - boot) if boot else None}
    _step(data, "cpu", lambda: {"count": os.cpu_count(), "percent": state.cpu_percent(), "load": _loadavg()})

    def memory():
        m = parse_vm_stat(out(["vm_stat"], 10) or "", state.memsize())
        m.update(parse_swapusage(out(["sysctl", "-n", "vm.swapusage"], 5)))
        return m
    _step(data, "memory", memory)
    _step(data, "disks", lambda: filter_mac_disks(parse_df(out(["df", "-k"], 30))))
    _step(data, "net", lambda: state.net(parse_netstat_ibn(out(["netstat", "-ibn"], 15))))
    data["temps"] = None  # no cheap unprivileged sensor source on macOS
    _step(data, "smart", collect_smart)
    _step(data, "procs", collect_procs)
    _step(data, "services", lambda: {"failed": launchd_failed(parse_launchctl_list(out(["launchctl", "list"], 15)))})
    darwin = {"softwareupdate": None}
    data["darwin"] = darwin
    errs = data["errors"]

    def updates():
        u, raw = _mac_updates(state)
        darwin["softwareupdate"] = raw
        return u
    _step(data, "updates", updates)
    _step(darwin, "brew", lambda: state.cached("brew", SLOW_CACHE_S, _mac_brew), errors=errs)
    _step(darwin, "xcode", _mac_xcode, errors=errs)

    def tm():
        latest = parse_tmutil_latest(out(["tmutil", "latestbackup"], 30))
        age = None
        if latest:
            age = int((time.time() - time.mktime(time.strptime(latest, "%Y-%m-%dT%H:%M:%S"))) // 86400)
        return {"latest": latest, "age_days": age}
    _step(darwin, "time_machine", tm, errors=errs)
    _step(darwin, "pmset", lambda: parse_pmset(out(["pmset", "-g"], 10)), errors=errs)
    darwin["launchd_failed"] = (data.get("services") or {}).get("failed", [])

    def security():
        return {"filevault": parse_fdesetup(out(["fdesetup", "status"], 10)),
                "firewall": parse_socketfilterfw(out(["/usr/libexec/ApplicationFirewall/socketfilterfw",
                                                      "--getglobalstate"], 10)),
                "gatekeeper": parse_spctl(run(["spctl", "--status"], 10)[1]),
                "sip": parse_csrutil(out(["csrutil", "status"], 10))}
    _step(data, "security", security)

    def tdrift():
        _, o, e = run(["sntp", "-t", "3", "time.apple.com"], 15)
        return {"drift_s": parse_time_offset(o + e), "source": "sntp time.apple.com", "synced": None}
    _step(data, "time", tdrift)


# ----- Windows -----

WIN_INVENTORY_PS = r"""
$r = @{}
function Step($name, [scriptblock]$sb) { try { $r[$name] = & $sb } catch { $r[$name] = @{ error = "$($_.Exception.Message)" } } }
Step 'os' { $o = Get-CimInstance Win32_OperatingSystem; @{ caption=$o.Caption; version=$o.Version; build=$o.BuildNumber; boot=$o.LastBootUpTime.ToUniversalTime().ToString('o') } }
Step 'cs' { $c = Get-CimInstance Win32_ComputerSystem; @{ model=$c.Model; manufacturer=$c.Manufacturer; domain=$c.Domain; part_of_domain=$c.PartOfDomain } }
Step 'pagefile' { @(Get-CimInstance Win32_PageFileUsage | ForEach-Object { @{ name=$_.Name; size_mb=$_.AllocatedBaseSize; used_mb=$_.CurrentUsage } }) }
Step 'disks' { @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { @{ device=$_.DeviceID; fstype=$_.FileSystem; size=$_.Size; free=$_.FreeSpace } }) }
Step 'physical' { @(Get-PhysicalDisk | ForEach-Object { @{ name=$_.FriendlyName; health="$($_.HealthStatus)"; media="$($_.MediaType)" } }) }
Step 'net' { @(Get-NetAdapterStatistics | ForEach-Object { @{ name=$_.Name; rx=$_.ReceivedBytes; tx=$_.SentBytes } }) }
Step 'procs' { $n = [Environment]::ProcessorCount; @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } | ForEach-Object { @{ pid=$_.IDProcess; name=$_.Name; cpu=[math]::Round($_.PercentProcessorTime / $n, 1); rss=$_.WorkingSetPrivate } }) }
Step 'services_failed' { @(Get-CimInstance Win32_Service -Filter "StartMode='Auto' AND State<>'Running'" | ForEach-Object { @{ name=$_.Name; display=$_.DisplayName; state=$_.State; exit_code=$_.ExitCode } }) }
Step 'hotfix' { @(Get-HotFix | Select-Object HotFixID, InstalledOn) }
Step 'defender' { Get-MpComputerStatus | Select-Object AMServiceEnabled, AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureLastUpdated, AntivirusSignatureAge, QuickScanAge, FullScanAge, IsTamperProtected }
Step 'wu_history' { $s = New-Object -ComObject Microsoft.Update.Session; $h = $s.CreateUpdateSearcher(); $c = $h.GetTotalHistoryCount(); if ($c -gt 0) { @($h.QueryHistory(0, [math]::Min($c, 5)) | ForEach-Object { @{ Date=$_.Date.ToUniversalTime().ToString('o'); ResultCode=[int]$_.ResultCode; Title=$_.Title } }) } else { @() } }
Step 'pending_reboot' { @{ cbs=(Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'); wu=(Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'); file_rename=[bool](Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue) } }
Step 'tasks' { @(Get-ScheduledTask | Where-Object { $_.State -ne 'Disabled' -and $_.TaskPath -notlike '\Microsoft\*' } | ForEach-Object { $i = $_ | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue; if ($i) { @{ name=$_.TaskName; path=$_.TaskPath; LastTaskResult=$i.LastTaskResult; last_run=$(if ($i.LastRunTime) { $i.LastRunTime.ToUniversalTime().ToString('o') } else { $null }) } } }) }
Step 'runners' { @(Get-CimInstance Win32_Service -Filter "Name LIKE 'actions.runner.%'" | ForEach-Object { @{ name=$_.Name; state=$_.State; run_as=$_.StartName; path=$_.PathName } }) }
Step 'workers' { @(Get-CimInstance Win32_Process -Filter "Name='Runner.Worker.exe'" | ForEach-Object { "$($_.ExecutablePath)" }) }
Step 'temps' { @(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop | ForEach-Object { @{ sensor=$_.InstanceName; celsius=[math]::Round($_.CurrentTemperature / 10 - 273.15, 1) } }) }
$r | ConvertTo-Json -Depth 5 -Compress
"""

WIN_PENDING_PS = r"""
$s = New-Object -ComObject Microsoft.Update.Session
$res = $s.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
$items = @($res.Updates | ForEach-Object { $_.Title })
@{ count=$res.Updates.Count; reboot=@($res.Updates | Where-Object { $_.InstallationBehavior.RebootBehavior -ne 0 }).Count; items=$items } | ConvertTo-Json -Depth 3 -Compress
"""


def powershell_exe():
    if IS_WINDOWS:
        return which("powershell") or which("pwsh")
    return which("pwsh")


def run_ps_json(script, timeout=180):
    exe = powershell_exe()
    if not exe:
        raise RuntimeError("PowerShell not found")
    full = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue';" + script
    enc = base64.b64encode(full.encode("utf-16-le")).decode()
    rc, o, e = run([exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc],
                   timeout)
    if rc != 0 or not o.strip():
        raise RuntimeError((e.strip() or "PowerShell exit %s" % rc)[:300])
    return json.loads(o)


def _ok(v):
    return v if not (isinstance(v, dict) and "error" in v) else None


def _inv_windows(state, data):
    win = {}
    try:
        win = run_ps_json(WIN_INVENTORY_PS, 240)
    except Exception as e:
        data["errors"]["powershell"] = ("%s: %s" % (type(e).__name__, e))[:300]
    o, cs = _ok(win.get("os")) or {}, _ok(win.get("cs")) or {}
    up = _win_uptime()
    data["os_info"] = {"name": o.get("caption"), "version": o.get("version"), "build": o.get("build"),
                       "pretty": os_version(), "kernel": platform.version(), "arch": platform.machine(),
                       "model": cs.get("model"), "domain": cs.get("domain") if cs.get("part_of_domain") else None,
                       "ip": local_ip(), "boot_time": parse_ps_date(o.get("boot")), "uptime_s": up}
    _step(data, "cpu", lambda: {"count": os.cpu_count(), "percent": state.cpu_percent(), "load": None})

    def memory():
        m = _win_memory()
        pf = _as_list(_ok(win.get("pagefile")))
        st = sum(to_int(p.get("size_mb"), 0) for p in pf) * 1024 ** 2
        su = sum(to_int(p.get("used_mb"), 0) for p in pf) * 1024 ** 2
        m.update(swap_total=st or None, swap_used=su if st else None, swap_percent=pct(su, st))
        return m
    _step(data, "memory", memory)

    def disks():
        rows = []
        for d in _as_list(_ok(win.get("disks"))):
            total, free = to_int(d.get("size"), 0), to_int(d.get("free"), 0)
            rows.append({"device": d.get("device"), "mount": (d.get("device") or "") + "\\", "fstype": d.get("fstype"),
                         "total": total, "used": total - free, "free": free, "percent": pct(total - free, total),
                         "inodes_total": None, "inodes_used": None, "inodes_percent": None})
        return rows
    _step(data, "disks", disks)
    _step(data, "net", lambda: state.net({n.get("name"): (to_int(n.get("rx"), 0), to_int(n.get("tx"), 0))
                                          for n in _as_list(_ok(win.get("net")))}))
    data["temps"] = [t for t in _as_list(_ok(win.get("temps"))) if isinstance(t, dict)] or None
    data["smart"] = [{"device": p.get("name"), "health": {"Healthy": "ok", "Warning": "failing",
                                                          "Unhealthy": "failing"}.get(p.get("health"), "unknown"),
                      "detail": p.get("health")} for p in _as_list(_ok(win.get("physical")))] or None

    def procs():
        rows = [{"pid": to_int(p.get("pid")), "user": None, "name": p.get("name"), "cpu": to_float(p.get("cpu"), 0.0),
                 "mem_percent": None, "rss": to_int(p.get("rss"), 0)} for p in _as_list(_ok(win.get("procs")))]
        return top_procs(rows)
    _step(data, "procs", procs)
    data["services"] = {"failed": [{"name": s.get("name"), "state": s.get("state"),
                                    "detail": "%s (exit %s)" % (s.get("display"), s.get("exit_code"))}
                                   for s in _as_list(_ok(win.get("services_failed")))]}
    pr = _ok(win.get("pending_reboot")) or {}
    pr["any"] = any(bool(pr.get(k)) for k in ("cbs", "wu", "file_rename"))
    hot = parse_hotfixes(_ok(win.get("hotfix")))

    def updates():
        p = state.cached("wu_pending", SLOW_CACHE_S, lambda: run_ps_json(WIN_PENDING_PS, 600))
        return {"pending": p.get("count"), "security": None, "restart_required": bool(p.get("reboot")),
                "reboot_required": pr["any"], "reboot_pending_days": None, "last_patch": hot["last_patch"],
                "items": _as_list(p.get("items"))[:200]}
    _step(data, "updates", updates)
    if data.get("updates") is None:
        data["updates"] = {"pending": None, "security": None, "restart_required": None,
                           "reboot_required": pr["any"], "reboot_pending_days": None,
                           "last_patch": hot["last_patch"], "items": []}
    data["security"] = {"defender": parse_defender(win.get("defender"))}
    data["windows"] = {"pending_reboot": pr, "failed_tasks": parse_failed_tasks(_ok(win.get("tasks"))),
                       "last_update": parse_wu_history(_ok(win.get("wu_history"))), "hotfixes": hot}

    def tdrift():
        src = (out(["w32tm", "/query", "/source"], 10) or "").strip().split(",")[0]
        if not src or "CMOS" in src or "Free-running" in src:
            return {"drift_s": None, "source": src or None, "synced": False}
        o2 = out(["w32tm", "/stripchart", "/computer:" + src, "/samples:1", "/dataonly"], 20)
        return {"drift_s": parse_time_offset(o2), "source": src, "synced": True}
    _step(data, "time", tdrift)
    return win


def collect_inventory(state):
    data = {"schema": 2, "agent_version": VERSION, "os": OS_NAME, "hostname": socket.gethostname(), "errors": {}}
    win = None
    try:
        if IS_LINUX:
            _inv_linux(state, data)
        elif IS_DARWIN:
            _inv_darwin(state, data)
        else:
            win = _inv_windows(state, data)
    except Exception as e:
        data["errors"]["inventory"] = ("%s: %s" % (type(e).__name__, e))[:300]
    _step(data, "docker", collect_docker)
    _step(data, "runners", collect_runners, state, win)
    return data


def register_message(cfg, state):
    mem = memory_quick(state) or {}
    return {"type": "register", "host_id": cfg["host_id"], "hostname": socket.gethostname(), "os": OS_NAME,
            "os_version": os_version(), "arch": platform.machine(), "agent_version": VERSION, "kind": "agent",
            "info": {"cpus": os.cpu_count(), "ram_total": mem.get("total"), "ip": local_ip(),
                     "platform": platform.platform(), "python": platform.python_version(),
                     "install_dir": INSTALL_DIR}}


# ---------------------------------------------------------------------------
# Jobs: streaming runner
# ---------------------------------------------------------------------------

PS_PREFIX = ("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n"
             "$OutputEncoding = [System.Text.Encoding]::UTF8\n"
             "$ProgressPreference = 'SilentlyContinue'\n")


def build_job_command(shell, script, workdir):
    """Write the job script into workdir. Return argv. Raise ValueError for an unknown or missing shell."""
    script = script or ""
    if shell == "python":
        path = os.path.join(workdir, "job.py")
        with open(path, "w", encoding="utf-8") as f:
            f.write(script)
        return [sys.executable, "-u", path]
    if shell == "bash":
        exe = which("bash") or ("/bin/bash" if os.path.exists("/bin/bash") else None)
        if not exe:
            raise ValueError("bash is not installed")
        path = os.path.join(workdir, "job.sh")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(script)
        return [exe, path]
    if shell == "powershell":
        exe = powershell_exe()
        if not exe:
            raise ValueError("PowerShell is not installed")
        path = os.path.join(workdir, "job.ps1")
        with open(path, "w", encoding="utf-8-sig") as f:  # Windows PowerShell 5.1 needs the BOM for UTF-8
            f.write(PS_PREFIX + script)
        return [exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path]
    raise ValueError("unknown shell: %r" % (shell,))


def job_env(extra):
    env = dict(os.environ)
    env.update(PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
    for k, v in (extra or {}).items():
        env[str(k)] = "" if v is None else str(v)
    return env


def kill_tree(proc):
    """Kill the job and every process it started."""
    if IS_WINDOWS:
        run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], 30)
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(proc.pid, signal.SIGKILL)  # also clears children that ignore SIGTERM
    except (ProcessLookupError, PermissionError):
        pass


def _read_fd(fd, stream, q):
    try:
        while True:
            try:
                b = os.read(fd, 4096)
            except OSError:  # EIO once every writer of the pty has gone (Linux)
                break
            if not b:
                break
            q.put((stream, b))
    finally:
        q.put((stream, None))


def _read_pipe(f, stream, q):
    try:
        while True:
            b = f.read1(4096)
            if not b:
                break
            q.put((stream, b))
    except (OSError, ValueError):
        pass
    finally:
        q.put((stream, None))


def run_job(msg, send, cancel_event=None, use_pty=None):
    """Run one run_job message. Stream job_output, then send and return job_complete."""
    job_id = msg.get("job_id")
    start = time.monotonic()
    cancel_event = cancel_event or threading.Event()
    seq = [0]

    def emit(stream, text):
        if text:
            send({"type": "job_output", "job_id": job_id, "seq": seq[0], "stream": stream, "chunk": text})
            seq[0] += 1

    def complete(status, rc):
        m = {"type": "job_complete", "job_id": job_id, "status": status, "exit_code": rc,
             "duration_ms": int((time.monotonic() - start) * 1000)}
        send(m)
        return m

    workdir = tempfile.mkdtemp(prefix="labctl-job-")
    master = None
    try:
        try:
            argv = build_job_command(msg.get("shell") or "bash", msg.get("script"), workdir)
        except (ValueError, OSError) as e:
            emit("stderr", "[labctl] %s\n" % e)
            return complete("failed", None)
        stdin_data = msg.get("stdin")
        use_pty = (not IS_WINDOWS) if use_pty is None else use_pty
        kw = {"cwd": workdir, "env": job_env(msg.get("env")), "stderr": subprocess.PIPE,
              "stdin": subprocess.PIPE if stdin_data is not None else subprocess.DEVNULL}
        if IS_WINDOWS:
            kw["creationflags"] = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        else:
            kw["start_new_session"] = True
        q = queue.Queue()
        try:
            if use_pty:
                import pty
                import termios
                master, slave = pty.openpty()
                attrs = termios.tcgetattr(slave)
                attrs[1] &= ~termios.ONLCR  # keep \n as \n
                termios.tcsetattr(slave, termios.TCSANOW, attrs)
                try:
                    proc = subprocess.Popen(argv, stdout=slave, **kw)
                finally:
                    os.close(slave)
                readers = [threading.Thread(target=_read_fd, args=(master, "stdout", q), daemon=True)]
            else:
                proc = subprocess.Popen(argv, stdout=subprocess.PIPE, **kw)
                readers = [threading.Thread(target=_read_pipe, args=(proc.stdout, "stdout", q), daemon=True)]
        except OSError as e:
            emit("stderr", "[labctl] could not start %s: %s\n" % (argv[0], e))
            return complete("failed", None)
        readers.append(threading.Thread(target=_read_pipe, args=(proc.stderr, "stderr", q), daemon=True))
        for t in readers:
            t.start()
        if stdin_data is not None:
            def feed():
                try:
                    proc.stdin.write(str(stdin_data).encode("utf-8"))
                    proc.stdin.close()
                except OSError:
                    pass
            threading.Thread(target=feed, daemon=True).start()

        bufs = {"stdout": bytearray(), "stderr": bytearray()}
        decoders = {s: codecs.getincrementaldecoder("utf-8")("replace") for s in bufs}

        def flush(stream, final=False):
            data = bytes(bufs[stream])
            bufs[stream].clear()
            emit(stream, decoders[stream].decode(data, final))

        timeout = to_float(msg.get("timeout_s"))
        deadline = start + timeout if timeout and timeout > 0 else None
        open_streams, last_flush, reason, exited_at = len(readers), time.monotonic(), None, None
        while open_streams:
            try:
                stream, b = q.get(timeout=0.1)
                if b is None:
                    open_streams -= 1
                else:
                    bufs[stream] += b
                    if len(bufs[stream]) >= FLUSH_BYTES:
                        flush(stream)
            except queue.Empty:
                pass
            now = time.monotonic()
            if now - last_flush >= FLUSH_S:
                for s in bufs:
                    if bufs[s]:
                        flush(s)
                last_flush = now
            if reason is None and cancel_event.is_set():
                reason = "cancelled"
                kill_tree(proc)
            elif reason is None and deadline and now > deadline:
                reason = "timeout"
                kill_tree(proc)
            if exited_at is None and proc.poll() is not None:
                exited_at = now
            if exited_at is not None and now - exited_at > 2.0:
                kill_tree(proc)  # background children still hold the output open
                break
        while True:  # drain what the readers already queued
            try:
                stream, b = q.get_nowait()
            except queue.Empty:
                break
            if b:
                bufs[stream] += b
        try:
            rc = proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            kill_tree(proc)
            rc = proc.wait()
        for s in bufs:
            flush(s, final=True)
        for t in readers:
            t.join(0.5)
        if not any(t.is_alive() for t in readers):  # a pipe still held by an orphan stays open
            for f in (proc.stdout, proc.stderr):
                if f:
                    f.close()
        if reason == "timeout":
            emit("stderr", "[labctl] job timed out after %s s\n" % msg.get("timeout_s"))
        status = "cancelled" if reason == "cancelled" else "success" if rc == 0 and not reason else "failed"
        return complete(status, rc)
    finally:
        if master is not None:
            try:
                os.close(master)
            except OSError:
                pass
        shutil.rmtree(workdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Self-update, watchdog, uninstall
# ---------------------------------------------------------------------------

class UpdateError(Exception):
    pass


def marker_path(target=SCRIPT_PATH):
    return os.path.join(os.path.dirname(os.path.abspath(target)), "update-pending.json")


def apply_update(source, expected_sha256, target=SCRIPT_PATH, version=None):
    """Verify and install a new agent file. Keep the old one as <target>.bak and write the
    update marker that the watchdog checks. Raise UpdateError and leave target untouched on any failure."""
    data = source.encode("utf-8") if isinstance(source, str) else bytes(source)
    digest = hashlib.sha256(data).hexdigest()
    if not expected_sha256 or digest != str(expected_sha256).strip().lower():
        raise UpdateError("sha256 mismatch")
    target = os.path.abspath(target)
    fd, tmp = tempfile.mkstemp(prefix=".labctl-agent-", suffix=".py", dir=os.path.dirname(target))
    cfile = tmp + "c"
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        try:
            py_compile.compile(tmp, cfile=cfile, doraise=True)
        except py_compile.PyCompileError as e:
            raise UpdateError(("syntax check failed: %s" % e.msg)[:500])
        if os.path.exists(target):
            shutil.copy2(target, target + ".bak")
        if not IS_WINDOWS:
            os.chmod(tmp, 0o755)
        os.replace(tmp, target)
        tmp = None
        with open(marker_path(target), "w", encoding="utf-8") as f:
            json.dump({"version": version, "ts": time.time(), "sha256": digest}, f)
    finally:
        for p in (tmp, cfile):
            if p and os.path.exists(p):
                os.remove(p)


def fetch_source(source, timeout=60):
    """update_agent.source is the file content, or an http(s) URL to fetch it from."""
    if isinstance(source, str) and re.match(r"^https?://\S+$", source.strip()):
        with urllib.request.urlopen(source.strip(), timeout=timeout) as r:
            return r.read()
    return source


def restore_bak(target=SCRIPT_PATH):
    bak = target + ".bak"
    if not os.path.exists(bak):
        raise UpdateError("no backup at %s" % bak)
    shutil.copy2(bak, target)
    try:
        os.remove(marker_path(target))
    except FileNotFoundError:
        pass


def watchdog_check(target=SCRIPT_PATH, grace=UPDATE_GRACE_S, now=None, restart=None):
    """Return 'idle', 'waiting' or 'restored'."""
    marker = marker_path(target)
    try:
        with open(marker, encoding="utf-8") as f:
            info = json.load(f)
    except FileNotFoundError:
        return "idle"
    except (OSError, ValueError):
        info = {}
    if (now if now is not None else time.time()) - float(info.get("ts") or 0) < grace:
        return "waiting"
    restore_bak(target)
    if restart:
        restart()
    return "restored"


def clear_update_marker(target=SCRIPT_PATH):
    try:
        os.remove(marker_path(target))
        log("[update] new agent connected; update confirmed")
    except FileNotFoundError:
        pass


def restart_service(cfg):
    if IS_LINUX:
        run(["systemctl", "restart", LINUX_UNIT], 60)
    elif IS_DARWIN:
        run(["launchctl", "kickstart", "-k", "system/" + MAC_LABEL], 60)
    else:
        name = _ps_quote(cfg.get("windows_task_name") or DEFAULT_WINDOWS_TASK)
        script = ("if (Get-Service -Name %s -ErrorAction SilentlyContinue) { Restart-Service -Name %s -Force } "
                  "else { schtasks /End /TN %s | Out-Null; schtasks /Run /TN %s | Out-Null }" % ((name,) * 4))
        enc = base64.b64encode(script.encode("utf-16-le")).decode()
        run([powershell_exe() or "powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", enc], 60)


def _ps_quote(s):
    return "'" + str(s).replace("'", "''") + "'"


def safe_install_dir(path):
    """Refuse to delete anything that does not look like a LabCTL install folder."""
    p = os.path.abspath(path)
    parts = [x for x in re.split(r"[\\/]+", p) if x and not x.endswith(":")]
    if len(parts) < 2 or "labctl" not in p.lower():
        raise ValueError("refusing to remove %s" % p)
    return p


def uninstall_script(os_name, install_dir, cfg=None, pid=None):
    """Return the cleanup script for the detached helper (sh on Linux/macOS, PowerShell on Windows)."""
    cfg = cfg or {}
    d = safe_install_dir(install_dir)
    if os_name == "linux":
        units = "/etc/systemd/system/"
        return "\n".join([
            "sleep 2",
            "systemctl disable --now %s-watchdog.timer %s-watchdog.service 2>/dev/null" % (LINUX_UNIT, LINUX_UNIT),
            "systemctl disable --now %s 2>/dev/null" % LINUX_UNIT,
            "rm -f %s%s.service %s%s-watchdog.service %s%s-watchdog.timer" % (units, LINUX_UNIT, units, LINUX_UNIT,
                                                                             units, LINUX_UNIT),
            "systemctl daemon-reload",
            "systemctl reset-failed %s 2>/dev/null" % LINUX_UNIT,
            "rm -rf -- %s" % shlex.quote(d),
            "",
        ])
    if os_name == "darwin":
        return "\n".join([
            "sleep 2",
            "launchctl bootout system/%s 2>/dev/null" % MAC_WATCHDOG_LABEL,
            "rm -f /Library/LaunchDaemons/%s.plist /Library/LaunchDaemons/%s.plist /etc/newsyslog.d/labctl.conf"
            % (MAC_WATCHDOG_LABEL, MAC_LABEL),
            "rm -rf -- %s" % shlex.quote(d),
            "rm -f /var/log/labctl-agent.log /var/log/labctl-agent.log.*",
            "launchctl bootout system/%s 2>/dev/null" % MAC_LABEL,
            "",
        ])
    name = cfg.get("windows_task_name") or DEFAULT_WINDOWS_TASK
    return "\n".join([
        "Start-Sleep -Seconds 2",
        "foreach ($n in @(%s, %s)) {" % (_ps_quote(name), _ps_quote(name + "-Watchdog")),
        "  if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {",
        "    Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue",
        "    Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue }",
        "  if (Get-Service -Name $n -ErrorAction SilentlyContinue) {",
        "    Stop-Service -Name $n -Force -ErrorAction SilentlyContinue; sc.exe delete $n | Out-Null } }",
        "Stop-Process -Id %d -Force -ErrorAction SilentlyContinue" % int(pid or 0) if pid else "",
        "for ($i = 0; $i -lt 30 -and (Test-Path -LiteralPath %s); $i++) {" % _ps_quote(d),
        "  Remove-Item -LiteralPath %s -Recurse -Force -ErrorAction SilentlyContinue; Start-Sleep 1 }" % _ps_quote(d),
        "",
    ])


def spawn_uninstall(cfg):
    """Start the cleanup helper outside the agent's service so stopping the service does not kill it."""
    script = uninstall_script(OS_NAME, INSTALL_DIR, cfg, os.getpid())
    if IS_WINDOWS:
        enc = base64.b64encode(script.encode("utf-16-le")).decode()
        argv = [powershell_exe() or "powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                "-EncodedCommand", enc]
        base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        try:
            subprocess.Popen(argv, cwd=tempfile.gettempdir(), creationflags=base | CREATE_BREAKAWAY_FROM_JOB,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:  # the task's job object does not allow breakaway
            subprocess.Popen(argv, cwd=tempfile.gettempdir(), creationflags=base,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return
    argv = ["/bin/sh", "-c", script]
    if IS_LINUX and which("systemd-run"):  # leave the service cgroup, which systemctl stop kills
        argv = ["systemd-run", "--unit", "labctl-uninstall-%d" % os.getpid(), "--collect", "--quiet"] + argv
    subprocess.Popen(argv, cwd="/", start_new_session=True, stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _systemd_quote(s):
    return '"%s"' % s.replace("\\", "\\\\").replace('"', '\\"')


def install_linux_service(config_path):
    exe, script = _systemd_quote(sys.executable), _systemd_quote(SCRIPT_PATH)
    cfgq = _systemd_quote(os.path.abspath(config_path))
    units = {
        "%s.service" % LINUX_UNIT: (
            "[Unit]\nDescription=LabCTL Agent\nAfter=network-online.target\nWants=network-online.target\n\n"
            "[Service]\nType=simple\nExecStart=%s %s --config %s\nRestart=always\nRestartSec=5\nUser=root\n"
            "WorkingDirectory=%s\nEnvironment=PYTHONUNBUFFERED=1\n\n[Install]\nWantedBy=multi-user.target\n"
            % (exe, script, cfgq, _systemd_quote(INSTALL_DIR))),
        "%s-watchdog.service" % LINUX_UNIT: (
            "[Unit]\nDescription=LabCTL Agent self-update watchdog\n\n[Service]\nType=oneshot\n"
            "ExecStart=%s %s --watchdog --config %s\n" % (exe, script, cfgq)),
        "%s-watchdog.timer" % LINUX_UNIT: (
            "[Unit]\nDescription=LabCTL Agent self-update watchdog\n\n[Timer]\nOnBootSec=60\n"
            "OnUnitActiveSec=30\n\n[Install]\nWantedBy=timers.target\n"),
    }
    for name, text in units.items():
        with open("/etc/systemd/system/" + name, "w", encoding="utf-8") as f:
            f.write(text)
    run(["systemctl", "daemon-reload"], 60)
    run(["systemctl", "enable", "--now", "%s-watchdog.timer" % LINUX_UNIT], 60)
    run(["systemctl", "enable", LINUX_UNIT], 60)
    run(["systemctl", "restart", LINUX_UNIT], 60)
    print("Service installed: systemctl status %s" % LINUX_UNIT)


# ---------------------------------------------------------------------------
# WebSocket client
# ---------------------------------------------------------------------------

class Agent:
    def __init__(self, cfg):
        self.cfg = cfg
        self.state = CollectorState(cfg)
        self.ws = None
        self.connected = threading.Event()
        self.send_lock = threading.Lock()
        self.inv_lock = threading.Lock()
        self.jobs = {}
        self.job_threads = {}
        self.outbox = []
        self.outbox_bytes = 0
        self.running = True
        self.uninstalling = False
        self.blocked = False
        self.exit_code = 0
        self.gen = 0

    # --- sending ---
    def send(self, msg):
        data = json.dumps(msg)
        with self.send_lock:
            if self.ws is not None and self.connected.is_set():
                try:
                    self.ws.send(data)
                    return True
                except Exception as e:
                    log("[ws] send failed:", e)
            if msg.get("job_id"):
                # shortcut: job traffic waits in memory for the next connection; output beyond the cap is dropped
                if msg.get("type") == "job_complete" or self.outbox_bytes + len(data) <= OUTBOX_MAX_BYTES:
                    self.outbox.append(data)
                    self.outbox_bytes += len(data)
        return False

    def _flush_outbox(self):
        with self.send_lock:
            pending, self.outbox, self.outbox_bytes = self.outbox, [], 0
            for i, data in enumerate(pending):
                try:
                    self.ws.send(data)
                except Exception:
                    self.outbox = pending[i:]
                    self.outbox_bytes = sum(len(x) for x in self.outbox)
                    return

    # --- websocket callbacks ---
    def on_open(self, ws):
        log("[ws] connected")
        self.blocked = False
        self.connected.set()
        self.gen += 1
        self.send(register_message(self.cfg, self.state))
        self._flush_outbox()
        clear_update_marker()
        threading.Thread(target=self._loop, args=(self.gen,), daemon=True).start()

    def on_message(self, ws, message):
        try:
            msg = json.loads(message)
        except ValueError:
            log("[ws] ignored a frame that is not JSON")
            return
        t = msg.get("type")
        if t == "run_job":
            jid = msg.get("job_id")
            if jid in self.jobs:
                return
            ev = threading.Event()
            self.jobs[jid] = ev
            th = threading.Thread(target=self._job, args=(msg, ev), daemon=True)
            self.job_threads[jid] = th
            th.start()
        elif t == "cancel_job":
            ev = self.jobs.get(msg.get("job_id"))
            if ev:
                ev.set()
        elif t == "update_agent":
            threading.Thread(target=self._update, args=(msg,), daemon=True).start()
        elif t == "uninstall":
            threading.Thread(target=self._uninstall, daemon=True).start()
        elif t == "collect":
            self.start_inventory()
        elif t == "ping":
            self.send({"type": "pong", "host_id": self.cfg["host_id"], "agent_version": VERSION, "ts": now_iso()})
        else:
            log("[ws] unknown message type:", t)

    def on_error(self, ws, error):
        log("[ws] error:", error)

    def on_close(self, ws, code=None, reason=None):
        self.connected.clear()
        if code == 4403:
            self.blocked = True
        log("[ws] closed", code or "", reason or "")

    # --- work ---
    def _loop(self, gen):
        next_hb = time.monotonic() + HEARTBEAT_S
        next_inv = time.monotonic()
        while self.running and gen == self.gen and self.connected.is_set():
            now = time.monotonic()
            if now >= next_inv:
                self.start_inventory()
                next_inv = now + INVENTORY_S
            if now >= next_hb:
                try:
                    self.send(heartbeat(self.state, self.cfg["host_id"]))
                except Exception as e:
                    log("[hb] error:", e)
                next_hb = now + HEARTBEAT_S
            time.sleep(1)

    def start_inventory(self):
        if self.inv_lock.acquire(blocking=False):
            threading.Thread(target=self._inventory, daemon=True).start()

    def _inventory(self):
        try:
            data = collect_inventory(self.state)
            self.send({"type": "inventory", "host_id": self.cfg["host_id"], "ts": now_iso(), "data": data})
        except Exception as e:
            log("[inventory] error:", e)
        finally:
            self.inv_lock.release()

    def _job(self, msg, ev):
        jid = msg.get("job_id")
        log("[job] start", jid, msg.get("shell"))
        try:
            m = run_job(msg, self.send, ev)
            log("[job] end", jid, m["status"], m["exit_code"])
        except Exception as e:
            log("[job] crashed", jid, e)
            self.send({"type": "job_complete", "job_id": jid, "status": "failed", "exit_code": None, "duration_ms": 0})
        finally:
            self.jobs.pop(jid, None)
            self.job_threads.pop(jid, None)

    def _update(self, msg):
        try:
            apply_update(fetch_source(msg.get("source")), msg.get("sha256"), SCRIPT_PATH, msg.get("version"))
        except Exception as e:
            log("[update] rejected:", e)
            return
        log("[update] installed version", msg.get("version"), "- restarting")
        self.stop(EXIT_RESTART)

    def _uninstall(self):
        log("[uninstall] requested")
        try:
            safe_install_dir(INSTALL_DIR)
        except ValueError as e:
            log("[uninstall] refused:", e)
            return
        self.send({"type": "agent_gone", "host_id": self.cfg["host_id"]})
        time.sleep(1)
        try:
            spawn_uninstall(self.cfg)
        except Exception as e:
            log("[uninstall] helper failed:", e)
            return
        self.uninstalling = True
        self.stop(0)

    def stop(self, code=0):
        self.exit_code = code
        self.running = False
        for ev in list(self.jobs.values()):
            ev.set()
        for th in list(self.job_threads.values()):
            th.join(timeout=10)
        ws = self.ws
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass

    def run(self):
        attempt = 0
        while self.running:
            url = build_ws_url(self.cfg["server_url"], self.cfg.get("token"))
            self.ws = websocket.WebSocketApp(url, on_open=self.on_open, on_message=self.on_message,
                                             on_error=self.on_error, on_close=self.on_close)
            gen = self.gen
            try:
                self.ws.run_forever(ping_interval=20, ping_timeout=10)
            except Exception as e:
                log("[ws] connection failed:", e)
            self.connected.clear()
            if not self.running:
                break
            attempt = 0 if self.gen != gen else min(attempt + 1, 6)
            delay = 300 if self.blocked else min(60, 2 ** attempt) + random.uniform(0, 1)
            log("[ws] reconnecting in %d s%s" % (delay, " (host is blocked)" if self.blocked else ""))
            end = time.monotonic() + delay
            while self.running and time.monotonic() < end:
                time.sleep(0.5)
        return self.exit_code


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description="LabCTL agent %s" % VERSION)
    ap.add_argument("--config", default=None, help="config file (default: agent.json next to this script)")
    ap.add_argument("--server", help="server URL, saved into the config")
    ap.add_argument("--token", help="enrolment token, saved into the config")
    ap.add_argument("--install-service", action="store_true", help="Linux: install the systemd service")
    ap.add_argument("--watchdog", action="store_true", help="one-shot self-update check")
    ap.add_argument("--restore-bak", action="store_true", help="restore labctl-agent.py.bak")
    ap.add_argument("--collect", action="store_true", help="print one inventory as JSON and exit")
    ap.add_argument("--version", action="version", version=VERSION)
    args = ap.parse_args(argv)

    if args.restore_bak:
        restore_bak()
        print("Restored %s.bak" % SCRIPT_PATH)
        return 0
    path = args.config or default_config_path()
    cfg = load_config(path, {"server_url": args.server, "token": args.token})
    if args.watchdog:
        result = watchdog_check(restart=lambda: restart_service(cfg))
        if result == "restored":
            log("[watchdog] new agent did not connect within %d s; restored the backup" % UPDATE_GRACE_S)
        return 0
    if args.collect:
        print(json.dumps(collect_inventory(CollectorState(cfg)), indent=2, default=str))
        return 0
    if args.server or args.token or not os.path.exists(path):
        save_config(path, cfg)
    if args.install_service:
        if IS_LINUX:
            install_linux_service(path)
        elif IS_DARWIN:
            print("On macOS run setup-mac.sh, which installs the launchd daemons.")
        else:
            print("On Windows run setup-windows.ps1, which installs the scheduled tasks.")
        return 0
    if not cfg.get("server_url"):
        print("No server URL. Pass --server or set server_url in %s" % path, file=sys.stderr)
        return EXIT_CONFIG
    if websocket is None:
        print("websocket-client is missing. Install it into the agent venv: venv/bin/python -m pip install "
              "websocket-client", file=sys.stderr)
        return EXIT_CONFIG
    log("[agent] LabCTL agent %s, host %s (%s), %s" % (VERSION, socket.gethostname(), cfg["host_id"], OS_NAME))
    agent = Agent(cfg)

    def on_term(signum, frame):
        log("[agent] stopping")
        threading.Thread(target=agent.stop, daemon=True).start()
    try:
        signal.signal(signal.SIGTERM, on_term)
    except (ValueError, OSError):
        pass
    try:
        code = agent.run()
    except KeyboardInterrupt:
        agent.stop(0)
        return 0
    if agent.uninstalling:
        time.sleep(120)  # an exit now would make the service manager restart us; the helper stops the service
    return code


if __name__ == "__main__":
    sys.exit(main())
