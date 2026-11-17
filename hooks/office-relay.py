# office-relay.py - forwards another AI tool's hook payload to the Agent Office.
#
# Usage, from a tool's hook config (written by `agent-office install-hooks --tool <id>`):
#   python3 -I /path/to/office-relay.py <tool> [<event>]
# with the tool's hook payload on stdin. <tool> is one of codex, gemini,
# opencode, antigravity, kimi; <event> is the hook event name, passed for
# tools whose payload leaves it out (Antigravity).
#
# What it does: reads stdin, and POSTs it unchanged to
#   http://127.0.0.1:<AGENT_OFFICE_PORT|3334>/hook/<tool>[?event=<event>]
# signed with the office token exactly like hooks/agent-tracker.sh signs
# /event (X-Office-Timestamp / X-Office-Signature = HMAC-SHA256(token,
# "POST\n<path>\n<ts>\n<body>")). The server translates the payload
# (server/tools/<tool>.js), so a wrong field name is fixed by an office
# update, never by reinstalling this hook.
#
# Never in the tool's way: it always exits 0, gives up after TIMEOUT_S, and
# prints only what a tool requires on stdout (REPLIES). Loopback only: the
# host is fixed and AGENT_OFFICE_EVENT_URL is ignored, so prompts and code
# never leave the machine. Nothing is sent inside the office's own runs
# (AGENT_OFFICE_RUN=1) or without a token. Standard library only.
#
# AGENT_OFFICE_CAPTURE_DIR=<dir> (testing only) also saves each raw payload as
# <dir>/<tool>-<event>-<ms>.json, for recording real payloads as test fixtures
# (tests/fixtures/tools/). Never set by the installer.
import json, os, sys, time, hashlib

TOOLS = ('codex', 'gemini', 'opencode', 'antigravity', 'kimi')
# Why 1.5 s: a local server answers in milliseconds; this only bounds a hung
# one, and some tools wait for the hook before running the tool call
TIMEOUT_S = 1.5
# What a tool needs on stdout, by (tool, event); '*' is every event.
# Why '{}' and never a decision: Gemini parses stdout as JSON (anything else
# becomes a message to the user), and Antigravity's PreToolUse / PostToolUse /
# Stop expect a JSON reply; "allow" would approve tools on the person's behalf.
# Kimi appends stdout to the model's context, so it gets nothing; Codex too.
REPLIES = {
    ('gemini', '*'): '{}',
    ('antigravity', 'PreToolUse'): '{}',
    ('antigravity', 'PostToolUse'): '{}',
    ('antigravity', 'Stop'): '{}',
}


def _hmac_sha256_hex(key, msg):
    # HMAC-SHA256 per RFC 2104 on hashlib (as agent-tracker.py does: importing
    # hmac costs ~5 ms on every hook run)
    if len(key) > 64:
        key = hashlib.sha256(key).digest()
    key = key.ljust(64, b'\0')
    inner = hashlib.sha256(bytes(b ^ 0x36 for b in key) + msg).digest()
    return hashlib.sha256(bytes(b ^ 0x5c for b in key) + inner).hexdigest()


def _token():
    home = os.environ.get('AGENT_OFFICE_HOME') or os.path.join(os.path.expanduser('~'), '.agent-office')
    try:
        with open(os.path.join(home, 'auth-token'), encoding='utf-8') as f:
            return f.read().strip()
    except OSError:
        return ''


def _port():
    raw = os.environ.get('AGENT_OFFICE_PORT', '')
    return int(raw) if raw.isdigit() and 0 < int(raw) < 65536 else 3334


def _safe_event(name):
    # An event name goes into the URL: letters only (PreToolUse, session.idle ...)
    return name if name and len(name) <= 60 and all(c.isalnum() or c in '._' for c in name) else ''


def main(argv):
    if len(argv) < 2 or argv[1] not in TOOLS:
        return
    tool = argv[1]
    event = _safe_event(argv[2]) if len(argv) > 2 else ''
    body = sys.stdin.buffer.read()
    try:
        payload = json.loads(body or b'null')
    except ValueError:
        return
    if not isinstance(payload, dict):
        return
    name = event or str(payload.get('hook_event_name') or '')
    capture = os.environ.get('AGENT_OFFICE_CAPTURE_DIR')
    if capture and os.path.isdir(capture):
        label = _safe_event(name) or 'event'
        try:
            with open(os.path.join(capture, '%s-%s-%d.json' % (tool, label, int(time.time() * 1000))), 'wb') as f:
                f.write(body)
        except OSError:
            pass  # a capture problem never stops the forward
    reply = REPLIES.get((tool, name)) or REPLIES.get((tool, '*'))
    if reply:
        # Before the network: the tool gets its answer even if the office hangs
        sys.stdout.write(reply)
        sys.stdout.flush()
    if os.environ.get('AGENT_OFFICE_RUN') == '1':
        return
    token = _token()
    if not token:
        return
    path = '/hook/' + tool + ('?event=' + event if event else '')
    ts = str(int(time.time() * 1000))
    sig = _hmac_sha256_hex(token.encode(), ('POST\n' + path + '\n' + ts + '\n').encode() + body)
    import http.client  # only once there is something to send
    conn = http.client.HTTPConnection('127.0.0.1', _port(), timeout=TIMEOUT_S)
    try:
        conn.request('POST', path, body=body, headers={
            'Content-Type': 'application/json',
            'X-Office-Timestamp': ts,
            'X-Office-Signature': sig,
        })
        conn.getresponse().read()
    finally:
        conn.close()


if __name__ == '__main__':
    try:
        main(sys.argv)
    except Exception:
        pass
    sys.exit(0)
