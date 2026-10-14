#!/usr/bin/env bash
# =============================================================================
# chat-ai-watcher.sh — Watches office chat and replies as Claude
# Started by start-office.sh, stopped by stop-office.sh
#
# Only messages a person typed into the office chat are answered. The server
# stores those with role 'default', is_system 0 and no recipient; the
# watcher's own replies and the server's "starting: / done:" announcements
# carry an agent role, and agent-to-agent messages carry a recipient, so none
# of them can trigger another `claude -p` call.
#
# Environment (all optional):
#   AGENT_OFFICE_HOME            state dir            (default ~/.agent-office)
#   AGENT_OFFICE_PORT            office server port   (default 3334)
#   CHAT_AI_POLL_INTERVAL        seconds between polls (default 8)
#   CHAT_AI_MODEL                model for `claude -p` (default claude-haiku-5-5)
#   CHAT_AI_TIMEOUT              seconds before a `claude -p` call is killed (default 60)
#   CHAT_AI_MAX_REPLIES_PER_MIN  backstop against reply loops (default 5)
# =============================================================================

set -u

PORT="${AGENT_OFFICE_PORT:-3334}"
SERVER="http://127.0.0.1:$PORT"
POLL_INTERVAL="${CHAT_AI_POLL_INTERVAL:-8}"
MODEL="${CHAT_AI_MODEL:-claude-haiku-5-5}"
CLAUDE_TIMEOUT="${CHAT_AI_TIMEOUT:-60}"
MAX_REPLIES_PER_MIN="${CHAT_AI_MAX_REPLIES_PER_MIN:-5}"

STATE_DIR="${AGENT_OFFICE_HOME:-$HOME/.agent-office}"
PID_FILE="$STATE_DIR/chat-watcher.pid"
LAST_TS_FILE="$STATE_DIR/chat-ai-last-ts"
LOCK_FILE="$STATE_DIR/chat-ai.lock"
ERR_FILE="$STATE_DIR/chat-ai-claude.err"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Flags for every `claude -p` call:
#   --safe-mode           no hooks, CLAUDE.md, MCP servers, skills or plugins —
#                         the office's own agent-tracker hook must not fire for
#                         each reply, and no project MCP server should start.
#                         (--bare also skips hooks but only accepts an API key,
#                         not the OAuth login most people use.)
#   --strict-mcp-config   belt and braces: ignore every MCP config not given
#                         on the command line (and none is).
#   --tools ""            nothing to call, so --max-turns 1 always ends in text.
#   --no-session-persistence  do not litter ~/.claude with one-shot sessions.
CLAUDE_ARGS=(--max-turns 1 --model "$MODEL" --safe-mode --strict-mcp-config --tools "" --no-session-persistence)

mkdir -p "$STATE_DIR"
echo $$ > "$PID_FILE"
# A lock left behind by a crashed or SIGKILLed watcher must not block this one
rm -f "$LOCK_FILE"

# Initialise last-seen timestamp to now
if [ -f "$LAST_TS_FILE" ]; then
    LAST_TS=$(cat "$LAST_TS_FILE")
else
    LAST_TS=$(date +%s)000
    echo "$LAST_TS" > "$LAST_TS_FILE"
fi

echo "[chat-ai] Started (pid $$), polling $SERVER every ${POLL_INTERVAL}s, model $MODEL"
command -v claude >/dev/null 2>&1 || echo "[chat-ai] Warning: 'claude' CLI not on PATH — messages will be seen but not answered"

cleanup() { trap - EXIT INT TERM; rm -f "$PID_FILE" "$LOCK_FILE"; echo "[chat-ai] Stopped"; exit 0; }
trap cleanup EXIT INT TERM

# --- helpers -----------------------------------------------------------------

# run_with_timeout SECS CMD... — GNU timeout where present, perl's alarm on
# macOS (no coreutils), plain execution as a last resort.
run_with_timeout() {
    local secs="$1"; shift
    if command -v timeout >/dev/null 2>&1; then
        timeout "$secs" "$@"
    elif command -v perl >/dev/null 2>&1; then
        perl -e 'alarm shift; exec @ARGV' "$secs" "$@"
    else
        "$@"
    fi
}

# Reply-rate backstop: epoch seconds of the `claude -p` calls made in the last
# minute, so a misclassified message can never burn tokens indefinitely.
CALL_TIMES=""
rate_cap_hit() {
    local now t keep="" n=0
    now=$(date +%s)
    for t in $CALL_TIMES; do
        if [ $((now - t)) -lt 60 ]; then keep="$keep $t"; n=$((n + 1)); fi
    done
    CALL_TIMES="$keep"
    [ "$n" -ge "$MAX_REPLIES_PER_MIN" ]
}
record_claude_call() { CALL_TIMES="$CALL_TIMES $(date +%s)"; }

