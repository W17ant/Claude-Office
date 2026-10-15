#!/usr/bin/env bash
# =============================================================================
# agent-tracker.sh — Claude Code Hook → Agent Office bridge
#
# Claude Code passes hook event JSON on stdin.
# This script inspects the event and forwards relevant activity to the
# Agent Office server at http://localhost:3334/event.
#
# Hook events handled:
#   PreToolUse         — detect Agent tool calls, MCP tool calls, tool activity
#   PostToolUse        — detect Agent/MCP completion
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
#   PostToolBatch      — a batch of main-thread tool calls finished (lowers a
#                        permission hand the batch answered)
#   CwdChanged         — the session cd'd somewhere else (project tag follows)
#   PostModelSwitch    — the session runs another model now
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
# Background agents (run_in_background): the Agent tool returns straight away
# with status "async_launched", so PostToolUse only links the office agent to
# the subagent's agentId. The agent leaves on SubagentStop (or a
# SubagentHandback tool call, on Claude Code versions that have one).
# Tool calls made inside a subagent carry that subagent's agent_id, which is
# forwarded so the server knows which office agent is doing the work.
#
# The payload shapes handled below are the ones Claude Code 2.1.300 was
# observed sending (see tests/hook-script.test.ts for verbatim captures).
#
# Usage (configured in ~/.claude/settings.json hooks section):
#   { "type": "command", "command": "/path/to/agent-tracker.sh" }
# =============================================================================

# Where the office listens: AGENT_OFFICE_EVENT_URL wins, else the port from
# AGENT_OFFICE_PORT (the same knob the office scripts take), default 3334
SERVER_URL="${AGENT_OFFICE_EVENT_URL:-http://localhost:${AGENT_OFFICE_PORT:-3334}/event}"

# Read the hook payload from stdin
PAYLOAD=$(cat)


# Auth token (optional — read from file if present)
AUTH_HEADER=""
TOKEN_FILE="${AGENT_OFFICE_HOME:-$HOME/.agent-office}/auth-token"
if [ -f "$TOKEN_FILE" ]; then
    TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null)
    if [ -n "$TOKEN" ]; then
        AUTH_HEADER="Authorization: Bearer $TOKEN"
    fi
fi

