#!/usr/bin/env python3
"""Post a message to the office chat as Claude. Truncates to first ~10 words.

A slash command (`python3 scripts/chat-post.py /clear`, `/incident`,
`/all-clear`, `/status`) goes to POST /chat with the office token instead:
that is the route that runs commands (/chat/reply only ever posts a line),
and /clear, which wipes the chat history with every stored prompt and reply,
needs the token. Exits 1 when the server refuses the command.
"""
import urllib.error, urllib.request, json, os, sys

SERVER = "http://127.0.0.1:" + os.environ.get("AGENT_OFFICE_PORT", "3334")
# The office token (written by the server once it is up): /chat/reply speaks
# as an agent, so it needs it. Same file the hook reads.
TOKEN_FILE = os.path.join(os.environ.get("AGENT_OFFICE_HOME") or os.path.expanduser("~/.agent-office"), "auth-token")

text = ' '.join(sys.argv[1:]) if len(sys.argv) > 1 else ''
if not text:
    print("Usage: python3 chat-post.py <message>   (or a slash command: /clear, /incident, ...)")
    sys.exit(1)

command = text.startswith('/')
if not command:
    # Truncate to ~10 words
    words = text.split()
    if len(words) > 12:
        text = ' '.join(words[:10]) + '...'

headers = {'Content-Type': 'application/json'}
try:
    with open(TOKEN_FILE) as f:
        headers['Authorization'] = 'Bearer ' + f.read().strip()
except OSError:
    print(f"no office token at {TOKEN_FILE} — is the server running?", file=sys.stderr)

if command:
    route, payload = '/chat', {'sender': 'Claude', 'text': text}
else:
    route, payload = '/chat/reply', {'sender': 'Claude', 'role': 'assistant', 'text': text}
req = urllib.request.Request(
    SERVER + route,
    data=json.dumps(payload).encode(),
    headers=headers,
    method='POST'
)
try:
    urllib.request.urlopen(req, timeout=5)
    print(f"Posted: {text}")
except urllib.error.HTTPError as e:
    body = e.read().decode('utf-8', 'replace')
    try:
        reason = json.loads(body).get('error') or body
    except (ValueError, AttributeError):
        reason = body
    print(f"Failed: HTTP {e.code}: {reason}", file=sys.stderr)
    if command:
        sys.exit(1)
except Exception as e:
    print(f"Failed: {e}", file=sys.stderr)
    if command:
        sys.exit(1)