# Keyword routing: which office persona answers.
route_message() {
    printf '%s' "$1" | python3 -c "
import sys
msg = sys.stdin.read().lower()
routes = [
    (['bug','error','crash','fix','broken','debug','exception','traceback','stack trace','segfault'], 'debugger', 'Debugger'),
    (['review','pr','merge','approve','lgtm','pull request','code review','diff'], 'code-reviewer', 'Reviewer'),
    (['css','ui','ux','component','design','frontend','style','layout','responsive','tailwind','animation','pixel','theme','dark mode','light mode','color','font','spacing','padding','margin'], 'frontend-developer', 'Frontend'),
    (['test','coverage','spec','jest','pytest','unit test','e2e','playwright','cypress','assertion','mock'], 'test-engineer', 'Tester'),
    (['security','auth','vuln','xss','injection','csrf','cors','token','jwt','oauth','password','encrypt','ssl','tls','certificate'], 'security-auditor', 'Security'),
    (['deploy','ci','pipeline','docker','devops','kubernetes','k8s','terraform','aws','gcp','azure','vercel','netlify','heroku','nginx','cdn','dns','domain','ssl cert'], 'devops-engineer', 'DevOps'),
    (['perf','slow','optimize','speed','latency','bundle','lighthouse','core web vitals','memory leak','cache','lazy load','render','fps','bottleneck'], 'performance-engineer', 'PerfEng'),
    (['db','query','schema','migration','sql','postgres','mysql','mongo','redis','index','join','table','row','column','orm','prisma','drizzle','supabase','neon'], 'database-architect', 'DBA'),
    (['typescript','type','interface','generic','enum','union','infer','zod','validation','schema'], 'typescript-pro', 'TS Pro'),
    (['ai','llm','prompt','model','openai','anthropic','embedding','vector','rag','agent','token','context window'], 'ai-engineer', 'AI Eng'),
    (['api','endpoint','rest','graphql','webhook','route','middleware','request','response','http','fetch','axios','cors'], 'fullstack-developer', 'Fullstack'),
    (['git','branch','commit','rebase','cherry-pick','stash','conflict','remote','origin'], 'code-reviewer', 'Reviewer'),
    (['refactor','clean','abstract','pattern','solid','dry','yagni','architecture','module','package','monorepo'], 'architect-reviewer', 'Architect'),
]
for keywords, role, name in routes:
    if any(w in msg for w in keywords):
        print(f'{role}|{name}')
        sys.exit(0)
print('assistant|Claude')
"
}

