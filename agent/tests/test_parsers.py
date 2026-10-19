import json
import unittest
from datetime import datetime

from agent_loader import fixture, load, sections

A = load()


class MacParsers(unittest.TestCase):
    def test_softwareupdate_restart(self):
        r = A.parse_softwareupdate(fixture("softwareupdate_14_restart.txt"))
        self.assertEqual(r["pending"], 3)
        self.assertTrue(r["restart_required"])
        first = r["items"][0]
        self.assertEqual(first["label"], "macOS Sonoma 14.4.1-23E224")
        self.assertEqual(first["title"], "macOS Sonoma 14.4.1")
        self.assertEqual(first["version"], "14.4.1")
        self.assertEqual(first["size_kb"], 6894476)
        self.assertTrue(first["recommended"] and first["restart"])
        self.assertFalse(r["items"][1]["restart"])
        self.assertEqual(r["items"][2]["title"], "Command Line Tools for Xcode")

    def test_softwareupdate_no_restart(self):
        r = A.parse_softwareupdate(fixture("softwareupdate_15_norestart.txt"))
        self.assertEqual(r["pending"], 2)
        self.assertFalse(r["restart_required"])
        self.assertFalse(r["items"][1]["recommended"])

    def test_softwareupdate_none(self):
        r = A.parse_softwareupdate(fixture("softwareupdate_none.txt"))
        self.assertEqual((r["pending"], r["restart_required"], r["items"]), (0, False, []))

    def test_vm_stat(self):
        total = 16 * 1024 ** 3
        r = A.parse_vm_stat(fixture("vm_stat.txt"), total)
        self.assertEqual(r["page_size"], 16384)
        # (anonymous 250000 - purgeable 10000 + wired 100000 + compressor 50000) * 16384
        self.assertEqual(r["used"], 390000 * 16384)
        self.assertEqual(r["available"], total - r["used"])
        self.assertAlmostEqual(r["percent"], round(390000 * 16384 * 100 / total, 1))

    def test_df_macos(self):
        rows = A.parse_df(fixture("df_k_macos.txt"))
        self.assertEqual(len(rows), 13)
        mounts = [r["mount"] for r in A.filter_mac_disks(rows)]
        self.assertEqual(mounts, ["/", "/System/Volumes/Data", "/Volumes/Backup Disk"])
        data = next(r for r in rows if r["mount"] == "/System/Volumes/Data")
        self.assertEqual(data["used"], 247580960 * 1024)
        self.assertEqual(data["inodes_used"], 2306788)
        self.assertEqual(data["inodes_total"], 2306788 + 2201788200)
        auto = next(r for r in rows if r["mount"] == "/System/Volumes/Data/home")
        self.assertEqual(auto["device"], "map auto_home")

    def test_sysctl(self):
        s = A.parse_kv_lines(fixture("sysctl_macos.txt"))
        self.assertEqual(A.parse_sysctl_boottime(s["kern.boottime"]), 1712300000)
        sw = A.parse_swapusage(s["vm.swapusage"])
        self.assertEqual(sw["swap_total"], 2048 * 1024 ** 2)
        self.assertEqual(sw["swap_used"], int(1024.5 * 1024 ** 2))
        self.assertEqual(sw["swap_percent"], 50.0)
        self.assertTrue(sw["encrypted"])

    def test_security_lines(self):
        s = sections("mac_security.txt")
        self.assertTrue(A.parse_fdesetup(s["fdesetup status"]))
        self.assertFalse(A.parse_fdesetup(s["fdesetup status off"]))
        self.assertTrue(A.parse_socketfilterfw(s["socketfilterfw --getglobalstate"]))
        self.assertFalse(A.parse_socketfilterfw(s["socketfilterfw off"]))
        self.assertTrue(A.parse_spctl(s["spctl --status"]))
        self.assertFalse(A.parse_spctl(s["spctl off"]))
        self.assertTrue(A.parse_csrutil(s["csrutil status"]))
        self.assertFalse(A.parse_csrutil(s["csrutil off"]))
        self.assertIsNone(A.parse_csrutil("System Integrity Protection status: unknown (Custom Configuration)."))
        self.assertIsNone(A.parse_fdesetup(""))

    def test_brew(self):
        r = A.parse_brew_outdated(fixture("brew_outdated.json"))
        self.assertEqual((r["formulae"], r["casks"]), (3, 1))
        openssl = next(i for i in r["items"] if i["name"] == "openssl@3")
        self.assertEqual(openssl["installed"], "3.2.1")
        self.assertTrue(next(i for i in r["items"] if i["name"] == "node")["pinned"])

    def test_simctl(self):
        r = A.parse_simctl(fixture("simctl_list.json"))
        self.assertEqual(r, {"count": 3, "unavailable": 1, "bytes": 1073741824 + 536870912 + 268435456})
        self.assertIsNone(A.parse_simctl('{"devices": {"x": [{"isAvailable": true}]}}')["bytes"])

    def test_launchctl(self):
        rows = A.parse_launchctl_list(fixture("launchctl_list.txt"))
        self.assertEqual(len(rows), 6)
        failed = A.launchd_failed(rows)
        self.assertEqual([f["name"] for f in failed],
                         ["com.example.backup-helper", "com.apple.mdworker.shared.0B000000-0000-0000-0000-000000000000",
                          "com.example.sync"])
        self.assertEqual(failed[0]["state"], "exit 78")

    def test_tmutil(self):
        self.assertEqual(A.parse_tmutil_latest(fixture("tmutil_latest.txt")), "2024-01-15T12:34:56")
        self.assertEqual(A.parse_tmutil_latest("/Volumes/Backup/Backups.backupdb/Mac/2023-12-01-090000"),
                         "2023-12-01T09:00:00")
        self.assertIsNone(A.parse_tmutil_latest("No machine directory found for host."))

    def test_pmset(self):
        p = A.parse_pmset(fixture("pmset_g.txt"))
        self.assertEqual(p["sleep"], 1)
        self.assertEqual(p["sleep_note"], "sleep prevented by sharingd, powerd")
        self.assertEqual(p["displaysleep"], 10)
        self.assertEqual(p["Sleep On Power Button"], 1)
        self.assertEqual(p["hibernatefile"], "/var/vm/sleepimage")

    def test_sw_vers(self):
        v = A.parse_sw_vers("ProductName:\t\tmacOS\nProductVersion:\t\t14.4.1\nBuildVersion:\t\t23E224\n")
        self.assertEqual(v, {"name": "macOS", "version": "14.4.1", "build": "23E224"})

    def test_install_history(self):
        entries = [{"processName": "softwareupdated", "date": datetime(2024, 1, 10, 3, 0, 0)},
                   {"processName": "Installer", "date": datetime(2024, 2, 1)},
                   {"processName": "softwareupdated", "date": datetime(2024, 1, 15, 3, 0, 0)}]
        self.assertEqual(A.parse_install_history(entries), "2024-01-15T03:00:00Z")
        self.assertIsNone(A.parse_install_history([]))


