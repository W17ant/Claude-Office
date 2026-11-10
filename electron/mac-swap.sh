#!/bin/sh
# mac-swap.sh - replaces the installed macOS app with a downloaded update, once the app has quit.
#
# Started detached by electron/mac-update.cjs when "Restart to update" is
# clicked (or on quit, with relaunch 0). By then the new bundle is unpacked
# beside the installed one and has passed its checksum, bundle-id and version
# checks; all that is left needs the app not to be running, so it is done here.
#
#   mac-swap.sh <pids> <app> <staged-app> <stage-dir> <log> <relaunch> [args...]
#
#   pids        comma-separated: the app and its server child. Nothing moves
#               until every one of them has exited.
#   app         the installed bundle, e.g. /Applications/Agent Office.app
#   staged-app  the verified new bundle, inside stage-dir
#   stage-dir   a directory beside <app>, so both moves are renames on one
#               volume. Removed at the end, with the old bundle in it.
#   log         appended to (update-swap.log in the app's user-data directory)
#   relaunch    1 to start the app again afterwards, 0 to leave it closed
#   args        passed to the relaunched app
#
# The order is what makes it safe: the old bundle is moved aside (not
# deleted), the new one is moved in, and only then is the old one removed. If
# the second move fails the old bundle is moved back. There is a moment
# between the two renames with no bundle at <app>; it is two system calls long.
#
# Exit status: 0 swapped, 1 nothing changed (the old app is in place),
# 2 the old app could not be put back (it is at <stage-dir>/previous.app).
#
# Why the whole script is one function called on the last line: sh reads a
# script as it runs it, and this file lives inside the bundle it removes. A
# function is parsed in full before its first command runs.

main() {
  pids=$1
  app=$2
  staged=$3
  stage=$4
  log=$5
  relaunch=$6
  shift 6

  say() {
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$log" 2>/dev/null
  }

  # Start whatever bundle is at <app> now: the new one after a swap, the old
  # one after a failed swap (the user asked for a restart either way).
  start_app() {
    [ "$relaunch" = 1 ] || return 0
    exe=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist" 2>/dev/null)
    if [ -n "$exe" ] && [ -x "$app/Contents/MacOS/$exe" ]; then
      # Why the executable and not `open`: this keeps the environment and the
      # arguments the app was started with (AGENT_OFFICE_PORT, --compact),
      # which is what Electron's own app.relaunch() does.
      "$app/Contents/MacOS/$exe" "$@" >/dev/null 2>&1 &
    else
      open -n "$app" --args "$@" >/dev/null 2>&1
    fi
  }

  case "$staged" in
    "$stage"/*) ;;
    *) say "refused: the new app is not in the staging directory"; exit 1 ;;
  esac
  if [ ! -d "$app" ] || [ ! -d "$staged/Contents/MacOS" ]; then
    say "refused: the installed app or the new one is missing"
    exit 1
  fi

  # Why 300 polls of 0.2 s (one minute): the app and its server child exit
  # within a second or two of quitting. An app still running after a minute
  # is not going to quit, and moving a running app's bundle from under it is
  # the one thing this must never do.
  #
  # Why the process list as well as the pids: the app may have been opened
  # again in that second or two (an update applied on quit, and a quick
  # double-click). Any process whose executable is inside the bundle counts.
  polls=0
  while :; do
    alive=0
    old_ifs=$IFS
    IFS=,
    for pid in $pids; do
      if kill -0 "$pid" 2>/dev/null; then alive=1; fi
    done
    IFS=$old_ifs
    if [ "$alive" = 0 ] && ps -axww -o comm= 2>/dev/null | grep -F -q -- "$app/Contents/"; then alive=1; fi
    [ "$alive" = 0 ] && break
    if [ "$polls" -ge 300 ]; then
      say "gave up: the app was still running after a minute; nothing changed"
      exit 1
    fi
    polls=$((polls + 1))
    sleep 0.2
  done

  backup="$stage/previous.app"
  if ! mv "$app" "$backup" 2>>"$log"; then
    say "could not move the installed app aside; nothing changed"
    start_app "$@"
    exit 1
  fi
  if ! mv "$staged" "$app" 2>>"$log"; then
    if mv "$backup" "$app" 2>>"$log"; then
      say "could not move the new app into place; the old one was put back"
      start_app "$@"
      exit 1
    fi
    # Why the staging directory is kept here: it holds the only copy of the app.
    say "could not move the new app into place or put the old one back: it is at $backup"
    exit 2
  fi

  # Why: a changed modification time is what makes Launch Services re-read
  # the bundle (its version in Finder, its icon).
  touch "$app" 2>/dev/null
  rm -rf "$stage" 2>>"$log"
  say "updated $app"
  start_app "$@"
  exit 0
}

main "$@"; exit
