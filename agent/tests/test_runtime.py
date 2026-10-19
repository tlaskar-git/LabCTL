import builtins
import hashlib
import json
import os
import shutil
import shlex
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from agent_loader import FIXTURES, load

A = load()
IS_WINDOWS = os.name == "nt"


def pid_alive(pid):
    if IS_WINDOWS:
        import ctypes
        h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(h)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:
        with open("/proc/%d/stat" % pid) as f:
            return f.read().split()[2] != "Z"
    except OSError:
        return True


class Collector:
    def __init__(self):
        self.msgs = []
        self.lock = threading.Lock()

    def __call__(self, m):
        with self.lock:
            self.msgs.append(m)

    def text(self, stream):
        with self.lock:
            return "".join(m["chunk"] for m in self.msgs if m["type"] == "job_output" and m["stream"] == stream)

    def outputs(self):
        with self.lock:
            return [m for m in self.msgs if m["type"] == "job_output"]


def job(script, shell="python", **kw):
    m = {"type": "run_job", "job_id": "j1", "shell": shell, "script": script, "env": {}, "timeout_s": 60}
    m.update(kw)
    return m


def nl(s):
    return s.replace("\r\n", "\n")


class Streaming(unittest.TestCase):
    def test_stdout_stderr_and_exit_code(self):
        c = Collector()
        done = A.run_job(job("import sys\nprint('out')\nprint('err', file=sys.stderr)\nsys.exit(3)\n"), c)
        self.assertEqual(nl(c.text("stdout")), "out\n")
        self.assertEqual(nl(c.text("stderr")), "err\n")
        self.assertEqual((done["status"], done["exit_code"]), ("failed", 3))
        self.assertEqual(c.msgs[-1], done)
        self.assertEqual(set(done), {"type", "job_id", "status", "exit_code", "duration_ms"})

    def test_success_env_and_stdin(self):
        c = Collector()
        script = "import os, sys\nprint(os.environ['LABCTL_P_NAME'], sys.stdin.read().upper())\n"
        done = A.run_job(job(script, env={"LABCTL_P_NAME": "value"}, stdin="hello"), c)
        self.assertEqual(nl(c.text("stdout")), "value HELLO\n")
        self.assertEqual((done["status"], done["exit_code"]), ("success", 0))

    def test_long_output_is_not_capped(self):
        c = Collector()
        A.run_job(job("import sys\nsys.stdout.write('x' * 70000 + '\\nend\\n')\n"), c)
        out = nl(c.text("stdout"))
        self.assertEqual(out, "x" * 70000 + "\nend\n")
        seqs = [m["seq"] for m in c.outputs()]
        self.assertEqual(seqs, list(range(len(seqs))))
        self.assertGreater(len(seqs), 1)

    def test_output_streams_before_exit(self):
        c = Collector()
        t = threading.Thread(target=A.run_job,
                             args=(job("import time\nprint('first', flush=True)\ntime.sleep(4)\nprint('last')\n"), c))
        t.start()
        deadline = time.time() + 3.5
        while time.time() < deadline and "first" not in c.text("stdout"):
            time.sleep(0.1)
        self.assertIn("first", c.text("stdout"))
        self.assertNotIn("last", c.text("stdout"))
        t.join(30)

    def test_cancel_kills_child_tree(self):
        c = Collector()
        ev = threading.Event()
        script = ("import subprocess, sys, time\n"
                  "c = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
                  "print('CHILD', c.pid, flush=True)\n"
                  "time.sleep(60)\n")
        result = {}
        t = threading.Thread(target=lambda: result.update(A.run_job(job(script), c, ev)))
        t.start()
        deadline = time.time() + 20
        while time.time() < deadline and "CHILD" not in c.text("stdout"):
            time.sleep(0.1)
        child = int(c.text("stdout").split()[1])
        self.assertTrue(pid_alive(child))
        ev.set()
        t.join(30)
        self.assertEqual(result["status"], "cancelled")
        deadline = time.time() + 10
        while time.time() < deadline and pid_alive(child):
            time.sleep(0.2)
        self.assertFalse(pid_alive(child), "child process survived cancel")

    def test_timeout_fails_job(self):
        c = Collector()
        done = A.run_job(job("import time\ntime.sleep(30)\n", timeout_s=1), c)
        self.assertEqual(done["status"], "failed")
        self.assertIn("timed out", c.text("stderr"))
        self.assertLess(done["duration_ms"], 20000)

    def test_unknown_shell(self):
        c = Collector()
        done = A.run_job(job("x", shell="cmd"), c)
        self.assertEqual(done["status"], "failed")
        self.assertIn("unknown shell", c.text("stderr"))

    @unittest.skipIf(IS_WINDOWS, "bash jobs are tested on Linux and macOS")
    def test_bash(self):
        c = Collector()
        done = A.run_job(job("echo hello\necho oops >&2\nexit 4\n", shell="bash"), c)
        self.assertEqual(c.text("stdout"), "hello\n")
        self.assertEqual(c.text("stderr"), "oops\n")
        self.assertEqual(done["exit_code"], 4)

    @unittest.skipIf(IS_WINDOWS, "pty exists only on Linux and macOS")
    def test_pty_stdout(self):
        c = Collector()
        A.run_job(job("import sys\nprint(sys.stdout.isatty(), sys.stderr.isatty())\n"), c)
        self.assertEqual(c.text("stdout"), "True False\n")

    @unittest.skipUnless(IS_WINDOWS and A.powershell_exe(), "Windows PowerShell only")
    def test_powershell_utf8_and_exit(self):
        c = Collector()
        done = A.run_job(job("Write-Output 'caf\u00e9'\nexit 5\n", shell="powershell"), c)
        self.assertIn("caf\u00e9", c.text("stdout"))
        self.assertEqual((done["status"], done["exit_code"]), ("failed", 5))