# Extract common fields and build event JSON in a single Python invocation.
# The Python source is the quoted heredoc below (tests/hook-script.test.ts
# lifts it out by the PYEOF markers); the payload goes to it on stdin, never
# through an environment variable or an argument: a PostToolUse carrying a
# big tool_response (a 300 KB file read is routine) is over the ~128 KiB
# single-argument limit and would fail the exec with E2BIG. No shell
# variables are interpolated into the Python source.
PY=$(cat <<'PYEOF'
import json, sys, os, re

try:
    d = json.loads(sys.stdin.read() or '{}')
except Exception:
    sys.exit(0)
if not isinstance(d, dict):
    sys.exit(0)

hook_event = d.get('hook_event_name', '')
tool_name  = d.get('tool_name', '')

# ── Session identity — present on every hook payload Claude Code sends ──────
# session_id, transcript_path and cwd are in the base schema of all 33 hook
# events (captured 2.1.300). project is the basename of cwd: the folder the
# terminal was opened in, which is what the office shows on the session pill.
def session_fields(payload):
    out = {}
    sid = payload.get('session_id')
    if sid:
        out['sessionId'] = str(sid)
    cwd = payload.get('cwd')
    if isinstance(cwd, str) and cwd:
        out['project'] = os.path.basename(cwd.rstrip('/')) or cwd
        out['cwd'] = cwd
    transcript = payload.get('transcript_path')
    if isinstance(transcript, str) and transcript:
        out['transcriptPath'] = transcript
    return out

SESSION = session_fields(d)

def emit(event):
    # Every event the office receives says which session it belongs to
    for key, value in SESSION.items():
        event.setdefault(key, value)
    print(json.dumps(event))

# ── Session lifecycle ───────────────────────────────────────────────────────
# Captured 2.1.300 payloads (besides session_id/transcript_path/cwd):
#   SessionStart {"source": "startup"}                      first start, no model
#   SessionStart {"source": "startup", "model": "claude-haiku-5-5"}
#   SessionStart {"source": "resume", "seconds_since_last_response": 5,
#                 "context_tokens": 44052, ...}             claude -r / --continue
#   SessionStart {"source": "compact", "model": "claude-haiku-5-5", "prompt_id": ...}
#   SessionEnd   {"reason": "other"}                        every -p exit
#   SessionEnd   {"reason": "prompt_input_exit"}            /exit
# source may also be clear | fork (schema). session_title is only present
# when the session was named (--name, /rename) and becomes `title`.
if hook_event == 'SessionStart':
    event = {'type': 'session_started', 'source': str(d.get('source') or 'startup')}
    if d.get('model'):
        event['model'] = str(d['model'])
    if d.get('session_title'):
        event['title'] = str(d['session_title'])[:120]
    if SESSION.get('sessionId'):
        emit(event)
    sys.exit(0)

if hook_event == 'SessionEnd':
    if SESSION.get('sessionId'):
        emit({'type': 'session_ended', 'reason': str(d.get('reason') or 'other')})
    sys.exit(0)

# ── Subagent started — fires right after PreToolUse(Agent) ──────────────────
# Captured 2.1.300 payload (besides session_id/transcript_path/cwd/prompt_id):
#   {"hook_event_name": "SubagentStart", "agent_id": "ac5ff55b850b4fecf",
#    "agent_type": "general-purpose"}
# Here `agent_id` IS the new subagent — the same id its tool calls and its
# SubagentStop carry later — not the agent the hook ran inside, as it is on
# every other event. There is no tool_use_id, description or parent field, so
# the lineage of a nested spawn comes from the PreToolUse(Agent) that launched
# it (parentSubagentId below), not from here. The server ties the id to the
# agent_spawned of the same agent_type, whichever of the two arrives first.
if hook_event == 'SubagentStart':
    if d.get('agent_id') and d.get('agent_type'):
        emit({
            'type':       'agent_started',
            'subagentId': str(d['agent_id']),
            'agentType':  str(d['agent_type']),
        })
    sys.exit(0)

# ── Subagent finished (foreground or background) — carries the subagent's
# agent_id and its final message, but no tool_name.
# SubagentStop also fires for sidechains that are not workers and never had a
# SubagentStart: the compaction summariser (between PreCompact/PostCompact)
# and the prompt-suggestion pass, both with agent_type "". Those are phantoms,
# so emit nothing rather than a completion for an id the office never saw.
if hook_event == 'SubagentStop':
    if d.get('agent_id') and d.get('agent_type'):
        emit({
            'type':    'agent_completed',
            'agentId': str(d['agent_id']),
            'result':  str(d.get('last_assistant_message') or 'done')[:120],
        })
    sys.exit(0)

# ── The session's own Claude ────────────────────────────────────────────────
# The events below describe the main thread, not a worker, and none of them
# carries a tool_name except PermissionRequest — so they sit above the
# tool_name gate. All of them need the session they belong to. Text is
# clamped HERE as well as on the server: the server clamps `text` to 2000
# characters, but an oversize body would be refused whole (413) and the state
# change lost along with the text.
def clamp(value, limit):
    return str(value if value is not None else '')[:limit]

def one_line(value, limit):
    # Labels: whitespace collapsed, then clamped
    return ' '.join(str(value if value is not None else '').split())[:limit]

def emit_session(event):
    pid = d.get('prompt_id')
    if pid:
        event['promptId'] = str(pid)[:80]
    if SESSION.get('sessionId'):
        emit(event)
    sys.exit(0)

# UserPromptSubmit {prompt, prompt_id, permission_mode} — the boss's prompt.
# Also fired for turns Claude Code starts by itself: a background subagent
# reporting back arrives as a prompt that begins "<task-notification>" and
# names the subagent in <task-id> (captured 2.1.300: the schema's `source`
# field, which would say so, was never sent). Such a wake-up is flagged and
# only its <summary> line travels, never the XML or the agent's result.
if hook_event == 'UserPromptSubmit':
    prompt = d.get('prompt')
    prompt = prompt if isinstance(prompt, str) else ''
    event = {'type': 'session_prompt', 'text': clamp(prompt, 2000), 'isWakeup': False}
    if prompt.lstrip().startswith('<task-notification>'):
        event['isWakeup'] = True
        m = re.search(r'<task-id>\s*([^<\s]+)\s*</task-id>', prompt)
        if m:
            event['wakeupAgentId'] = m.group(1)[:80]
        m = re.search(r'<status>\s*([^<\s]+)\s*</status>', prompt)
        if m:
            event['wakeupStatus'] = m.group(1)[:40]
        m = re.search(r'<summary>(.*?)</summary>', prompt, re.S)
        event['text'] = one_line(m.group(1) if m else 'a background task finished', 2000)
    emit_session(event)

# Stop {stop_hook_active, last_assistant_message, background_tasks, session_crons}
# — Claude's turn ended. background_tasks is the in-flight background work
# ({id, type, status, description, ...} per the schema; every captured Stop
# had [] because a background subagent's finish is delivered as a new prompt,
# so "waiting on N workers" is schema-backed, not capture-backed).
# session_crons are scheduled wake-ups (/loop, CronCreate). Stop does NOT fire
# when the user rejects a permission dialog — that turn is interrupted.
if hook_event == 'Stop':
    tasks = []
    raw_tasks = d.get('background_tasks')
    for task in (raw_tasks if isinstance(raw_tasks, list) else [])[:10]:
        if not isinstance(task, dict):
            continue
        tasks.append({
            'id':          clamp(task.get('id'), 64),
            'type':        clamp(task.get('type'), 40),
            'status':      clamp(task.get('status'), 40),
            'description': one_line(task.get('description'), 120),
        })
    crons = d.get('session_crons')
    emit_session({
        'type':            'session_turn_end',
        'text':            clamp(d.get('last_assistant_message'), 2000),
        'backgroundTasks': tasks,
        'crons':           len(crons) if isinstance(crons, list) else 0,
        'stopHookActive':  bool(d.get('stop_hook_active')),
    })

# PermissionRequest {tool_name, tool_input, permission_suggestions} — Claude
# is waiting for the user's answer (no tool_use_id). In -p mode the call is
# auto-denied right after this fires; interactively the dialog stays up and
# a Notification{permission_prompt} follows ~6 s later (deduped server-side).
# A request raised inside a subagent would carry agent_id (schema-only, not
# captured); it is forwarded when present.
def permission_summary(name, inp):
    inp = inp if isinstance(inp, dict) else {}
    if name in ('Write', 'Edit', 'Read', 'MultiEdit', 'NotebookEdit'):
        path = str(inp.get('file_path') or inp.get('notebook_path') or '')
        return os.path.basename(path.rstrip('/')) or name
    if name == 'Bash':
        return one_line(inp.get('command') or inp.get('description'), 80) or name
    return name

if hook_event == 'PermissionRequest':
    name = str(tool_name or 'tool')
    event = {
        'type':     'session_needs_you',
        'kind':     'permission',
        'toolName': name[:80],
        'summary':  permission_summary(name, d.get('tool_input'))[:120],
    }
    if d.get('agent_id'):
        event['agentId'] = str(d['agent_id'])
    emit_session(event)

# Notification {message, notification_type, title?} — only the types that mean
# the session is waiting on a person (or was paused by the quota) are
# forwarded; auth_success, elicitation_*, agent_completed, ... are ignored.
# permission_prompt and idle_prompt are presence-gated (they fire only when
# the user looks away from the terminal), so they are best-effort.
NOTIFICATION_KINDS = {
    'permission_prompt':           'permission',
    'idle_prompt':                 'idle',
    'quota_auto_resume_fired':     'quota',
    'quota_auto_resume_stale':     'quota',
    'quota_auto_resume_disabled':  'quota',
    'agent_needs_input':           'agent-input',
}
if hook_event == 'Notification':
    ntype = str(d.get('notification_type') or '')
    kind = NOTIFICATION_KINDS.get(ntype)
    if not kind:
        sys.exit(0)
    emit_session({
        'type':             'session_needs_you',
        'kind':             kind,
        'notificationType': ntype[:40],
        'message':          one_line(d.get('message'), 200),
    })

# StopFailure {error, error_details?, last_assistant_message?} — the turn
# ended on an API error (rate_limit, overloaded, authentication_failed, ...).
# Never captured locally; shape per the schema and the hooks reference.
if hook_event == 'StopFailure':
    detail = d.get('error_details') or d.get('last_assistant_message') or ''
    emit_session({
        'type':   'session_error',
        'error':  one_line(d.get('error') or 'unknown', 40),
        'detail': one_line(detail, 200),
    })

# PreCompact / PostCompact {trigger: manual|auto} — the summary text is not
# forwarded (it is the conversation). PreCompact fires even when compaction
# is then refused ("Not enough messages"), so a `pre` may have no `post`.
if hook_event in ('PreCompact', 'PostCompact'):
    emit_session({
        'type':    'session_compact',
        'phase':   'pre' if hook_event == 'PreCompact' else 'post',
        'trigger': one_line(d.get('trigger') or 'manual', 20),
    })

# PostToolBatch {tool_calls: [{tool_name, tool_input, tool_use_id, tool_response}]}
# — one per model turn, once every tool call of that turn has an answer
# (a denied one included). Only the main thread's batches matter here: the
# server uses them to lower a permission hand the batch has answered, so a
# headless auto-deny (PermissionRequest, then this ~60 ms later) never shows.
if hook_event == 'PostToolBatch':
    if d.get('agent_id'):
        sys.exit(0)
    calls = d.get('tool_calls')
    emit_session({'type': 'session_tool_done', 'batch': True, 'count': len(calls) if isinstance(calls, list) else 0})

# CwdChanged {old_cwd, new_cwd} — after a persistent `cd` in Bash. The
# session's cwd and project tag follow (the payload's own cwd is still the
# old one, so both are set explicitly before emit() fills the defaults).
if hook_event == 'CwdChanged':
    new_cwd = d.get('new_cwd')
    if isinstance(new_cwd, str) and new_cwd:
        event = {'type': 'session_cwd', 'cwd': new_cwd, 'project': os.path.basename(new_cwd.rstrip('/')) or new_cwd}
        if isinstance(d.get('old_cwd'), str) and d['old_cwd']:
            event['oldCwd'] = d['old_cwd']
        emit_session(event)
    sys.exit(0)

# PostModelSwitch {from_model, to_model, requested_model, source, context_tokens, ...}
# — /model, the picker, an SDK set_model or an automatic fallback.
if hook_event == 'PostModelSwitch':
    to_model = d.get('to_model')
    if isinstance(to_model, str) and to_model:
        event = {'type': 'session_model', 'model': to_model[:80]}
        if isinstance(d.get('from_model'), str) and d['from_model']:
            event['fromModel'] = d['from_model'][:80]
        if isinstance(d.get('source'), str) and d['source']:
            event['switchSource'] = d['source'][:20]
        emit_session(event)
    sys.exit(0)

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
        emit({
            'type':   'mcp_call',
            'server': mcp_server,
            'tool':   mcp_tool,
        })
    elif hook_event in ('PostToolUse', 'PostToolUseFailure'):
        # A failed MCP call gets PostToolUseFailure instead of PostToolUse;
        # either way the transient worker leaves
        emit({
            'type':   'mcp_done',
            'server': mcp_server,
        })
    sys.exit(0)

# Role mapping: normalise subagent_type to office role keys
ROLE_MAP = {
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

# Display name per role
NAME_MAP = {
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

# General-purpose agents all share one sprite. Give them a specialist desk
# when the task clearly says what they're doing; the server spreads the rest
# across the least-used sprites.
TASK_ROLE_HINTS = [
    (r'\b(test|tests|testing|spec|coverage)\b',            'test-engineer'),
    (r'\b(review|audit the diff|code review)\b',           'code-reviewer'),
    (r'\b(debug|bug|crash|stack ?trace|failing)\b',        'debugger'),
    (r'\b(security|vuln|cve|auth\b|secret)',                 'security-auditor'),
    (r'\b(frontend|ui|css|react|component|layout)\b',      'frontend-developer'),
    (r'\b(perf|performance|latency|profil)',                'performance-engineer'),
    (r'\b(deploy|ci|docker|pipeline|infra)\b',             'devops-engineer'),
    (r'\b(database|sql|schema|migration|query)\b',         'database-architect'),
    (r'\b(architecture|design doc|refactor plan)\b',       'architect-reviewer'),
]

def role_for(subagent_type, task=''):
    role = ROLE_MAP.get(subagent_type, 'general-purpose')
    if role == 'general-purpose' and task:
        low = task.lower()
        for pattern, hinted in TASK_ROLE_HINTS:
            if re.search(pattern, low):
                return hinted
    return role

def response_dict(resp):
    if isinstance(resp, dict):
        return resp
    if isinstance(resp, str):
        try:
            parsed = json.loads(resp)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}

def result_text(resp):
    if isinstance(resp, dict):
        out = resp.get('output', resp.get('result', resp.get('content', 'done')))
        if isinstance(out, list):
            out = ' '.join(str(c.get('text', '')) if isinstance(c, dict) else str(c) for c in out)
        return str(out)[:120]
    if isinstance(resp, str):
        return resp[:120]
    return 'done'

# Set when this hook fires for a tool call made inside a subagent
sub_agent_id   = d.get('agent_id', '') or ''
sub_agent_type = d.get('agent_type', '') or ''

def tag_subagent(event):
    # Inside a subagent — the server maps this id to the office agent
    if sub_agent_id:
        event['agentId']   = str(sub_agent_id)
        event['agentType'] = sub_agent_type or 'general-purpose'
        event['role']      = role_for(sub_agent_type)
        event['name']      = NAME_MAP.get(event['role'], 'Agent')
    return event

def error_summary(err, limit=60):
    # First `limit` chars of a tool error with its newlines collapsed, e.g.
    # "Exit code 1" + newline + "cat: /x: No such file" -> "Exit code 1 cat: /x: No such file"
    return ' '.join(str(err or '').split())[:limit] or 'unknown error'

# ── Agent tool calls  (tool_name == "Agent" or "Task") ─────────────────────
if tool_name in ('Agent', 'Task'):
    inp = d.get('tool_input', {}) or {}
    tool_use_id = d.get('tool_use_id', '')

    if hook_event == 'PreToolUse':
        # Claude Code Agent tool input has: description, prompt, subagent_type, agent_type
        description   = inp.get('description', '') or inp.get('prompt', '')
        subagent_type = inp.get('subagent_type', '') or inp.get('agent_type', '')

        role = role_for(subagent_type, description)
        name = NAME_MAP.get(role, 'Agent')

        # Truncate task description for display
        task = description[:80] if description else 'Working on task'

        # Stable ID based on tool_use_id if available
        agent_id = f'agent-{tool_use_id}' if tool_use_id else f'agent-{role}-{id(d)}'

        agent = {
            'id':        agent_id,
            'name':      name,
            'role':      role,
            'task':      task,
            'agentType': subagent_type or 'general-purpose',
            'background': bool(inp.get('run_in_background')),
        }
        # Nested spawn: an Agent call made inside a subagent carries that
        # subagent's agent_id, which makes it the new agent's parent
        if sub_agent_id:
            agent['parentSubagentId'] = str(sub_agent_id)

        emit({'type': 'agent_spawned', 'agent': agent})

    elif hook_event == 'PostToolUseFailure':
        # The launch itself failed (unknown subagent_type, interrupted, ...):
        # no subagent ever existed, so walk the office agent out again
        agent_id = f'agent-{tool_use_id}' if tool_use_id else ''
        if agent_id:
            emit({
                'type':    'agent_completed',
                'agentId': agent_id,
                'result':  f"failed: {error_summary(d.get('error'), 110)}",
            })

    elif hook_event == 'PostToolUse':
        agent_id = f'agent-{tool_use_id}' if tool_use_id else ''
        resp = d.get('tool_response', {})
        rd = response_dict(resp)

        # Background launch: the agent is still working. Link the office agent
        # to the subagent id so its tool calls and hand-back find it.
        if rd.get('status') == 'async_launched' or (inp.get('run_in_background') and not rd.get('status') == 'completed'):
            subagent_id = rd.get('agentId') or rd.get('agent_id') or ''
            if agent_id and subagent_id:
                emit({
                    'type':       'agent_linked',
                    'agentId':    agent_id,
                    'subagentId': str(subagent_id),
                })
            sys.exit(0)

        # A foreground agent's result also says what it cost (captured 2.1.300:
        # totalTokens, totalDurationMs, totalToolUseCount, resolvedModel next to
        # content/usage/toolStats); each travels only when present
        event = {
            'type':    'agent_completed',
            'agentId': agent_id,
            'result':  result_text(resp),
        }
        def whole(value):
            return isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0
        if whole(rd.get('totalTokens')):
            event['tokens'] = int(rd['totalTokens'])
        if whole(rd.get('totalDurationMs')):
            event['durationMs'] = int(rd['totalDurationMs'])
        if whole(rd.get('totalToolUseCount')):
            event['toolUses'] = int(rd['totalToolUseCount'])
        if isinstance(rd.get('resolvedModel'), str) and rd['resolvedModel']:
            event['model'] = rd['resolvedModel'][:80]
        emit(event)

    sys.exit(0)

# ── Background agent finished — some Claude Code versions hand the report back
# through a SubagentHandback tool call instead of (or as well as) SubagentStop
if tool_name == 'SubagentHandback' and hook_event == 'PostToolUse':
    inp = d.get('tool_input', {}) or {}
    rd = response_dict(d.get('tool_response', {}))
    subagent_id = (sub_agent_id or inp.get('agent_id') or inp.get('agentId')
                   or rd.get('agent_id') or rd.get('agentId') or '')
    if subagent_id:
        emit({
            'type':    'agent_completed',
            'agentId': str(subagent_id),
            'result':  result_text(d.get('tool_response', {})),
        })
    sys.exit(0)

# ── A tool call errored — Claude Code fires PostToolUseFailure {tool_name,
# tool_input, tool_use_id, error, is_interrupt, duration_ms} and NO PostToolUse
# for that call (a non-zero Bash exit counts: error "Exit code 1\n<stderr>").
# Shown as a failed status on the agent that made the call; a main-thread
# failure carries no agentId, exactly like the working events below.
if hook_event == 'PostToolUseFailure':
    emit(tag_subagent({
        'type':   'agent_working',
        'status': f"failed: {tool_name} — {error_summary(d.get('error'))}",
        'failed': True,
    }))
    sys.exit(0)

# ── A main-thread tool call finished — PostToolUse of anything but the Agent
# and MCP tools handled above. Nothing to draw, but a permission hand raised
# for this tool comes down on the server: the call ran, so it was granted.
# (A worker's PostToolUse says nothing; its agent is already shown working.)
if hook_event == 'PostToolUse' and not sub_agent_id:
    emit_session({'type': 'session_tool_done', 'toolName': str(tool_name)[:80]})

# ── Every other tool use — broadcast as a working status update ────────────
# The common tools get a specific line; anything else (WebFetch, TodoWrite,
# ToolSearch, AskUserQuestion, ...) a generic one, so the main thread (no
# agent_id — the session's own Claude) and a worker are seen working on every
# call, not only on the handful the office used to know.
if hook_event == 'PreToolUse':
    inp = d.get('tool_input', {})
    inp = inp if isinstance(inp, dict) else {}

    status_map = {
        'Read':  lambda i: f"reading {str(i.get('file_path') or '').split('/')[-1]}",
        'Write': lambda i: f"writing {str(i.get('file_path') or '').split('/')[-1]}",
        'Edit':  lambda i: f"editing {str(i.get('file_path') or '').split('/')[-1]}",
        'Bash':  lambda i: f"running: {str(i.get('command') or i.get('description') or '')[:60]}",
        'Grep':  lambda i: f"searching for '{str(i.get('pattern') or '')[:30]}'",
        'Glob':  lambda i: f"finding files: {str(i.get('pattern') or '')[:40]}",
        'Skill': lambda i: f"using /{i.get('skill') or 'skill'}",
    }

    status_fn = status_map.get(tool_name)
    status = status_fn(inp) if status_fn else f"using {str(tool_name)[:40]}"
    emit(tag_subagent({
        'type': 'agent_working',
        'status': status,
    }))

sys.exit(0)
PYEOF
)

# -I: ignore PYTHON* env vars and the user site, and keep the cwd (the
# project Claude is working in) off sys.path
EVENT_JSON=$(printf '%s' "$PAYLOAD" | python3 -I -c "$PY")

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
