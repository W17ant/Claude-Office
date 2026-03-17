#!/usr/bin/env bash
# =============================================================================
# stop-office.sh — Shut down all Agent Office processes
#
# Stops:
#   1. Chat watcher (bash background process)
#   2. WebSocket/HTTP server (port 3334)
#   3. Vite dev server (port 3333)
#
# Usage:
#   bash scripts/stop-office.sh
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════╗${RESET}"
echo -e "${CYAN}║    Agent Office — Shutting Down            ║${RESET}"
echo -e "${CYAN}╚═══════════════════════════════════════════╝${RESET}"
echo ""

STOPPED=0

# 1. Chat watcher
PID_FILE="$HOME/.agent-office/chat-watcher.pid"
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null)
    if kill -0 "$PID" 2>/dev/null; then
        kill "$PID" 2>/dev/null
        echo -e "${GREEN}[ok]${RESET} Chat watcher stopped (pid $PID)"
        STOPPED=$((STOPPED + 1))
    else
        echo -e "${YELLOW}[skip]${RESET} Chat watcher not running"
    fi
    rm -f "$PID_FILE"
else
    echo -e "${YELLOW}[skip]${RESET} No chat watcher pid file"
fi

# 2. Server on port 3334
SERVER_PIDS=$(lsof -ti :3334 2>/dev/null || true)
if [ -n "$SERVER_PIDS" ]; then
    echo "$SERVER_PIDS" | xargs kill 2>/dev/null
    echo -e "${GREEN}[ok]${RESET} Server stopped (port 3334)"
    STOPPED=$((STOPPED + 1))
else
    echo -e "${YELLOW}[skip]${RESET} Server not running on port 3334"
fi

# 3. Vite on port 3333
VITE_PIDS=$(lsof -ti :3333 2>/dev/null || true)
if [ -n "$VITE_PIDS" ]; then
    echo "$VITE_PIDS" | xargs kill 2>/dev/null
    echo -e "${GREEN}[ok]${RESET} Vite dev server stopped (port 3333)"
    STOPPED=$((STOPPED + 1))
else
    echo -e "${YELLOW}[skip]${RESET} Vite not running on port 3333"
fi

echo ""
if [ "$STOPPED" -gt 0 ]; then
    echo -e "${GREEN}Office closed. $STOPPED process(es) stopped.${RESET}"
else
    echo -e "${YELLOW}Nothing was running.${RESET}"
fi
echo ""
