#!/usr/bin/env bash
# =============================================================================
# agent-tracker.sh — Claude Code Hook → Agent Office bridge
#
# Claude Code passes hook event JSON on stdin.
# This script inspects the event and forwards relevant activity to the
# Agent Office server at http://localhost:3334/event (AGENT_OFFICE_PORT or
# AGENT_OFFICE_EVENT_URL move it; see SERVER_URL below).
#
# Hook events handled:
#   PreToolUse         — detect Agent tool calls, MCP tool calls, tool activity
#   PostToolUse        — detect Agent/MCP completion; any other call's finish
#                        (main thread or worker) lowers the permission hand
#                        that very call raised
#   PostToolUseFailure — a tool call errored (a non-zero Bash exit lands here
#                        and gets NO PostToolUse); shown as a failed status
#   SubagentStart      — a subagent exists; ties the office agent to its agent_id
#   SubagentStop       — a subagent finished (the completion signal for background agents)
#   SessionStart       — a Claude Code session began (startup/resume/compact/clear/fork)
#   SessionEnd         — that session exited
#   UserPromptSubmit   — the boss's prompt (or a background worker waking Claude)
#   Stop               — Claude's turn ended: its reply + the background work still running
#   PermissionRequest  — Claude is waiting for a permission answer
#   Notification       — permission_prompt / idle_prompt / quota_* / agent_needs_input
#   StopFailure        — the turn ended on an API error
#   PreCompact /
#   PostCompact        — context compaction started / finished
#   PostToolBatch      — a batch of tool calls finished, on the main thread or
#                        inside a worker (lowers a permission hand that thread
#                        raised)
#   CwdChanged         — the session cd'd somewhere else (project tag follows)
#   PostModelSwitch    — the session runs another model now
#   TaskCreated /
#   TaskCompleted      — the session's task list changed (the TaskCreate tool,
#                        TaskUpdate to completed); the office reads the list
#                        itself from ~/.claude/tasks/<session_id>/, these only
#                        make it look at once
#
# Every event carries the session it came from: sessionId (session_id),
# project (basename of cwd), cwd and transcriptPath. Two terminals are two
# sessions, and the server keeps their agents apart with these. The events
# of the second group describe the session's own Claude (its "main" record
# on the server) rather than a worker.
#
# UserPromptSubmit is special: whatever a hook prints on stdout is injected
# into Claude's context and exit 2 blocks the prompt. This script captures
# the Python's stdout into a variable and only ever exits 0, so nothing of
# the office leaks into the conversation.
#
# PermissionRequest is the one event that may print: what a PermissionRequest
# hook writes on stdout answers the dialog. When the office is allowed to
# answer (the marker file $AGENT_OFFICE_HOME/answer-permissions exists — the
# server keeps it in step with its answerPermissions setting) the event is
# POSTed in the foreground, the server's reply names a pending permission, and
# the script long-polls GET /permission/<id> until the office clicks (the
# server's hookOutput is printed verbatim) or the server says the dialog was
# answered in the terminal, expired, or is unknown (nothing is printed). If
# the server cannot be reached at any point, exit 0 at once: the terminal
# dialog is in charge. Every other event is POSTed in the background and
# never waits.
#
# Background agents (run_in_background): the Agent tool returns straight away
# with status "async_launched", so PostToolUse only links the office agent to
# the subagent's agentId. The agent leaves on SubagentStop (or a
# SubagentHandback tool call, on Claude Code versions that have one), or on
# the PostToolUse of a TaskStop that names it (taskId on session_tool_done).
# Tool calls made inside a subagent carry that subagent's agent_id, which is
# forwarded so the server knows which office agent is doing the work.
#
# Signals: a Bash command that deploys, builds, tests or pushes is classified
# (classify_command, "Signals" in agent-tracker.py, with its pattern table)
# and its start, success or failure travels as `signals` on the event the
# call sends anyway — deploy_start / deploy_success / deploy_fail, build_*,
# test_*, push / push_done / push_failed — so the office can show a deploy
# shipping, open an incident when one fails, and cheer a push to main.
#
# The payload shapes handled below are the ones Claude Code 2.1.300 was
# observed sending (see tests/hook-script.test.ts for verbatim captures).
#
# Usage (configured in ~/.claude/settings.json hooks section):
#   { "type": "command", "command": "/path/to/agent-tracker.sh" }
# =============================================================================

