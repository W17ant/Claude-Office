#!/usr/bin/env python3
"""Post a reply to office chat. Usage: python3 chat-reply.py 'message text'"""
import json, os, sys, time, urllib.request

STATE_DIR = os.environ.get("AGENT_OFFICE_HOME") or os.path.expanduser("~/.agent-office")
SERVER = "http://127.0.0.1:" + os.environ.get("AGENT_OFFICE_PORT", "3334")

if len(sys.argv) < 2:
    print("Usage: python3 chat-reply.py 'message'")
    sys.exit(1)

text = sys.argv[1]
# /chat/reply with an agent role: /chat is for messages a person typed, and
# the chat watchers answer those
data = json.dumps({"sender": "Claude", "role": "assistant", "text": text}).encode()
req = urllib.request.Request(
    SERVER + "/chat/reply",
    data=data,
    headers={"Content-Type": "application/json"},
    method="POST",
)
resp = urllib.request.urlopen(req)
result = json.loads(resp.read().decode())

# Update state timestamp so we don't reply to our own message
state_path = os.path.join(STATE_DIR, "chat-poll-state")
try:
    with open(state_path) as f:
        state = json.load(f)
    # Bump timestamp past any current messages
    state["last_seen_timestamp"] = max(state.get("last_seen_timestamp", 0), int(time.time() * 1000))
    state["consecutive_idle_count"] = 0
    with open(state_path, "w") as f:
        json.dump(state, f)
except:
    pass

print(f"Sent: {text}")
