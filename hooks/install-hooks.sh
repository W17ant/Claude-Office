#!/usr/bin/env bash
# =============================================================================
# install-hooks.sh — Add Agent Office hook to ~/.claude/settings.json
#
# This script:
#   1. Backs up the existing settings file
#   2. Registers agent-tracker.sh for PreToolUse (spawns + tool activity),
#      PostToolUse (completions), PostToolUseFailure (failed tool calls),
#      SubagentStart (subagent ids), SubagentStop (subagents finishing),
#      SessionStart and SessionEnd (one session pill per Claude Code terminal)
#   3. Registers status-line.sh as the statusLine (+ subagentStatusLine)
#      command — the payroll / electricity / memory meters — chaining any
#      status line you already had (--no-status-line skips this step)
#   4. Prints next steps
#
# Safe to re-run: each hook event is checked separately, so an older install
# gets any missing entries added, and an entry that still points at a checkout
# you have since moved, re-cloned or deleted is repointed at this one. Hooks
# that are not ours are never touched.
#
# Usage:
#   bash hooks/install-hooks.sh [--no-status-line]
# =============================================================================

set -euo pipefail

# --no-status-line: register the hooks only (no payroll / electricity / memory meters)
STATUS_LINE=1
for arg in "$@"; do
    case "$arg" in
        --no-status-line|--no-statusline) STATUS_LINE=0 ;;
        -h|--help)
            echo "Usage: bash hooks/install-hooks.sh [--no-status-line]"
            exit 0
            ;;
        *)
            echo "Unknown option: $arg (try --no-status-line)" >&2
            exit 1
            ;;
    esac
done

SETTINGS_FILE="$HOME/.claude/settings.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRACKER_SCRIPT="$SCRIPT_DIR/agent-tracker.sh"
HOOK_COMMAND="bash \"$TRACKER_SCRIPT\""

# Colours
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════╗${RESET}"
echo -e "${CYAN}║    Agent Office — Hook Installer          ║${RESET}"
echo -e "${CYAN}╚═══════════════════════════════════════════╝${RESET}"
echo ""

# ---------------------------------------------------------------------------
# Validate tracker script exists and is executable
# ---------------------------------------------------------------------------
if [ ! -f "$TRACKER_SCRIPT" ]; then
    echo -e "${RED}[error]${RESET} Tracker script not found: $TRACKER_SCRIPT"
    echo "        Make sure you run this from the agent-office project directory."
    exit 1
fi

chmod +x "$TRACKER_SCRIPT"
echo -e "${GREEN}[ok]${RESET} Tracker script: $TRACKER_SCRIPT"

# ---------------------------------------------------------------------------
# Ensure ~/.claude directory exists
# ---------------------------------------------------------------------------
mkdir -p "$(dirname "$SETTINGS_FILE")"

# ---------------------------------------------------------------------------
# Create settings file if it does not exist
# ---------------------------------------------------------------------------
if [ ! -f "$SETTINGS_FILE" ]; then
    echo -e "${YELLOW}[info]${RESET} Creating $SETTINGS_FILE"
    echo '{}' > "$SETTINGS_FILE"
fi

# ---------------------------------------------------------------------------
# Backup existing settings
# ---------------------------------------------------------------------------
BACKUP_FILE="${SETTINGS_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
cp "$SETTINGS_FILE" "$BACKUP_FILE"
echo -e "${GREEN}[ok]${RESET} Backup saved: $BACKUP_FILE"

# A merge step that fails leaves the backup as the way back
merge_failed() {
    echo -e "${RED}[error]${RESET} Could not update $SETTINGS_FILE — your previous settings are in $BACKUP_FILE" >&2
    exit 1
}

# ---------------------------------------------------------------------------
# Merge hook entries into settings JSON using Python
#
# An entry is ours when its command names agent-tracker.sh. One that points
# at this checkout is left alone; one that points anywhere else (a moved or
# deleted checkout, a pruned worktree, a second clone) is repointed in place,
# otherwise Claude Code reports a hook error on every tool call and the office
# never hears about it. Shapes Claude Code itself would reject ("hooks" not an
# object, an event given as one group instead of a list, entries that are not
# objects) are repaired or ignored instead of crashing the install.
# ---------------------------------------------------------------------------
echo -e "${CYAN}[...]${RESET} Registering PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop, SessionStart + SessionEnd hooks..."