class CommonParsers(unittest.TestCase):
    def setUp(self):
        self.s = sections("linux_misc.txt")

    def test_time_offsets(self):
        t = sections("time_offsets.txt")
        self.assertAlmostEqual(A.parse_time_offset(t["sntp"]), -0.012345)
        self.assertAlmostEqual(A.parse_time_offset(t["chronyc tracking"]), -0.00025)
        self.assertAlmostEqual(A.parse_time_offset(t["w32tm stripchart"]), -0.025)
        self.assertIsNone(A.parse_time_offset("garbage"))

    def test_meminfo(self):
        m = A.parse_meminfo(self.s["meminfo"])
        self.assertEqual(m["total"], 8000000 * 1024)
        self.assertEqual(m["used"], 2000000 * 1024)
        self.assertEqual(m["percent"], 25.0)
        self.assertEqual(m["swap_used"], 500000 * 1024)

    def test_net(self):
        c = A.parse_proc_net_dev(self.s["proc_net_dev"])
        self.assertEqual(c["eth0"], (123456789, 987654321))
        mac = A.parse_netstat_ibn(self.s["netstat_ibn"])
        self.assertEqual(mac["en0"], (987654321, 12345678))
        rows = A.net_rates({"eth0": (123456789 - 1000, 987654321 - 500)}, c, 10.0)
        self.assertEqual([r["iface"] for r in rows], ["eth0"])
        self.assertEqual((rows[0]["rx_bytes_per_s"], rows[0]["tx_bytes_per_s"]), (100, 50))
        self.assertIsNone(A.net_rates(None, c, None)[0]["rx_bytes_per_s"])

    def test_cpu(self):
        prev = A.parse_proc_stat_cpu(self.s["proc_stat"])
        self.assertEqual(prev, (82000, 97300))
        self.assertEqual(A.cpu_percent_from(prev, (prev[0] + 50, prev[1] + 100)), 50.0)
        self.assertEqual(A.parse_top_cpu(self.s["top_mac"]), 8.0)

    def test_ps(self):
        procs = A.parse_ps(self.s["ps_mac"])
        top = A.top_procs(procs, 2)
        self.assertEqual(top["top_cpu"][0]["name"], "Google Chrome")
        self.assertEqual(top["top_mem"][0]["rss"], 1650000 * 1024)
        self.assertEqual(len(top["top_cpu"]), 2)

    def test_apt(self):
        a = A.parse_apt_simulate(self.s["apt_simulate"])
        self.assertEqual((a["pending"], a["security"]), (3, 2))
        self.assertEqual(A.parse_apt_history_last(self.s["apt_history"]), "2024-01-15T06:01:30")

    def test_systemctl_failed(self):
        rows = A.parse_systemctl_failed(self.s["systemctl_failed"])
        self.assertEqual(rows[0], {"name": "backup.service", "state": "failed/failed", "detail": "Nightly backup job"})

    def test_smart(self):
        self.assertEqual(A.parse_smartctl_health(self.s["smartctl_ok"]), "ok")
        self.assertEqual(A.parse_smartctl_health(self.s["smartctl_bad"]), "failing")
        self.assertEqual(A.parse_smartctl_health(""), "unknown")
        self.assertEqual(A.parse_diskutil_smart("   SMART Status:              Verified\n")["health"], "ok")

    def test_df_linux(self):
        rows = A.parse_df(fixture("df_kP_linux.txt"))
        keep = A.filter_linux_disks(rows, A.parse_proc_mounts(fixture("proc_mounts.txt")))
        self.assertEqual([(d["mount"], d["fstype"]) for d in keep],
                         [("/", "ext4"), ("/boot/efi", "vfat"), ("/srv/data share", "xfs")])
        self.assertIsNone(keep[0]["inodes_total"])

    def test_proxmox(self):
        p = sections("proxmox.txt")
        self.assertEqual(A.parse_arcstats(p["arcstats"]), {"arc_bytes": 4294967296, "arc_max_bytes": 8589934592})
        vms = A.parse_qm_list(p["qm_list"])
        self.assertEqual([(v["vmid"], v["status"], v["mem_mb"]) for v in vms], [(100, "running", 4096),
                                                                               (101, "stopped", 2048)])
        cts = A.parse_pct_list(p["pct_list"])
        self.assertEqual(cts[0], {"vmid": 200, "status": "running", "lock": None, "name": "ct-one"})
        self.assertEqual(cts[1]["lock"], "backup")
        pools = A.parse_zpool_list(p["zpool_list"])
        self.assertEqual([(z["name"], z["health"]) for z in pools], [("rpool", "ONLINE"), ("tank", "DEGRADED")])

    def test_docker(self):
        d = json.loads(fixture("docker.json"))
        now = A.parse_iso_ts("2024-01-15T12:00:01Z")
        r = A.parse_docker(d["ps"], d["stats"], d["inspect"], d["images"], now=now)
        self.assertEqual((r["running"], r["total"]), (1, 2))
        web, worker = r["containers"]
        self.assertEqual(web["health"], "healthy")
        self.assertEqual(web["cpu_percent"], 0.5)
        self.assertEqual(web["mem_bytes"], int(12.5 * 1024 ** 2))
        self.assertEqual(web["image_age_days"], 10)
        self.assertIsNone(web["newer_image"])
        self.assertEqual(worker["restart_count"], 7)
        self.assertIsNone(worker["cpu_percent"])
        self.assertEqual(worker["image_age_days"], 30)

    def test_sizes_and_dates(self):
        self.assertEqual(A.parse_size("1.5GiB"), int(1.5 * 1024 ** 3))
        self.assertEqual(A.parse_size("100kB"), 100000)
        self.assertIsNone(A.parse_size("n/a"))
        self.assertEqual(A.parse_ps_date("/Date(1705276800000)/"), "2024-01-15T00:00:00Z")
        self.assertEqual(A.parse_ps_date({"value": "/Date(1705276800000)/"}), "2024-01-15T00:00:00Z")
        self.assertEqual(A.parse_ps_date("2024-01-15T01:00:00+01:00"), "2024-01-15T00:00:00Z")
        self.assertIsNone(A.parse_ps_date(None))


