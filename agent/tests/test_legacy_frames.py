"""The agent answers frames it cannot run, so a job never waits silently on the server."""
import json
import time
import unittest

from agent_loader import load

A = load()


class FakeWS:
    def __init__(self):
        self.sent = []

    def send(self, data):
        self.sent.append(json.loads(data))


def agent():
    a = A.Agent({"host_id": "abc123", "server_url": "https://labctl.example.test"})
    a.ws = FakeWS()
    a.connected.set()
    return a


class LegacyFrames(unittest.TestCase):
    def test_v1_job_frame_fails_with_a_message(self):
        a = agent()
        a.on_message(a.ws, json.dumps({"type": "job", "job": {"id": "j1", "type": "list_crons", "params": "{}"}}))
        out = [m for m in a.ws.sent if m["type"] == "job_output"]
        done = [m for m in a.ws.sent if m["type"] == "job_complete"]
        self.assertEqual(out[0]["job_id"], "j1")
        self.assertEqual(out[0]["stream"], "stderr")
        self.assertIn("Unsupported job type list_crons for this agent version", out[0]["chunk"])
        self.assertEqual((done[0]["status"], done[0]["exit_code"], done[0]["duration_ms"]), ("failed", 1, 0))

    def test_run_job_is_acknowledged_before_output(self):
        a = agent()
        a.on_message(a.ws, json.dumps({"type": "run_job", "job_id": "j2", "shell": "python",
                                       "script": "print('hi')\n", "env": {}, "timeout_s": 30}))
        self.assertEqual(a.ws.sent[0], {"type": "job_started", "job_id": "j2"})
        deadline = time.time() + 20
        while time.time() < deadline and not any(m["type"] == "job_complete" for m in a.ws.sent):
            time.sleep(0.1)
        self.assertTrue(any(m["type"] == "job_complete" and m["status"] == "success" for m in a.ws.sent))


if __name__ == "__main__":
    unittest.main()
