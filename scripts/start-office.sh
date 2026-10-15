#!/usr/bin/env bash
# =============================================================================
# start-office.sh — Start Agent Office (server + UI) and open in browser
#
# If the packaged Electron app exists (release/mac/Agent Office.app or the
# --dir output at release/mac-unpacked/Agent Office.app), launch it directly —
# the app manages the server internally.
#
# Otherwise fall back to the dev workflow: start the Express server and Vite
# separately (same behaviour as before).
#
# The office opens with its token (scripts/open-office.mjs, the same as
# `npm run open`): without it the page shows the office read-only. The
# browser gets a redirect page in $AGENT_OFFICE_HOME rather than the tokened
# link itself, so the token never shows up on a command line in `ps`.
#
# Every process this script starts gets its own process group and a pid file
# under $AGENT_OFFICE_HOME (~/.agent-office): server.pid, vite.pid and
# chat-watcher.pid. stop-office.sh — and the Ctrl+C trap here — stop exactly
# those processes, never "whatever is on port 3334".
#
# Environment (all optional):
#   AGENT_OFFICE_HOME      state dir (default ~/.agent-office)
#   AGENT_OFFICE_PORT      office server port (default 3334)
#   AGENT_OFFICE_UI_PORT   Vite dev server port (default 3333)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

RUNTIME_DIR="${AGENT_OFFICE_HOME:-$HOME/.agent-office}"
SERVER_PORT="${AGENT_OFFICE_PORT:-3334}"
UI_PORT="${AGENT_OFFICE_UI_PORT:-3333}"
SERVER_URL="http://127.0.0.1:$SERVER_PORT"
UI_URL="http://localhost:$UI_PORT"

SERVER_PID_FILE="$RUNTIME_DIR/server.pid"
VITE_PID_FILE="$RUNTIME_DIR/vite.pid"
WATCHER_PID_FILE="$RUNTIME_DIR/chat-watcher.pid"
CHAT_AI_LOG="$RUNTIME_DIR/chat-ai.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

cd "$PROJECT_DIR"
mkdir -p "$RUNTIME_DIR"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Open a URL (or .app) with whatever this platform has. Never fails the script:
# on a box without an opener it just prints the address.
open_target() {
    local target="$1"
    if [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] && command -v open >/dev/null 2>&1; then
        if open "$target" 2>/dev/null; then return 0; fi
    elif command -v xdg-open >/dev/null 2>&1; then
        if xdg-open "$target" >/dev/null 2>&1; then return 0; fi
    fi
    echo -e "${YELLOW}[info]${RESET} Could not open a browser automatically — open $target yourself"
    return 0
}

# Start "$@" in the background in its own process group (python's setsid; a
# plain background job if python3 is missing) and leave its pid in
# SPAWNED_PID. A whole tree such as npx -> vite can then be stopped at once.
SPAWNED_PID=""
spawn() {
    if command -v python3 >/dev/null 2>&1; then
        python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' "$@" < /dev/null &
    else
        "$@" < /dev/null &
    fi
    SPAWNED_PID=$!
}

# Pids and pid files of the processes this run started, for the exit trap
STARTED_PIDS=""
STARTED_PID_FILES=""

cleanup() {
    local pid f
    trap - EXIT INT TERM
    for pid in $STARTED_PIDS; do
        kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    done
    for f in $STARTED_PID_FILES; do rm -f "$f"; done
}
on_interrupt() {
    echo ""
    echo -e "${CYAN}[...]${RESET} Stopping Agent Office..."
    cleanup
    exit 130
}
# An early abort tears the children down rather than orphaning them
trap cleanup EXIT
trap on_interrupt INT TERM

# Stop a watcher left by a previous run — by its pid file, never by a
# `pkill -f` pattern that would also hit editors or shells mentioning the
# script.
stop_stale_watcher() {
    local pid args
    [ -f "$WATCHER_PID_FILE" ] || return 0
    pid=$(tr -d '[:space:]' < "$WATCHER_PID_FILE" 2>/dev/null || true)
    rm -f "$WATCHER_PID_FILE"
    case "$pid" in ''|*[!0-9]*) return 0 ;; esac
    args=$(ps -o args= -p "$pid" 2>/dev/null || true)
    case "$args" in
        *chat-ai-watcher.sh*|*chat-watcher.sh*)
            kill -TERM "$pid" 2>/dev/null || true
            echo -e "${CYAN}[...]${RESET} Stopped previous chat watcher (pid $pid)" ;;
    esac
}

# ---------------------------------------------------------------------------
# Check for a packaged Electron build
# Electron-builder places the .app at:
#   release/<mac|mac-arm64>/Agent Office.app        (DMG build)
#   release/mac-unpacked/Agent Office.app           (--dir / pack build)
# ---------------------------------------------------------------------------

