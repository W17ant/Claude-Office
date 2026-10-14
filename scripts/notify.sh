#!/usr/bin/env bash
# notify.sh TITLE MESSAGE — desktop notification from the office server.
#
# The text comes from chat messages and agent names, i.e. from anyone who can
# reach the server, so it is never spliced into AppleScript source: it is
# handed to osascript as plain `argv` items, which keeps quotes, backslashes
# and newlines inert. On Linux notify-send is used when present. Always exits
# 0 — a missing notifier is not an error.
TITLE="${1:-Agent Office}"
MSG="${2:-Something happened}"

# Neither tool should read a leading '-' in the text as an option
case "$TITLE" in -*) TITLE=" $TITLE" ;; esac
case "$MSG" in -*) MSG=" $MSG" ;; esac

if command -v osascript >/dev/null 2>&1; then
    osascript \
        -e 'on run argv' \
        -e 'display notification (item 2 of argv) with title (item 1 of argv)' \
        -e 'end run' \
        "$TITLE" "$MSG" >/dev/null 2>&1
elif command -v notify-send >/dev/null 2>&1; then
    notify-send "$TITLE" "$MSG" >/dev/null 2>&1
fi
exit 0
