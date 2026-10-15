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
# SubagentHandback tool call, on Claude Code versions that have one).
# Tool calls made inside a subagent carry that subagent's agent_id, which is
# forwarded so the server knows which office agent is doing the work.
#
# Signals: a Bash command that deploys, builds, tests or pushes is classified
# (classify_command, "Signals" in the Python below, with its pattern table)
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
# The Python source is the quoted heredoc below (tests/hook-script.test.ts
# lifts it out by the PYEOF markers); the payload goes to it on stdin, never
# through an environment variable or an argument: a PostToolUse carrying a
# big tool_response (a 300 KB file read is routine) is over the ~128 KiB
# single-argument limit and would fail the exec with E2BIG. No shell
# variables are interpolated into the Python source.
PY=$(cat <<'PYEOF'
import json, sys, os, re, hashlib

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

def _hmac_sha256_hex(key, msg):
    # HMAC-SHA256 per RFC 2104 on hashlib, which this pass already loads:
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

def sign_post(body):
    # The POST /event signature, computed HERE so the common path spends no
    # extra process on signing: HMAC-SHA256(token, POST\npath\nts\nbody) with
    # the token from the environment (never argv). '' when there is no token
    # (the wrapper then POSTs unsigned and the server answers 401). The GET
    # long-poll of the permission path re-signs per poll in the wrapper.
    token = os.environ.get('OFFICE_TOKEN', '')
    if not token:
        return ''
    import time
    path = _url_path(os.environ.get('OFFICE_POST_URL', ''))
    ts = str(int(time.time() * 1000))
    msg = ('POST\n' + path + '\n' + ts + '\n').encode() + body.encode()
    return ts + '\x1f' + _hmac_sha256_hex(token.encode(), msg)

def emit(event):
    # Every event the office receives says which session it belongs to
    for key, value in SESSION.items():
        event.setdefault(key, value)
    body = json.dumps(event)
    # Line 1: the event (the POST body). Line 2: its POST signature (or empty).
    # A later `wait` line (emit_session) becomes line 3.
    print(body)
    print(sign_post(body))

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
        event = {
            'type':    'agent_completed',
            'agentId': str(d['agent_id']),
            'result':  str(d.get('last_assistant_message') or 'done')[:120],
        }
        # The worker's own transcript (…/<session_id>/subagents/agent-<agent_id>.jsonl),
        # which the inspector card tails; a path string, nothing from inside it
        transcript = d.get('agent_transcript_path')
        if isinstance(transcript, str) and transcript:
            event['agentTranscriptPath'] = transcript[:400]
        emit(event)
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
# Which call asked: with no tool_use_id, the only thing a PermissionRequest
# shares with its own call's PostToolUse is the tool input (captured: the
# PreToolUse, the PermissionRequest and the batch entry of one call carry the
# same tool_input). call_key hashes the tool name and that input; the
# PermissionRequest and every PostToolUse send it, so the server lowers a hand
# only on the finish of the call that raised it, not on another call of the
# same tool running beside it (`git status` next to the `git push` that asked).
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

def call_key(name, inp):
    # 16 hex characters of sha256(tool name, NUL, the input as canonical JSON)
    try:
        blob = json.dumps(inp, sort_keys=True, separators=(',', ':'), ensure_ascii=False, default=str)
    except Exception:
        return ''
    return hashlib.sha256((str(name) + '\0' + blob).encode('utf-8', 'replace')).hexdigest()[:16]

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
        'callKey':  call_key(name, d.get('tool_input')),
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
        # A fresh nonce the office must echo back inside its proof. A squatter
        # answering the POST has never seen the token, so it cannot forge
        # HMAC(token, nonce + permissionId + decision) and its answer is
        # rejected before anything is printed.
        event['nonce'] = os.urandom(16).hex()
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
# (a denied one included). The server uses it to lower a permission hand the
# batch has answered, so a headless auto-deny (PermissionRequest, then this
# ~60 ms later) never shows. Inside a subagent (agent_id, captured) the batch
# is that worker's: it answers only a dialog the worker raised, and the
# worker's id travels so the server can tell.
if hook_event == 'PostToolBatch':
    calls = d.get('tool_calls')
    event = {'type': 'session_tool_done', 'batch': True, 'count': len(calls) if isinstance(calls, list) else 0}
    if d.get('agent_id'):
        event['agentId'] = str(d['agent_id'])
    emit_session(event)

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

# TaskCreated {task_id, task_subject, task_description?, teammate_name?} — the
# TaskCreate tool is making a task; TaskCompleted — TaskUpdate is setting one
# to completed. Shapes from the schema and the hooks reference (never fired
# here: this machine's sessions have no task tools). The task list itself is
# on disk (~/.claude/tasks/<session_id>/<n>.json) and the server reads it
# (server/tasks.js), so the event only names the task and says "look now";
# nothing is printed on stdout, which on these events could veto the change.
# The description stays here: it is longer, conversation-derived text, and
# the server serves it from the file only to a token holder.
if hook_event in ('TaskCreated', 'TaskCompleted'):
    task_id = one_line(d.get('task_id'), 40)
    if task_id:
        emit_session({
            'type':    'task_created' if hook_event == 'TaskCreated' else 'task_completed',
            'taskId':  task_id,
            'subject': one_line(d.get('task_subject'), 120),
        })
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
        # either way the transient worker leaves. The tool, the call_key and
        # the worker it ran in (if any) let the server lower the permission
        # hand this call raised, as session_tool_done does for other tools
        done = {
            'type':    'mcp_done',
            'server':  mcp_server,
            'tool':    mcp_tool,
            'callKey': call_key(tool_name, d.get('tool_input')),
        }
        if d.get('agent_id'):
            done['agentId'] = str(d['agent_id'])
        emit(done)
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
# Extending it is one row in SIGNAL_RULES (programs, the subcommand words
# that make it count, kind, the flags that take a value, where the target
# is, vetoes) — plus the program's name in SIGNAL_PROGRAMS or SIGNAL_NO_VERB
# below so the prefilter lets it through. npm/pnpm/yarn/bun scripts, make,
# gradle, mvn and git push have small functions of their own. A --dry-run,
# --version or --help run never counts.
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
# session_tool_done of a PostToolUse (a worker's carries its agentId). A
# PostToolUse without a session id sends nothing of its own, so there they go
# out alone as {type: 'signal', signals: [...]}, tagged with the subagent like
# any of its events. Each signal: kind, target, command (160), and on a
# failure error (the first meaningful line, 200), exitCode, detail ("3
# failing", "2 errors") and interrupted. Classification never changes the
# exit status and never fails the event it rides on. Cost: nothing on a
# command the prefilter rules out; ~5 ms on one it lets through (compiling
# the classifier, 0.1 ms to run it), a few more on a failure's patterns.
DEFAULT_BRANCHES = ('main', 'master')

# The prefilter. Most Bash calls (ls, cat, grep, git status, sed) can never
# be a signal, and every hook run is a fresh python3 that would compile the
# classifier and its patterns from scratch — ~10 ms on every call. So a
# command only reaches the classifier when one of its words is a program
# from the table and it either needs no verb (tsc, vitest, make, ...) or
# one of its words is a verb the table knows.
SIGNAL_PROGRAMS = frozenset((
    'vercel', 'netlify', 'fly', 'flyctl', 'railway', 'heroku', 'gcloud', 'aws', 'sam', 'serverless', 'sls', 'kubectl',
    'helm', 'terraform', 'tofu', 'pulumi', 'cdk', 'wrangler', 'firebase', 'gh', 'docker', 'podman', 'docker-compose',
    'npm', 'pnpm', 'yarn', 'bun', 'vite', 'next', 'cargo', 'go', 'gradle', 'gradlew', 'mvn', 'mvnw', 'dotnet', 'deno',
    'playwright', 'git', 'python', 'python3',
))
SIGNAL_NO_VERB = frozenset(('tsc', 'vue-tsc', 'webpack', 'esbuild', 'vitest', 'jest', 'mocha', 'pytest', 'py.test', 'rspec', 'phpunit', 'make', 'gmake'))
SIGNAL_VERBS = frozenset((
    'deploy', 'up', 'push', 'container:push', 'apply', 'rollout', 'upgrade', 'install', 'publish', 'create', 'build', 'buildx',
    'test', 't', 'tst', 'run', 'run-script', 'b', 'nextest', 'assemble', 'package', 'compile', 'verify', 'check', 'workspace',
    '--prod', '--production', '-m',
))

def might_signal(command):
    s = command
    for ch in ';|&()<>\'"`${}\n\t':
        s = s.replace(ch, ' ')
    words = {w.rsplit('/', 1)[-1] for w in s.split()}
    if words & SIGNAL_NO_VERB:
        return True
    if not words & SIGNAL_PROGRAMS:
        return False
    return bool(words & SIGNAL_VERBS) or any(w.startswith(('build', 'test', 'compile', 'typecheck', 'type-check', 'e2e', 'spec')) for w in words)

# The classifier itself is compiled only for a command that passed the
# prefilter (load_signals): kept as source here, it costs nothing on the
# calls that never need it. It reads this hook's globals (d, hook_event,
# SESSION, clamp, one_line) like the code around it.
SIGNALS_PY = r'''
SIGNAL_NAMES = {
    'deploy': ('deploy_start', 'deploy_success', 'deploy_fail'),
    'build':  ('build_start', 'build_ok', 'build_failed'),
    'test':   ('test_start', 'test_ok', 'test_failed'),
    'push':   ('push', 'push_done', 'push_failed'),
}
MAX_SIGNALS = 8
NEVER_FLAGS = ('--dry-run', '--version', '--help')

def is_assign(t):
    key, eq, _ = t.partition('=')
    return bool(eq) and key.isidentifier()

def is_tag(ref):
    return ref.startswith('refs/tags/') or (ref[:1] == 'v' and ref[1:2].isdigit())

def positionals(args, with_value=()):
    # The non-flag arguments, skipping the values of the flags that take one
    out, i = [], 0
    while i < len(args):
        a = args[i]
        if a == '--':
            return out + args[i + 1:]
        if a.startswith('-') and len(a) > 1:
            i += 2 if (a in with_value and '=' not in a) else 1
            continue
        out.append(a)
        i += 1
    return out

def flag_value(args, names):
    # `-x v`, `--name v`, `--name=v` or `-chdir=v`
    for i, a in enumerate(args):
        for n in names:
            if a == n and i + 1 < len(args):
                return args[i + 1]
            if a.startswith(n + '='):
                return a[len(n) + 1:]
    return None

def name_of(value):
    # A directory, package, release or image as a display name: its last
    # path segment, without an image tag ("ghcr.io/me/api:1.2" -> "api");
    # a config file stands for its directory (packages/api/tsconfig.json -> api)
    parts = str(value or '').strip().rstrip('/').split('/')
    if parts[-1].endswith(('.json', '.yaml', '.yml', '.toml')):
        parts = parts[:-1] or ['']
    last = parts[-1].split('@')[0].split(':')[0]
    return last if last not in ('', '.', '..', '~', '-', '*') else None

def script_kind(name):
    # npm-style script names: build, build:electron, typecheck, test:e2e, ...
    for kind, heads in (('build', ('build', 'compile', 'typecheck', 'type-check', 'tsc')), ('test', ('test', 'tests', 'e2e', 'spec'))):
        for h in heads:
            if name == h or (name.startswith(h) and name[len(h)] in ':-_.'):
                return kind
    return None

PM_VALUE_FLAGS = ('--prefix', '-w', '--workspace', '--filter', '-F', '-C', '--dir', '--cwd')

def package_manager(prog, args):
    pos = positionals(args, PM_VALUE_FLAGS)
    target = name_of(flag_value(args, ('--filter', '-F', '--workspace', '-w', '--prefix', '-C', '--dir', '--cwd')))
    if pos[:1] == ['workspace'] and len(pos) > 2:
        target, pos = name_of(pos[1]), pos[2:]
    if not pos:
        return None
    if pos[0] == 'publish' or pos[:2] == ['npm', 'publish']:
        return ('deploy', target)
    if pos[0] in ('run', 'run-script'):
        script = pos[1] if len(pos) > 1 else ''
    elif prog == 'npm' and pos[0] in ('t', 'tst'):
        script = 'test'
    else:
        script = pos[0]
    kind = script_kind(script)
    return (kind, target) if kind else None

def make(args):
    goals = [a for a in positionals(args, ('-C', '--directory', '-f', '--file', '-j', '-l', '-I', '-o', '-W')) if '=' not in a]
    goal = goals[0] if goals else ''
    target = name_of(flag_value(args, ('-C', '--directory')))
    if goal in ('clean', 'distclean', 'mrproper', 'help', 'fmt', 'format', 'lint', 'deps', 'install-deps'):
        return None
    if goal in ('test', 'tests', 'check'):
        return ('test', target)
    return ('deploy' if goal in ('deploy', 'release', 'publish') else 'build', target)

def gradle(args):
    tasks = [t.split(':')[-1] for t in positionals(args, ('-p', '--project-dir', '-x'))]
    if any(t in ('build', 'assemble', 'jar', 'bootJar', 'shadowJar', 'compileJava', 'compileKotlin') for t in tasks):
        return ('build', None)
    return ('test', None) if any(t in ('test', 'check') for t in tasks) else None

def maven(args):
    phases = positionals(args, ('-pl', '-f', '-P', '-s'))
    target = name_of(flag_value(args, ('-pl',)))
    if 'deploy' in phases:
        return ('deploy', target)
    if any(p in ('package', 'install', 'compile', 'verify') for p in phases):
        return ('build', target)
    return ('test', target) if 'test' in phases else None

KUBECTL = ('-n', '--namespace', '--context', '--kubeconfig', '-s', '--server', '--cluster', '--user', '-f', '--filename', '-l', '--selector')
DOCKER = ('-t', '--tag', '-f', '--file', '-H', '--host', '--context', '--platform')
CARGO = ('-p', '--package', '--manifest-path', '--target', '-j', '--features')
VERCEL_OTHER = ('env', 'login', 'logout', 'dev', 'link', 'logs', 'ls', 'list', 'pull', 'whoami', 'domains', 'alias',
                'rm', 'remove', 'inspect', 'secrets', 'teams', 'projects', 'certs', 'dns', 'build', 'promote', 'rollback')

# (programs, the leading positionals that make it count ('*' = any word,
# () = always), kind, flags that take a value, where the target is: flag
# names, or the index of a positional after the matched words, or None,
# words that veto it). First row that matches wins.
SIGNAL_RULES = (
    (('vercel',), (('deploy',),), 'deploy', ('--scope', '-t', '--token', '-A', '--local-config'), None, ()),
    (('netlify',), (('deploy',),), 'deploy', ('--site', '-s', '--dir', '-d'), ('--site',), ()),
    (('fly', 'flyctl'), (('deploy',),), 'deploy', ('-a', '--app', '-c', '--config'), ('-a', '--app'), ()),
    (('railway',), (('up',),), 'deploy', ('-s', '--service', '-e', '--environment'), ('-s', '--service'), ()),
    (('gcloud',), (('run', 'deploy'), ('functions', 'deploy')), 'deploy', ('--project', '--region', '--image', '--source'), 0, ()),
    (('gcloud',), (('app', 'deploy'),), 'deploy', ('--project',), None, ()),
    (('aws',), (('deploy',), ('*', 'deploy')), 'deploy', ('--profile', '--region', '--output'), ('--stack-name',), ()),
    (('sam', 'serverless', 'sls', 'cdk', 'firebase'), (('deploy',),), 'deploy',
     ('--profile', '-c', '--context', '-a', '--app', '-P', '--project', '--only', '--stage', '-s'), ('--stack-name',), ()),
    (('kubectl',), (('apply',), ('rollout', 'restart'), ('rollout', 'undo'), ('rollout', 'resume'), ('rollout', 'status')), 'deploy', KUBECTL, 0, ()),
    (('helm',), (('upgrade',), ('install',)), 'deploy', ('-n', '--namespace', '--kube-context', '-f', '--values', '--set', '--version', '--timeout'), 0, ()),
    (('terraform', 'tofu'), (('apply',),), 'deploy', (), ('-chdir',), ()),
    (('pulumi',), (('up',),), 'deploy', ('-s', '--stack', '-C', '--cwd'), ('-s', '--stack'), ()),
    (('wrangler',), (('deploy',), ('publish',), ('pages', 'deploy')), 'deploy', ('-c', '--config', '-e', '--env', '--name', '--project-name'), ('--name', '--project-name'), ()),
    (('gh',), (('release', 'create'),), 'deploy', ('-R', '--repo'), None, ()),
    (('docker', 'podman'), (('push',), ('image', 'push')), 'deploy', DOCKER, 0, ()),
    (('docker', 'podman'), (('build',), ('buildx', 'build'), ('compose', 'build'), ('image', 'build'), ('builder', 'build')), 'build', DOCKER, ('-t', '--tag'), ()),
    (('docker-compose',), (('build',),), 'build', ('-f', '--file', '-p', '--project-name'), None, ()),
    (('vite', 'next'), (('build',),), 'build', (), None, ()),
    (('cargo',), (('build',), ('b',)), 'build', CARGO, ('-p', '--package'), ()),
    (('cargo',), (('test',), ('t',), ('nextest',)), 'test', CARGO, ('-p', '--package'), ()),
    (('go', 'dotnet'), (('build',), ('publish',)), 'build', (), None, ()),
    (('go', 'dotnet', 'deno'), (('test',),), 'test', (), None, ()),
    (('playwright',), (('test',),), 'test', ('-c', '--config', '--project'), None, ()),
    (('tsc', 'vue-tsc'), ((),), 'build', (), ('-p', '--project'), ('--init', '-v', '--showConfig', '-w', '--watch')),
    (('webpack',), ((),), 'build', (), None, ('serve', 'init', 'info')),
    (('esbuild',), ((),), 'build', (), None, ('--serve',)),
    (('vitest',), ((),), 'test', (), None, ('bench', 'init', 'list')),
    (('jest', 'mocha', 'pytest', 'py.test', 'rspec', 'phpunit'), ((),), 'test', (), None, ()),
)

def classify_program(prog, args):
    # One segment's program and arguments -> (kind, target) or None
    words = [a.split('=')[0] for a in args]
    if any(w in NEVER_FLAGS for w in words):
        return None
    if prog in ('npm', 'pnpm', 'yarn', 'bun'):
        return package_manager(prog, args)
    if prog in ('make', 'gmake'):
        return make(args)
    if prog in ('gradle', 'gradlew'):
        return gradle(args)
    if prog in ('mvn', 'mvnw'):
        return maven(args)
    if prog.startswith('python') and args[:1] == ['-m'] and args[1:2] in (['pytest'], ['unittest'], ['nose2']):
        return ('test', None)
    if prog == 'heroku' and any(a == 'push' or a.endswith(':push') for a in args):
        return ('deploy', name_of(flag_value(args, ('-a', '--app'))))
    if prog == 'vercel' and ('--prod' in args or '--production' in args):
        pos = positionals(args, ('--scope', '-t', '--token', '-A', '--local-config'))
        if not pos or pos[0] not in VERCEL_OTHER:
            return ('deploy', None)
    for progs, prefixes, kind, with_value, where, unless in SIGNAL_RULES:
        if prog not in progs:
            continue
        pos = positionals(args, with_value)
        for prefix in prefixes:
            if len(pos) >= len(prefix) and all(p == '*' or p == q for p, q in zip(prefix, pos)):
                # A veto is a subcommand (webpack serve) or a flag (tsc --watch)
                if (pos[:1] and pos[0] in unless) or any(w in unless for w in words if w.startswith('-')):
                    return None
                if isinstance(where, int):
                    rest = pos[len(prefix):]
                    target = name_of(rest[where]) if len(rest) > where else None
                else:
                    target = name_of(flag_value(args, where)) if where else None
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
        else:
            pos.append(a)
        i += 1
    if flags & {'-n', '--dry-run', '-d', '--delete', '--prune'}:
        return []
    if pos and pos[0].startswith('heroku'):
        return [{'kind': 'deploy'}]
    dests = []
    for ref in pos[1:]:
        ref = ref.lstrip('+').split(':')[-1]
        ref = ref[len('refs/heads/'):] if ref.startswith('refs/heads/') else ref
        if ref:
            dests.append(ref)
    tags = [x for x in dests if is_tag(x)]
    branches = [x for x in dests if not is_tag(x)]
    out = [{'kind': 'deploy'}] if tags or flags & {'--tags', '--follow-tags'} else []
    if not branches and (tags or '--tags' in flags):
        return out
    entry = {'kind': 'push'}
    named = [b for b in branches if b != 'HEAD']
    if named and not flags & {'--all', '--mirror', '--branches'}:
        entry['branch'] = named[0]
        entry['toDefault'] = any(b in DEFAULT_BRANCHES for b in named)
    return out + [entry]

def split_command(command):
    # [(segment, operator after it)]: split on && || ; | & and newlines
    # outside quotes, backticks and $(...). 2>&1, &> and >&2 are
    # redirections, not operators; a heredoc body is never read as commands.
    s = str(command or '')
    h = s.find('<<')
    if h >= 0 and s[h + 2:h + 3] != '<':
        nl = s.find('\n', h)
        s = s if nl < 0 else s[:nl]
    segs, buf, quote, depth, i, n = [], [], None, 0, 0, len(s)
    while i < n:
        c = s[i]
        two = s[i:i + 2]
        if quote:
            if c == '\\' and quote == '"':
                buf.append(two)
                i += 2
                continue
            quote = None if c == quote else quote
        elif c == '\\':
            buf.append(two)
            i += 2
            continue
        elif c in '"\'`':
            quote = c
        elif two == '$(':
            depth += 1
            buf.append(two)
            i += 2
            continue
        elif depth:
            depth += {'(': 1, ')': -1}.get(c, 0)
        elif c == '#' and (not buf or buf[-1][-1:].isspace()):
            nl = s.find('\n', i)
            i = n if nl < 0 else nl
            continue
        elif two in ('&&', '||') or c in ';\n|' or (c == '&' and s[i + 1:i + 2] != '>' and (buf[-1][-1:] if buf else '') not in '<>'):
            op = two if two in ('&&', '||') else ';' if c in ';\n' else c
            segs.append((''.join(buf).strip(), op))
            buf = []
            i += 2 if (two in ('&&', '||', '|&')) else 1
            continue
        buf.append(c)
        i += 1
    segs.append((''.join(buf).strip(), None))
    return segs

WRAPPERS = ('sudo', 'env', 'npx', 'pnpx', 'bunx', 'time', 'nohup', 'exec', 'command', 'builtin', 'nice', 'timeout', 'stdbuf')
WRAPPER_PAIRS = (('uv', 'run'), ('poetry', 'run'), ('pipenv', 'run'), ('bundle', 'exec'), ('pnpm', 'exec'), ('pnpm', 'dlx'),
                 ('yarn', 'dlx'), ('yarn', 'exec'), ('npm', 'exec'), ('hatch', 'run'), ('rye', 'run'), ('pdm', 'run'))
WRAPPER_VALUES = ('-u', '-g', '-C', '-D', '-p', '-r', '-U', '--unset', '--chdir', '-S', '--package', '-c', '-n', '--adjustment', '-s', '--signal', '-k', '--kill-after')

def strip_wrappers(tokens):
    # FOO=1 sudo -E npx --yes vitest run -> [vitest, run]
    i, n = 0, len(tokens)
    while i < n:
        base = tokens[i].rsplit('/', 1)[-1]
        if is_assign(tokens[i]):
            i += 1
        elif base in WRAPPERS:
            i += 1
            while i < n and (tokens[i].startswith('-') or (base == 'env' and is_assign(tokens[i]))):
                i += 2 if tokens[i] in WRAPPER_VALUES else 1
            i += 1 if base == 'timeout' else 0  # its duration
        elif i + 1 < n and (base, tokens[i + 1]) in WRAPPER_PAIRS:
            i += 2
            while i < n and tokens[i].startswith('-'):
                i += 1
        else:
            break
    return tokens[i:]

def tokenize(segment):
    import shlex
    try:
        tokens = shlex.split(segment)
    except ValueError:
        tokens = segment.split()
    # A subshell's parentheses, a group's braces and redirections are not arguments
    if tokens:
        tokens[0] = tokens[0].lstrip('({!')
        tokens[-1] = tokens[-1].rstrip(')}')
    out, skip = [], False
    for t in tokens:
        op = t.lstrip('0123456789')
        if skip or not t:
            skip = False
            continue
        if op in ('>', '>>', '<', '&>', '&>>'):
            skip = True
        elif not op.startswith(('>', '<', '&>')):
            out.append(t)
    return out

def classify_segments(command, cwd=None, stats=None):
    # Every meaningful segment, with what the outcome logic needs:
    # {kind, target?, branch?, toDefault?, masked, dir, seg}. `stats`, when
    # given, gets 'gates': how many segments of the WHOLE chain decide its
    # exit status (unmasked), classified or not, so a failure is never
    # pinned on a deploy when an unclassified `npm ci` before it could just
    # as well have been the one that failed. A `cd` is not counted: it rarely
    # fails, and `cd api && npm test` is the commonest chain there is.
    out, here, prev = [], cwd if isinstance(cwd, str) and cwd else None, None
    gates = 0
    for seg, (text, op) in enumerate(split_command(command)):
        masked = op in ('|', '||', ';', '&') or prev == '||'
        prev = op
        tokens = strip_wrappers(tokenize(text)) if text else []
        if not tokens:
            continue
        prog, args = tokens[0].rsplit('/', 1)[-1], tokens[1:]
        if prog in ('cd', 'pushd') and args and args[0] != '-':
            here = os.path.normpath(os.path.join(here or '', os.path.expanduser(args[0])))
            continue
        if not masked:
            gates += 1
            if stats is not None:
                stats['gates'] = gates
        if prog == 'git':
            sub = positionals(args, ('-C', '-c', '--git-dir', '--work-tree', '--namespace'))
            if sub[:1] == ['push']:
                gdir = flag_value(args, ('-C',))
                where = os.path.normpath(os.path.join(here or '', gdir)) if gdir else here
                for entry in git_push(args[args.index('push') + 1:]):
                    out.append(dict(entry, masked=masked, dir=where, seg=seg))
            continue
        hit = classify_program(prog, args)
        if hit:
            entry = {'kind': hit[0], 'masked': masked, 'dir': here, 'seg': seg}
            if hit[1]:
                entry['target'] = hit[1][:80]
            out.append(entry)
    return out

def classify_command(command, cwd=None):
    # The pure classifier: [{kind, target?, branch?, toDefault?}], one per
    # meaningful segment, without repeats. A target the command does not
    # name comes from the directory a `cd` in it moved to.
    out = []
    for e in classify_segments(command, cwd):
        entry = {'kind': e['kind']}
        target = e.get('target') or (name_of(e['dir']) if e['dir'] and e['dir'] != cwd else None)
        if target:
            entry['target'] = target
        entry.update({k: e[k] for k in ('branch', 'toDefault') if k in e})
        if entry not in out:
            out.append(entry)
    return out

# What a failed or masked run's output says, by kind; compiled on first use
FAIL_PRINTS = {
    'test':   r'\b[1-9]\d*\s+(?:failed|failing|failures?)\b|^\s*FAIL\b|^--- FAIL|FAILURES!|\btests? failed\b',
    'build':  r'error TS\d+|\bbuild failed\b|Failed to compile|error\[E\d+\]|could not compile|BUILD FAILURE|FAILURE: Build failed|make(?:\[\d+\])?: \*\*\*|^ERROR in |Found [1-9]\d* errors?',
    'deploy': r'\b(?:deploy(?:ment)?|release|rollout|publish(?:ing)?|upload)\b[^\n]{0,40}\b(?:failed|errored)\b',
    'push':   r'\[(?:remote )?rejected\]|failed to push|non-fast-forward|could not read from remote|Authentication failed',
}
PASS_PRINTS = {
    'test':  r'\b[1-9]\d*\s+pass(?:ed|ing)\b|test result: ok\b|^ok\s|\bOK \(\d+ tests?|\b\d+ examples?, 0 failures',
    'build': r'\bbuilt in\b|Compiled successfully|BUILD SUCCESS|\bbuild succeeded\b',
}
ERROR_WORDS = ('error', 'fail', 'fatal', 'denied', 'not found', 'no such', 'cannot', 'could not', 'unable', 'refused', 'rejected', 'exception', 'panic', 'timed out')

def prints(table, kind, text):
    return kind in table and re.search(table[kind], text, re.M | re.I) is not None

def plain(text):
    # Output as text: the last 6000 characters, colour codes removed
    text = str(text or '')[-6000:]
    return re.sub(r'\x1b\[[0-9;?]*[ -/]*[@-~]', '', text) if '\x1b' in text else text

def judged(kind, text):
    # A masked run, judged by its output: 'fail', 'ok' or None (silent)
    if prints(FAIL_PRINTS, kind, text):
        return 'fail'
    return 'ok' if prints(PASS_PRINTS, kind, text) else None

def first_meaningful(text):
    lines = [l.strip() for l in text.splitlines()]
    lines = [l for l in lines if any(ch.isalnum() for ch in l)]
    for l in lines:
        if any(w in l.lower() for w in ERROR_WORDS):
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
        go = text.count('\n--- FAIL') + text.startswith('--- FAIL')
        if go:
            return f'{go} failing'
        m = re.search(r'^\s*(FAIL\b.*)$', text, re.M)
        return one_line(m.group(1), 80) if m else None
    if kind == 'build':
        n = re.search(r'Found ([1-9]\d*) errors?', text)
        n = int(n.group(1)) if n else text.count('error TS')
        return f'{n} error{"" if n == 1 else "s"}' if n else None
    return None

def current_branch(start):
    # The branch checked out where a bare `git push` runs: .git/HEAD of the
    # nearest repository (a worktree's .git file points at its own HEAD).
    # A few stats and one small read; None when it cannot be known.
    here = start if isinstance(start, str) and os.path.isabs(start) else None
    while here:
        dotgit = os.path.join(here, '.git')
        try:
            if os.path.isfile(dotgit):
                with open(dotgit) as fh:
                    line = fh.read(512).strip()
                if not line.startswith('gitdir:'):
                    return None
                dotgit = os.path.join(here, line[len('gitdir:'):].strip())
            elif not os.path.isdir(dotgit):
                parent = os.path.dirname(here)
                here = parent if parent != here else None
                continue
            with open(os.path.join(dotgit, 'HEAD')) as fh:
                ref = fh.read(256).strip()
        except OSError:
            return None
        return ref[len('ref: refs/heads/'):] if ref.startswith('ref: refs/heads/') else None
    return None

def bash_signals():
    # This Bash call's signals for the current hook phase
    inp = d.get('tool_input') if isinstance(d.get('tool_input'), dict) else {}
    command = inp.get('command')
    phase = ('PreToolUse', 'PostToolUse', 'PostToolUseFailure').index(hook_event)
    cwd = d.get('cwd') if isinstance(d.get('cwd'), str) else None
    chain = {'gates': 0}
    segs = classify_segments(command, cwd, chain)
    if not segs or (phase == 1 and inp.get('run_in_background')):
        return []  # a backgrounded command is still running: no outcome yet
    error = exit_code = None
    text, interrupted = '', False
    if phase == 0:
        outcomes = ['start'] * len(segs)
    elif phase == 1:
        resp = d.get('tool_response')
        interrupted = isinstance(resp, dict) and resp.get('interrupted') is True
        text = plain('\n'.join(str(resp.get(k) or '') for k in ('stdout', 'stderr')) if isinstance(resp, dict) else resp)
        outcomes = ['fail' if interrupted else 'ok' if not s['masked'] else judged(s['kind'], text) for s in segs]
    else:
        err = str(d.get('error') or '')
        interrupted = d.get('is_interrupt') is True
        head, _, rest = err.partition('\n')
        if head.startswith('Exit code ') and head[10:].strip().isdigit():
            exit_code, err = int(head[10:].strip()), rest
        text = plain(err)
        error = first_meaningful(text) or (f'exit code {exit_code}' if exit_code is not None else '')
        # A lone segment that decides the exit status is the culprit; only a
        # chain needs the output to say which of its segments failed. With no
        # pointer in the output, the first classified gate is blamed only
        # when every gate of the chain is classified: `npm ci && vercel
        # deploy` failing on npm says nothing about the deploy, which never ran
        alone = len(segs) == 1 and not segs[0]['masked'] and chain['gates'] == 1
        pointed = [] if alone else [i for i, s in enumerate(segs) if prints(FAIL_PRINTS, s['kind'], text)]
        gates = [i for i, s in enumerate(segs) if not s['masked']]
        all_known = chain['gates'] == len({segs[i]['seg'] for i in gates})
        blamed = (pointed or (gates if all_known else []) or [None])[0]
        outcomes = ['fail' if interrupted or i == blamed or (s['masked'] and i in pointed) else None for i, s in enumerate(segs)]
    out = []
    for s, outcome in zip(segs, outcomes):
        if outcome is None:
            continue
        sig = {'kind': SIGNAL_NAMES[s['kind']][('start', 'ok', 'fail').index(outcome)]}
        target = s.get('target') or name_of(s['dir']) or SESSION.get('project')
        if target:
            sig['target'] = target[:80]
        if s['kind'] == 'push':
            branch = s['branch'] if 'branch' in s else current_branch(s['dir'])
            if branch:
                sig['branch'] = branch[:120]
                sig['toDefault'] = s['toDefault'] if 'toDefault' in s else branch in DEFAULT_BRANCHES
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
        if not any(o['kind'] == sig['kind'] and o.get('target') == sig.get('target') and o.get('branch') == sig.get('branch') for o in out):
            out.append(sig)
    return out[:MAX_SIGNALS]
'''

SIGNALS_LOADED = False

def load_signals():
    # Compile the classifier into this module's globals, once
    global SIGNALS_LOADED
    if not SIGNALS_LOADED:
        exec(compile(SIGNALS_PY, 'agent-tracker signals', 'exec'), globals())
        SIGNALS_LOADED = True

def with_signals(event):
    # Attach this Bash call's signals to the event it sends anyway. A command
    # the prefilter rules out costs nothing more; a bug in the classifier
    # costs the signals, never the event.
    inp = d.get('tool_input')
    command = inp.get('command') if isinstance(inp, dict) else None
    if tool_name != 'Bash' or not isinstance(command, str) or not might_signal(command):
        return event
    try:
        load_signals()
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
    emit(with_signals(tag_subagent({
        'type':   'agent_working',
        'status': f"failed: {tool_name} — {error_summary(d.get('error'))}",
        'failed': True,
        'tool':   str(tool_name)[:80],
    })))
    sys.exit(0)

# ── A tool call finished — PostToolUse of anything but the Agent and MCP
# tools handled above, on the main thread or inside a worker (agentId).
# Nothing to draw, but the permission hand this very call raised (call_key)
# comes down on the server: the call ran, so it was granted. A worker's
# dialog is the worker's: its own finish is what answers it.
# A Bash call's signals ride on the session_tool_done; where nothing would be
# sent (no session id) they go out alone as a `signal` event.
if hook_event == 'PostToolUse':
    done = with_signals({'type': 'session_tool_done', 'toolName': str(tool_name)[:80], 'callKey': call_key(tool_name, d.get('tool_input'))})
    if sub_agent_id:
        done['agentId'] = str(sub_agent_id)
    if SESSION.get('sessionId'):
        emit_session(done)
    if done.get('signals'):
        emit(tag_subagent({'type': 'signal', 'signals': done['signals']}))
    sys.exit(0)

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
    # The tool's own name travels beside the status line: the inspector card
    # counts calls per tool, and the status is a phrase, not an identifier
    emit(with_signals(tag_subagent({
        'type': 'agent_working',
        'status': status,
        'tool': str(tool_name)[:80],
    })))

sys.exit(0)
PYEOF
)

# -I: ignore PYTHON* env vars and the user site, and keep the cwd (the
# project Claude is working in) off sys.path. The token and the event URL go
# in through the environment (never argv) so the Python can sign the POST in
# this one process — the common path spends no extra process on signing.
# Line 1 is the event, line 2 its POST signature ("ts<US>sig", or empty), and
# line 3 is `wait` for a PermissionRequest the office may answer.
PY_OUT=$(printf '%s' "$PAYLOAD" | OFFICE_TOKEN="$TOKEN" OFFICE_POST_URL="$SERVER_URL" python3 -I -c "$PY")
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
PY_SIGN=$(cat <<'PYSIGN'
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
)

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
PY_REPLY=$(cat <<'PYREPLY'
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
)

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
