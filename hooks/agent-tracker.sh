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
AUTH_ARGS=()
TOKEN_FILE="${AGENT_OFFICE_HOME:-$HOME/.agent-office}/auth-token"
if [ -f "$TOKEN_FILE" ]; then
    TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null)
    if [ -n "$TOKEN" ]; then
        AUTH_HEADER="Authorization: Bearer $TOKEN"
        AUTH_ARGS=(-H "$AUTH_HEADER")
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

def emit_session(event, wait=False):
    pid = d.get('prompt_id')
    if pid:
        event['promptId'] = str(pid)[:80]
    if SESSION.get('sessionId'):
        emit(event)
        # A second line tells the wrapper to POST this one in the foreground
        # and wait for the office's answer (PermissionRequest only)
        if wait:
            print('wait')
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
# auto-denied as soon as every PermissionRequest hook has finished;
# interactively the dialog stays up and a Notification{permission_prompt}
# follows ~6 s later (deduped server-side). A request raised inside a
# subagent would carry agent_id (schema-only, not captured); it is forwarded
# when present.
#
# When the office may answer (ANSWER_MARKER exists, kept by the server in step
# with its answerPermissions setting) the event also carries what the card
# needs — answerable, permissionMode, the dialog's own permission_suggestions
# (echoed back verbatim on "allow and remember", so their shape is kept and
# only their sizes are bounded) and a detail line (the command, the path, or
# the tool input as compact JSON) — and the wrapper waits for the answer.
FILE_TOOLS = ('Write', 'Edit', 'Read', 'MultiEdit', 'NotebookEdit')
ANSWER_MARKER = os.path.join(os.environ.get('AGENT_OFFICE_HOME') or os.path.join(os.path.expanduser('~'), '.agent-office'), 'answer-permissions')

def permission_summary(name, inp):
    inp = inp if isinstance(inp, dict) else {}
    if name in FILE_TOOLS:
        path = str(inp.get('file_path') or inp.get('notebook_path') or '')
        return os.path.basename(path.rstrip('/')) or name
    if name == 'Bash':
        return one_line(inp.get('command') or inp.get('description'), 80) or name
    return name

def permission_detail(name, inp):
    inp = inp if isinstance(inp, dict) else {}
    if name == 'Bash':
        text = inp.get('command') or inp.get('description') or ''
    elif name in FILE_TOOLS:
        text = inp.get('file_path') or inp.get('notebook_path') or ''
    else:
        try:
            text = json.dumps(inp, separators=(',', ':'), ensure_ascii=False)
        except Exception:
            text = ''
    return clamp(text, 400)

def clamp_json(value, depth=0):
    # permission_suggestions, bounded but shape-preserving (server re-clamps)
    if isinstance(value, str):
        return value[:200]
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    if depth >= 3:
        return None
    if isinstance(value, list):
        return [clamp_json(v, depth + 1) for v in value[:8]]
    if isinstance(value, dict):
        return {str(k)[:40]: clamp_json(v, depth + 1) for k, v in list(value.items())[:12]}
    return None

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
    answerable = os.path.exists(ANSWER_MARKER)
    if answerable:
        suggestions = d.get('permission_suggestions')
        event['answerable'] = True
        event['permissionMode'] = clamp(d.get('permission_mode') or 'default', 40)
        event['suggestions'] = [clamp_json(s) for s in suggestions if isinstance(s, dict)][:4] if isinstance(suggestions, list) else []
        event['detail'] = permission_detail(name, d.get('tool_input'))
    emit_session(event, wait=answerable)

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

