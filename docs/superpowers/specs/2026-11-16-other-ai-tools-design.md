# Other AI tools in the office — design

Tracking issue: [#115](https://github.com/W17ant/Claude-Office/issues/115). Date: 2026-11-16.

## Intent

The office only shows Claude Code today. Five forks each taught it about other
AI coding tools, separately, and none of that came back. The owner wants more
community engagement (downloads, stars, contributions from other people's
forks). Supporting other tools upstream does both: people who use Codex or
Gemini can use the office, and the fork authors get a clear, small way to
contribute what they know about their tool.

## Goals

- Sessions from five tools appear in the office: **Codex, Gemini CLI,
  OpenCode, Antigravity, Kimi** (the owner chose all five, over shipping
  Codex alone first).
- Each such session gets the same lifecycle a Claude Code session gets, as
  far as its tool reports it: started, prompt, working (with the tool name),
  needs you, turn ended, ended. Subagents too, where the tool reports them.
- Every session shows which tool it is.
- One command per tool connects it, and another disconnects it.
- Codex is verified against a real Codex install (it is set up on the
  owner's Mac). The other four ship labelled **experimental — tell us if it
  works**, with a link to #115, in the README and in the installer's output.
- A fork author can fix or improve one tool by sending one translator file
  and one test built from a real payload they paste in.

## Non-goals (this project)

- Cost and token meters for other tools. None of the forks get this data
  from hooks. Such a session shows no cost, not $0.
- Answering a permission prompt from the office for other tools. The office
  shows "needs you" for them, and the person answers in the tool's own
  terminal.
- The office launching other tools as workers (EooL's `adapter-contract.md`),
  and chat-to-session prompts (#108) for other tools.
- Qoder, Windows-native support, and new character art.

## Anti-goals (a failure even if it technically works)

- The relay slows down or breaks the tool it is attached to. It must always
  exit 0, never block on the office, and answer any tool that reads the
  hook's stdout with that tool's "carry on" reply.
- Claude Code sessions show up twice, or change in any way.
- Prompts or code leave the machine. The relay posts to loopback only (EooL's
  security review found a configurable event URL could send prompts to a
  remote host).
- An installer clobbers a user's existing config for that tool, or follows a
  symlink out of it.

## Approaches considered

- **A. Translate in the hook (EooL's fork).** Each tool's hook runs a script
  that maps its payload to office events and posts finished `/event` bodies.
  The server is unchanged, and it reuses the most fork code. But four of the
  five tools have never run against the real thing, so field names will be
  wrong. Every fix would mean users update the office *and* re-run that
  tool's installer, and many won't.
- **B. Translate in the server — chosen.** Each tool's hook runs one tiny
  shared relay that forwards the raw payload, signed with the office token,
  to a per-tool endpoint. A small translator per tool lives in the server. A
  wrong field name is fixed in the next npx or desktop release, with no
  reinstall. It also gives fork authors the easiest PR shape (translator plus
  test). The cost: a new server entry point (token-checked like `/event`),
  and EooL's mapping code is ported into server translators rather than
  copied as-is.
- (gilberth's server normaliser is the same idea for Codex only. lafuan's
  app-server integration only sees sessions the office starts itself, so it
  doesn't meet the goal.)

## Design

### 1. The relay (`hooks/office-relay.py`)

- Run by each tool's hook as `python3 -I <hooks dir>/office-relay.py <tool>`,
  with the payload on stdin.
- It uses the standard library only. Why python3: it is already a hook
  requirement, `npm run doctor` checks for it, and the desktop app's users
  may not have Node on their PATH.
- It reads stdin, signs the raw body exactly as `agent-tracker.py` does today
  (same token file, same signature header), and POSTs it to
  `http://127.0.0.1:<port>/hook/<tool>`. The port comes from
  `AGENT_OFFICE_PORT` (default 3334), and the host is always loopback.
- Short timeout. It ignores every error and always exits 0.
- It prints the tool's required stdout reply when that tool needs one
  (Antigravity's PreToolUse; check each tool's docs), and nothing otherwise.
- It skips forwarding when `AGENT_OFFICE_RUN=1`, so the office's own headless
  runs aren't counted twice.

### 2. The server: `POST /hook/:tool`

- `:tool` must be one of the five ids: `codex`, `gemini`, `opencode`,
  `antigravity`, `kimi`. Anything else gets a 404.
- It sits behind `requireToken`.
- *(Builder-check call)* It allows bodies up to 1 MB, not `/event`'s 64 KB:
  raw post-tool payloads carry the full tool output, and a 413 would be
  dropped silently by the relay and leave hands stuck. Translators read only
  the fields they need.
- The handler calls the tool's translator, which returns a list of office
  events (the same shapes documented above `/event`). Each event then goes
  through the **same** validate → sanitise → handle path as `POST /event`.
  The current `/event` handler body becomes a function, `ingestEvent(body)`,
  that both routes call. No event type is added or changed.
- Translators live in `server/tools/<tool>.js`. Each one exports
  `translate(payload) → event[]`, a pure function with no I/O, plus
  `label` (for example `"Codex"`).
- Session ids are prefixed `<tool>:<native id>` so they never collide with
  Claude Code's.
- Every event from a translator carries `client: '<id>'`. The session
  stores it. A Claude Code session has no `client` field and shows nothing
  new. *(Builder-check call: not `tool`, because `tool` already means the
  tool name on `agent_working` and other events.)*
- A payload the translator doesn't understand returns `[]` and the route
  answers 204. It never returns 500.

### 3. Showing the tool

- The session strip pill, the session hover card and the phone view show a
  small text tag with the tool's `label` when `client` is set (for example
  `Codex`).
- The tag is text, so it needs no new art. Its style is left to the builder;
  it should be readable and match the existing pills.

### 4. Connecting and disconnecting a tool

- `agent-office install-hooks --tool <id>` and
  `agent-office uninstall-hooks --tool <id>`. From a checkout:
  `npm run install-hooks -- --tool <id>`.
- Without `--tool`, everything behaves exactly as today (Claude Code).
- The installer is Node (`scripts/install-tool-hooks.mjs`), called from the
  CLI. It uses the same hooks-dir rule as today: outside a checkout,
  `office-relay.py` is copied to `~/.agent-office/hooks`.
- What each tool gets (exact event names and file shapes come from each
  tool's docs and EooL's `docs/hooks-other-clis-research.md`):

  | Tool | Where | What we write |
  |---|---|---|
  | Codex | `~/.codex/hooks.json` | relay entry per event; print "approve once with `/hooks` in Codex" |
  | Gemini CLI | `~/.gemini/settings.json` `hooks` | relay entry per event |
  | Antigravity | `~/.gemini/config/hooks.json` | relay entry per event |
  | Kimi | `~/.kimi-code/config.toml` (or the older `~/.kimi/config.toml`, whichever exists) | `[[hooks]]` tables inside a marked block (`# >>> claude-office` … `# <<< claude-office`), edited as text, no TOML library. *(Builder-check call)* If the file already has an inline `hooks = [...]` key, refuse and print the lines to add by hand: mixing the two syntaxes would make the file invalid and break Kimi |
  | OpenCode | `~/.config/opencode/plugins/claude-office.js` | a plugin that POSTs the signed event itself with `fetch` (no process per event) |

- Every entry we write is recognisable as ours (by command path or marker),
  so uninstall removes only those entries and leaves the rest of the file
  byte-for-byte unchanged.
- Before the first write to a file, keep a backup next to it.
- Refuse to write through a symlink.
- Re-running install is idempotent.
- `npm run doctor` adds one line per tool it finds (connected, not
  connected, or the tool isn't installed). This is informational only: a
  missing tool is never a FAIL.

### 5. What each translator maps

- Everything maps onto existing office events:
  - `session_started` / `session_ended`
  - `session_prompt`
  - `agent_working` (tool name)
  - `session_tool_done`
  - `session_needs_you` (display only, never `answerable`)
  - `session_turn_end`
  - `session_compact`
  - `agent_spawned` / `agent_completed` for subagents
- A tool that has no session-start hook (Antigravity) gets an implicit
  session on its first event, the same way the server already handles
  Claude Code events without a SessionStart. A tool with no session-end
  event leaves its session to the server's existing idle handling.
- Codex subagents map to office roles using gilberth's `agent_type` alias
  table.

### 6. Tests and fixtures

- `tests/fixtures/tools/<tool>/*.json` hold payloads.
  - Codex fixtures are recorded from a real Codex session on the owner's Mac
    (the live check).
  - The others come from the tools' docs and EooL's fixtures. Each one is
    marked in a `README.md` in its folder as *from docs, not yet seen live*,
    so a contributor knows a real capture is wanted.
- Each translator is tested on its fixtures. These tests are pure: payload
  in, events out.
- Route tests cover:
  - an unsigned request gets a 401
  - an unknown tool gets a 404
  - a garbage payload gets a 204
  - a fixture produces a session carrying `tool`
- Relay tests: always exits 0 when the server is down, never posts to a
  non-loopback host, and prints the right stdout reply for tools that need
  one.
- Installer tests run against a temp HOME:
  - install, then uninstall, leaves files byte-identical
  - install is idempotent
  - install refuses a symlink
  - install keeps entries that aren't ours

### 7. Docs and credit

- README: a short "Other AI tools" section listing the five, with Codex as
  supported and the other four experimental, each linking to #115.
- `docs/reference.md`: the `/hook/:tool` route, the translator shape, and
  how to add a tool.
- CONTRIBUTING: "Add or fix a tool: one file in `server/tools/`, one fixture,
  one test."
- CHANGELOG credits **EooL** (event mapping and CLI research), **gilberth**
  (Codex role aliases) and **waguirre** (Gemini and Kimi wiring) by name,
  plus anyone whose code is ported. All three forks are MIT, from this MIT
  repo.
- When it ships, post a comment on #115 asking the fork authors to try their
  tool.

## Left to the builder

- The exact hook event list per tool, and each payload field, taken from the
  tools' current docs, EooL's research (Codex, Antigravity, OpenCode) and
  waguirre's fork (Gemini, Kimi; `hooks/multi-client/`).
- The tag's styling, and the relay's timeout value (with a `// Why:`).
- How to record the Codex fixture (run Codex with the relay pointed at a test
  server, or capture stdin in a temp file).
