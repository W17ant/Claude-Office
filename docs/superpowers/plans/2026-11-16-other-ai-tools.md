# Other AI tools in the office — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions from Codex, Gemini CLI, OpenCode, Antigravity and Kimi appear in the office, each tagged with its tool, connected by one install command per tool.

**Architecture:** Each tool's hook runs one shared python3 relay (`hooks/office-relay.py <tool>`) that signs and forwards the raw payload to `POST /hook/:tool`. Server-side translators (`server/tools/<tool>.js`, pure functions) turn a payload into existing office events, which go through the same ingest path as `POST /event`. Sessions carry a `client` id the UI shows as a tag; a Node installer edits each tool's config.

**Tech Stack:** Node 22 / Express (server), python3 stdlib (relay), Node ESM (installer, CLI), React + TS (UI), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-16-other-ai-tools-design.md`

## Global Constraints

- Tool ids, exactly: `codex`, `gemini`, `opencode`, `antigravity`, `kimi`. Labels: `Codex`, `Gemini CLI`, `OpenCode`, `Antigravity`, `Kimi`.
- Session ids from a tool are `<id>:<native session id>`.
- The per-session tool field is `client` (never `tool`, which already means the tool name). A Claude Code session has no `client`.
- `POST /hook/:tool` body limit `1mb`; `/event` stays `64kb`.
- No new office event types. `session_needs_you` from a translator is never `answerable`.
- Relay: python3 standard library, run with `-I`, posts only to `127.0.0.1`, always exits 0, does nothing when `AGENT_OFFICE_RUN=1`.
- Installer: backup `<file>.claude-office.bak` before the first write to a file; refuse to write through a symlink; idempotent; uninstall removes only our entries and leaves everything else byte-identical.
- Kimi block markers, exactly: `# >>> claude-office` and `# <<< claude-office`.
- Experimental copy, exactly: `experimental — tell us if it works` linking to `https://github.com/W17ant/Claude-Office/issues/115`. Codex is labelled supported only after Task 8 passes.
- Every new file gets a header comment; decisions get `// Why:` (or `# Why:`). No `Co-Authored-By` or tool trailers in commits or PR bodies.
- Mapping sources (MIT, credit by name): EooL `hooks/cli-tracker.mjs` + `docs/hooks-other-clis-research.md` (Codex, Antigravity, OpenCode); gilberth `server/codex-normalizer.js` (Codex `agent_type` → role aliases); waguirre `hooks/multi-client/office-map.mjs` + `install.py` (Gemini, Kimi). Read with `gh api repos/<owner>/Claude-Office/contents/<path>`. Check field names against each tool's current docs (Gemini: geminicli.com/docs/hooks; Kimi: moonshotai.github.io/kimi-code/en/customization/hooks).

## Review Focus

- The office is down or hangs while a tool runs → the tool carries on: relay exits 0 within its timeout. Pinned in Task 5.
- A Codex/Gemini post-tool payload over 64 KB (big command output) → accepted, not a silent 413. Pinned in Task 2.
- Two tools (or a tool and Claude Code) report the same native session id → separate sessions. Pinned in Task 2.
- The user edits a tool's config after install (adds their own hooks) → uninstall removes only ours. Pinned in Task 6.
- Claude Code behaviour changes → it must not: existing suite green, a Claude session's JSON has no `client`. Pinned in Task 2.

---

### Task 1: Translator contract and the Codex translator

**Files:**
- Create: `server/tools/index.js`, `server/tools/common.js`, `server/tools/codex.js`
- Create: `tests/fixtures/tools/codex/*.json`, `tests/fixtures/tools/codex/README.md`
- Test: `tests/tool-translators.test.ts`

**Interfaces:**
- Produces:
  - `server/tools/<id>.js` default-exports `{ id: string, label: string, translate(payload: object): OfficeEvent[] }`; `translate` is pure, never throws (wrap and return `[]`).
  - `server/tools/index.js`: `export const TOOLS` (id → module, all five once Tasks 3–4 land) and `export function translateFor(id: string, payload: unknown): OfficeEvent[] | null` (`null` for an unknown id, `[]` for a payload not understood).
  - `server/tools/common.js`: `export function sessionBase(client: string, nativeId: string, cwd?: string): { sessionId, project, cwd, client }`.
  - Every returned event has `client` and `sessionId` set.

