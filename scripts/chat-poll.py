#!/usr/bin/env python3
"""Chat poll helper — called by cron, no interactive prompts needed."""
import json, os, sys, urllib.request

STATE_DIR = os.environ.get("AGENT_OFFICE_HOME") or os.path.expanduser("~/.agent-office")
SERVER = "http://127.0.0.1:" + os.environ.get("AGENT_OFFICE_PORT", "3334")
state_path = os.path.join(STATE_DIR, "chat-poll-state")

try:
    with open(state_path) as f:
        state = json.load(f)
except:
    state = {"last_seen_timestamp": 0, "consecutive_idle_count": 0, "paused": False}

if state.get("paused"):
    sys.exit(0)

try:
    resp = urllib.request.urlopen(SERVER + "/chat", timeout=5)
    msgs = json.loads(resp.read().decode())["messages"]
except:
    sys.exit(0)

last_ts = state.get("last_seen_timestamp", 0)
# Only messages a person typed: role 'default', not system, not directed at an
# agent, not a slash command (replies and announcements carry an agent role)
new_msgs = [m for m in msgs if m["timestamp"] > last_ts
            and m.get("role", "default") == "default" and not m.get("is_system")
            and not m.get("recipient") and not m.get("text", "").lstrip().startswith("/")]

if new_msgs:
    for m in new_msgs:
        print(f"NEW: {m['sender']}: {m['text']}")
    state["last_seen_timestamp"] = max(m["timestamp"] for m in new_msgs)
    state["consecutive_idle_count"] = 0
else:
    state["consecutive_idle_count"] = state.get("consecutive_idle_count", 0) + 1
    idle = state["consecutive_idle_count"]
    if idle > 10:
        with open(state_path, "w") as f:
            json.dump(state, f)
        sys.exit(0)
    print(f"No new messages. (idle count: {idle})")

with open(state_path, "w") as f:
    json.dump(state, f)
