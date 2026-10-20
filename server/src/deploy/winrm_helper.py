"""WinRM session helper for LabCTL, run by winrm.js as a child process (no shell).

Why: Windows hosts such as domain controllers offer only the Negotiate scheme and refuse unencrypted traffic on
port 5985. pywinrm (transport 'ntlm', message_encryption 'auto') answers Negotiate with NTLM inside it and seals
the SOAP messages, which the pure JavaScript client cannot do.

Protocol, JSON lines on stdin and stdout:
  first line in:  {"host", "port", "https", "username", "password", "timeout_s"}
  first line out: {"ready": true} or {"ok": false, "error": "...", "code": "..."} and exit 1
  each line in:   {"id": n, "script": "<PowerShell>"}
  each line out:  {"id": n, "ok": true, "exit_code": c, "stdout": "...", "stderr": "..."} or {"id": n, "ok": false, "error": "..."}
  end of stdin:   the remote shell is closed and the helper exits 0.
One remote shell serves every script of a session. The password arrives on stdin only and is never printed.
"""
import base64
import json
import sys


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def explain(err, req):
    """Plain words for the operator. The password is removed from anything the libraries put in a message."""
    name = type(err).__name__
    user, where = req.get("username", ""), "%s:%s" % (req.get("host"), req.get("port"))
    if name == "InvalidCredentialsError":
        msg = ("WinRM rejected the sign-in for %s. Use DOMAIN\\name for domain accounts, check the password, and the account "
               "must be a local administrator or a member of Remote Management Users." % user)
    elif "Timeout" in name:
        msg = "Timed out talking to WinRM on %s." % where
    elif "ConnectionError" in name or isinstance(err, OSError):
        msg = "Could not connect to WinRM on %s. Is WinRM enabled (winrm quickconfig) and the port open? (%s)" % (where, name)
    else:
        msg = "WinRM error on %s: %s" % (where, err)
    pw = req.get("password") or ""
    return msg.replace(pw, "[redacted]") if len(pw) >= 4 else msg


def encoded(script):
    return "powershell.exe -NoProfile -NonInteractive -EncodedCommand " + base64.b64encode(script.encode("utf-16-le")).decode("ascii")


def main():
    sys.stdin.reconfigure(encoding="utf-8")  # Windows defaults to the ANSI code page
    first = sys.stdin.readline()
    try:
        req = json.loads(first)
    except ValueError:
        out({"ok": False, "error": "The helper expected a JSON request on stdin.", "code": "bad_request"})
        return 2
    try:
        from winrm.protocol import Protocol
    except ImportError:
        out({"ok": False, "error": "pywinrm is not installed", "code": "no_pywinrm"})
        return 3
    timeout = max(5, int(req.get("timeout_s") or 60))
    url = "%s://%s:%d/wsman" % ("https" if req.get("https") else "http", req["host"], int(req["port"]))
    try:
        # Username goes through exactly as typed: DOMAIN\name, name@domain or a local name.
        # Self-signed certificates are the norm on 5986, so they are not validated (see docs/ARCHITECTURE.md).
        proto = Protocol(url, transport="ntlm", username=req["username"], password=req["password"],
                         server_cert_validation="ignore", message_encryption="auto",
                         operation_timeout_sec=timeout, read_timeout_sec=timeout + 10)
        shell = proto.open_shell()
    except Exception as e:  # noqa: BLE001 - every failure becomes one plain line
        out({"ok": False, "error": explain(e, req), "code": "open"})
        return 1
    out({"ready": True})
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            msg = json.loads(line)
            try:
                cid = proto.run_command(shell, encoded(msg["script"]))
                try:
                    so, se, rc = proto.get_command_output(shell, cid)
                finally:
                    proto.cleanup_command(shell, cid)
                out({"id": msg.get("id"), "ok": True, "exit_code": rc,
                     "stdout": so.decode("utf-8", "replace"), "stderr": se.decode("utf-8", "replace")})
            except Exception as e:  # noqa: BLE001
                out({"id": msg.get("id"), "ok": False, "error": explain(e, req)})
    finally:
        try:
            proto.close_shell(shell)
        except Exception:  # noqa: BLE001 - the host may be gone already
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