- [ ] **Step 1: Write fixtures** from EooL's tracker tests and Codex hook docs: `session-start.json`, `user-prompt.json`, `pre-tool-bash.json`, `post-tool-bash.json`, `permission-request.json`, `stop.json`, `subagent-start.json`, `subagent-stop.json`. `README.md` says: *from docs and EooL's fork, not yet seen live — Task 8 replaces these with a real capture*.
- [ ] **Step 2: Write the failing tests** in `tests/tool-translators.test.ts`:
  - `translateFor('nope', {})` is `null`; `translateFor('codex', 'garbage')` and `translateFor('codex', {})` are `[]`.
  - session-start → one `session_started` with `sessionId: 'codex:<id from fixture>'`, `client: 'codex'`, `project` = basename of fixture cwd.
  - user-prompt → `session_prompt` with the prompt text.
  - pre-tool-bash → `agent_working` with `tool: 'Bash'` (or Codex's tool name as given) and no `agentId`.
  - post-tool-bash → `session_tool_done`.
  - permission-request → `session_needs_you` with `kind: 'permission'` and `answerable` not `true`.
  - stop → `session_turn_end`.
  - subagent-start → `agent_spawned` whose `agent.role` comes from gilberth's alias table for the fixture's `agent_type`; subagent-stop → `agent_completed` for the same agent id.
  - every event from every fixture has `client === 'codex'` and a `sessionId` starting `codex:`.
- [ ] **Step 3: Run** `npx vitest run tests/tool-translators.test.ts` — Expected: FAIL (modules missing).
- [ ] **Step 4: Implement** `common.js`, `codex.js` (port EooL's `normalizeEvent` Codex branch and gilberth's alias table, crediting both in the file header), and `index.js`.
- [ ] **Step 5: Run** the test — Expected: PASS.
- [ ] **Step 6: Commit** `Tools: translator contract and Codex translator`.

### Task 2: `POST /hook/:tool` and the `client` field

**Files:**
- Modify: `server/index.js` — `/event` handler (~2062), `createSession` (1126), `touchSession` (1172), `sessionToRecord` (1092), `sessionToJSON` (1101), body parsers (~1786–1834)
- Test: `tests/tool-hooks.test.ts` (uses `loadOffice`, `postAuthed`, `postEvent` from `tests/helpers.ts`)

**Interfaces:**
- Consumes: `translateFor` (Task 1).
- Produces:
  - `function ingestEvent(body): { error: string } | { sanitised }` — the validate → sanitise → `processEvent` → broadcast → signals → `tasks.noteEvent` → `health.markHook` → `status.noteHook` half of today's `/event`. `/event` calls it, then keeps its permission and claim handling.
  - `POST /hook/:tool`: unknown tool → 404; unauthorised → 401; translator gives `[]` → 204; else each event through `ingestEvent` with `client` forced to the route's id → 200 `{ ok: true, count }`.
  - Sessions store `client` (set on create, kept by `touchSession`), and `sessionToJSON` / `sessionToRecord` include it only when set. `client` from `/event` bodies is accepted only if it is one of the five ids.

- [ ] **Step 1: Write the failing tests:**
  - `POST /hook/codex` with the session-start fixture, signed → 200; `GET /sessions` has `codex:<id>` with `client: 'codex'`.
  - unsigned → 401; `POST /hook/nope` → 404; `POST /hook/codex` with `{}` → 204.
  - pre-tool-bash with no prior session-start → an implicit session that still has `client: 'codex'`.
  - a post-tool-bash fixture padded to ~200 KB of output → 200 (not 413).
  - the same native id via `/hook/codex` and as a Claude Code `/event` `sessionId` → two sessions.
  - a Claude Code `session_started` via `/event` → its JSON has no `client` key.
- [ ] **Step 2: Run** `npx vitest run tests/tool-hooks.test.ts` — Expected: FAIL (404 on the route).
- [ ] **Step 3: Implement.** Add a `toolJsonBody = express.json({ limit: '1mb', verify: captureRaw })` with `// Why:` (raw tool output), choose it for paths starting `/hook/` in the body-parser switch, extract `ingestEvent`, add the route and the `client` plumbing.
- [ ] **Step 4: Run** the new test, then `npm test` — Expected: PASS, and no existing test changes.
- [ ] **Step 5: Commit** `Server: POST /hook/:tool and a client id on sessions`.

### Task 3: Gemini CLI, Antigravity and Kimi translators

**Files:**
- Create: `server/tools/gemini.js`, `server/tools/antigravity.js`, `server/tools/kimi.js`, `tests/fixtures/tools/{gemini,antigravity,kimi}/*.json` + a `README.md` each (same *not yet seen live* wording)
- Modify: `server/tools/index.js`, `tests/tool-translators.test.ts`

**Interfaces:** Same contract as Task 1.

- [ ] **Step 1: Write fixtures** per tool for each event it has: Gemini `SessionStart`, `BeforeAgent` (prompt), `BeforeTool`, `AfterTool`, `AfterAgent`, `Notification`, `PreCompress`, `SessionEnd`; Antigravity's six (no prompt, no session end); Kimi's Claude-like set.
- [ ] **Step 2: Write failing tests** in the same style as Task 1, per tool: ids prefixed `<id>:`, `client` on every event, the event each fixture maps to, `{}` → `[]`. Antigravity: a tool event with no prior start still yields events (the implicit session comes from Task 2).
- [ ] **Step 3: Run** — Expected: FAIL.
- [ ] **Step 4: Implement** the three translators (Gemini and Kimi from waguirre's mapping, Antigravity from EooL's), register them.
- [ ] **Step 5: Run** — Expected: PASS.
- [ ] **Step 6: Commit** `Tools: Gemini CLI, Antigravity and Kimi translators`.

### Task 4: OpenCode translator and plugin

**Files:**
- Create: `server/tools/opencode.js`, `hooks/opencode-plugin.js`, `tests/fixtures/tools/opencode/*.json` + `README.md`
- Modify: `server/tools/index.js`, `tests/tool-translators.test.ts`
- Test: `tests/opencode-plugin.test.ts`

**Interfaces:**
- Produces: `hooks/opencode-plugin.js` — an OpenCode plugin module (`export const ClaudeOffice = async () => ({ event: async ({ event }) => … })`) that POSTs `JSON.stringify(event)` to `http://127.0.0.1:<AGENT_OFFICE_PORT|3334>/hook/opencode`, signed with `x-office-timestamp` / `x-office-signature` = HMAC-SHA256(token, `POST\n/hook/opencode\n<ts>\n<body>`) using the token at `${AGENT_OFFICE_HOME:-~/.agent-office}/auth-token`; swallows every error; skips when `AGENT_OFFICE_RUN=1`. Exports `signRequest(token, path, ts, body): string` for the test.

- [ ] **Step 1: Write fixtures** for OpenCode bus events (`session.created`, `message.updated` user prompt, `tool.execute.before`, `tool.execute.after`, `permission.updated`, `session.idle`, `session.deleted`) from EooL's mapping and OpenCode's SDK types.
- [ ] **Step 2: Write failing tests:** translator cases as in Task 1; `signRequest` output equals the server's `requestSignature` for the same inputs (import it, or recompute with `node:crypto`); the plugin's handler with `fetch` stubbed to reject resolves without throwing.
- [ ] **Step 3: Run** — Expected: FAIL.
- [ ] **Step 4: Implement** both files.
- [ ] **Step 5: Run** — Expected: PASS.
- [ ] **Step 6: Commit** `Tools: OpenCode translator and plugin`.

### Task 5: The relay

**Files:**
- Create: `hooks/office-relay.py`
- Modify: `cli/agent-office.mjs` (`HOOK_FILES` gains `office-relay.py`, `opencode-plugin.js`)
- Test: `tests/office-relay.test.ts`

**Interfaces:**
- Produces: `python3 -I office-relay.py <tool>` — stdin payload; POST to `http://127.0.0.1:<AGENT_OFFICE_PORT|3334>/hook/<tool>` signed exactly like `agent-tracker.sh`'s `PY_SIGN` (same header names, same message, token from `${AGENT_OFFICE_HOME:-~/.agent-office}/auth-token`); prints the tool's required stdout reply from a `REPLIES` table keyed by `(tool, hook_event_name)` (fill from each tool's docs; empty where none is needed); exit 0 always.

- [ ] **Step 1: Write failing tests** (spawn `python3 -I hooks/office-relay.py`):
  - against a `loadOffice` server with `AGENT_OFFICE_HOME` set to its temp home: the codex session-start fixture creates `codex:<id>`.
  - port with nothing listening → exit 0, under 1.5 s.
  - a server that accepts and never answers → exit 0 within the relay timeout + 0.5 s.
  - `AGENT_OFFICE_PORT` pointing elsewhere still posts to `127.0.0.1` (assert by listening only on 127.0.0.1); an env var giving a full URL is ignored.
  - `AGENT_OFFICE_RUN=1` → nothing posted.
  - an unknown tool arg, empty stdin, non-JSON stdin → exit 0, nothing posted.
  - each non-empty `REPLIES` entry is printed for its event.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Timeout constant with `# Why:`.
- [ ] **Step 4: Run** — Expected: PASS; `npx vitest run tests/cli.test.ts` still passes with the longer `HOOK_FILES`.
- [ ] **Step 5: Commit** `Hooks: office-relay forwards other tools' hook events`.

### Task 6: Installer, CLI `--tool`, doctor

**Files:**
- Create: `scripts/install-tool-hooks.mjs`
- Modify: `cli/agent-office.mjs` (`parseArgs` accepts `--tool <id>` / `--tool=<id>` for `install-hooks` and `uninstall-hooks`; help text), `hooks/install-hooks.sh` (when `--tool` is among its args, `exec node scripts/install-tool-hooks.mjs "$@"` from the repo, so `npm run install-hooks -- --tool codex` works), `scripts/doctor.mjs`
- Test: `tests/install-tool-hooks.test.ts`, additions to `tests/cli.test.ts`, `tests/doctor.test.ts`

**Interfaces:**
- Produces (`scripts/install-tool-hooks.mjs`):
  - `install(tool, { home, hooksDir }): { changed: string[], notes: string[] }`
  - `uninstall(tool, { home }): { changed: string[], notes: string[] }`
  - `status(tool, { home, path? }): 'connected' | 'not-connected' | 'not-installed'`
  - CLI: `node scripts/install-tool-hooks.mjs (--uninstall)? --tool <id>`; prints `notes` (Codex: approve once with `/hooks`; non-Codex: the experimental line).
- Targets per tool as in the spec's table (Codex `~/.codex/hooks.json`, Gemini `~/.gemini/settings.json` `hooks`, Antigravity `~/.gemini/config/hooks.json`, Kimi `~/.kimi-code/config.toml` else `~/.kimi/config.toml`, OpenCode `~/.config/opencode/plugins/claude-office.js` copied from `hooks/opencode-plugin.js`). Our entries are recognised by a command containing `office-relay.py` (JSON) or the Kimi markers.
- Kimi: if the file has an inline `hooks =` key outside our block → write nothing, `notes` gives the lines to add by hand.
- doctor: one informational line per tool from `status`; never FAIL.

- [ ] **Step 1: Write failing tests** against a temp `home` per tool:
  - install on a missing file creates it; on an existing file keeps every other key; writes a `.claude-office.bak` once.
  - install twice → identical file.
  - install then uninstall → byte-identical to before (and file removed if we created it).
  - user adds their own hook entry after install → uninstall keeps it.
  - target is a symlink → throws, nothing written.
  - Kimi with an inline `hooks = [...]` → no write, `notes` non-empty.
  - `status` before/after install; `not-installed` when the tool's config dir doesn't exist.
  - `parseArgs(['install-hooks','--tool','codex'])` → `tool: 'codex'`; `--tool nope` → error naming the five ids.
  - doctor reports each tool's status as info.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the three test files, then `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `Installer: connect Codex, Gemini CLI, OpenCode, Antigravity and Kimi`.

### Task 7: Show the tool in the office

**Files:**
- Modify: `src/types.ts` (`SessionInfo.client?: string`; the `session_started` action), `src/components/SessionStrip.tsx` (tag on the pill; `tool: <label>` line in `describe`), the phone session view (find via `grep -n "pillLabel\|SessionInfo" src/components`), `src/officeReducer.ts` (`ensureClaude`: the session's main character is named the tool's label instead of `cfg.title` when `client` is set), `src/styles/strip.css`
- Create: `src/tools.ts` — `export const CLIENT_LABELS: Record<string, string>` (same five labels)
- Test: additions to `tests/officeReducer.test.ts`, and a strip test in the style of `tests/inspector-ui.test.ts`

**Interfaces:** Consumes `client` on sessions and on `session_started` (Task 2).

- [ ] **Step 1: Write failing tests:**
  - `session_started` with `client: 'codex'` → the main character's name is `Codex`; without `client` → unchanged.
  - the strip renders a `Codex` tag for a `client: 'codex'` session and no tag for a Claude Code session; the hover text has `tool: Codex`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Tag styling matches existing pill text, readable in both themes.
- [ ] **Step 4: Run**, then `npx tsc --noEmit` — Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `UI: tag sessions from other AI tools`.

### Task 8: Live Codex check (owner present)

**Files:** Replace `tests/fixtures/tools/codex/*.json` with real captures; update its `README.md`.

- [ ] **Step 1: STOP and ask the owner** to run `npm i -g @openai/codex` and log in. Wait.
- [ ] **Step 2:** Start the office from this branch (`npm run build && node server/index.js` or `npm run dev`), then `node scripts/install-tool-hooks.mjs --tool codex`. Add a temporary capture: `AGENT_OFFICE_CAPTURE_DIR=<scratch>` makes the relay also write each raw payload to `<dir>/<event>-<n>.json` (test-only env var, documented in the relay header, covered by one relay test).
- [ ] **Step 3: Ask the owner** to run `codex`, approve the hook with `/hooks`, and give it one short task that runs a shell command and asks permission once. Wait.
- [ ] **Step 4: Verify** in the office: a `Codex`-tagged session appears, shows working with the tool name, raises a hand on the permission prompt, ends its turn. Screenshot it.
- [ ] **Step 5:** Copy the captured payloads into the fixtures (strip anything personal: paths reduced to `/Users/someone/project`, prompt text replaced), fix the Codex translator where a field differs, run `npx vitest run tests/tool-translators.test.ts tests/tool-hooks.test.ts` — Expected: PASS. README now says *recorded from Codex CLI <version>*.
- [ ] **Step 6: Commit** `Codex: fixtures recorded from a live session`.

### Task 9: Docs and credit

**Files:** `README.md`, `docs/reference.md`, `CONTRIBUTING.md`, `CHANGELOG.md` (`## Unreleased`)

- [ ] **Step 1:** README "Other AI tools" section: a table of the five with the install command each, Codex *supported*, the other four with the exact experimental copy and link.
- [ ] **Step 2:** `docs/reference.md`: `POST /hook/:tool` (auth, 1 MB, 404/204/200), the translator contract from Task 1, the relay, the installer targets, how to add a tool.
- [ ] **Step 3:** CONTRIBUTING, under "Got something in your fork?": *Add or fix a tool: one file in `server/tools/`, one fixture (a real capture is best), one test.*
- [ ] **Step 4:** CHANGELOG entry crediting EooL, gilberth and waguirre by name for what was ported.
- [ ] **Step 5: Verify** `grep -n "experimental — tell us if it works" README.md` shows four lines; `npm test` passes.
- [ ] **Step 6: Commit** `Docs: other AI tools, and credit for the forks`.