class SelfUpdate(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="labctl-test-")
        self.target = os.path.join(self.dir, "labctl-agent.py")
        with open(self.target, "w") as f:
            f.write("OLD = 1\n")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def files(self):
        return sorted(os.listdir(self.dir))

    def test_good_update_keeps_bak(self):
        src = "NEW = 2\n"
        A.apply_update(src, hashlib.sha256(src.encode()).hexdigest(), self.target, "2.0.1")
        with open(self.target) as f:
            self.assertEqual(f.read(), src)
        with open(self.target + ".bak") as f:
            self.assertEqual(f.read(), "OLD = 1\n")
        self.assertEqual(self.files(), ["labctl-agent.py", "labctl-agent.py.bak", "update-pending.json"])
        with open(A.marker_path(self.target)) as f:
            self.assertEqual(json.load(f)["version"], "2.0.1")

    def test_hash_mismatch_rejected(self):
        with self.assertRaises(A.UpdateError):
            A.apply_update("NEW = 2\n", "0" * 64, self.target)
        self.assertEqual(self.files(), ["labctl-agent.py"])
        with open(self.target) as f:
            self.assertEqual(f.read(), "OLD = 1\n")

    def test_syntax_error_rejected(self):
        src = "def broken(:\n"
        with self.assertRaises(A.UpdateError) as cm:
            A.apply_update(src, hashlib.sha256(src.encode()).hexdigest(), self.target)
        self.assertIn("syntax", str(cm.exception))
        self.assertEqual(self.files(), ["labctl-agent.py"])

    def test_watchdog_restores_after_grace(self):
        src = "NEW = 2\n"
        A.apply_update(src, hashlib.sha256(src.encode()).hexdigest(), self.target)
        restarted = []
        self.assertEqual(A.watchdog_check(self.target, 60, now=time.time(), restart=lambda: restarted.append(1)),
                         "waiting")
        self.assertEqual(A.watchdog_check(self.target, 60, now=time.time() + 61,
                                          restart=lambda: restarted.append(1)), "restored")
        self.assertEqual(restarted, [1])
        with open(self.target) as f:
            self.assertEqual(f.read(), "OLD = 1\n")
        self.assertEqual(A.watchdog_check(self.target, 60), "idle")

    def test_connected_agent_clears_marker(self):
        src = "NEW = 2\n"
        A.apply_update(src, hashlib.sha256(src.encode()).hexdigest(), self.target)
        A.clear_update_marker(self.target)
        self.assertEqual(A.watchdog_check(self.target, 0), "idle")

    def test_restore_without_bak(self):
        with self.assertRaises(A.UpdateError):
            A.restore_bak(self.target)


class Uninstall(unittest.TestCase):
    def test_refuses_unsafe_paths(self):
        for p in ("/", "C:\\", "/opt", "/usr/local/agent"):
            with self.assertRaises(ValueError):
                A.safe_install_dir(p)

    def test_scripts(self):
        d = A.safe_install_dir("/opt/labctl/agent")
        lin = A.uninstall_script("linux", "/opt/labctl/agent")
        self.assertIn("rm -rf -- " + shlex.quote(d), lin)
        self.assertIn("systemctl disable --now labctl-agent", lin)
        mac = A.uninstall_script("darwin", "/usr/local/labctl/agent")
        self.assertIn("/Library/LaunchDaemons/com.labctl.agent.plist", mac)
        self.assertTrue(mac.strip().endswith("launchctl bootout system/com.labctl.agent 2>/dev/null"))
        win = A.uninstall_script("windows", "C:\\Program Files\\LabCTL\\agent", {"windows_task_name": "My Task"}, 42)
        self.assertIn("'My Task'", win)
        self.assertIn("Stop-Process -Id 42", win)
        self.assertIn("Remove-Item -LiteralPath", win)


