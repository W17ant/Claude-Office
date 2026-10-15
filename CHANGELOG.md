# Changelog

All notable changes to Claude Office. Numbers refer to pull requests.

## Unreleased

### Truthful office
- Subagents are linked to their worker the moment Claude Code starts them (`SubagentStart`); phantom `SubagentStop` events from the compaction and prompt-suggestion sidechains are ignored; a tool call that errors (`PostToolUseFailure`) shows as `failed:` on the agent that made it; nested spawns record their parent (#10).
- The office is session-aware: every hook event carries the Claude Code session and project, `SessionStart`/`SessionEnd` open and close sessions, one pill per terminal in the title bar, `GET /sessions`, sessions survive a server restart (#12).
- Payroll, electricity and memory meters fed by the Claude Code status line (and the subagent status line): cost, $/min, tokens per minute, context-window fill per session, a five-hour rate-limit pill, and a "desk is getting cluttered" warning past 85 % (#15).
- Faithful worker lifecycle: event handling moved into a pure `officeReducer`; workers arrive before they work; when desks run out new arrivals wait in a lobby by the door; reconnects reconcile with the server snapshot; duplicate chat lines, dropped side effects and a sprite-lagging CSS transition are gone (#19).
- The session's own Claude is a first-class record (`main` on each session): the hook forwards the main thread's turn — `UserPromptSubmit` (incl. a background worker's wake-up), `Stop`, `PermissionRequest`, `Notification`, `StopFailure`, `PreCompact`/`PostCompact`, `PostToolBatch`, `CwdChanged`, `PostModelSwitch` — as `session_*` events; the server keeps working / waiting / idle / needs-you / error / compacting per session with a debounced, deduped permission wait that the granted tool or the batch end lowers; prompts and replies are stored as Boss/Claude chat rows at the `logPrompts` level (off / summary / full, `GET`/`POST /settings`) and stay behind the token on `GET /chat` and `GET /sessions`; the hook reads its payload from stdin (a 300 KB tool result used to fail with E2BIG) and honours `AGENT_OFFICE_EVENT_URL` / `AGENT_OFFICE_PORT`; a foreground agent's completion carries its tokens, duration, tool count and model.
- Background agents stay at their desk until they finish, and agents survive a server restart (#5, #6).

### Incident mode
- "Prod Is Down": three failed tool calls in five minutes turn the office red (night room, pulsing tint, beacon over the door, rollback on the TV, days-since sign at 0, live timer) with `/incident`, `/all-clear`, `?variant=incident` and a postmortem card (#11).

### Agent-to-agent messaging
- Directed messages with recipient, type and reply threading; per-agent inbox files; unread badges over the recipient's head; an A2A JSON-RPC `message/send` endpoint and agent cards; self-message and loop-budget guards (#5, #7).

### Distribution and reliability
- The production build works again (#8).
- Vitest harness and GitHub Actions CI; the server is importable without side effects and every runtime path honours `AGENT_OFFICE_HOME` (#9).
- The server serves the built UI on one port and the Electron bundle is self-contained: it spawns the server with its own Node, ships the Electron-ABI `better-sqlite3`, and no longer needs `node` on the PATH (#13).
- Scripts hardening: the chat watcher no longer answers its own replies or the office's announcements, runs `claude -p` with `--safe-mode` so it cannot fire the office hooks, always releases its lock, is rate-capped; `stop-office.sh` only stops what `start-office.sh` started; Linux start works; `notify.sh` passes text as arguments (#14).
- Server hardening: bearer token on every route that acts as an agent or destroys state, constant-time compare, token written only after the port is bound, private file modes, JSON error middleware, lifecycle and input fixes (#16, #17).
- The installer registers all hook events idempotently, adds the status line (chaining an existing one), repairs entries from a moved checkout and tolerates malformed settings files (#5, #15, #18).
- `bash hooks/install-hooks.sh --uninstall` (`npm run uninstall-hooks`) takes the office back out of `~/.claude/settings.json`: every `agent-tracker.sh` hook goes (stale paths and duplicates included, empty groups/events/`hooks` dropped), a chained status line is put back from the saved command and the saved files are deleted, foreign hooks and settings are untouched, nothing of ours means exit 0 and no write; backup first (#25).

### Documentation
- README leads with the product; NOTICE for the fan-art skin; CONTRIBUTING and issue templates (#20).

## 1.0.0

Initial release: pixel-art office driven by Claude Code hooks, Slack-style chat, Dunder Mifflin skin, Electron wrapper.
