#!/usr/bin/env python3
"""Agent-to-agent messaging through the office.

Send a directed message:
    python3 agent-message.py --from Reviewer --role code-reviewer --to Debugger \\
        [--type question|review_request|task_handoff] [--reply-to <id>] 'can you look at auth.ts?'

Read messages addressed to you (clears your unread badge unless --peek):
    python3 agent-message.py --inbox Debugger [--since <timestamp_ms>] [--peek]

See who is in the office:
    python3 agent-message.py --who
"""
import argparse, json, os, sys, urllib.error, urllib.parse, urllib.request

PORT = os.environ.get("AGENT_OFFICE_PORT", "3334")
BASE = "http://127.0.0.1:" + PORT
# The office token, written by the server once it is up — the same file the
# hook reads. Every call that speaks as an agent (/chat/reply, /chat/inbox/read)
# needs it; reads (/agents, /chat) do not.
TOKEN_FILE = os.path.join(os.environ.get("AGENT_OFFICE_HOME") or os.path.expanduser("~/.agent-office"), "auth-token")


def auth_header():
    try:
        with open(TOKEN_FILE) as f:
            token = f.read().strip()
    except OSError:
        return {}
    return {"Authorization": "Bearer " + token} if token else {}


def call(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        headers={"Content-Type": "application/json", **auth_header()},
        method="POST" if body is not None else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read().decode()).get("error", e.reason)
        except Exception:
            err = e.reason
        if e.code == 401:
            err = f"{err} — the office token at {TOKEN_FILE} is missing or stale (is the server running?)"
        sys.exit(f"office refused: {err}")
    except urllib.error.URLError:
        sys.exit(f"office server is not running on port {PORT}")


p = argparse.ArgumentParser(description="Message other agents in the office")
p.add_argument("text", nargs="?")
p.add_argument("--from", dest="sender", default="Claude")
p.add_argument("--role", default="default")
p.add_argument("--to", dest="recipient")
p.add_argument("--type", default="message",
               choices=["message", "question", "review_request", "task_handoff"])
p.add_argument("--reply-to", type=int)
p.add_argument("--inbox", metavar="NAME", help="list messages sent to NAME")
p.add_argument("--since", type=int, default=0)
p.add_argument("--peek", action="store_true", help="read the inbox without marking it read")
p.add_argument("--who", action="store_true", help="list agents in the office")
args = p.parse_args()

if args.who:
    for a in call("/agents")["agents"]:
        unread = f"✉ {a['unread']}" if a.get("unread") else ""
        print(f"{a['name']:<12} {a['role']:<22} {a['state']:<10} {unread:<5} {a.get('task') or ''}")
elif args.inbox:
    q = urllib.parse.urlencode({"recipient": args.inbox, "since": args.since})
    for m in call(f"/chat?{q}")["messages"]:
        kind = m.get("msg_type") or "message"
        reply = f" (re #{m['thread_id']})" if m.get("thread_id") else ""
        print(f"#{m['id']} [{kind}] {m['sender']}{reply}: {m['text']}")
    if not args.peek:
        call("/chat/inbox/read", {"recipient": args.inbox})
elif args.recipient and args.text:
    body = {"sender": args.sender, "role": args.role, "recipient": args.recipient,
            "type": args.type, "text": args.text}
    if args.reply_to:
        body["replyTo"] = args.reply_to
    r = call("/chat/reply", body)
    where = "delivered" if r.get("delivered") else "queued (recipient not in the office)"
    print(f"#{r.get('id')} -> {args.recipient}: {where}")
else:
    p.print_help()
    sys.exit(1)
