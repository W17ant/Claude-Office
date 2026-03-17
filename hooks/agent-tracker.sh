#!/usr/bin/env bash
# =============================================================================
# agent-tracker.sh — Claude Code Hook → Agent Office bridge
#
# Claude Code passes hook event JSON on stdin.
# This script inspects the event and forwards relevant activity to the
# Agent Office server at http://localhost:3334/event.
#
# Hook events handled:
#   PreToolUse  — detect Agent tool calls, MCP tool calls
#   PostToolUse — detect Agent/MCP completion
#
# Usage (configured in ~/.claude/settings.json hooks section):
#   { "type": "command", "command": "/path/to/agent-tracker.sh" }
# =============================================================================

SERVER_URL="http://localhost:3334/event"

# Read the hook payload from stdin
PAYLOAD=$(cat)


# Auth token (optional — read from file if present)
AUTH_HEADER=""
TOKEN_FILE="$HOME/.agent-office/auth-token"
if [ -f "$TOKEN_FILE" ]; then
    TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null)
    if [ -n "$TOKEN" ]; then
        AUTH_HEADER="Authorization: Bearer $TOKEN"
    fi
fi

# Extract common fields and build event JSON in a single Python invocation.
# All variable data is passed via stdin; no shell variables are interpolated
# into Python source code.
EVENT_JSON=$(HOOK_PAYLOAD="$PAYLOAD" python3 - <<'PYEOF'
import json, sys, os, re

try:
    d = json.loads(os.environ.get('HOOK_PAYLOAD', '{}'))
except Exception:
    sys.exit(0)

hook_event = d.get('hook_event_name', '')
tool_name  = d.get('tool_name', '')

if not tool_name:
    sys.exit(0)

# ── MCP tool calls  (tool names match pattern: mcp__<server>__<tool>) ──────
if tool_name.startswith('mcp__'):
    stripped   = tool_name[len('mcp__'):]
    # Split on first '__' to get server and tool
    parts      = stripped.split('__', 1)
    mcp_server = parts[0] if len(parts) > 0 else ''
    mcp_tool   = parts[1] if len(parts) > 1 else ''

    if hook_event == 'PreToolUse':
        print(json.dumps({
            'type':   'mcp_call',
            'server': mcp_server,
            'tool':   mcp_tool,
        }))
    elif hook_event == 'PostToolUse':
        print(json.dumps({
            'type':   'mcp_done',
            'server': mcp_server,
        }))
    sys.exit(0)

# ── Agent tool calls  (tool_name == "Agent" or "Task") ─────────────────────
if tool_name in ('Agent', 'Task'):
    if hook_event == 'PreToolUse':
        inp = d.get('tool_input', {})

        # Claude Code Agent tool input has: description, prompt, subagent_type, agent_type
        description   = inp.get('description', '') or inp.get('prompt', '')
        subagent_type = inp.get('subagent_type', '') or inp.get('agent_type', '')

        # Role mapping: normalise subagent_type to office role keys
        role_map = {
            'debugger':             'debugger',
            'code-reviewer':        'code-reviewer',
            'code_reviewer':        'code-reviewer',
            'frontend-developer':   'frontend-developer',
            'frontend_developer':   'frontend-developer',
            'fullstack-developer':  'fullstack-developer',
            'fullstack_developer':  'fullstack-developer',
            'test-engineer':        'test-engineer',
            'test_engineer':        'test-engineer',
            'security-auditor':     'security-auditor',
            'security_auditor':     'security-auditor',
            'architect-reviewer':   'architect-reviewer',
            'architect_reviewer':   'architect-reviewer',
            'performance-engineer': 'performance-engineer',
            'performance_engineer': 'performance-engineer',
            'devops-engineer':      'devops-engineer',
            'devops_engineer':      'devops-engineer',
            'database-architect':   'database-architect',
            'database_architect':   'database-architect',
            'typescript-pro':       'typescript-pro',
            'typescript_pro':       'typescript-pro',
            'ai-engineer':          'ai-engineer',
            'ai_engineer':          'ai-engineer',
            'prompt-engineer':      'prompt-engineer',
            'prompt_engineer':      'prompt-engineer',
            'general-purpose':      'general-purpose',
            'general_purpose':      'general-purpose',
            'Explore':              'Explore',
        }
        role = role_map.get(subagent_type, 'general-purpose')

        # Derive a display name from the role
        name_map = {
            'debugger':             'Debugger',
            'code-reviewer':        'Reviewer',
            'frontend-developer':   'Frontend',
            'fullstack-developer':  'Fullstack',
            'test-engineer':        'Tester',
            'security-auditor':     'Security',
            'architect-reviewer':   'Architect',
            'performance-engineer': 'PerfEng',
            'devops-engineer':      'DevOps',
            'database-architect':   'DBA',
            'typescript-pro':       'TS Pro',
            'ai-engineer':          'AI Eng',
            'prompt-engineer':      'Prompts',
            'general-purpose':      'Agent',
            'Explore':              'Explorer',
        }
        name = name_map.get(role, 'Agent')

        # Truncate task description for display
        task = description[:80] if description else 'Working on task'

        # Stable ID based on tool_use_id if available
        tool_use_id = d.get('tool_use_id', '')
        agent_id = f'agent-{tool_use_id}' if tool_use_id else f'agent-{role}-{id(d)}'

        print(json.dumps({
            'type': 'agent_spawned',
            'agent': {
                'id':   agent_id,
                'name': name,
                'role': role,
                'task': task,
            }
        }))

    elif hook_event == 'PostToolUse':
        tool_use_id = d.get('tool_use_id', '')
        agent_id = f'agent-{tool_use_id}' if tool_use_id else ''

        resp = d.get('tool_response', {})
        if isinstance(resp, dict):
            result = resp.get('output', resp.get('result', 'done'))
        elif isinstance(resp, str):
            result = resp[:120]
        else:
            result = 'done'

        print(json.dumps({
            'type':    'agent_completed',
            'agentId': agent_id,
            'result':  str(result)[:120],
        }))

    sys.exit(0)

# ── Common tool uses — broadcast as working status updates ─────────────────
if hook_event == 'PreToolUse' and tool_name in ('Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Skill'):
    inp = d.get('tool_input', {})

    status_map = {
        'Read':  lambda i: f"reading {i.get('file_path', '').split('/')[-1]}",
        'Write': lambda i: f"writing {i.get('file_path', '').split('/')[-1]}",
        'Edit':  lambda i: f"editing {i.get('file_path', '').split('/')[-1]}",
        'Bash':  lambda i: f"running: {(i.get('command', '') or i.get('description', ''))[:60]}",
        'Grep':  lambda i: f"searching for '{i.get('pattern', '')[:30]}'",
        'Glob':  lambda i: f"finding files: {i.get('pattern', '')[:40]}",
        'Skill': lambda i: f"using /{i.get('skill', 'skill')}",
    }

    status_fn = status_map.get(tool_name)
    if status_fn:
        status = status_fn(inp)
        print(json.dumps({
            'type': 'agent_working',
            'status': status,
        }))

sys.exit(0)
PYEOF
)

# If Python produced no output, nothing to send
if [ -z "$EVENT_JSON" ]; then
    exit 0
fi

# Send the event, including the auth header if we have a token
if [ -n "$AUTH_HEADER" ]; then
    curl -sf -X POST "$SERVER_URL" \
        -H "Content-Type: application/json" \
        -H "$AUTH_HEADER" \
        -d "$EVENT_JSON" \
        --max-time 1 \
        > /dev/null 2>&1 &
else
    curl -sf -X POST "$SERVER_URL" \
        -H "Content-Type: application/json" \
        -d "$EVENT_JSON" \
        --max-time 1 \
        > /dev/null 2>&1 &
fi

exit 0
