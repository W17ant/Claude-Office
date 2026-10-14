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
# gets any missing entries added.
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

# ---------------------------------------------------------------------------
# Merge hook entries into settings JSON using Python
# ---------------------------------------------------------------------------
echo -e "${CYAN}[...]${RESET} Registering PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop, SessionStart + SessionEnd hooks..."

python3 - "$SETTINGS_FILE" "$HOOK_COMMAND" <<'PYEOF'
import json, sys

settings_path = sys.argv[1]
hook_command  = sys.argv[2]

with open(settings_path, 'r') as f:
    try:
        settings = json.load(f)
    except json.JSONDecodeError:
        settings = {}

hooks = settings.setdefault('hooks', {})

def has_tracker(groups):
    # Match on the script name so installs from another checkout path count too
    return any(
        'agent-tracker.sh' in h.get('command', '')
        for group in groups if isinstance(group, dict)
        for h in group.get('hooks', []) if isinstance(h, dict)
    )

for event in ('PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'SessionStart', 'SessionEnd'):
    groups = hooks.setdefault(event, [])
    if has_tracker(groups):
        print(f'  [skip] {event} already registered')
        continue
    groups.append({
        "matcher": "",
        "hooks": [{"type": "command", "command": hook_command}],
    })
    print(f'  [add]  {event}')

with open(settings_path, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')
PYEOF

echo -e "${GREEN}[ok]${RESET} Hooks up to date in $SETTINGS_FILE"

# ---------------------------------------------------------------------------
# Status line — the payroll / electricity / memory meters (statusLine +
# subagentStatusLine, both served by status-line.sh). A status line you
# already had is chained: its command is saved next to the auth token and
# status-line.sh prints its output, so nothing you see changes.
# ---------------------------------------------------------------------------
STATUS_SCRIPT="$SCRIPT_DIR/status-line.sh"
OFFICE_HOME="${AGENT_OFFICE_HOME:-$HOME/.agent-office}"
if [ "$STATUS_LINE" = "1" ] && [ -f "$STATUS_SCRIPT" ]; then
    chmod +x "$STATUS_SCRIPT"
    mkdir -p "$OFFICE_HOME"
    echo -e "${CYAN}[...]${RESET} Registering the status line (payroll / electricity / memory meters)..."

    python3 - "$SETTINGS_FILE" "bash \"$STATUS_SCRIPT\"" "$OFFICE_HOME" <<'PYEOF'
import json, os, sys

settings_path, command, office_home = sys.argv[1:4]

with open(settings_path, 'r') as f:
    try:
        settings = json.load(f)
    except json.JSONDecodeError:
        settings = {}

def register(key, command, prev_file, padding):
    current = settings.get(key)
    # Match on the script name so installs from another checkout path count too
    if isinstance(current, dict) and 'status-line.sh' in str(current.get('command', '')):
        print(f'  [skip] {key} already registered')
        return
    entry = {'type': 'command', 'command': command}
    if isinstance(current, dict) and current.get('command'):
        if current.get('type', 'command') != 'command':
            print(f'  [skip] {key}: existing entry of type {current.get("type")!r} left alone')
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
        return
    if padding is not None:
        entry['padding'] = padding
    settings[key] = entry
    print(f'  [add]  {key}')

register('statusLine', command, os.path.join(office_home, 'statusline-prev'), 0)
register('subagentStatusLine', command + ' --subagents', os.path.join(office_home, 'subagent-statusline-prev'), None)

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
