#!/usr/bin/env bash
# =============================================================================
# stop-office.sh — Shut down the Agent Office processes start-office.sh started
#
# Reads the pid files written under $AGENT_OFFICE_HOME (~/.agent-office):
#   chat-watcher.pid   chat AI watcher (written by chat-ai-watcher.sh)
#   server.pid         WebSocket/HTTP server (written by start-office.sh)
#   vite.pid           Vite dev server     (written by start-office.sh)
#
# Only those processes — and their process groups — are signalled, after a
# check that the pid still belongs to an office process. Browsers holding a
# WebSocket to :3334, the Electron app, or an unrelated Vite on :3333 are
# left alone.
#
# Usage:
#   bash scripts/stop-office.sh            # stop by pid file
#   bash scripts/stop-office.sh --force    # additionally kill whatever is
#                                          # LISTENING on the office ports
#
# Environment (all optional):
#   AGENT_OFFICE_HOME      state dir (default ~/.agent-office)
#   AGENT_OFFICE_PORT      office server port (default 3334)
#   AGENT_OFFICE_UI_PORT   Vite dev server port (default 3333)
# =============================================================================

set -uo pipefail

RUNTIME_DIR="${AGENT_OFFICE_HOME:-$HOME/.agent-office}"
SERVER_PORT="${AGENT_OFFICE_PORT:-3334}"
UI_PORT="${AGENT_OFFICE_UI_PORT:-3333}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

FORCE=0
for arg in "$@"; do
    case "$arg" in
        -f|--force) FORCE=1 ;;
        -h|--help)
            echo "Usage: bash scripts/stop-office.sh [--force]"
            echo "  Stops the processes recorded in \$AGENT_OFFICE_HOME/{chat-watcher,server,vite}.pid."
            echo "  --force  also kill whatever is listening on :$SERVER_PORT and :$UI_PORT"
            exit 0 ;;
        *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
    esac
done

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════╗${RESET}"
echo -e "${CYAN}║    Agent Office — Shutting Down            ║${RESET}"
echo -e "${CYAN}╚═══════════════════════════════════════════╝${RESET}"
echo ""

STOPPED=0

# Command line of a pid, empty if it is gone
cmdline_of() { ps -o args= -p "$1" 2>/dev/null || true; }

# stop_pidfile LABEL FILE PATTERN — stop the process named in FILE if it is
# alive and its command line matches the extended regex PATTERN. The pid file
# is removed either way (a stale one is just noise).
stop_pidfile() {
    local label="$1" file="$2" pattern="$3" pid args i

    if [ ! -f "$file" ]; then
        echo -e "${YELLOW}[skip]${RESET} $label: no pid file"
        return 0
    fi
    pid=$(tr -d '[:space:]' < "$file" 2>/dev/null || true)
    rm -f "$file"
    case "$pid" in
        ''|*[!0-9]*)
            echo -e "${YELLOW}[skip]${RESET} $label: pid file was empty or invalid"
            return 0 ;;
    esac
    if ! kill -0 "$pid" 2>/dev/null; then
        echo -e "${YELLOW}[skip]${RESET} $label not running (pid $pid)"
        return 0
    fi
    args=$(cmdline_of "$pid")
    if ! [[ "$args" =~ $pattern ]]; then
        echo -e "${YELLOW}[skip]${RESET} $label: pid $pid is not an office process (${args:-?}) — stale pid file removed, nothing killed"
        return 0
    fi

    # Its process group first (npx -> vite, bash -> curl ...), then the pid itself
    kill -TERM -- "-$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.2
    done
    if kill -0 "$pid" 2>/dev/null; then
        kill -KILL -- "-$pid" 2>/dev/null || true
        kill -KILL "$pid" 2>/dev/null || true
        echo -e "${GREEN}[ok]${RESET} $label killed (pid $pid did not exit on SIGTERM)"
    else
        echo -e "${GREEN}[ok]${RESET} $label stopped (pid $pid)"
    fi
    STOPPED=$((STOPPED + 1))
    return 0
}

# Pids LISTENING on TCP port $1 (not clients connected to it)
listeners_on_port() {
    local port="$1"
    if command -v lsof >/dev/null 2>&1; then
        lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true
    elif command -v ss >/dev/null 2>&1; then
        ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true
    elif command -v fuser >/dev/null 2>&1; then
        fuser -n tcp "$port" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true
    else
        echo -e "${YELLOW}[warn]${RESET} --force needs lsof, ss or fuser to find listeners on :$port" >&2
    fi
}

# --force: kill the listeners on a port, whatever they are
force_stop_port() {
    local label="$1" port="$2" pids pid
    pids=$(listeners_on_port "$port")
    if [ -z "$pids" ]; then
        echo -e "${YELLOW}[skip]${RESET} --force: nothing listening on :$port"
        return 0
    fi
    for pid in $pids; do
        [ "$pid" = "$$" ] && continue
        if kill -TERM "$pid" 2>/dev/null; then
            echo -e "${GREEN}[ok]${RESET} --force: killed pid $pid listening on :$port ($label: $(cmdline_of "$pid"))"
            STOPPED=$((STOPPED + 1))
        fi
    done
    return 0
}

# 1. Chat watcher
stop_pidfile "Chat watcher" "$RUNTIME_DIR/chat-watcher.pid" 'chat-(ai-)?watcher\.sh'

# 2. Server
stop_pidfile "Server" "$RUNTIME_DIR/server.pid" '(^|/| )node( |$)|server/index\.js'

# 3. Vite dev server
stop_pidfile "Vite dev server" "$RUNTIME_DIR/vite.pid" 'vite|(^|/| )node( |$)|npx|npm'

# 4. --force: whatever still listens on the office ports
if [ "$FORCE" = 1 ]; then
    force_stop_port "server" "$SERVER_PORT"
    force_stop_port "vite" "$UI_PORT"
fi

echo ""
if [ "$STOPPED" -gt 0 ]; then
    echo -e "${GREEN}Office closed. $STOPPED process(es) stopped.${RESET}"
else
    echo -e "${YELLOW}Nothing was running.${RESET}"
    if [ "$FORCE" = 0 ]; then
        echo "  (Started the server some other way? bash scripts/stop-office.sh --force kills whatever listens on :$SERVER_PORT / :$UI_PORT.)"
    fi
fi
echo ""