# ── Signals: what a Bash command means ──────────────────────────────────────
# A Bash call that deploys, builds, tests or pushes becomes `signals` the
# office acts on (a shipping scene, incident mode, chat lines).
# classify_command(command, cwd) is pure — no I/O — and returns one entry per
# meaningful segment: {kind, target?} with kind deploy | build | test | push;
# a push also says which branch it names (branch, toDefault) when the
# refspec does. The hook phase turns each entry into a signal:
#
#   kind     PreToolUse      PostToolUse      PostToolUseFailure
#   deploy   deploy_start    deploy_success   deploy_fail
#   build    build_start     build_ok         build_failed
#   test     test_start      test_ok          test_failed
#   push     push            push_done        push_failed
#
# How a command is read: it is split on && || ; | & and newlines (outside
# quotes, backticks and $(...); a heredoc body is never read), each segment
# loses its leading env assignments and wrappers (sudo, env, npx, time,
# timeout, uv run, bundle exec, ...), `cd DIR` moves the directory the next
# segments run in, and the segment's program is looked up in SIGNAL_RULES:
#
#   deploy  vercel deploy | vercel --prod, netlify deploy, fly/flyctl deploy,
#           railway up, heroku ... push, gcloud run|app|functions deploy,
#           aws ... deploy, sam deploy, serverless/sls deploy, kubectl apply |
#           rollout, helm upgrade|install, terraform/tofu apply, pulumi up,
#           cdk deploy, wrangler deploy|publish, firebase deploy, npm/pnpm/
#           yarn publish, gh release create, docker/podman push, mvn deploy,
#           make deploy|release|publish, git push of a tag (--tags, v1.2.3)
#           or to a heroku remote
#   build   npm/pnpm/yarn/bun scripts named build* | compile* | typecheck*,
#           vite build, next build, tsc, vue-tsc, cargo build, go build, make
#           (any target but clean/help/fmt and the test/deploy ones), gradle
#           build|assemble, mvn package|install|compile|verify, docker build,
#           webpack, esbuild, dotnet build
#   test    npm test / npm run test*, pnpm/yarn/bun test*, vitest, jest,
#           mocha, pytest (python -m pytest|unittest too), cargo test, go
#           test, mvn test, gradle test|check, rspec, phpunit, playwright
#           test, deno test, dotnet test, make test|check
#   push    git push (branch from the refspec; main or master is toDefault)
#
# Extending it is one row in SIGNAL_RULES: (program names, a function of the
# arguments that returns the kind or None, a function that returns the
# target or None). A --dry-run / --version / --help run never counts.
#
# Outcome. A segment followed by `|`, `||`, `;` or `&` (or that runs only
# after a `||`) does not decide the call's exit status: `npm test | tail`
# exits 0 whatever the tests did. Such a segment is judged by its output
# instead (a failure count, "Build failed", "[rejected]", or for tests and
# builds an explicit pass line) and says nothing when the output is silent.
# Every other segment of a successful call succeeded. When the call fails,
# the segment whose kind the error text points at is blamed, else the first
# segment that could have ended the call; the rest say nothing. A Bash call
# run in the background has no outcome yet on PostToolUse; an interrupted
# one (Esc) is reported as a failure marked `interrupted`, which the office
# never counts against prod.
#
# Where they travel. The hook sends ONE JSON per invocation, so the signals
# ride on the event this call sends anyway: `signals: [...]` on the
# agent_working of PreToolUse and of PostToolUseFailure, and on the
# session_tool_done of a main-thread PostToolUse. A worker's PostToolUse (or
# one without a session id) sends nothing of its own, so there they go out
# alone as {type: 'signal', signals: [...]}, tagged with the subagent like
# any of its events. Each signal: kind, target, command (160), and on a
# failure error (the first meaningful line, 200), exitCode, detail ("3
# failing", "2 errors") and interrupted. Classification never changes the
# exit status and never fails the event it rides on.
DEFAULT_BRANCHES = ('main', 'master')
SIGNAL_NAMES = {
    'deploy': ('deploy_start', 'deploy_success', 'deploy_fail'),
    'build':  ('build_start', 'build_ok', 'build_failed'),
    'test':   ('test_start', 'test_ok', 'test_failed'),
    'push':   ('push', 'push_done', 'push_failed'),
}
MAX_SIGNALS = 8
ENV_ASSIGN = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*=')
TAG_REF = re.compile(r'^(refs/tags/|v\d)')
NEVER_FLAGS = ('--dry-run', '--version', '--help')

def positionals(args, with_value=()):
    # The non-flag arguments, skipping the values of the flags that take one
    out, i = [], 0
    while i < len(args):
        a = args[i]
        if a == '--':
            out.extend(args[i + 1:])
            break
        if a.startswith('-') and len(a) > 1:
            i += 2 if (a in with_value and '=' not in a) else 1
            continue
        out.append(a)
        i += 1
    return out

def flag_value(args, names):
    # The value of the first of `names` given as `-x v`, `--name v` or `--name=v`
    for i, a in enumerate(args):
        for n in names:
            if a == n and i + 1 < len(args):
                return args[i + 1]
            if n.startswith('--') and a.startswith(n + '='):
                return a[len(n) + 1:]
    return None

def name_of(path):
    # A directory or package as a display name: its last path segment, no @scope/
    p = str(path or '').strip().rstrip('/')
    p = p.split('/')[-1] if '/' in p else p
    return p if p not in ('', '.', '..', '~', '-', '*') else None

PM_VALUE_FLAGS = ('--prefix', '-w', '--workspace', '--filter', '-F', '-C', '--dir', '--cwd')

def pm_script(prog, args):
    # The script an npm / pnpm / yarn / bun call runs: `npm run build:x` ->
    # build:x, `npm test` / `npm t` -> test, `pnpm --filter web build` -> build
    pos = positionals(args, PM_VALUE_FLAGS)
    if not pos:
        return None
    if pos[0] in ('run', 'run-script', 'rum', 'urn'):
        return pos[1] if len(pos) > 1 else None
    if pos[0] in ('t', 'tst') and prog == 'npm':
        return 'test'
    return pos[0]

SCRIPT_BUILD = re.compile(r'^(build|compile|typecheck|type-check|tsc)([:\-_.].*)?$')
SCRIPT_TEST = re.compile(r'^(test|tests|e2e|spec)([:\-_.].*)?$')

def pm_kind(prog, args):
    pos = positionals(args, PM_VALUE_FLAGS)
    if not pos:
        return None
    if pos[0] == 'publish' or (prog == 'yarn' and pos[:2] == ['npm', 'publish']):
        return 'deploy'
    script = pm_script(prog, args)
    if not script:
        return None
    if SCRIPT_BUILD.match(script):
        return 'build'
    if SCRIPT_TEST.match(script):
        return 'test'
    return None