class WindowsParsers(unittest.TestCase):
    def test_hotfix(self):
        r = A.parse_hotfixes(json.loads(fixture("win_hotfix.json")))
        self.assertEqual(r, {"count": 3, "last_patch": "2024-01-15T00:00:00Z", "last_id": "KB5034441"})
        self.assertEqual(A.parse_hotfixes(None)["count"], 0)

    def test_defender(self):
        r = A.parse_defender(json.loads(fixture("win_defender.json")))
        self.assertTrue(r["realtime"] and r["tamper_protected"])
        self.assertEqual(r["signature_updated"], "2024-01-15T10:00:00Z")
        self.assertIsNone(A.parse_defender({"error": "not available"}))

    def test_wu_history(self):
        r = A.parse_wu_history(json.loads(fixture("win_wu_history.json")))
        self.assertEqual(r["result"], "failed")
        self.assertEqual(r["date"], "2024-01-15T03:05:00Z")
        self.assertIn("KB5034129", r["title"])
        self.assertIsNone(A.parse_wu_history([]))

    def test_failed_tasks(self):
        rows = A.parse_failed_tasks(json.loads(fixture("win_tasks.json")))
        self.assertEqual([r["name"] for r in rows], ["\\LabCTL\\Nightly Backup", "\\Exit One"])
        self.assertEqual(rows[0]["result_hex"], "0x80070002")