# Where the office listens: AGENT_OFFICE_EVENT_URL wins, else the port from
# AGENT_OFFICE_PORT (the same knob the office scripts take), default 3334.
# The default host is 127.0.0.1, not 'localhost': 'localhost' can resolve to
# ::1 first (macOS tries IPv6 for it), which would let a squatter on [::1]
# win the name even while the real office runs on 127.0.0.1.
SERVER_URL="${AGENT_OFFICE_EVENT_URL:-http://127.0.0.1:${AGENT_OFFICE_PORT:-3334}/event}"

# Read the hook payload from stdin
PAYLOAD=$(cat)


# Auth token (optional — read from file if present). The token is NEVER put on
# curl's command line (every local user can read argv in `ps` / /proc), and
# the token file is stable across restarts, so a leak would stay valid. The
# hook instead SIGNS each request with it (sign_request below): the token stays
# in this variable and this process's memory, both of which only its owner can
# read. It travels to the signing python through the environment, never argv.
TOKEN=""
TOKEN_FILE="${AGENT_OFFICE_HOME:-$HOME/.agent-office}/auth-token"
if [ -f "$TOKEN_FILE" ]; then
    TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null)
fi

# Extract common fields and build event JSON in a single Python invocation.
# The Python is hooks/agent-tracker.py, next to this script (its header says
# why it is not inlined here); the payload goes to it on stdin, never through
# an environment variable or an argument: a PostToolUse carrying a big
# tool_response (a 300 KB file read is routine) is over the ~128 KiB
# single-argument limit and would fail the exec with E2BIG.
TRACKER_PY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-tracker.py"

# -I: ignore PYTHON* env vars and the user site, and keep the cwd (the
# project Claude is working in) off sys.path. The token and the event URL go
# in through the environment (never argv) so the Python can sign the POST in
# this one process — the common path spends no extra process on signing.
# Line 1 is the event, line 2 its POST signature ("ts<US>sig", or empty), and
# line 3 is `wait` for a PermissionRequest the office may answer.
PY_OUT=$(printf '%s' "$PAYLOAD" | OFFICE_TOKEN="$TOKEN" OFFICE_POST_URL="$SERVER_URL" python3 -I "$TRACKER_PY")
EVENT_JSON=$(printf '%s\n' "$PY_OUT" | sed -n 1p)
POST_SIG_LINE=$(printf '%s\n' "$PY_OUT" | sed -n 2p)
WAIT_FLAG=$(printf '%s\n' "$PY_OUT" | sed -n 3p)

# If Python produced no output, nothing to send
if [ -z "$EVENT_JSON" ]; then
    exit 0
fi
# Split the precomputed POST signature (empty when there is no token)
IFS=$'\x1f' read -r POST_TS POST_SIG <<EOF
$POST_SIG_LINE
EOF

# ── Request signing ─────────────────────────────────────────────────────────
# The hook authenticates by signing each request rather than sending the
# token. Given a method and the request's URL (via the environment, so the
# token never reaches argv) and the body on stdin, this prints
#   <timestamp><US><signature>
# where the signature is HMAC-SHA256(token, method\npath\ntimestamp\nbody).
# The server verifies it over the raw body and a ±60 s window. The timestamp
# and signature do ride on curl's argv, but they are useless to a reader
# beyond replaying that exact request within the window — the token itself
# never appears. No token (no file): nothing is printed and the request goes
# out unsigned (the server answers 401, which the caller ignores).
IFS= read -r -d '' PY_SIGN <<'PYSIGN' || true
import os, sys, time, hashlib
token = os.environ.get('OFFICE_TOKEN', '')
if not token:
    sys.exit(0)
def _hmac_sha256_hex(key, msg):
    # HMAC-SHA256 per RFC 2104 on hashlib, far cheaper to load than hmac:
    # importing the hmac module costs ~5 ms on every hook run
    if len(key) > 64:
        key = hashlib.sha256(key).digest()
    key = key.ljust(64, b'\0')
    inner = hashlib.sha256(bytes(b ^ 0x36 for b in key) + msg).digest()
    return hashlib.sha256(bytes(b ^ 0x5c for b in key) + inner).hexdigest()

