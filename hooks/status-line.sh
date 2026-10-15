#!/usr/bin/env bash
# =============================================================================
# status-line.sh — Claude Code statusLine → Agent Office meters bridge
#
# Claude Code runs the configured `statusLine.command` on every state change
# of an interactive session (new assistant message, /compact, permission-mode
# change, ...) with a JSON object on stdin (Claude Code 2.1.300, see
# https://code.claude.com/docs/en/statusline):
#   session_id, transcript_path, cwd, version, model{id,display_name},
#   workspace{current_dir,project_dir}, cost{total_cost_usd,total_duration_ms,
#   total_api_duration_ms,total_lines_added,total_lines_removed},
#   context_window{total_input_tokens,total_output_tokens,context_window_size,
#   used_percentage,current_usage}, exceeds_200k_tokens, effort{level},
#   rate_limits{five_hour{used_percentage,resets_at},seven_day{...},spend_limit{...}}
#   (rate_limits only for Pro/Max subscribers, and only after the first API
#   response; used_percentage may be null early in the session)
#
# This script POSTs a compact summary to the office (POST /status — the
# payroll / electricity / memory wall panel) and prints the status line that
# Claude Code displays:
#   default   <model> · ctx <used>% · $<cost>
#   chained   the output of the statusLine command that was configured before
#             install-hooks.sh wrapped it (saved in
#             $AGENT_OFFICE_HOME/statusline-prev); the default line is printed
#             when that command prints nothing
#
# `--subagents` makes it the `subagentStatusLine` command. Claude Code then
# sends {...base hook fields, columns, tasks:[{id, agentType, status,
# description, label, startTime, model, effort, contextWindowSize, tokenCount,
# tokenSamples, cwd}]} once per refresh tick while subagents are visible. The
# per-worker token counts are forwarded as an agent_status and nothing is
# printed, which keeps Claude Code's default rows (or the chained previous
# command's rows, saved in $AGENT_OFFICE_HOME/subagent-statusline-prev).
#
# Bash 3.2 compatible; one python3 -I call (no cwd imports, no PYTHON* env);
# curl runs in the background with a 1 s cap, so a stopped server costs
# nothing and never blocks the status line.
# =============================================================================

# Where the office listens: AGENT_OFFICE_STATUS_URL wins, else the port from
# AGENT_OFFICE_PORT (the same knob as agent-tracker.sh and the office
# scripts), default 3334
SERVER_URL="${AGENT_OFFICE_STATUS_URL:-http://localhost:${AGENT_OFFICE_PORT:-3334}/status}"
OFFICE_HOME="${AGENT_OFFICE_HOME:-$HOME/.agent-office}"

MODE="main"
PREV_FILE="$OFFICE_HOME/statusline-prev"
if [ "${1:-}" = "--subagents" ]; then
    MODE="subagents"
    PREV_FILE="$OFFICE_HOME/subagent-statusline-prev"
fi

PAYLOAD=$(cat)
if [ -z "$PAYLOAD" ]; then
    exit 0
fi

# Auth token (written by the server on start; optional — the same lookup as
# agent-tracker.sh)
AUTH_HEADER=""
TOKEN_FILE="$OFFICE_HOME/auth-token"
if [ -f "$TOKEN_FILE" ]; then
    TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null)
    if [ -n "$TOKEN" ]; then
        AUTH_HEADER="Authorization: Bearer $TOKEN"
    fi
fi