def pm_target(prog, args):
    v = flag_value(args, ('--filter', '-F', '--workspace', '-w'))
    if v:
        return name_of(v.lstrip('.').lstrip('/') if v.startswith('./') else v) or name_of(v)
    return name_of(flag_value(args, ('--prefix', '-C', '--dir', '--cwd')))

def make_kind(args):
    targets = [a for a in positionals(args, ('-C', '-f', '--file', '--directory', '-I', '-o', '-W')) if '=' not in a and not a.isdigit()]
    goal = targets[0] if targets else ''
    if goal in ('clean', 'distclean', 'mrproper', 'help', 'fmt', 'format', 'lint', 'install-deps', 'deps'):
        return None
    if goal in ('test', 'tests', 'check'):
        return 'test'
    if goal in ('deploy', 'release', 'publish'):
        return 'deploy'
    return 'build'

def gradle_kind(args):
    tasks = [t.split(':')[-1] for t in positionals(args, ('-p', '--project-dir', '-x'))]
    if any(t in ('build', 'assemble', 'jar', 'bootJar', 'compileJava', 'compileKotlin', 'shadowJar') for t in tasks):
        return 'build'
    if any(t in ('test', 'check') for t in tasks):
        return 'test'
    return None

def mvn_kind(args):
    phases = positionals(args, ('-pl', '-f', '-P', '-s', '-D'))
    if 'deploy' in phases:
        return 'deploy'
    if any(p in ('package', 'install', 'compile', 'verify') for p in phases):
        return 'build'
    if 'test' in phases:
        return 'test'
    return None

def docker_kind(args):
    pos = positionals(args, ('-t', '--tag', '-f', '--file', '-H', '--host', '--context', '--platform'))
    if not pos:
        return None
    if pos[0] == 'push' or pos[:2] == ['image', 'push']:
        return 'deploy'
    if pos[0] == 'build' or pos[:2] in (['buildx', 'build'], ['compose', 'build'], ['image', 'build'], ['builder', 'build']):
        return 'build'
    return None

def image_name(ref):
    # ghcr.io/me/api:1.2 -> api
    ref = str(ref or '').split('@')[0]
    last = ref.split('/')[-1]
    return last.split(':')[0] or None

def docker_target(args):
    pos = positionals(args, ('-t', '--tag', '-f', '--file', '-H', '--host', '--context', '--platform'))
    if pos[:1] == ['push']:
        return image_name(pos[1]) if len(pos) > 1 else None
    if pos[:2] == ['image', 'push']:
        return image_name(pos[2]) if len(pos) > 2 else None
    tag = flag_value(args, ('-t', '--tag'))
    return image_name(tag) if tag else None

KUBECTL_VALUE_FLAGS = ('-n', '--namespace', '--context', '--kubeconfig', '-s', '--server', '--cluster', '--user', '-f', '--filename', '-l', '--selector')

def kubectl_kind(args):
    pos = positionals(args, KUBECTL_VALUE_FLAGS)
    if pos[:1] == ['apply'] or pos[:2] in (['rollout', 'restart'], ['rollout', 'undo'], ['rollout', 'resume'], ['rollout', 'status']):
        return 'deploy'
    return None

def kubectl_target(args):
    pos = positionals(args, KUBECTL_VALUE_FLAGS)
    if pos[:1] == ['rollout'] and len(pos) > 2:
        return name_of(pos[2])
    return None

def first_pos(args, with_value=()):
    pos = positionals(args, with_value)
    return pos[0] if pos else ''

def nth_pos(args, n, with_value=()):
    pos = positionals(args, with_value)
    return pos[n] if len(pos) > n else None

VERCEL_NON_DEPLOY = ('env', 'login', 'logout', 'dev', 'link', 'logs', 'ls', 'list', 'pull', 'whoami', 'domains', 'alias',
                     'rm', 'remove', 'inspect', 'secrets', 'teams', 'projects', 'certs', 'dns', 'build', 'promote', 'rollback')