python3 - "$SETTINGS_FILE" "$HOOK_COMMAND" "$TRACKER_SCRIPT" <<'PYEOF' || merge_failed
import json, os, shlex, sys

settings_path, hook_command, tracker_script = sys.argv[1:4]
SCRIPT_NAME = os.path.basename(tracker_script)

with open(settings_path, 'r') as f:
    try:
        settings = json.load(f)
    except json.JSONDecodeError:
        settings = {}

def kind(value):
    return 'null' if value is None else type(value).__name__

def warn(message):
    print(f'  [warn] {message} (the backup keeps the old value)')

if not isinstance(settings, dict):
    warn(f'settings file holds a JSON {kind(settings)}, not an object; starting from {{}}')
    settings = {}

hooks = settings.get('hooks')
if not isinstance(hooks, dict):
    if 'hooks' in settings:
        warn(f'"hooks" is a JSON {kind(hooks)}, not an object; replaced with {{}}')
    hooks = settings['hooks'] = {}

def script_path(command):
    # The agent-tracker.sh path a hook command names, or None when the hook is not ours
    if not isinstance(command, str) or SCRIPT_NAME not in command:
        return None
    try:
        words = shlex.split(command)
    except ValueError:
        words = command.split()
    return next((w for w in words if os.path.basename(w) == SCRIPT_NAME), command)

def is_current(path):
    return os.path.realpath(os.path.expanduser(path)) == os.path.realpath(tracker_script)