# One Python pass. Line 1 is the event to POST (empty = nothing to send), the
# rest is the default status line. The payload travels through the
# environment, never through the Python source.
OUT=$(STATUS_PAYLOAD="$PAYLOAD" STATUS_MODE="$MODE" python3 -I - <<'PYEOF'
import json, os, sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

def num(v):
    # A finite number, or None (bool is not a number here)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    if v != v or v in (float('inf'), float('-inf')):
        return None
    return v

def text(v, limit=120):
    if isinstance(v, bool) or not isinstance(v, (str, int, float)):
        return ''
    return str(v)[:limit]

try:
    d = json.loads(os.environ.get('STATUS_PAYLOAD', '') or '{}')
    if not isinstance(d, dict):
        d = {}
except Exception:
    d = {}

mode = os.environ.get('STATUS_MODE', 'main')
session_id = text(d.get('session_id'), 200)

# ── subagentStatusLine: one agent_status for every visible subagent row ─────
if mode == 'subagents':
    agents = []
    tasks = d.get('tasks') if isinstance(d.get('tasks'), list) else []
    for t in tasks[:32]:
        if not isinstance(t, dict) or not t.get('id'):
            continue
        a = {
            'id':     text(t['id'], 200),
            'tokens': num(t.get('tokenCount')) or 0,
            'status': text(t.get('status'), 40),
        }
        size = num(t.get('contextWindowSize'))
        if size:
            a['contextSize'] = size
        for key in ('agentType', 'name', 'model', 'description'):
            if t.get(key):
                a[key] = text(t[key])
        agents.append(a)
    if session_id and agents:
        print(json.dumps({'type': 'agent_status', 'sessionId': session_id, 'agents': agents}, separators=(',', ':')))
    else:
        print('')
    print('')  # no row override: Claude Code keeps its default rendering
    sys.exit(0)

# ── statusLine: the session's cost, context window and rate limits ──────────
def obj(key):
    v = d.get(key)
    return v if isinstance(v, dict) else {}

model, cost, ctx, rl, ws, effort = (obj(k) for k in ('model', 'cost', 'context_window', 'rate_limits', 'workspace', 'effort'))

project_dir = text(ws.get('project_dir'), 400) or text(ws.get('current_dir'), 400) or text(d.get('cwd'), 400)
project = os.path.basename(project_dir.rstrip('/')) or project_dir

model_name = text(model.get('display_name')) or text(model.get('id')) or 'Claude'
total_cost = num(cost.get('total_cost_usd')) or 0
used = num(ctx.get('used_percentage'))

event = {
    'type':         'session_status',
    'sessionId':    session_id,
    'project':      project,
    'model':        model_name,
    'modelId':      text(model.get('id')),
    'cost':         total_cost,
    'durationMs':   num(cost.get('total_duration_ms')) or 0,
    'apiDurationMs': num(cost.get('total_api_duration_ms')) or 0,
    'linesAdded':   num(cost.get('total_lines_added')) or 0,
    'linesRemoved': num(cost.get('total_lines_removed')) or 0,
    'context': {
        'used':   used,
        'size':   num(ctx.get('context_window_size')),
        'input':  num(ctx.get('total_input_tokens')) or 0,
        'output': num(ctx.get('total_output_tokens')) or 0,
    },
    'effort':      text(effort.get('level'), 20) or None,
    'exceeds200k': bool(d.get('exceeds_200k_tokens')),
    'version':     text(d.get('version'), 20) or None,
}

# Each window is independently absent; used_percentage runs 0-100 (spend_limit
# can exceed 100 once over the limit), resets_at is Unix epoch seconds
limits = {}
for src, dst in (('five_hour', 'fiveHour'), ('seven_day', 'sevenDay'), ('spend_limit', 'spendLimit')):
    window = rl.get(src)
    if not isinstance(window, dict):
        continue
    pct = num(window.get('used_percentage'))
    if pct is not None:
        limits[dst] = pct
    resets = num(window.get('resets_at'))
    if resets is not None:
        limits[dst + 'ResetsAt'] = resets
if limits:
    event['rateLimits'] = limits

print(json.dumps(event, separators=(',', ':')) if session_id else '')
print('%s · ctx %s%% · $%.2f' % (model_name, ('%d' % round(used)) if used is not None else '0', total_cost))
PYEOF
)

NL='
'
EVENT_JSON="${OUT%%"$NL"*}"
DEFAULT_LINE="${OUT#*"$NL"}"
if [ "$DEFAULT_LINE" = "$OUT" ]; then
    DEFAULT_LINE=""
fi

# Send the event in the background (never waits on the server)
if [ -n "$EVENT_JSON" ]; then
    if [ -n "$AUTH_HEADER" ]; then
        curl -sf -X POST "$SERVER_URL" \
            -H "Content-Type: application/json" \
            -H "$AUTH_HEADER" \
            --data-binary "$EVENT_JSON" \
            --max-time 1 \
            > /dev/null 2>&1 &
    else
        curl -sf -X POST "$SERVER_URL" \
            -H "Content-Type: application/json" \
            --data-binary "$EVENT_JSON" \
            --max-time 1 \
            > /dev/null 2>&1 &
    fi
fi

# Chain the status line that was configured before the office wrapped it:
# same stdin, its output is what gets displayed
PREV_CMD=""
if [ "$MODE" = "main" ]; then
    PREV_CMD="${AGENT_OFFICE_PREV_STATUSLINE:-}"
fi
if [ -z "$PREV_CMD" ] && [ -f "$PREV_FILE" ]; then
    PREV_CMD=$(cat "$PREV_FILE" 2>/dev/null)
fi
if [ -n "$PREV_CMD" ]; then
    CHAINED=$(printf '%s' "$PAYLOAD" | bash -c "$PREV_CMD" 2>/dev/null)
    if [ -n "$CHAINED" ]; then
        printf '%s\n' "$CHAINED"
        exit 0
    fi
fi

if [ -n "$DEFAULT_LINE" ]; then
    printf '%s\n' "$DEFAULT_LINE"
fi
exit 0