# (program names, kind of the call or None, its target or None). First match wins.
SIGNAL_RULES = [
    (('vercel',),
     lambda a: 'deploy' if first_pos(a, ('--scope', '-t', '--token', '-A', '--local-config')) == 'deploy'
         or (('--prod' in a or '--production' in a) and first_pos(a, ('--scope', '-t', '--token')) not in VERCEL_NON_DEPLOY) else None,
     lambda a: None),
    (('netlify',),      lambda a: 'deploy' if first_pos(a) == 'deploy' else None, lambda a: name_of(flag_value(a, ('--site', '-s')))),
    (('fly', 'flyctl'), lambda a: 'deploy' if first_pos(a, ('-a', '--app', '-c', '--config')) == 'deploy' else None,
     lambda a: name_of(flag_value(a, ('-a', '--app')))),
    (('railway',),      lambda a: 'deploy' if first_pos(a, ('-s', '--service', '-e', '--environment')) == 'up' else None,
     lambda a: name_of(flag_value(a, ('-s', '--service')))),
    (('heroku',),       lambda a: 'deploy' if any(x == 'push' or x.endswith(':push') for x in a) else None,
     lambda a: name_of(flag_value(a, ('-a', '--app')))),
    (('gcloud',),       lambda a: 'deploy' if positionals(a, ('--project', '--region'))[:2] in (['run', 'deploy'], ['app', 'deploy'], ['functions', 'deploy']) else None,
     lambda a: name_of(nth_pos(a, 2, ('--project', '--region', '--image', '--source'))) if first_pos(a, ('--project',)) in ('run', 'functions') else None),
    (('aws',),          lambda a: 'deploy' if 'deploy' in positionals(a, ('--profile', '--region', '--output'))[:2] else None, lambda a: name_of(flag_value(a, ('--stack-name',)))),
    (('sam',),          lambda a: 'deploy' if first_pos(a) == 'deploy' else None, lambda a: name_of(flag_value(a, ('--stack-name',)))),
    (('serverless', 'sls'), lambda a: 'deploy' if first_pos(a) == 'deploy' else None, lambda a: None),
    (('kubectl',),      kubectl_kind, kubectl_target),
    (('helm',),         lambda a: 'deploy' if first_pos(a, ('-n', '--namespace', '--kube-context')) in ('upgrade', 'install') else None,
     lambda a: name_of(nth_pos(a, 1, ('-n', '--namespace', '--kube-context', '-f', '--values', '--set', '--version', '--timeout')))),
    (('terraform', 'tofu'), lambda a: 'deploy' if first_pos(a) == 'apply' else None,
     lambda a: name_of(next((x.split('=', 1)[1] for x in a if x.startswith('-chdir=')), None))),
    (('pulumi',),       lambda a: 'deploy' if first_pos(a, ('-s', '--stack', '-C', '--cwd')) == 'up' else None, lambda a: name_of(flag_value(a, ('-s', '--stack')))),
    (('cdk',),          lambda a: 'deploy' if first_pos(a, ('--profile', '-c', '--context', '-a', '--app')) == 'deploy' else None, lambda a: None),
    (('wrangler',),     lambda a: 'deploy' if positionals(a, ('-c', '--config', '-e', '--env', '--name', '--project-name'))[:1] in (['deploy'], ['publish'])
         or positionals(a, ('-c', '--config', '--project-name'))[:2] == ['pages', 'deploy'] else None,
     lambda a: name_of(flag_value(a, ('--name', '--project-name')))),
    (('firebase',),     lambda a: 'deploy' if first_pos(a, ('-P', '--project', '--only')) == 'deploy' else None, lambda a: None),
    (('gh',),           lambda a: 'deploy' if positionals(a, ('-R', '--repo'))[:2] == ['release', 'create'] else None, lambda a: None),
    (('docker', 'podman'), docker_kind, docker_target),
    (('docker-compose',), lambda a: 'build' if first_pos(a, ('-f', '--file', '-p', '--project-name')) == 'build' else None, lambda a: None),
    (('npm', 'pnpm', 'yarn', 'bun'), lambda a, p=None: None, lambda a: None),  # placeholder: package managers are matched below
    (('vite', 'next'),  lambda a: 'build' if first_pos(a) == 'build' else None, lambda a: None),
    (('tsc', 'vue-tsc'), lambda a: None if any(x in a for x in ('--init', '-v', '--showConfig', '-w', '--watch')) else 'build',
     lambda a: name_of(flag_value(a, ('-p', '--project'))) if (flag_value(a, ('-p', '--project')) or '').find('.json') < 0 else None),
    (('cargo',),        lambda a: {'build': 'build', 'b': 'build', 'test': 'test', 't': 'test', 'nextest': 'test'}.get(first_pos(a, ('-p', '--package', '--manifest-path', '--target', '-j'))),
     lambda a: name_of(flag_value(a, ('-p', '--package')))),
    (('go',),           lambda a: {'build': 'build', 'test': 'test'}.get(first_pos(a)), lambda a: None),
    (('make', 'gmake'), make_kind, lambda a: name_of(flag_value(a, ('-C', '--directory')))),
    (('gradle', 'gradlew'), gradle_kind, lambda a: None),
    (('mvn', 'mvnw'),   mvn_kind, lambda a: name_of(flag_value(a, ('-pl',)))),
    (('webpack',),      lambda a: None if first_pos(a) in ('serve', 'init', 'info') else 'build', lambda a: None),
    (('esbuild',),      lambda a: None if '--serve' in a or any(x.startswith('--serve=') for x in a) else 'build', lambda a: None),
    (('dotnet',),       lambda a: {'build': 'build', 'test': 'test', 'publish': 'build'}.get(first_pos(a)), lambda a: None),
    (('vitest',),       lambda a: None if first_pos(a) in ('bench', 'init', 'list') else 'test', lambda a: None),
    (('jest', 'mocha', 'pytest', 'py.test', 'rspec', 'phpunit'), lambda a: 'test', lambda a: None),
    (('playwright',),   lambda a: 'test' if first_pos(a, ('-c', '--config', '--project')) == 'test' else None, lambda a: None),
    (('deno',),         lambda a: 'test' if first_pos(a) == 'test' else None, lambda a: None),
]