class Runners(unittest.TestCase):
    def test_describe_runner_never_opens_credentials(self):
        root = tempfile.mkdtemp(prefix="labctl-runner-")
        try:
            d = os.path.join(root, "actions-runner")
            shutil.copytree(os.path.join(FIXTURES, "runner"), d)
            for name in (".credentials", ".credentials_rsaparams"):
                with open(os.path.join(d, name), "w") as f:
                    f.write("{}")
            for sub, size in (("_work/_tool/node/x.bin", 1000), ("_work/_temp/t.txt", 200), ("_work/repo/a", 50)):
                p = os.path.join(d, *sub.split("/"))
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, "wb") as f:
                    f.write(b"\0" * size)
            real_open = builtins.open

            def guard(file, *a, **kw):
                if os.path.basename(str(file)).startswith(".credentials"):
                    raise AssertionError("agent opened %s" % file)
                return real_open(file, *a, **kw)
            worker = os.path.join(d, "bin", "Runner.Worker")
            entry = {"path": d, "service": "actions.runner.example", "service_state": "active", "run_as": "runner",
                     "source": "test"}
            with mock.patch("builtins.open", guard):
                r = A.describe_runner(entry, ["/usr/bin/foo", worker + " spawnclient 1 2"], A.CollectorState({}))
            self.assertEqual((r["name"], r["pool"], r["level"]), ("runner-01", "Default", "repo"))
            self.assertTrue(r["busy"])
            self.assertEqual(r["job"], "build (ubuntu-latest)")
            self.assertIn("completed with result: Succeeded", r["log_tail"][-1])
            self.assertEqual(r["sizes"]["tool_cache"], 1000)
            self.assertEqual(r["sizes"]["temp"], 200)
            self.assertEqual(r["sizes"]["work"], 1250)
            self.assertFalse(r["sizes_partial"])
            self.assertIsNone(r["version"])
            r2 = A.describe_runner(entry, [], A.CollectorState({}))
            self.assertFalse(r2["busy"])
        finally:
            shutil.rmtree(root, ignore_errors=True)


class ConfigAndAgent(unittest.TestCase):
    def test_config_round_trip(self):
        d = tempfile.mkdtemp(prefix="labctl-cfg-")
        try:
            path = os.path.join(d, "agent.json")
            cfg = A.load_config(path, {"server_url": "https://labctl.example.test", "token": None},
                                env={"LABCTL_TOKEN": "t0k"})
            self.assertEqual((cfg["server_url"], cfg["token"]), ("https://labctl.example.test", "t0k"))
            A.save_config(path, cfg)
            again = A.load_config(path, env={})
            self.assertEqual(again["host_id"], cfg["host_id"])
            self.assertEqual(again["token"], "t0k")
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_heartbeat_shape(self):
        hb = A.heartbeat(A.CollectorState({}), "abc123")
        for k in ("type", "host_id", "agent_version", "ts", "cpu", "ram", "load", "uptime"):
            self.assertIn(k, hb)
        self.assertEqual(hb["agent_version"], A.VERSION)

    def test_dispatch_ping_and_job(self):
        class FakeWS:
            def __init__(self):
                self.sent = []

            def send(self, data):
                self.sent.append(json.loads(data))

        agent = A.Agent({"host_id": "abc123", "server_url": "https://labctl.example.test"})
        agent.ws = FakeWS()
        agent.connected.set()
        agent.on_message(agent.ws, json.dumps({"type": "ping"}))
        self.assertEqual(agent.ws.sent[0]["type"], "pong")
        agent.on_message(agent.ws, json.dumps(job("print('hi')\n")))
        deadline = time.time() + 20
        while time.time() < deadline and not any(m["type"] == "job_complete" for m in agent.ws.sent):
            time.sleep(0.1)
        done = [m for m in agent.ws.sent if m["type"] == "job_complete"]
        self.assertEqual(done[0]["status"], "success")

    def test_outbox_keeps_job_traffic_while_offline(self):
        agent = A.Agent({"host_id": "abc123", "server_url": "https://labctl.example.test"})
        self.assertFalse(agent.send({"type": "job_complete", "job_id": "j9", "status": "success"}))
        self.assertFalse(agent.send({"type": "heartbeat"}))
        self.assertEqual(len(agent.outbox), 1)


if __name__ == "__main__":
    unittest.main()
