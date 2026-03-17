#!/usr/bin/env python3
"""Post a reply to office chat. Usage: python3 chat-reply.py 'message text'"""
import json, os, sys, urllib.request

if len(sys.argv) < 2:
    print("Usage: python3 chat-reply.py 'message'")
    sys.exit(1)

text = sys.argv[1]
data = json.dumps({"sender": "Claude", "text": text}).encode()
req = urllib.request.Request(
    "http://127.0.0.1:3334/chat",
    data=data,
    headers={"Content-Type": "application/json"},
    method="POST",
)
resp = urllib.request.urlopen(req)
result = json.loads(resp.read().decode())

# Update state timestamp so we don't reply to our own message
state_path = os.path.expanduser("~/.agent-office/chat-poll-state")
try:
    with open(state_path) as f:
        state = json.load(f)
    # Bump timestamp past any current messages
    state["last_seen_timestamp"] = max(state.get("last_seen_timestamp", 0), int(os.popen("date +%s%3N").read().strip()))
    state["consecutive_idle_count"] = 0
    with open(state_path, "w") as f:
        json.dump(state, f)
except:
    pass

print(f"Sent: {text}")