def _url_path(url):
    # The request path and query of a URL (what urlsplit gives, without
    # importing urllib.parse): http://127.0.0.1:3334/event?x -> /event?x
    rest = url.split('://', 1)[-1].split('#', 1)[0]
    i = rest.find('/')
    return rest[i:] if i >= 0 else '/'

method = os.environ.get('OFFICE_METHOD', '')
path = _url_path(os.environ.get('OFFICE_URL', ''))
body = sys.stdin.buffer.read()
ts = str(int(time.time() * 1000))
msg = (method + '\n' + path + '\n' + ts + '\n').encode() + body
sig = _hmac_sha256_hex(token.encode(), msg)
sys.stdout.write(ts + '\x1f' + sig)
PYSIGN

# Emit the two signing headers for a request, or nothing when there is no
# token. $1 method, $2 full URL; the body is read from stdin.
sign_headers() {
    local ts_sig ts sig
    ts_sig=$(OFFICE_TOKEN="$TOKEN" OFFICE_METHOD="$1" OFFICE_URL="$2" python3 -I -c "$PY_SIGN")
    [ -n "$ts_sig" ] || return 0
    IFS=$'\x1f' read -r ts sig <<EOF
$ts_sig
EOF
    printf '%s\x1f%s' "$ts" "$sig"
}

# Reads a server reply on stdin. `created`: the /event reply -> the pending
# permission's id, the poll length and the deadline. `poll`: a GET
# /permission/<id> reply -> its status, whether the deadline has passed, and
# the hook output to print (built HERE from the decision word, never from
# server JSON) once the office has proved it holds the token. Fields are
# separated by the unit separator, which JSON never contains unescaped. The
# token, the request's nonce and the dialog's own suggestions arrive through
# the environment, never argv; the permission id is a public argument.
IFS= read -r -d '' PY_REPLY <<'PYREPLY' || true
import json, os, sys, time, hmac, hashlib
try:
    r = json.loads(sys.stdin.read() or '{}')
except Exception:
    r = {}
if not isinstance(r, dict):
    r = {}
mode = sys.argv[1] if len(sys.argv) > 1 else ''
if mode == 'created':
    wait = r.get('wait') if isinstance(r.get('wait'), dict) else {}
    pid = r.get('permissionId')
    if isinstance(pid, str) and pid:
        print('\x1f'.join([pid, str(int(wait.get('pollMs') or 20000)), str(int(wait.get('deadline') or 0))]))
elif mode == 'poll':
    status = str(r.get('status') or '')
    deadline = r.get('deadline')
    late = isinstance(deadline, (int, float)) and time.time() * 1000 > deadline + 2000
    out = ''
    if status in ('allowed', 'denied'):
        token = os.environ.get('OFFICE_TOKEN', '')
        nonce = os.environ.get('OFFICE_NONCE', '')
        pid = sys.argv[2] if len(sys.argv) > 2 else ''
        decision = str(r.get('decision') or '')
        proof = str(r.get('proof') or '')
        if token and nonce and decision in ('allow', 'allow-remember', 'deny'):
            # Constant-time check that the answer came from a holder of the
            # token. A squatter cannot produce this, so its answer prints
            # nothing and the terminal dialog stays in charge.
            expected = hmac.new(token.encode(), (nonce + pid + decision).encode(), hashlib.sha256).hexdigest()
            if hmac.compare_digest(expected, proof):
                if decision == 'allow':
                    dec = {'behavior': 'allow'}
                elif decision == 'allow-remember':
                    try:
                        suggestions = json.loads(os.environ.get('OFFICE_SUGGESTIONS', '[]'))
                    except Exception:
                        suggestions = []
                    if not isinstance(suggestions, list):
                        suggestions = []
                    # Echo only the dialog's OWN permission_suggestions, never
                    # anything the server made up, and never an updatedInput.
                    dec = {'behavior': 'allow', 'updatedPermissions': suggestions}
                else:
                    dec = {'behavior': 'deny', 'message': 'Denied from Claude Office', 'interrupt': False}
                out = json.dumps({'hookSpecificOutput': {'hookEventName': 'PermissionRequest', 'decision': dec}})
    print('\x1f'.join([status, '1' if late else '0', out]))
