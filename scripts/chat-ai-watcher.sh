#!/usr/bin/env bash
# =============================================================================
# chat-ai-watcher.sh — Watches office chat and replies as Claude
# Started by start-office.sh, stopped by stop-office.sh
# =============================================================================

set -u

SERVER="http://127.0.0.1:3334"
POLL_INTERVAL=8
PID_FILE="$HOME/.agent-office/chat-watcher.pid"
STATE_DIR="$HOME/.agent-office"
LAST_TS_FILE="$STATE_DIR/chat-ai-last-ts"

LOCK_FILE="$STATE_DIR/chat-ai.lock"

mkdir -p "$STATE_DIR"
echo $$ > "$PID_FILE"

# Initialise last-seen timestamp to now
if [ -f "$LAST_TS_FILE" ]; then
    LAST_TS=$(cat "$LAST_TS_FILE")
else
    LAST_TS=$(date +%s)000
    echo "$LAST_TS" > "$LAST_TS_FILE"
fi

echo "[chat-ai] Started (pid $$), polling every ${POLL_INTERVAL}s"

cleanup() { rm -f "$PID_FILE" "$LOCK_FILE"; echo "[chat-ai] Stopped"; exit 0; }
trap cleanup EXIT INT TERM

while true; do
    sleep "$POLL_INTERVAL"

    # Check server
    curl -sf "$SERVER/health" > /dev/null 2>&1 || continue

    # Check AI toggle
    IS_PAUSED=$(curl -sf "$SERVER/chat/cron-state" 2>/dev/null | python3 -c "import sys,json; print('true' if json.load(sys.stdin).get('paused') else 'false')" 2>/dev/null || echo "true")
    [ "$IS_PAUSED" = "true" ] && continue

    # Fetch messages since last seen
    RESPONSE=$(curl -sf "$SERVER/chat?since=$LAST_TS" 2>/dev/null || echo '{"messages":[]}')

    # Check for new user messages (not from Claude or system)
    RESULT=$(echo "$RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
msgs = data.get('messages', [])
user_msgs = [m for m in msgs if m.get('sender','').lower() not in ('claude', 'system')]
if user_msgs:
    last = user_msgs[-1]
    print(last.get('text', ''))
else:
    print('')
# Always update to latest timestamp
if msgs:
    print(msgs[-1]['timestamp'], file=sys.stderr)
" 2>"$STATE_DIR/chat-ai-ts-tmp")

    # Update timestamp
    NEW_TS=$(cat "$STATE_DIR/chat-ai-ts-tmp" 2>/dev/null | head -1)
    rm -f "$STATE_DIR/chat-ai-ts-tmp"
    if [ -n "$NEW_TS" ]; then
        LAST_TS="$NEW_TS"
        echo "$LAST_TS" > "$LAST_TS_FILE"
    fi

    # Skip if no new user message
    [ -z "$RESULT" ] && continue

    # Skip if already generating a reply (prevent concurrent claude -p)
    if [ -f "$LOCK_FILE" ]; then
        echo "[chat-ai] Skipping — already generating a reply"
        continue
    fi

    echo "[chat-ai] New message: $RESULT"
    touch "$LOCK_FILE"

    # Detect which agent should respond based on keywords
    AGENT_INFO=$(echo "$RESULT" | python3 -c "
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
")
    AGENT_ROLE=$(echo "$AGENT_INFO" | cut -d'|' -f1)
    AGENT_NAME=$(echo "$AGENT_INFO" | cut -d'|' -f2)

    echo "[chat-ai] Routed to: $AGENT_NAME ($AGENT_ROLE)"
    echo "[chat-ai] Generating reply..."

    # Gather dev context
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    DEV_CONTEXT=$(bash "$SCRIPT_DIR/gather-context.sh" 2>/dev/null || echo "")

    # Load persona file
    PERSONA=""
    if [ -f "$HOME/.agent-office/claude-persona.md" ]; then
        PERSONA=$(cat "$HOME/.agent-office/claude-persona.md")
    fi

    # Fetch last 10 messages for context
    CONTEXT=$(curl -sf "$SERVER/chat" 2>/dev/null | python3 -c "
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

    # Build prompt from persona + dev context + conversation context + message
    PROMPT="$PERSONA

You are responding as $AGENT_NAME, the office $AGENT_ROLE. Stay in character.

$DEV_CONTEXT

Recent conversation:
$CONTEXT

Reply to the latest message naturally. Keep it short (8-12 words). Continue the conversation — reference previous messages if relevant."

    # Call Claude CLI
    REPLY=$(claude -p "$PROMPT" --max-turns 1 2>/dev/null | tr '\n' ' ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

    [ -z "$REPLY" ] && { echo "[chat-ai] Empty reply, skipping"; continue; }

    # Truncate to 15 words max
    REPLY=$(echo "$REPLY" | python3 -c "import sys; w=sys.stdin.read().strip().split(); print(' '.join(w[:15]))")

    echo "[chat-ai] Replying as $AGENT_NAME: $REPLY"

    # Post reply with agent role and name
    CHAT_REPLY="$REPLY" CHAT_ROLE="$AGENT_ROLE" CHAT_SENDER="$AGENT_NAME" python3 -c "
import urllib.request, json, os
data = json.dumps({
    'sender': os.environ.get('CHAT_SENDER', 'Claude'),
    'role': os.environ.get('CHAT_ROLE', 'assistant'),
    'text': os.environ.get('CHAT_REPLY', '')
}).encode()
req = urllib.request.Request('http://127.0.0.1:3334/chat/reply', data=data,
    headers={'Content-Type': 'application/json'}, method='POST')
try: urllib.request.urlopen(req, timeout=5)
except: pass
" 2>/dev/null

    rm -f "$LOCK_FILE"
    echo "[chat-ai] Done"
done
