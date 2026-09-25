#!/usr/bin/env python3
"""Drive Pi over RPC through a role switch and confirm compaction + re-send.

Uses a loosened copy of the example config (switch on the first differing
turn, compact at any context size) so the second prompt must trigger
compaction, and the prompt must still be answered afterwards.

    scripts/rpc-switch-test.py
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TIMEOUT = 150

tmp = Path(tempfile.mkdtemp(prefix="laya-router-rpc-"))
cfg = json.loads((REPO / "laya-router.example.json").read_text())
# The example points at localhost; take the real proxy and Laya settings from the user's config when there is one.
user_cfg = Path(os.environ.get("LAYA_ROUTER_CONFIG", Path.home() / ".pi" / "agent" / "laya-router.json")).expanduser()
if user_cfg.exists():
    for key in ("headroom", "laya", "fallback"):
        cfg[key] = {**cfg[key], **json.loads(user_cfg.read_text()).get(key, {})}
cfg["thresholds"].update({"streak": 1, "cooldownTurns": 2, "compactMinTokens": 0, "switch": 0.5, "margin": 0.1})
cfg["logPath"] = str(tmp / "decisions.jsonl")
(tmp / "config.json").write_text(json.dumps(cfg))
# Pi keeps keepRecentTokens (20k default) verbatim; lower it for this project so a small session compacts.
(tmp / ".pi").mkdir()
(tmp / ".pi" / "settings.json").write_text(json.dumps({"compaction": {"keepRecentTokens": 800}}))

env = {**os.environ, "LAYA_ROUTER_CONFIG": str(tmp / "config.json")}

# Load the user's other extensions (the proxy provider lives there) but never a
# second copy of this one, which settings.json may already list.
settings_file = Path.home() / ".pi" / "agent" / "settings.json"
user_exts = []
if settings_file.exists():
    for ext in json.loads(settings_file.read_text()).get("extensions", []):
        path = Path(ext).expanduser()
        if not path.is_absolute():
            path = settings_file.parent / path
        if not path.resolve().is_relative_to(REPO):
            user_exts += ["-e", str(path)]

proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session", "--approve", "--no-extensions", *user_exts, "-e", str(REPO / "extension"), "--model", "laya/auto"],
    cwd=tmp, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
)
events: list[dict] = []
lock = threading.Condition()


def reader():
    for line in proc.stdout:
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        with lock:
            events.append(rec)
            lock.notify_all()


threading.Thread(target=reader, daemon=True).start()


def send(cmd: dict):
    proc.stdin.write(json.dumps(cmd) + "\n")
    proc.stdin.flush()


def wait_for(pred, timeout=TIMEOUT):
    deadline = time.time() + timeout
    with lock:
        while time.time() < deadline:
            if any(pred(e) for e in events):
                return True
            lock.wait(timeout=1)
    return False


def wait_for_turn(prompt_id: str, start: int, timeout=TIMEOUT) -> bool:
    """A turn is done when its prompt was accepted and a run has ended and settled after that.
    Pi also emits agent_settled at startup, so counting settles alone is racy."""
    def done(_):
        seq = [(e.get("type"), e.get("id")) for e in events[start:]]
        try:
            resp = next(i for i, (t, i_) in enumerate(seq) if t == "response" and i_ == prompt_id)
            end = next(i for i, (t, _) in enumerate(seq) if t == "agent_end" and i > resp)
            return any(t == "agent_settled" and i > end for i, (t, _) in enumerate(seq))
        except StopIteration:
            return False
    return wait_for(done, timeout)


def kinds(start: int):
    return [e.get("type") for e in events[start:] if e.get("type") not in ("message_update",)]


def assistant_text(start: int):
    for e in events[start:]:
        if e.get("type") == "message_end" and e.get("message", {}).get("role") == "assistant":
            return "".join(c.get("text", "") for c in e["message"].get("content", []) if c.get("type") == "text")
    return ""


ok = True
try:
    # Turns 1-2: build enough history for Pi to have something to summarize
    # (the cut point needs more than one assistant message before it).
    for i, topic in enumerate(["HTTP caching", "TCP congestion control"], start=1):
        mark = len(events)
        send({"id": f"p{i}", "type": "prompt", "message": f"No tools. Write about 500 words explaining {topic}, then end with the word OK."})
        assert wait_for_turn(f"p{i}", mark), f"turn {i} never settled"
        print(f"turn {i}:", kinds(mark)[-3:], "-> chars:", len(assistant_text(mark)))

    # Turn 3: planning -> should switch, compact, re-send, answer.
    mark = len(events)
    send({"id": "p3", "type": "prompt",
          "message": "Do not use tools. Plan how you would migrate this project's auth to Keycloak: give exactly 3 numbered steps, one line each."})
    assert wait_for_turn("p3", mark), "turn 3 never settled"
    ks = kinds(mark)
    print("turn 3:", ks)
    print("turn 3 answer:", repr(assistant_text(mark)[:200]))
    comp_end = next((e for e in events[mark:] if e.get("type") == "compaction_end"), None)
    errors = [e for e in events[mark:] if e.get("type") == "extension_error"]
    if errors:
        ok = False
        print("EXTENSION ERRORS:", errors)
    if "compaction_start" not in ks or not comp_end or "result" not in comp_end:
        ok = False
        print("FAIL: no successful compaction; compaction_end =", comp_end)
    else:
        print("compaction summary chars:", len(comp_end["result"].get("summary", "")))
    if not assistant_text(mark).strip():
        ok = False
        print("FAIL: prompt was not answered after compaction")

    log = [json.loads(l) for l in (tmp / "decisions.jsonl").read_text().splitlines()]
    print("decisions:", [(r["turn"], r["decision"], r["intent"], r["source"]) for r in log])
    if len(log) != 3 or log[-1]["decision"] != "switch":
        ok = False
        print("FAIL: expected exactly 3 decisions ending in a switch")
finally:
    try:
        proc.stdin.close()
        proc.wait(timeout=15)
    except Exception:
        proc.kill()
    err = proc.stderr.read()
    if err.strip():
        print("stderr:", err[-1500:])

print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