def classify_program(prog, args):
    # One segment's program and arguments -> (kind, target) or None
    if any(x in args for x in NEVER_FLAGS):
        return None
    if prog in ('npm', 'pnpm', 'yarn', 'bun'):
        kind = pm_kind(prog, args)
        return (kind, pm_target(prog, args)) if kind else None
    if prog.startswith('python') and len(args) >= 2 and args[0] == '-m' and args[1] in ('pytest', 'unittest', 'nose2'):
        return ('test', None)
    for progs, kind_of, target_of in SIGNAL_RULES:
        if prog in progs:
            kind = kind_of(args)
            if not kind:
                return None
            try:
                target = target_of(args)
            except Exception:
                target = None
            return (kind, target)
    return None

def git_push(args):
    # git push [flags] [remote [refspec...]] -> entries (a tag push is a deploy)
    flags, pos, i = set(), [], 0
    while i < len(args):
        a = args[i]
        if a in ('-o', '--push-option', '--repo', '--receive-pack', '--exec'):
            i += 2
            continue
        if a.startswith('-') and len(a) > 1:
            flags.add(a.split('=')[0])
            i += 1
            continue
        pos.append(a)
        i += 1
    if flags & {'-n', '--dry-run', '-d', '--delete', '--prune'}:
        return []
    remote = pos[0] if pos else None
    if remote and remote.startswith('heroku'):
        return [{'kind': 'deploy'}]
    def dest(ref):
        ref = ref.lstrip('+')
        if ':' in ref:
            ref = ref.split(':', 1)[1]
        return ref[len('refs/heads/'):] if ref.startswith('refs/heads/') else ref
    dests = [dest(r) for r in pos[1:] if dest(r)]
    tags = [x for x in dests if TAG_REF.match(x)]
    branches = [x for x in dests if not TAG_REF.match(x)]
    out = []
    if tags or '--tags' in flags or '--follow-tags' in flags:
        out.append({'kind': 'deploy'})
    if '--tags' in flags and not branches:
        return out
    if tags and not branches:
        return out
    entry = {'kind': 'push'}
    named = [b for b in branches if b != 'HEAD']
    if named and not (flags & {'--all', '--mirror', '--branches'}):
        entry['branch'] = named[0]
        entry['toDefault'] = any(b in DEFAULT_BRANCHES for b in named)
    out.append(entry)
    return out

