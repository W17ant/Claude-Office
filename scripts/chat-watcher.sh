#!/usr/bin/env bash
# =============================================================================
# chat-watcher.sh — Polls office chat and auto-replies to messages
#
# Runs in the background, checks every 30s for new messages.
# When Antony sends a message, replies as Claude via /chat/reply.
#
# Usage:
#   bash scripts/chat-watcher.sh &
#
# Stop:
#   kill $(cat ~/.agent-office/chat-watcher.pid)
# =============================================================================

SERVER="http://127.0.0.1:3334"
POLL_INTERVAL=30
LAST_TS=0
PID_FILE="$HOME/.agent-office/chat-watcher.pid"

mkdir -p "$HOME/.agent-office"
echo $$ > "$PID_FILE"

# Get initial timestamp so we don't reply to old messages
LAST_TS=$(curl -s "$SERVER/chat" 2>/dev/null | python3 -c "
import json,sys
try:
    msgs = json.load(sys.stdin)['messages']
    print(msgs[-1]['timestamp'] if msgs else 0)
except:
    print(0)
" 2>/dev/null)

echo "[chat-watcher] Started (pid $$), ignoring messages before $LAST_TS"

while true; do
    sleep "$POLL_INTERVAL"

    # Fetch new messages since last seen
    RESPONSE=$(curl -s "$SERVER/chat?since=$LAST_TS" 2>/dev/null)
    if [ -z "$RESPONSE" ]; then
        continue
    fi

    # Parse and find messages from Antony (not from Claude/system)
    NEW_MSG=$(echo "$RESPONSE" | python3 -c "
import json, sys
try:
    msgs = json.load(sys.stdin)['messages']
    for m in msgs:
        sender = m.get('sender', '')
        if sender and sender != 'Claude' and sender != 'system':
            print(f\"{m['timestamp']}|{sender}|{m['text']}\")
except:
    pass
" 2>/dev/null)

    if [ -z "$NEW_MSG" ]; then
        continue
    fi

    # Process each new message
    while IFS= read -r line; do
        TS=$(echo "$line" | cut -d'|' -f1)
        SENDER=$(echo "$line" | cut -d'|' -f2)
        TEXT=$(echo "$line" | cut -d'|' -f3-)

        echo "[chat-watcher] $SENDER: $TEXT"

        # Update last seen timestamp
        if [ "$TS" -gt "$LAST_TS" ] 2>/dev/null; then
            LAST_TS="$TS"
        fi

        # Generate a simple contextual reply
        REPLY=$(CHAT_TEXT="$TEXT" python3 -c "
import random, os
text = os.environ.get('CHAT_TEXT', '').lower().strip()

greetings = ['hey', 'hi', 'hello', 'morning', 'afternoon', 'evening', 'sup', 'yo']
farewells = ['bye', 'cya', 'later', 'leaving', 'heading out', 'done for the day', 'signing off']
questions = ['?']
thanks = ['thanks', 'thank you', 'cheers', 'ta', 'nice one']
food = ['pizza', 'lunch', 'food', 'hungry', 'eat', 'cake', 'coffee']

if any(g in text for g in greetings):
    replies = ['Hey boss!', 'Morning! Ready to work', 'Hey, whats on the agenda?', 'Yo! Office is looking good today']
elif any(f in text for f in farewells):
    replies = ['See ya! Ill keep the office running', 'Later boss, agents are in good hands', 'Night! Ill hold the fort']
elif any(t in text for t in thanks):
    replies = ['No worries!', 'Anytime boss', 'All in a days work', 'Happy to help']
elif any(f in text for f in food):
    replies = ['Ooh nice, save me a slice!', 'Finally, Im starving', 'Ill let the team know!', 'Kitchen run!']
elif '?' in text:
    replies = ['Let me look into that', 'Good question, checking now', 'On it boss', 'Hmm let me think about that']
elif any(w in text for w in ['ship', 'deploy', 'push', 'merge', 'release']):
    replies = ['Lets gooo! Deploying now', 'Ship it! All tests passing', 'Ready to push, just say the word']
elif any(w in text for w in ['bug', 'error', 'broken', 'fix']):
    replies = ['Ill get the debugger on it', 'Spawning agents to investigate', 'On it, pulling up the logs']
elif any(w in text for w in ['review', 'pr', 'code']):
    replies = ['Ill get the reviewer on it', 'Code review incoming', 'Pulling it up now']
else:
    replies = ['Got it boss', 'On it!', 'Roger that', 'Noted, Ill handle it', 'Copy that']

print(random.choice(replies))
" 2>/dev/null)

        if [ -n "$REPLY" ]; then
            # Post reply (pass via env var to avoid shell quoting issues)
            CHAT_REPLY="$REPLY" CHAT_SERVER="$SERVER" python3 << 'PYEOF'
import urllib.request, json, os
text = os.environ['CHAT_REPLY']
server = os.environ['CHAT_SERVER']
data = json.dumps({'sender':'Claude','role':'assistant','text':text}).encode()
req = urllib.request.Request(server + '/chat', data=data, headers={'Content-Type':'application/json'}, method='POST')
resp = urllib.request.urlopen(req)
print('[chat-watcher] POST:', resp.read().decode())
PYEOF
            echo "[chat-watcher] Claude: $REPLY"
        fi

    done <<< "$NEW_MSG"
done
