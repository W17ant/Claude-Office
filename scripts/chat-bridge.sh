#!/usr/bin/env bash
# =============================================================================
# chat-bridge.sh — Polls for new chat messages and posts them as context
# for the current Claude session. Called by /loop or manually.
#
# Also provides a function to post Claude's replies back to the chat.
# =============================================================================

SERVER="http://127.0.0.1:3334"
STATE_DIR="$HOME/.agent-office"
LAST_TS_FILE="$STATE_DIR/chat-bridge-last-ts"
PENDING_FILE="$STATE_DIR/chat-pending"

mkdir -p "$STATE_DIR"

# Initialise timestamp if needed
if [ ! -f "$LAST_TS_FILE" ]; then
    echo "$(date +%s)000" > "$LAST_TS_FILE"
fi

LAST_TS=$(cat "$LAST_TS_FILE")

# Check server is alive
if ! curl -sf "$SERVER/health" > /dev/null 2>&1; then
    echo "Office server not running"
    exit 0
fi

# Check AI toggle
AI_STATE=$(curl -sf "$SERVER/chat/cron-state" 2>/dev/null || echo '{}')
IS_PAUSED=$(echo "$AI_STATE" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('paused') else 'false')" 2>/dev/null || echo "true")

if [ "$IS_PAUSED" = "true" ]; then
    echo "AI toggle is off — not checking chat"
    exit 0
fi

# Fetch new messages
RESPONSE=$(curl -sf "$SERVER/chat?since=$LAST_TS" 2>/dev/null || echo '{"messages":[]}')

# Get user messages (not from Claude or system)
NEW_MSGS=$(echo "$RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
msgs = data.get('messages', [])
user_msgs = [m for m in msgs if m.get('sender','').lower() not in ('claude', 'system')]
for m in user_msgs:
    print(f\"{m['sender']}: {m['text']}\")
# Update last seen to latest timestamp
if msgs:
    print(f\"__TS__:{msgs[-1]['timestamp']}\", file=sys.stderr)
" 2>"$STATE_DIR/chat-bridge-ts-tmp")

# Update timestamp
NEW_TS=$(grep '__TS__:' "$STATE_DIR/chat-bridge-ts-tmp" 2>/dev/null | sed 's/__TS__://')
if [ -n "$NEW_TS" ]; then
    echo "$NEW_TS" > "$LAST_TS_FILE"
fi
rm -f "$STATE_DIR/chat-bridge-ts-tmp"

if [ -n "$NEW_MSGS" ]; then
    echo "=== New office chat messages ==="
    echo "$NEW_MSGS"
    echo "================================"
    echo ""
    echo "Reply with: chat-reply \"your message here\""
else
    echo "No new chat messages"
fi