ELECTRON_APP=""

for candidate in \
    "release/mac/Agent Office.app" \
    "release/mac-arm64/Agent Office.app" \
    "release/mac-unpacked/Agent Office.app"
do
    if [ -d "$PROJECT_DIR/$candidate" ]; then
        ELECTRON_APP="$PROJECT_DIR/$candidate"
        break
    fi
done

if [ -n "$ELECTRON_APP" ]; then
    echo -e "${GREEN}[ok]${RESET} Found packaged app: $ELECTRON_APP"
    echo -e "${CYAN}[...]${RESET} Launching Agent Office..."
    open_target "$ELECTRON_APP"
    echo ""
    echo -e "${GREEN}Agent Office launched!${RESET}"
    echo "  The app manages the server internally and opens the office with its token."
    echo "  To open the same office in a browser: npm run open"
    exit 0
fi

# ---------------------------------------------------------------------------
# Dev fallback — separate server + Vite
# ---------------------------------------------------------------------------

echo -e "${CYAN}[info]${RESET} No packaged app found — starting in dev mode"
echo -e "       (Run 'npm run pack' to build the Electron app)"
echo ""

# Check if server is already running
if curl -sf "$SERVER_URL/health" > /dev/null 2>&1; then
    echo -e "${GREEN}[ok]${RESET} Server already running on port $SERVER_PORT"
else
    echo -e "${CYAN}[...]${RESET} Starting WebSocket server..."
    spawn node server/index.js
    SERVER_PID=$SPAWNED_PID
    echo "$SERVER_PID" > "$SERVER_PID_FILE"
    STARTED_PIDS="$STARTED_PIDS $SERVER_PID"
    STARTED_PID_FILES="$STARTED_PID_FILES $SERVER_PID_FILE"
    # Wait for server to be ready
    for i in {1..10}; do
        if curl -sf "$SERVER_URL/health" > /dev/null 2>&1; then
            echo -e "${GREEN}[ok]${RESET} Server ready (PID: $SERVER_PID)"
            break
        fi
        sleep 0.5
    done
fi

# Check if Vite is already running
if curl -sf "$UI_URL" > /dev/null 2>&1; then
    echo -e "${GREEN}[ok]${RESET} Vite already running on port $UI_PORT"
else
    echo -e "${CYAN}[...]${RESET} Starting Vite dev server..."
    spawn npx vite --port "$UI_PORT"
    VITE_PID=$SPAWNED_PID
    echo "$VITE_PID" > "$VITE_PID_FILE"
    STARTED_PIDS="$STARTED_PIDS $VITE_PID"
    STARTED_PID_FILES="$STARTED_PID_FILES $VITE_PID_FILE"
    # Wait for Vite to be ready
    for i in {1..15}; do
        if curl -sf "$UI_URL" > /dev/null 2>&1; then
            echo -e "${GREEN}[ok]${RESET} Vite ready (PID: $VITE_PID)"
            break
        fi
        sleep 0.5
    done
fi

# Start chat AI watcher in background (stop a stale one first)
stop_stale_watcher
echo -e "${CYAN}[...]${RESET} Starting chat AI watcher (log: $CHAT_AI_LOG)..."
spawn bash "$PROJECT_DIR/scripts/chat-ai-watcher.sh" >> "$CHAT_AI_LOG" 2>&1
WATCHER_PID=$SPAWNED_PID
STARTED_PIDS="$STARTED_PIDS $WATCHER_PID"
STARTED_PID_FILES="$STARTED_PID_FILES $WATCHER_PID_FILE"
# The watcher writes its own pid file; give a loaded machine a few seconds
for i in {1..30}; do
    [ -f "$WATCHER_PID_FILE" ] && break
    sleep 0.1
done
if [ -f "$WATCHER_PID_FILE" ]; then
    echo -e "${GREEN}[ok]${RESET} Chat AI watcher ready (PID: $(cat "$WATCHER_PID_FILE"))"
else
    echo -e "${YELLOW}[warn]${RESET} Chat AI watcher may not have started (see $CHAT_AI_LOG)"
fi

# Open in browser, with the office token (the bare address when there is no
# token to open it with: the office then shows read-only)
echo -e "${CYAN}[...]${RESET} Opening Agent Office..."
if ! node "$SCRIPT_DIR/open-office.mjs" --dev; then
    open_target "$UI_URL"
fi

echo ""
echo -e "${GREEN}Agent Office is running!${RESET}"
echo "  Office: $UI_URL  (another browser: npm run open)"
echo "  Server: http://localhost:$SERVER_PORT"
echo "  Chat AI: toggle on/off from the UI"
echo ""
echo "Press Ctrl+C to stop all services"

# Wait for background processes (Ctrl+C runs on_interrupt and stops them)
wait
