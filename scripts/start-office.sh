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
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RESET='\033[0m'

cd "$PROJECT_DIR"

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
    open "$ELECTRON_APP"
    echo ""
    echo -e "${GREEN}Agent Office launched!${RESET}"
    echo "  The app manages the server internally."
    echo "  Check /tmp/agent-office-token for the auth token."
    exit 0
fi

# ---------------------------------------------------------------------------
# Dev fallback — separate server + Vite
# ---------------------------------------------------------------------------

echo -e "${CYAN}[info]${RESET} No packaged app found — starting in dev mode"
echo -e "       (Run 'npm run pack' to build the Electron app)"
echo ""

# Check if server is already running
if curl -sf http://127.0.0.1:3334/health > /dev/null 2>&1; then
    echo -e "${GREEN}[ok]${RESET} Server already running on port 3334"
else
    echo -e "${CYAN}[...]${RESET} Starting WebSocket server..."
    node server/index.js &
    SERVER_PID=$!
    # Wait for server to be ready
    for i in {1..10}; do
        if curl -sf http://127.0.0.1:3334/health > /dev/null 2>&1; then
            echo -e "${GREEN}[ok]${RESET} Server ready (PID: $SERVER_PID)"
            break
        fi
        sleep 0.5
    done
fi

# Check if Vite is already running
if curl -sf http://localhost:3333 > /dev/null 2>&1; then
    echo -e "${GREEN}[ok]${RESET} Vite already running on port 3333"
else
    echo -e "${CYAN}[...]${RESET} Starting Vite dev server..."
    npx vite --port 3333 &
    VITE_PID=$!
    # Wait for Vite to be ready
    for i in {1..15}; do
        if curl -sf http://localhost:3333 > /dev/null 2>&1; then
            echo -e "${GREEN}[ok]${RESET} Vite ready (PID: $VITE_PID)"
            break
        fi
        sleep 0.5
    done
fi

# Start chat AI watcher in background (kill any stale ones first)
WATCHER_PID_FILE="$HOME/.agent-office/chat-watcher.pid"
# Kill any leftover watcher processes
pkill -f "chat-ai-watcher.sh" 2>/dev/null || true
pkill -f "chat-watcher.sh" 2>/dev/null || true
rm -f "$WATCHER_PID_FILE"
    echo -e "${CYAN}[...]${RESET} Starting chat AI watcher..."
    bash "$PROJECT_DIR/scripts/chat-ai-watcher.sh" >> /tmp/agent-office-chat-ai.log 2>&1 &
    sleep 0.5
    if [ -f "$WATCHER_PID_FILE" ]; then
        echo -e "${GREEN}[ok]${RESET} Chat AI watcher ready (PID: $(cat "$WATCHER_PID_FILE"))"
    else
        echo -e "${YELLOW}[warn]${RESET} Chat AI watcher may not have started"
    fi

# Open in browser
echo -e "${CYAN}[...]${RESET} Opening Agent Office..."
open http://localhost:3333

echo ""
echo -e "${GREEN}Agent Office is running!${RESET}"
echo "  Office: http://localhost:3333"
echo "  Server: http://localhost:3334"
echo "  Chat AI: toggle on/off from the UI"
echo ""
echo "Press Ctrl+C to stop all services"

# Wait for background processes
wait
