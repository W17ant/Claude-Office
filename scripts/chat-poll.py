#!/usr/bin/env python3
"""Chat poll helper — called by cron, no interactive prompts needed."""
import json, os, sys, urllib.request

state_path = os.path.expanduser("~/.agent-office/chat-poll-state")

try:
    with open(state_path) as f:
        state = json.load(f)
except:
    state = {"last_seen_timestamp": 0, "consecutive_idle_count": 0, "paused": False}

if state.get("paused"):
    sys.exit(0)

try:
    resp = urllib.request.urlopen("http://127.0.0.1:3334/chat", timeout=5)
    msgs = json.loads(resp.read().decode())["messages"]
except:
    sys.exit(0)

last_ts = state.get("last_seen_timestamp", 0)
new_msgs = [m for m in msgs if m["timestamp"] > last_ts and m["sender"] not in ("Claude", "system")]

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