# Generate and post one reply. Returns non-zero when nothing was posted; the
# caller (reply_to_message) clears the lock either way.
do_reply() {
    local msg="$1"
    local agent_info agent_role agent_name dev_context persona context prompt reply reply_ts

    agent_info=$(route_message "$msg")
    agent_role=${agent_info%%|*}
    agent_name=${agent_info#*|}
    echo "[chat-ai] Routed to: $agent_name ($agent_role)"

    # Gather dev context
    dev_context=$(bash "$SCRIPT_DIR/gather-context.sh" 2>/dev/null || echo "")

    # Load persona file
    persona=""
    if [ -f "$STATE_DIR/claude-persona.md" ]; then
        persona=$(cat "$STATE_DIR/claude-persona.md")
    fi

    # Fetch last 10 messages for context
    context=$(curl -sf "$SERVER/chat" 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
msgs = data.get('messages', [])[-10:]
lines = []
for m in msgs:
    s = m.get('sender','?')
    t = m.get('text','')
    lines.append(f'{s}: {t}')
print(chr(10).join(lines))
" 2>/dev/null)

    prompt="$persona

You are responding as $agent_name, the office $agent_role. Stay in character.

$dev_context

Recent conversation:
$context

Reply to the latest message naturally. Keep it short (8-12 words). Continue the conversation — reference previous messages if relevant."

    echo "[chat-ai] Generating reply..."
    record_claude_call
    reply=$(run_with_timeout "$CLAUDE_TIMEOUT" claude -p "$prompt" "${CLAUDE_ARGS[@]}" 2>"$ERR_FILE" \
        | tr '\n' ' ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

    if [ -z "$reply" ]; then
        echo "[chat-ai] Empty reply from claude — nothing posted"
        if [ -s "$ERR_FILE" ]; then sed 's/^/[chat-ai]   claude: /' "$ERR_FILE"; fi
        rm -f "$ERR_FILE"
        return 1
    fi
    rm -f "$ERR_FILE"

    # Truncate to 15 words max
    reply=$(printf '%s' "$reply" | python3 -c "import sys; w=sys.stdin.read().strip().split(); print(' '.join(w[:15]))")

    echo "[chat-ai] Replying as $agent_name: $reply"

    # Post the reply with its agent role and name. Prints the stored row's
    # timestamp on success, "error: ..." otherwise.
    # /chat/reply speaks as an agent, so it carries the office token (the file
    # the server writes once it is up — the same one the hook reads).
    reply_ts=$(CHAT_SERVER="$SERVER" CHAT_REPLY="$reply" CHAT_ROLE="$agent_role" CHAT_SENDER="$agent_name" CHAT_TOKEN_FILE="$STATE_DIR/auth-token" python3 -c "
import urllib.request, json, os
server = os.environ['CHAT_SERVER']
data = json.dumps({
    'sender': os.environ.get('CHAT_SENDER', 'Claude'),
    'role': os.environ.get('CHAT_ROLE', 'assistant'),
    'text': os.environ.get('CHAT_REPLY', ''),
}).encode()
headers = {'Content-Type': 'application/json'}
try:
    with open(os.environ['CHAT_TOKEN_FILE']) as f:
        headers['Authorization'] = 'Bearer ' + f.read().strip()
except OSError:
    pass
req = urllib.request.Request(server + '/chat/reply', data=data, headers=headers, method='POST')
try:
    with urllib.request.urlopen(req, timeout=5) as resp:
        posted_id = json.load(resp).get('id')
    with urllib.request.urlopen(server + '/chat', timeout=5) as resp:
        rows = [m for m in json.load(resp).get('messages', []) if m.get('id') == posted_id]
    print(rows[0].get('timestamp', 0) if rows else 0)
except Exception as e:
    print('error: ' + str(e))
" 2>/dev/null)
    case "$reply_ts" in
        error:*) echo "[chat-ai] Failed to post reply — $reply_ts"; return 1 ;;
        ''|*[!0-9]*) ;;
        *)
            # Advance past our own reply so the next poll never re-reads it
            if [ "$reply_ts" -gt "$LAST_TS" ]; then
                LAST_TS="$reply_ts"
                echo "$LAST_TS" > "$LAST_TS_FILE"
            fi
            ;;
    esac

    echo "[chat-ai] Done"
    return 0
}

# Hold the lock only while a reply is being generated; it is dropped on every
# exit path (and by the EXIT trap), so an empty or failed reply can never wedge
# the watcher.
reply_to_message() {
    touch "$LOCK_FILE"
    do_reply "$1"
    local rc=$?
    rm -f "$LOCK_FILE"
    return $rc
}

# --- poll loop ---------------------------------------------------------------

while true; do
    sleep "$POLL_INTERVAL"

    # Check server
    curl -sf "$SERVER/health" > /dev/null 2>&1 || continue

    # Check AI toggle
    IS_PAUSED=$(curl -sf "$SERVER/chat/cron-state" 2>/dev/null | python3 -c "import sys,json; print('true' if json.load(sys.stdin).get('paused') else 'false')" 2>/dev/null || echo "true")
    [ "$IS_PAUSED" = "true" ] && continue

    # Fetch messages since last seen
    RESPONSE=$(curl -sf "$SERVER/chat?since=$LAST_TS" 2>/dev/null || echo '{"messages":[]}')

    # Line 1: newest timestamp seen (0 if none). Line 2: the latest message a
    # person typed (empty if none) — newlines flattened so it stays one line.
    PARSED=$(printf '%s' "$RESPONSE" | python3 -c '
import sys, json
try:
    msgs = json.load(sys.stdin).get("messages", [])
except Exception:
    msgs = []
def typed_by_a_person(m):
    text = m.get("text")
    return (m.get("role", "default") == "default"
            and not m.get("is_system")
            and not m.get("recipient")
            and isinstance(text, str)
            and text.strip() != ""
            and not text.lstrip().startswith("/"))
human = [m for m in msgs if typed_by_a_person(m)]
print(max((int(m.get("timestamp") or 0) for m in msgs), default=0))
print(human[-1]["text"].replace("\n", " ").replace("\r", " ") if human else "")
' 2>/dev/null)
    NEW_TS=$(printf '%s\n' "$PARSED" | sed -n 1p)
    RESULT=$(printf '%s\n' "$PARSED" | sed -n 2p)

    # Advance past everything seen this poll — replies and announcements too
    case "$NEW_TS" in
        ''|*[!0-9]*) ;;
        *) if [ "$NEW_TS" -gt "$LAST_TS" ]; then
               LAST_TS="$NEW_TS"
               echo "$LAST_TS" > "$LAST_TS_FILE"
           fi ;;
    esac

    # Skip if no new message from a person
    [ -z "$RESULT" ] && continue

    # Skip if already generating a reply (prevent concurrent claude -p)
    if [ -f "$LOCK_FILE" ]; then
        echo "[chat-ai] Skipping — already generating a reply"
        continue
    fi

    if rate_cap_hit; then
        echo "[chat-ai] Reply cap reached ($MAX_REPLIES_PER_MIN per minute) — not answering: $RESULT"
        continue
    fi

    if ! command -v claude >/dev/null 2>&1; then
        echo "[chat-ai] 'claude' CLI not on PATH — not answering: $RESULT"
        continue
    fi

    echo "[chat-ai] New message: $RESULT"
    reply_to_message "$RESULT" || true
done
