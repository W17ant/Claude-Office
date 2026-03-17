#!/usr/bin/env bash
TITLE="${1:-Agent Office}"
MSG="${2:-Something happened}"
osascript -e "display notification \"$MSG\" with title \"$TITLE\"" 2>/dev/null
