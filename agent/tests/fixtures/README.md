# Agent test fixtures

Hand-written samples in the exact layout each tool prints. All names, paths and
addresses are placeholders (example.test, 192.0.2.x, example-org). Files with
`## name` lines hold several samples; the tests split them on those lines.

| File | Source command |
|---|---|
| softwareupdate_14_restart.txt | `softwareupdate -l` on macOS 14, one item needs a restart |
| softwareupdate_15_norestart.txt | `softwareupdate -l` on macOS 15, no restart |
| softwareupdate_none.txt | `softwareupdate -l` with nothing pending |
| vm_stat.txt | `vm_stat` (16 KB pages, Apple silicon) |
| df_k_macos.txt | `df -k` on macOS, with APFS system volumes, an autofs map, a Time Machine snapshot and a volume name with a space |
| df_kP_linux.txt, proc_mounts.txt | `df -kP` and `/proc/mounts` on Linux |
| sysctl_macos.txt | `sysctl kern.boottime` and `sysctl vm.swapusage` |
| mac_security.txt | `fdesetup status`, `socketfilterfw --getglobalstate`, `spctl --status`, `csrutil status` |
| brew_outdated.json | `brew outdated --json=v2` |
| simctl_list.json | `xcrun simctl list devices --json` |
| launchctl_list.txt | `launchctl list` |
| tmutil_latest.txt | `tmutil latestbackup` (APFS backup layout) |
| pmset_g.txt | `pmset -g` |
| time_offsets.txt | `sntp`, `chronyc tracking`, `w32tm /stripchart /dataonly` |
| runner/.runner | GitHub Actions runner `.runner` file, written with a UTF-8 BOM like the runner does |
| runner/_diag/*.log | Runner and Worker diagnostic logs |
| runner_unit.service | systemd unit written by the runner's `svc.sh install` |
| win_hotfix.json | `Get-HotFix \| Select-Object HotFixID, InstalledOn \| ConvertTo-Json` (PowerShell 5.1 date objects) |
| win_defender.json | `Get-MpComputerStatus` selected fields |
| win_wu_history.json | Windows Update history from the agent's COM query |
| win_tasks.json | Scheduled task results from the agent's query |
| linux_misc.txt | `/proc/meminfo`, `/proc/net/dev`, `/proc/stat`, `apt-get -s upgrade`, apt history, `systemctl --failed`, `smartctl -H`, macOS `ps`, `netstat -ibn`, `top -l 2` |
| proxmox.txt | ZFS arcstats, `qm list`, `pct list`, `zpool list -H -p` |
| docker.json | `docker ps`, `docker stats`, `docker inspect`, `docker image inspect` |

Never add a `.credentials` or `.credentials_rsaparams` file here. The agent must never
open those files, and test_runtime checks that it does not.

## Inventory keys

`inventory.data` uses these stable keys. Sizes are bytes, times are ISO 8601 UTC
strings unless noted, rates are bytes per second, and a value is null when the host
cannot report it. The same list sits at the top of `labctl-agent.py`.

| Key | Content |
|---|---|
| schema | 2 |
| agent_version, os, hostname | agent version, `linux`, `darwin` or `windows`, host name |
| errors | `{collector: message}` for each collector that failed; the rest of the inventory still arrives |
| os_info | name, version, build, kernel, arch, model, domain, ip, boot_time, uptime_s |
| cpu | count, percent, load [1, 5, 15] (null on Windows) |
| memory | total, used, available, percent, swap_total, swap_used, swap_percent |
| disks[] | device, mount, fstype, total, used, free, percent, inodes_total, inodes_used, inodes_percent |
| net[] | iface, rx_bytes, tx_bytes, rx_bytes_per_s, tx_bytes_per_s (null on the first sample) |
| temps[] | sensor, celsius |
| smart[] | device, health (`ok`, `failing`, `unknown`), detail |
| procs | top_cpu[], top_mem[]: pid, user, name, cpu, mem_percent, rss |
| services | failed[]: name, state, detail (systemd failed units, stopped automatic Windows services, launchd jobs with a non-zero last exit) |
| updates | pending, security, restart_required, reboot_required, reboot_pending_days, last_patch, items[] |
| time | drift_s (positive means the local clock is ahead), source, synced |
| docker | running, total, containers[]: id, name, image, state, status, health, restart_count, cpu_percent, mem_bytes, mem_percent, image_created, image_age_days, repo_digests, newer_image (null for now) |
| security | Linux: firewall. macOS: filevault, firewall, gatekeeper, sip. Windows: defender{} |
| runners[] | path, name, url, pool, level (`repo`, `org`, `enterprise`), labels, service, service_state, run_as, source, version, busy, job, sizes{work, diag, temp, tool_cache}, sizes_partial, log_tail[] |
| darwin | softwareupdate{pending, restart_required, items[]}, brew{formulae, casks, items[]}, xcode{apps[], clt{path, installed, version}, derived_data_bytes, simulators{count, unavailable, bytes}}, time_machine{latest (local time), age_days}, pmset{}, launchd_failed[] |
| windows | pending_reboot{cbs, wu, file_rename, any}, failed_tasks[], last_update{result, date, title}, hotfixes{count, last_patch, last_id} |
| proxmox | version, zpool_healthy, zpools[], arc_bytes, arc_max_bytes, vms[], containers[] |