def split_command(command):
    # [(segment, operator after it)] — split on && || ; | & and newlines that
    # are outside quotes, backticks and $(...). `2>&1`, `&>` and `>&2` are
    # redirections, not operators. A heredoc body is never read as commands.
    s = str(command or '')
    m = re.search(r'<<-?\s*[\'"]?\w+', s)
    if m:
        nl = s.find('\n', m.end())
        if nl >= 0:
            s = s[:nl]
    segs, buf, quote, depth, i, n = [], [], None, 0, 0, len(s)
    def cut(op):
        segs.append((''.join(buf), op))
        del buf[:]
    while i < n:
        c = s[i]
        if quote:
            buf.append(c)
            if c == '\\' and quote == '"' and i + 1 < n:
                buf.append(s[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c == '\\' and i + 1 < n:
            buf.append(s[i:i + 2])
            i += 2
            continue
        if c in ('"', "'", '`'):
            quote = c
            buf.append(c)
            i += 1
            continue
        if c == '$' and s[i + 1:i + 2] == '(':
            depth += 1
            buf.append('$(')
            i += 2
            continue
        if depth:
            if c == '(':
                depth += 1
            elif c == ')':
                depth -= 1
            buf.append(c)
            i += 1
            continue
        if c == '#' and (not buf or buf[-1][-1:].isspace()):
            nl = s.find('\n', i)
            i = n if nl < 0 else nl
            continue
        two = s[i:i + 2]
        if two in ('&&', '||'):
            cut(two)
            i += 2
            continue
        if c == '&':
            prev = buf[-1][-1:] if buf else ''
            if prev in ('>', '<') or s[i + 1:i + 2] == '>':
                buf.append(c)
                i += 1
                continue
            cut('&')
            i += 1
            continue
        if c == '|':
            cut('|')
            i += 2 if s[i + 1:i + 2] == '&' else 1
            continue
        if c in (';', '\n'):
            cut(';')
            i += 1
            continue
        buf.append(c)
        i += 1
    cut(None)
    return [(seg.strip(), op) for seg, op in segs]

WRAPPER_PAIRS = {('uv', 'run'), ('poetry', 'run'), ('pipenv', 'run'), ('bundle', 'exec'), ('pnpm', 'exec'), ('pnpm', 'dlx'),
                 ('yarn', 'dlx'), ('yarn', 'exec'), ('npm', 'exec'), ('hatch', 'run'), ('rye', 'run'), ('pdm', 'run')}
WRAPPER_VALUE_FLAGS = {'sudo': ('-u', '-g', '-C', '-D', '-p', '-r', '-t', '-U', '-h'), 'env': ('-u', '--unset', '-C', '--chdir', '-S'),
                       'npx': ('-p', '--package', '-c'), 'pnpx': ('-p', '--package'), 'bunx': ('-p', '--package'),
                       'nice': ('-n', '--adjustment'), 'timeout': ('-s', '--signal', '-k', '--kill-after')}

def strip_wrappers(tokens):
    # FOO=1 sudo -E npx --yes vitest run -> [vitest, run]
    i, n = 0, len(tokens)
    while i < n:
        t = tokens[i]
        base = t.split('/')[-1]
        if ENV_ASSIGN.match(t):
            i += 1
            continue
        if base in ('sudo', 'env', 'npx', 'pnpx', 'bunx', 'time', 'nohup', 'exec', 'command', 'builtin', 'nice', 'timeout', 'stdbuf'):
            with_value = WRAPPER_VALUE_FLAGS.get(base, ())
            i += 1
            while i < n and (tokens[i].startswith('-') or (base == 'env' and ENV_ASSIGN.match(tokens[i]))):
                i += 2 if (tokens[i] in with_value) else 1
            if base == 'timeout' and i < n:
                i += 1  # the duration
            continue
        if i + 1 < n and (base, tokens[i + 1]) in WRAPPER_PAIRS:
            i += 2
            while i < n and tokens[i].startswith('-'):
                i += 1
            continue
        break
    return tokens[i:]

def tokenize(segment):
    try:
        import shlex
        tokens = shlex.split(segment, posix=True)
    except Exception:
        tokens = segment.split()
    # A subshell's parentheses and a group's braces are not part of the program
    while tokens and tokens[0] in ('(', '{', '!'):
        tokens = tokens[1:]
    if tokens and tokens[0][:1] in ('(', '{'):
        tokens[0] = tokens[0].lstrip('({')
    while tokens and tokens[-1] in (')', '}'):
        tokens = tokens[:-1]
    if tokens and tokens[-1][-1:] in (')', '}'):
        tokens[-1] = tokens[-1].rstrip(')}')
    # Redirections are not arguments (2>&1, >out.log, < in)
    out, skip = [], False
    for t in tokens:
        if skip:
            skip = False
            continue
        if re.match(r'^\d*(>>?|<|&>>?)$', t):
            skip = True
            continue
        if re.match(r'^\d*(>>?|<|&>>?)\S|^\d*>&\d$', t):
            continue
        out.append(t)
    return [t for t in out if t]

def classify_segments(command, cwd=None):
    # Every meaningful segment of a command, with what the outcome logic needs:
    # {kind, target?, branch?, toDefault?, masked, dir}
    out = []
    here = cwd if isinstance(cwd, str) and cwd else None
    prev_op = None
    for text, op in split_command(command):
        tokens = strip_wrappers(tokenize(text)) if text else []
        masked = op in ('|', '||', ';', '&') or prev_op == '||'
        prev_op = op
        if not tokens:
            continue
        prog = tokens[0].split('/')[-1]
        args = tokens[1:]
        if prog in ('cd', 'pushd') and args:
            dest = os.path.expanduser(args[0]) if args[0] != '-' else None
            if dest:
                here = os.path.normpath(os.path.join(here, dest)) if here else os.path.normpath(dest)
            continue
        if prog == 'git':
            gdir = flag_value(args, ('-C',))
            sub = positionals(args, ('-C', '-c', '--git-dir', '--work-tree', '--namespace'))
            if not sub or sub[0] != 'push':
                continue
            rest = args[args.index('push') + 1:] if 'push' in args else []
            where = os.path.normpath(os.path.join(here or '', gdir)) if gdir else here
            for entry in git_push(rest):
                entry.update({'masked': masked, 'dir': where})
                out.append(entry)
            continue
        if prog == 'gradlew':
            prog = 'gradle'
        if prog == 'mvnw':
            prog = 'mvn'
        hit = classify_program(prog, args)
        if not hit:
            continue
        kind, target = hit
        entry = {'kind': kind, 'masked': masked, 'dir': here}
        if target:
            entry['target'] = str(target)[:80]
        out.append(entry)
    return out

def classify_command(command, cwd=None):
    # The pure classifier: [{kind, target?, branch?, toDefault?}], one per
    # meaningful segment, deduplicated. A target the command does not name
    # comes from the directory a `cd` in the command moved to.
    seen, out = set(), []
    for e in classify_segments(command, cwd):
        entry = {'kind': e['kind']}
        target = e.get('target') or (name_of(e['dir']) if e.get('dir') and e['dir'] != cwd else None)
        if target:
            entry['target'] = target
        for key in ('branch', 'toDefault'):
            if key in e:
                entry[key] = e[key]
        key = json.dumps(entry, sort_keys=True)
        if key not in seen:
            seen.add(key)
            out.append(entry)
    return out

# What the output says about a run whose exit status was masked, and which
# segment a failed call should be blamed on
FAIL_PRINTS = {
    'test':   re.compile(r'\b[1-9]\d*\s+(?:failed|failing|failures?)\b|^\s*FAIL\b|^--- FAIL|test result: FAILED|FAILURES!|\bTests? failed\b', re.M | re.I),
    'build':  re.compile(r'error TS\d+|\bbuild failed\b|Failed to compile|error\[E\d+\]|error: could not compile|BUILD FAILURE|FAILURE: Build failed|make(?:\[\d+\])?: \*\*\*|^ERROR in |Compilation failed|Found [1-9]\d* errors?', re.M | re.I),
    'deploy': re.compile(r'\b(?:deploy(?:ment)?|release|rollout|publish(?:ing)?|upload)\b[^\n]{0,40}\b(?:failed|errored)\b|\bdeploy(?:ment)? error\b', re.I),
    'push':   re.compile(r'\[rejected\]|\[remote rejected\]|failed to push|non-fast-forward|could not read from remote|Authentication failed'),
}
PASS_PRINTS = {
    'test':  re.compile(r'\b[1-9]\d*\s+pass(?:ed|ing)\b|test result: ok\b|^ok\s|\bOK \(\d+ tests?|\b\d+ examples?, 0 failures', re.M | re.I),
    'build': re.compile(r'\bbuilt in\b|Compiled successfully|\bFinished\b.*\btarget\(s\)|BUILD SUCCESS|\bbuild succeeded\b', re.I),
}
ANSI = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]')
DECORATION = re.compile(r'^[\s\-=_*#~.+|>:─━═│┃╌┄⎯]*$')
ERRORISH = re.compile(r'error|fail|fatal|denied|not found|no such|cannot|could not|unable|refused|rejected|exception|panic|ERR!|timed out', re.I)

def output_tail(value, limit=6000):
    if isinstance(value, dict):
        text = '\n'.join(str(value.get(k) or '') for k in ('stdout', 'stderr', 'output'))
    else:
        text = str(value or '')
    return ANSI.sub('', text[-limit:])

def judged(kind, text):
    # A masked run, judged by its output: 'fail', 'ok' or None (silent)
    if FAIL_PRINTS[kind].search(text):
        return 'fail'
    if kind in PASS_PRINTS and PASS_PRINTS[kind].search(text):
        return 'ok'
    return None

def first_meaningful(text):
    lines = [ANSI.sub('', l).strip() for l in str(text or '').splitlines()]
    lines = [l for l in lines if l and not DECORATION.match(l)]
    for l in lines:
        if ERRORISH.search(l):
            return l
    return lines[0] if lines else ''

def failure_detail(kind, text):
    # "3 failing" for a test run, "2 errors" for a build, when the output says
    if kind == 'test':
        for pattern in (r'Tests?:?\s+([1-9]\d*)\s+failed', r'\b([1-9]\d*)\s+failing\b', r'\b([1-9]\d*)\s+failed\b',
                        r'\b([1-9]\d*)\s+failures?\b', r'Failures:\s*([1-9]\d*)'):
            m = re.search(pattern, text, re.I)
            if m:
                return f'{m.group(1)} failing'
        go = len(re.findall(r'^--- FAIL', text, re.M))
        if go:
            return f'{go} failing'
        m = re.search(r'^\s*(FAIL\b.*)$', text, re.M)
        if m:
            return one_line(m.group(1), 80)
    if kind == 'build':
        m = re.search(r'Found ([1-9]\d*) errors?', text)
        if m:
            return f'{m.group(1)} error{"" if m.group(1) == "1" else "s"}'
        n = len(re.findall(r'error TS\d+', text))
        if n:
            return f'{n} error{"" if n == 1 else "s"}'
    return None

GIT_HEAD_CACHE = {}

def current_branch(start):
    # The branch checked out where a bare `git push` runs: .git/HEAD of the
    # nearest repository (a worktree's .git file points at its own HEAD).
    # A handful of stats and one small read; None when it cannot be known.
    if not start or not os.path.isabs(start):
        return None
    here = start
    for _ in range(40):
        dotgit = os.path.join(here, '.git')
        try:
            if os.path.isdir(dotgit):
                head = os.path.join(dotgit, 'HEAD')
            elif os.path.isfile(dotgit):
                with open(dotgit) as fh:
                    line = fh.read(512).strip()
                if not line.startswith('gitdir:'):
                    return None
                gitdir = line[len('gitdir:'):].strip()
                head = os.path.join(gitdir if os.path.isabs(gitdir) else os.path.join(here, gitdir), 'HEAD')
            else:
                parent = os.path.dirname(here)
                if parent == here:
                    return None
                here = parent
                continue
            with open(head) as fh:
                ref = fh.read(256).strip()
            return ref[len('ref: refs/heads/'):] if ref.startswith('ref: refs/heads/') else None
        except Exception:
            return None
    return None

def bash_signals():
    # This Bash call's signals for the current hook phase ([] for most calls)
    inp = d.get('tool_input')
    inp = inp if isinstance(inp, dict) else {}
    command = inp.get('command')
    if not isinstance(command, str) or not command.strip():
        return []
    cwd = d.get('cwd') if isinstance(d.get('cwd'), str) else None
    segs = classify_segments(command, cwd)
    if not segs:
        return []
    phase = {'PreToolUse': 0, 'PostToolUse': 1, 'PostToolUseFailure': 2}.get(hook_event)
    if phase is None:
        return []
    outcomes = [None] * len(segs)
    error, exit_code, text, interrupted = None, None, '', False
    if phase == 0:
        outcomes = ['start'] * len(segs)
    elif phase == 1:
        # A backgrounded command is still running: its outcome comes later, if ever
        if inp.get('run_in_background'):
            return []
        resp = d.get('tool_response')
        interrupted = isinstance(resp, dict) and resp.get('interrupted') is True
        text = output_tail(resp)
        for i, s in enumerate(segs):
            outcomes[i] = 'fail' if interrupted else ('ok' if not s['masked'] else judged(s['kind'], text))
    else:
        err = str(d.get('error') or '')
        interrupted = d.get('is_interrupt') is True
        m = re.match(r'\s*Exit code (\d+)', err)
        if m:
            exit_code = int(m.group(1))
            text = ANSI.sub('', err[m.end():][-6000:])
        else:
            text = ANSI.sub('', err[-6000:])
        error = first_meaningful(text) or (f'exit code {exit_code}' if exit_code is not None else one_line(err, 200))
        if interrupted:
            outcomes = ['fail'] * len(segs)
        else:
            pointed = [i for i, s in enumerate(segs) if FAIL_PRINTS[s['kind']].search(text)]
            gates = [i for i, s in enumerate(segs) if not s['masked']]
            blamed = pointed[0] if pointed else (gates[0] if gates else None)
            for i, s in enumerate(segs):
                if i == blamed or (s['masked'] and i in pointed):
                    outcomes[i] = 'fail'
    project = SESSION.get('project')
    out, seen = [], set()
    for s, outcome in zip(segs, outcomes):
        if outcome is None:
            continue
        names = SIGNAL_NAMES[s['kind']]
        sig = {'kind': names[{'start': 0, 'ok': 1, 'fail': 2}[outcome]]}
        target = s.get('target') or name_of(s.get('dir')) or project
        if target:
            sig['target'] = str(target)[:80]
        if s['kind'] == 'push':
            branch = s.get('branch')
            if branch is None:
                branch = current_branch(s.get('dir'))
                if branch:
                    sig['branch'] = branch[:120]
                    sig['toDefault'] = branch in DEFAULT_BRANCHES
            else:
                sig['branch'] = branch[:120]
                sig['toDefault'] = bool(s.get('toDefault'))
        sig['command'] = clamp(command, 160)
        if outcome == 'fail':
            if interrupted:
                sig['interrupted'] = True
            if error:
                sig['error'] = clamp(error, 200)
            if exit_code is not None:
                sig['exitCode'] = exit_code
            detail = failure_detail(s['kind'], text)
            if detail:
                sig['detail'] = clamp(detail, 120)
        key = (sig['kind'], sig.get('target'), sig.get('branch'))
        if key in seen:
            continue
        seen.add(key)
        out.append(sig)
    return out[:MAX_SIGNALS]

def with_signals(event):
    # Attach this Bash call's signals to the event it sends anyway; a bug in
    # the classifier costs the signals, never the event
    if tool_name == 'Bash':
        try:
            signals = bash_signals()
        except Exception:
            signals = []
        if signals:
            event['signals'] = signals
    return event

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
# project Claude is working in) off sys.path. The first line is the event;
# a second line saying `wait` (PermissionRequest the office may answer) makes
# the POST a foreground one that waits for the answer.
PY_OUT=$(printf '%s' "$PAYLOAD" | python3 -I -c "$PY")
EVENT_JSON=$(printf '%s\n' "$PY_OUT" | sed -n 1p)
WAIT_FLAG=$(printf '%s\n' "$PY_OUT" | sed -n 2p)

# If Python produced no output, nothing to send
if [ -z "$EVENT_JSON" ]; then
    exit 0
fi

# Reads a server reply on stdin. `created`: the /event reply -> the pending
# permission's id, the poll length and the deadline. `poll`: a GET
# /permission/<id> reply -> its status, whether the deadline has passed, and
# the hookOutput to print (one JSON line) when the office decided. Fields are
# separated by the unit separator, which JSON never contains unescaped.
PY_REPLY=$(cat <<'PYREPLY'
import json, sys, time
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
    out = r.get('hookOutput')
    print('\x1f'.join([status, '1' if late else '0', json.dumps(out) if isinstance(out, dict) else '']))
PYREPLY
)

# PermissionRequest the office may answer: POST in the foreground, then poll
# the pending permission until it is decided here (print the hookOutput),
# answered in the terminal, expired or gone (print nothing). Any failure to
# reach the server ends the wait at once, silently.
answer_from_office() {
    local base="${SERVER_URL%/event}"
    local reply id poll_ms deadline wait_s status late hook_output polls=0
    reply=$(curl -sf -X POST "$SERVER_URL" \
        -H "Content-Type: application/json" "${AUTH_ARGS[@]}" \
        -d "$EVENT_JSON" --max-time 2 2>/dev/null) || return 0
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
        reply=$(curl -sf "$base/permission/$id?wait=$wait_s" "${AUTH_ARGS[@]}" \
            --max-time $((wait_s + 5)) 2>/dev/null) || return 0
        IFS=$'\x1f' read -r status late hook_output < <(printf '%s' "$reply" | python3 -I -c "$PY_REPLY" poll)
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