added = updated = unchanged = 0
for event in ('PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'SessionStart', 'SessionEnd'):
    groups = hooks.get(event)
    if isinstance(groups, dict):
        # One group written where Claude Code expects a list of them
        print(f'  [warn] "hooks.{event}" is a single object, wrapped in a list')
        groups = [groups]
    elif not isinstance(groups, list):
        if event in hooks:
            warn(f'"hooks.{event}" is a JSON {kind(groups)}, not a list; replaced with []')
        groups = []
    hooks[event] = groups

    # (group, hook) pairs that run agent-tracker.sh; anything not shaped like a hook is left as is
    ours = [
        (group, h)
        for group in groups if isinstance(group, dict) and isinstance(group.get('hooks'), list)
        for h in group['hooks'] if isinstance(h, dict) and script_path(h.get('command')) is not None
    ]
    if not ours:
        groups.append({
            "matcher": "",
            "hooks": [{"type": "command", "command": hook_command}],
        })
        print(f'  [add]  {event}')
        added += 1
        continue

    group, h = ours[0]
    old_path = script_path(h['command'])
    if is_current(old_path):
        print(f'  [skip] {event} already registered')
        unchanged += 1
    else:
        h['command'] = hook_command
        print(f'  [update] {event} (was {old_path})')
        updated += 1

    # A second office entry would report every tool call twice
    for group, h in ours[1:]:
        print(f'  [drop] {event} duplicate office entry (was {script_path(h["command"])})')
        group['hooks'].remove(h)
        if not group['hooks']:
            groups.remove(group)

print(f'  hooks: {added} added, {updated} repointed at this checkout, {unchanged} unchanged')

with open(settings_path, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')
PYEOF

echo -e "${GREEN}[ok]${RESET} Hooks up to date in $SETTINGS_FILE"

# ---------------------------------------------------------------------------
# Status line — the payroll / electricity / memory meters (statusLine +
# subagentStatusLine, both served by status-line.sh). A status line you
# already had is chained: its command is saved next to the auth token and
# status-line.sh prints its output, so nothing you see changes. An entry that
# is already ours but points at another checkout is repointed in place, so
# the command you chained (and its padding / refreshInterval) stay as they are.
# ---------------------------------------------------------------------------
STATUS_SCRIPT="$SCRIPT_DIR/status-line.sh"
OFFICE_HOME="${AGENT_OFFICE_HOME:-$HOME/.agent-office}"
if [ "$STATUS_LINE" = "1" ] && [ -f "$STATUS_SCRIPT" ]; then
    chmod +x "$STATUS_SCRIPT"
    mkdir -p "$OFFICE_HOME"
    echo -e "${CYAN}[...]${RESET} Registering the status line (payroll / electricity / memory meters)..."

    python3 - "$SETTINGS_FILE" "bash \"$STATUS_SCRIPT\"" "$OFFICE_HOME" "$STATUS_SCRIPT" <<'PYEOF' || merge_failed
import json, os, shlex, sys

settings_path, command, office_home, status_script = sys.argv[1:5]
SCRIPT_NAME = os.path.basename(status_script)

with open(settings_path, 'r') as f:
    try:
        settings = json.load(f)
    except json.JSONDecodeError:
        settings = {}
if not isinstance(settings, dict):
    settings = {}

def script_path(command):
    # The status-line.sh path a command names, or None when the status line is not ours
    if not isinstance(command, str) or SCRIPT_NAME not in command:
        return None
    try:
        words = shlex.split(command)
    except ValueError:
        words = command.split()
    return next((w for w in words if os.path.basename(w) == SCRIPT_NAME), command)

def is_current(path):
    return os.path.realpath(os.path.expanduser(path)) == os.path.realpath(status_script)

counts = {'added': 0, 'repointed at this checkout': 0, 'wrapped': 0, 'unchanged': 0}

def register(key, command, prev_file, padding):
    current = settings.get(key)
    old_path = script_path(current.get('command')) if isinstance(current, dict) else None
    if old_path is not None:
        # Ours already: repoint it when the checkout has moved, keep the rest of the entry as is
        if is_current(old_path):
            print(f'  [skip] {key} already registered')
            counts['unchanged'] += 1
            return
        current['command'] = command
        print(f'  [update] {key} (was {old_path})')
        counts['repointed at this checkout'] += 1
        return
    entry = {'type': 'command', 'command': command}
    if isinstance(current, dict) and current.get('command'):
        if current.get('type', 'command') != 'command':
            print(f'  [skip] {key}: existing entry of type {current.get("type")!r} left alone')
            counts['unchanged'] += 1
            return
        previous = str(current['command'])
        with open(prev_file, 'w') as f:
            f.write(previous + '\n')
        os.chmod(prev_file, 0o600)
        for opt in ('padding', 'refreshInterval'):
            if opt in current:
                entry[opt] = current[opt]
        settings[key] = entry
        print(f'  [wrap] {key}: your existing command is kept and chained, its output is what you will see:')
        print(f'         {previous}')
        print(f'         (saved in {prev_file})')
        counts['wrapped'] += 1
        return
    if padding is not None:
        entry['padding'] = padding
    settings[key] = entry
    print(f'  [add]  {key}')
    counts['added'] += 1

register('statusLine', command, os.path.join(office_home, 'statusline-prev'), 0)
register('subagentStatusLine', command + ' --subagents', os.path.join(office_home, 'subagent-statusline-prev'), None)

print('  status line: ' + ', '.join(f'{n} {what}' for what, n in counts.items()))

with open(settings_path, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')
PYEOF

    echo -e "${GREEN}[ok]${RESET} Status line up to date in $SETTINGS_FILE"
elif [ "$STATUS_LINE" = "1" ]; then
    echo -e "${YELLOW}[warn]${RESET} status-line.sh not found next to the tracker — meters skipped"
else
    echo -e "${YELLOW}[skip]${RESET} statusLine + subagentStatusLine (--no-status-line)"
fi

# ---------------------------------------------------------------------------
# Print next steps
# ---------------------------------------------------------------------------
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}Installation complete!${RESET}"
echo ""
echo "Next steps:"
echo ""
echo "  1. Start the Agent Office server:"
echo "       cd $(dirname "$SCRIPT_DIR")"
echo "       npm run server"
echo ""
echo "  2. Start the Agent Office UI:"
echo "       npm run dev           # browser"
echo "       npm run dev:electron  # desktop app"
echo ""
echo "  3. Use Claude Code normally. When you (or Claude) use the Agent"
echo "     tool or any MCP tool, a character will appear in the office."
if [ "$STATUS_LINE" = "1" ]; then
echo ""
echo "  4. The wall panel above the chat shows payroll / electricity / memory"
echo "     as soon as Claude Code sends its first status line."
fi
echo ""
echo "  Hook installed at:"
echo "    $SETTINGS_FILE"
echo ""
echo "  Tracker script:"
echo "    $TRACKER_SCRIPT"
echo ""
echo -e "${YELLOW}Note:${RESET} The server must be running on port 3334 for events to appear."
echo "  If the server is not running, the hook exits silently — no errors."
echo ""
exit 0