PYREPLY

# PermissionRequest the office may answer: POST in the foreground, then poll
# the pending permission until it is decided here (print the hook output we
# build from the decision word), answered in the terminal, expired or gone
# (print nothing). Any failure to reach the server ends the wait at once,
# silently. The nonce and the dialog's own suggestions are lifted out of the
# event so the proof can be verified and allow-remember echoed back.
answer_from_office() {
    local base="${SERVER_URL%/event}"
    local reply id poll_ms deadline wait_s status late hook_output polls=0
    local nonce suggestions ts sig
    IFS=$'\x1f' read -r nonce suggestions < <(printf '%s' "$EVENT_JSON" | python3 -I -c '
import json, sys
try:
    d = json.loads(sys.stdin.read() or "{}")
except Exception:
    d = {}
print("\x1f".join([str(d.get("nonce") or ""), json.dumps(d.get("suggestions") or [])]))')
    # The POST signature was computed in the main Python pass (POST_TS/POST_SIG)
    reply=$(printf '%s' "$EVENT_JSON" | curl -sf -X POST "$SERVER_URL" \
        -H "Content-Type: application/json" \
        -H "X-Office-Timestamp: $POST_TS" -H "X-Office-Signature: $POST_SIG" \
        --data-binary @- --max-time 2 2>/dev/null) || return 0
    IFS=$'\x1f' read -r id poll_ms deadline < <(printf '%s' "$reply" | python3 -I -c "$PY_REPLY" created)
    [ -n "$id" ] || return 0
    wait_s=$(( ${poll_ms:-20000} / 1000 ))
    [ "$wait_s" -ge 1 ] || wait_s=1
    [ "$wait_s" -le 30 ] || wait_s=30
    # Each poll is bounded by curl; the server ends the wait at the deadline it
    # set (extended when the session turns out to be interactive), and the
    # loop cap is a backstop under the hook's 600 s timeout
    while [ "$polls" -lt 40 ]; do
        polls=$((polls + 1))
        local poll_url="$base/permission/$id?wait=$wait_s"
        IFS=$'\x1f' read -r ts sig < <(printf '' | sign_headers GET "$poll_url")
        reply=$(curl -sf "$poll_url" \
            -H "X-Office-Timestamp: $ts" -H "X-Office-Signature: $sig" \
            --max-time $((wait_s + 5)) 2>/dev/null) || return 0
        IFS=$'\x1f' read -r status late hook_output < <(printf '%s' "$reply" | \
            OFFICE_TOKEN="$TOKEN" OFFICE_NONCE="$nonce" OFFICE_SUGGESTIONS="$suggestions" \
            python3 -I -c "$PY_REPLY" poll "$id")
        case "$status" in
            allowed|denied)
                [ -n "$hook_output" ] && printf '%s\n' "$hook_output"
                return 0 ;;
            pending)
                [ "$late" = "1" ] && return 0 ;;
            *)
                return 0 ;;
        esac
    done
    return 0
}

if [ "$WAIT_FLAG" = "wait" ]; then
    answer_from_office
    exit 0
fi

# Send the event, signed (the body on stdin so neither the token nor the
# event text is ever on curl's argv). The signature was computed in the main
# Python pass (POST_TS/POST_SIG). No token: it goes out unsigned and the
# server answers 401, which this backgrounded, output-discarding call ignores.
if [ -n "$POST_SIG" ]; then
    printf '%s' "$EVENT_JSON" | curl -sf -X POST "$SERVER_URL" \
        -H "Content-Type: application/json" \
        -H "X-Office-Timestamp: $POST_TS" \
        -H "X-Office-Signature: $POST_SIG" \
        --data-binary @- \
        --max-time 1 \
        > /dev/null 2>&1 &
else
    printf '%s' "$EVENT_JSON" | curl -sf -X POST "$SERVER_URL" \
        -H "Content-Type: application/json" \
        --data-binary @- \
        --max-time 1 \
        > /dev/null 2>&1 &
fi

exit 0
