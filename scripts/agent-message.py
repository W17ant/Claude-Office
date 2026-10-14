#!/usr/bin/env python3
"""Agent-to-agent messaging through the office.

Send a directed message:
    python3 agent-message.py --from Reviewer --role code-reviewer --to Debugger \\
        [--type question|review_request|task_handoff] [--reply-to <id>] 'can you look at auth.ts?'

Read messages addressed to you:
    python3 agent-message.py --inbox Debugger [--since <timestamp_ms>]

See who is in the office:
    python3 agent-message.py --who
"""
import argparse, json, sys, urllib.error, urllib.parse, urllib.request

BASE = "http://127.0.0.1:3334"


def call(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        headers={"Content-Type": "application/json"},
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
        sys.exit(f"office refused: {err}")
    except urllib.error.URLError:
        sys.exit("office server is not running on port 3334")


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
p.add_argument("--who", action="store_true", help="list agents in the office")
args = p.parse_args()

if args.who:
    for a in call("/agents")["agents"]:
        print(f"{a['name']:<12} {a['role']:<22} {a['state']:<10} {a.get('task') or ''}")
elif args.inbox:
    q = urllib.parse.urlencode({"recipient": args.inbox, "since": args.since})
    for m in call(f"/chat?{q}")["messages"]:
        kind = m.get("msg_type") or "message"
        reply = f" (re #{m['thread_id']})" if m.get("thread_id") else ""
        print(f"#{m['id']} [{kind}] {m['sender']}{reply}: {m['text']}")
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
