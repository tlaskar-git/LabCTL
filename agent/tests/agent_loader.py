"""Load agent/labctl-agent.py once as module labctl_agent (the file name has a hyphen)."""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")
AGENT_PATH = os.path.join(os.path.dirname(HERE), "labctl-agent.py")


def load():
    mod = sys.modules.get("labctl_agent")
    if mod is None:
        spec = importlib.util.spec_from_file_location("labctl_agent", AGENT_PATH)
        mod = importlib.util.module_from_spec(spec)
        sys.modules["labctl_agent"] = mod
        spec.loader.exec_module(mod)
    return mod


def fixture(name, mode="r"):
    with open(os.path.join(FIXTURES, name), mode, **({} if "b" in mode else {"encoding": "utf-8"})) as f:
        return f.read()


def sections(name):
    """Split a fixture on '## name' lines."""
    out, key = {}, None
    for line in fixture(name).splitlines(keepends=True):
        if line.startswith("## "):
            key = line[3:].strip()
            out[key] = ""
        elif key is not None:
            out[key] += line
    return out
