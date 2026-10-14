#!/usr/bin/env python3
"""Post a message to the office chat as Claude. Truncates to first ~10 words."""
import urllib.request, json, os, sys

SERVER = "http://127.0.0.1:" + os.environ.get("AGENT_OFFICE_PORT", "3334")

text = ' '.join(sys.argv[1:]) if len(sys.argv) > 1 else ''
if not text:
    print("Usage: python3 chat-post.py <message>")
    sys.exit(1)

# Truncate to ~10 words
words = text.split()
if len(words) > 12:
    text = ' '.join(words[:10]) + '...'

data = json.dumps({'sender': 'Claude', 'role': 'assistant', 'text': text}).encode()
req = urllib.request.Request(
    SERVER + '/chat/reply',
    data=data,
    headers={'Content-Type': 'application/json'},
    method='POST'
)
try:
    urllib.request.urlopen(req, timeout=5)
    print(f"Posted: {text}")
except Exception as e:
    print(f"Failed: {e}", file=sys.stderr)