class RunnerParsers(unittest.TestCase):
    def test_runner_file_with_bom(self):
        raw = fixture("runner/.runner", "rb")
        self.assertTrue(raw.startswith(b"\xef\xbb\xbf"))
        info = A.parse_runner_file(raw)
        self.assertEqual(info["agentName"], "runner-01")
        self.assertEqual(A.runner_level(info["gitHubUrl"]), "repo")
        self.assertEqual(A.runner_level("https://github.com/example-org"), "org")
        self.assertEqual(A.runner_level("https://github.com/enterprises/example"), "enterprise")

    def test_worker_log(self):
        names = ["Runner_20240115-100000-utc.log", "Worker_20240101-080000-utc.log",
                 "Worker_20240115-101500-utc.log", "notes.txt"]
        self.assertEqual(A.newest_log(names, "Worker_"), "Worker_20240115-101500-utc.log")
        self.assertIsNone(A.newest_log(["notes.txt"], "Worker_"))
        self.assertEqual(A.parse_worker_job_name(fixture("runner/_diag/Worker_20240115-101500-utc.log")),
                         "build (ubuntu-latest)")
        self.assertEqual(A.parse_worker_job_name("x\nRunning job: deploy\n"), "deploy")

    def test_unit_file(self):
        u = A.parse_unit_file(fixture("runner_unit.service"))
        self.assertEqual((u["WorkingDirectory"], u["User"]), ("/opt/actions-runner", "runner"))


class Config(unittest.TestCase):
    def test_ws_url(self):
        self.assertEqual(A.build_ws_url("https://labctl.example.test", "abc"),
                         "wss://labctl.example.test/ws/agent?token=abc")
        self.assertEqual(A.build_ws_url("ws://192.0.2.5:7700/ws/agent", None), "ws://192.0.2.5:7700/ws/agent")
        self.assertEqual(A.build_ws_url("labctl.example.test/", "a+b"), "wss://labctl.example.test/ws/agent?token=a%2Bb")
        self.assertEqual(A.build_ws_url("wss://x.example.test/ws/agent?token=old", "new"),
                         "wss://x.example.test/ws/agent?token=new")

    def test_redact(self):
        self.assertEqual(A.redact("wss://h/ws/agent?token=secret123&x=1"), "wss://h/ws/agent?token=***&x=1")
        self.assertNotIn("abc", A.redact("Authorization: Bearer abc"))


if __name__ == "__main__":
    unittest.main()
