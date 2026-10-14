#!/usr/bin/env bash
# Gathers current dev context for chat AI prompt enrichment
#
# Git context comes from the first of these that is a git checkout:
#   $AGENT_OFFICE_PROJECT (if set), the current directory, then this repo.
# Every line is optional — missing git, a non-repo cwd or a stopped office
# server just leave it out.
PORT="${AGENT_OFFICE_PORT:-3334}"
SERVER="http://127.0.0.1:$PORT"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

echo "Current context:"

# Git branch
for dir in "${AGENT_OFFICE_PROJECT:-}" "$PWD" "$REPO_DIR"; do
    [ -n "$dir" ] && [ -d "$dir" ] || continue
    BRANCH=$(git -C "$dir" branch --show-current 2>/dev/null)
    if [ -n "$BRANCH" ]; then
        LAST_COMMIT=$(git -C "$dir" log --oneline -1 2>/dev/null)
        echo "- Branch: $BRANCH"
        echo "- Last commit: $LAST_COMMIT"
        RECENT=$(git -C "$dir" diff --name-only HEAD~1 2>/dev/null | head -3 | sed 's/^/- Changed: /')
        [ -n "$RECENT" ] && echo "$RECENT"
        break
    fi
done

# Active agents
AGENTS=$(curl -sf "$SERVER/roster" 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
agents=d.get('activeAgents',[])
if agents:
    for a in agents[:5]:
        print(f\"- Agent: {a.get('name','?')} ({a.get('role','?')}) — {a.get('task','')[:40]}\")
else:
    print('- No active agents')
" 2>/dev/null)
[ -n "$AGENTS" ] && echo "$AGENTS"
exit 0
