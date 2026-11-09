# Claude Office — reference

Everything the [README](../README.md) leaves out: how the hooks work, every setting, the security model and the details behind each feature.

- [Connect Claude Code](#connect-claude-code)
- [Platform support](#platform-support)
- [The start/stop scripts](#the-startstop-scripts)
- [Running tests](#running-tests)
- [Auto-permissions](#auto-permissions)
- [Payroll, electricity and memory](#payroll-electricity-and-memory)
- [Incident mode — Prod Is Down](#incident-mode--prod-is-down)
- [Agent-to-agent messages](#agent-to-agent-messages)
- [Desktop app (Electron)](#desktop-app-electron)
- [Configuration](#configuration)
- [Security](#security)
- [Roadmap](#roadmap)

## Connect Claude Code

Run the installer (registers the 19 hook events below plus the status line, safe to re-run):

```bash
npm run install-hooks
```

It writes `~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` when that is set (the file Claude Code reads then), and backs it up first (`settings.json.backup.<timestamp>`, with `.1`, `.2`, … added for further runs in the same second, so no backup is ever overwritten). A settings file that is not valid JSON is refused: the installer prints the parse error with its line and column, changes nothing and exits 1, so a stray comma never costs you the rest of your settings. If you move, rename or re-clone the checkout, re-run the installer: entries that still name the old `hooks/agent-tracker.sh` / `hooks/status-line.sh` path are repointed at the current one, so Claude Code stops reporting a hook error on every tool call. An entry counts as the office's only when a word of its command is a path ending in `hooks/agent-tracker.sh` (`hooks/status-line.sh`), so your own `my-status-line.sh` or `~/.claude/status-line.sh` is chained, never replaced. `bash hooks/install-hooks.sh --no-status-line` registers the hooks only (no meters); `npm run install-status-line` (`--status-line-only`) registers the status line only, for the [plugin install](#install-as-a-claude-code-plugin).

Or add the hooks to `~/.claude/settings.json` yourself:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "PostToolUseFailure": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "SessionStart": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "PermissionRequest": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "Notification": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "StopFailure": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "PreCompact": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "PostCompact": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "PostToolBatch": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "CwdChanged": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "PostModelSwitch": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "TaskCreated": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "TaskCompleted": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ]
  },
  "statusLine": { "type": "command", "command": "bash /path/to/Claude-Office/hooks/status-line.sh", "padding": 0 },
  "subagentStatusLine": { "type": "command", "command": "bash /path/to/Claude-Office/hooks/status-line.sh --subagents" }
}
```

Now spawn agents in Claude Code and watch them appear in the office.

**Background agents** (`run_in_background: true`) stay at their desk until they finish (the `SubagentStop` hook). Each worker is tied to its Claude Code subagent the moment it exists (`SubagentStart`), so tool calls made inside a subagent show up on that agent rather than a random one, and a tool call that errors (`PostToolUseFailure` — a non-zero Bash exit, say) shows as a `failed:` status on the agent that made it. Agents still working when the server restarts are restored from `~/.agent-office/agents.json`; agents that go quiet for 2 hours (`AGENT_OFFICE_STALE_MINUTES`) clock out on their own.

**Sessions.** Every hook payload names the Claude Code session it fired in (`session_id`, `cwd`, `transcript_path`), and the tracker forwards that on every event, so the office knows which terminal each agent works for. `SessionStart` adds a pill to the title bar (`SessionEnd` removes it and walks that session's agents out); a session the server first hears of mid-way — hooks installed while Claude was already running, or a server restart — is picked up from its next event. Sessions that go quiet for `AGENT_OFFICE_STALE_MINUTES` end the same way.

**Sessions without hooks.** Claude Code keeps a registry of its running processes in `~/.claude/sessions/<pid>.json` (`$CLAUDE_CONFIG_DIR/sessions` if you moved it) — one file per CLI process, with the session id, the working directory, a display name (`office-7f`, or what `--name` / `/rename` set) and a status (`busy`, `shell`, `idle`, `waiting`). The server watches that directory (`server/sessions.js`: `fs.watch` plus a 2 s poll; a dead pid counts as gone, and so does a pid some other process holds now — a crash leaves the file behind, and after a reboot or a pid wrap its pid may name anything — told apart the way Claude Code does it, by the process start time the file recorded: `/proc/<pid>/stat` on Linux, `ps -o lstart=` on macOS, the pid alone elsewhere), so **every running session shows up in the title bar within two seconds, hooks or no hooks**. A session only the registry knows is a grey, dashed pill labelled with its registry name and tagged *not hooked*; its dot follows the registry status (`waiting` — a permission dialog or a question on its screen — is amber) and its tooltip says how to hook it. No Claude is seated for it and nothing else is shown: what a session is *doing* stays hook-only by design (nothing tails transcripts). The moment the hooks report from that terminal the pill turns into a normal one, same session id, and Claude walks in. `GET /sessions` carries `hooked` (true/false) and `registry` (`pid`, `name`, `status`, `kind`, `version`, `startedAt`, `statusUpdatedAt`) per session — a hooked session with a running process has `registry` too, as presence only, and is never swept as stale while that process lives; `GET /registry` shows the directory as the server reads it. The office's own chat bot runs `claude -p --name agent-office-bot` and is skipped by that name. *"I started Claude Code but nothing appears"*: look for the grey pill — if it is there, the session is running and only the hooks are missing (`npm run install-hooks`, or `/plugin install agent-office`); if even that is missing, `GET /registry` shows which directory the server reads and what it found there (`sessions` on `GET /health` and in `npm run doctor` counts these registry-only sessions too, so "2 sessions, 0 hooks seen" means exactly that).

**Claude's turn and needs-you.** The other ten events describe the session's own Claude, kept as `main` on each session (`GET /sessions`, the WebSocket snapshot, every `session_*` broadcast): `UserPromptSubmit` is the boss's prompt (`session_prompt` — or, when a background worker reports back, a wake-up that names the worker and carries only its summary line), every main-thread tool call is Claude *working*, `Stop` is the reply (`session_turn_end`: *waiting* when background tasks are still running, else *idle*), `PermissionRequest` and `Notification` (`permission_prompt`, `idle_prompt`, `quota_auto_resume_*`, `agent_needs_input`) make the session *needs-you* with what it waits on, `StopFailure` is an API *error* (rate limit, overloaded, ...), `PreCompact`/`PostCompact` show *compacting*, `CwdChanged` moves the project tag after a `cd`, and `PostModelSwitch` updates the model. A permission wait is shown only once it has lasted 300 ms (a headless `-p` session auto-denies and moves on faster than that), the completion of the call that asked (matched by a hash of its input, so a `git status` finishing beside the `git push` that asked does not count) or the end of that thread's batch (`PostToolBatch`) lowers the hand — for a dialog a subagent raised, the subagent's own next step or its finish does too — and so does Claude Code's session registry leaving *waiting* (the dialog was answered or dismissed in the terminal, an Esc included); a hand nobody answers comes down after ten minutes, restart or not. The hook prints nothing on `UserPromptSubmit` and always exits 0, so nothing is injected into Claude's context and no prompt is ever blocked; the compaction summary and a worker's result are never forwarded. What the office keeps of the conversation is a setting — see `logPrompts` under [Security](#security).

In the office that record is one Claude per terminal (`main-<session id>`, created by the session's first event or the snapshot, seated by the boss when that desk is free): the boss gets up and hands each prompt over at its desk, it types through the turn with its tool calls as its status line, its reply is a chat row (prompt and reply rows are tagged, under the boss and that session's Claude — never fetched from `GET /chat`), it dozes off 30 s after an idle turn end, holds a glass of water while background workers are still out, sweeps its desk during a compaction, wears a red ⚠ badge after an API error, and raises a hand while it waits on you — a chime, an amber *needs you* pill and a ✋ in front of the window title, all of which go when the server's record moves on (the granted tool, the batch end, the ten-minute timeout, your next prompt). An idle prompt and a quota pause are soft: no chime, no title prefix. Hand-overs, visits and timers are reducer effects (`src/officeReducer.ts`), so every one of these is unit-tested with synthetic events.

**Answer permissions from the office.** What a `PermissionRequest` hook prints decides the dialog, so the office can answer it for you. While a session waits on "Do you want to run this command?" a card appears beside the chat column — *Claude wants to run Bash* / *write probe.txt*, the project and session, the command or path in a monospace box, a thin bar for the time left — with **Allow** (dialog option 1), **Allow & remember** (option 2: the dialog's own suggestion, say *switch this session to accept-edits*, shown in the tooltip; only offered when the dialog made one) and **Deny** (option 3, which tells Claude "Denied from Claude Office" and lets it carry on); with one card up, `y` and `n` work too. The tracker POSTs that one event in the foreground and long-polls `GET /permission/<id>` until the server has an answer, then prints the exact hook output; every other event is still a backgrounded curl. The terminal always wins: Claude Code never cancels the hook when you answer the dialog yourself, so any later activity of the session — the tool running, the batch ending, your next prompt, a new permission request, the session ending — releases the wait and the card fades with *answered in the terminal*. A headless `claude -p` session fires no `Notification` and auto-denies the call the moment the hook returns, so a pending permission expires after **15 s** unless the session is known to be interactive — a `Notification` (`permission_prompt` fires about 6 s in, whenever you are not looking at the terminal) has been seen for it, now or earlier — in which case it may wait **10 minutes**, inside the hook's default 600 s timeout; the card's bar stretches when that happens. The whole thing is a setting, `answerPermissions` (default on, `GET`/`POST /settings`, the **Answer here** toggle in the chat header): the server mirrors it as the marker file `~/.agent-office/answer-permissions`, which the hook checks before deciding to wait, so turning it off costs no round trip and leaves the hook exactly as it was. The hook never answers when the server is down or says nothing, nothing is ever auto-allowed, and who may click is covered under [Security](#security).

**Signals.** The office also reads what your Bash commands *mean*. The tracker classifies each command (`classify_command` in `hooks/agent-tracker.sh`, after stripping `cd x &&`, env assignments, `sudo`, `npx`, `timeout` and friends, and splitting on `&&`, `||`, `;`, `|`): a **deploy** (`vercel deploy` / `--prod`, `netlify deploy`, `fly deploy`, `railway up`, `gcloud run|app deploy`, `aws … deploy`, `sam`/`serverless deploy`, `kubectl apply|rollout`, `helm upgrade|install`, `terraform apply`, `pulumi up`, `cdk deploy`, `wrangler deploy`, `firebase deploy`, `npm publish`, `gh release create`, `docker push`, a tag push), a **build** (`npm run build*`, `pnpm`/`yarn build`, `vite build`, `tsc`, `next build`, `cargo`/`go build`, `make`, `gradle`, `mvn package`, `docker build`, `webpack`, `esbuild`), a **test run** (`npm test`, `vitest`, `jest`, `pytest`, `cargo`/`go test`, `mvn`/`gradle test`, `rspec`, `phpunit`, `playwright test`) or a **push** (`git push`, to `main`/`master` or not). Its start (PreToolUse), success (PostToolUse) or failure (PostToolUseFailure, with the first meaningful error line, the exit code and a count such as *3 failing*) travels as `signals` on the event that call sends anyway, and the server broadcasts one `signal` per signal right after it, keeps the last 100 in memory (`GET /signals?since=<ms>&sessionId=<id>`, the last 20 in the WebSocket snapshot) and persists nothing. In the office a deploy in flight puts a rocket over the Claude (or worker) that ran it, a deploy that lands gets a cheer and *🚀 api deployed*, a failed deploy opens incident mode at once, a failed build or test run flashes that character red with *❌ tests failed in api — 3 failing*, the next green run posts *✅ tests green again*, and a push to main gets a small celebration; those chat lines are system rows the chat bot never answers. A segment whose exit status the shell hides (`npm test | tail`, `|| true`) is judged by its output instead, `--dry-run` never counts, and a command that names none of the table's programs never even loads the classifier, so ordinary Bash calls cost nothing extra. To teach it a tool, add a row to `SIGNAL_RULES` (programs, the subcommand words that make it count, its kind, the flags that take a value, where the target is) and the program's name to `SIGNAL_PROGRAMS` or `SIGNAL_NO_VERB` beside it, then a line to the table in `tests/hook-script.test.ts`.

**Task board.** The kanban whiteboard on the wall shows the real task list of a session — the one Claude Code keeps with its `TaskCreate` / `TaskUpdate` tools, which the terminal draws as a checklist. Claude Code writes that list to `~/.claude/tasks/<session id>/<n>.json` (`$CLAUDE_CONFIG_DIR/tasks` if you moved it; one file per task with its subject, description, the spinner's *activeForm*, the status and what it is blocked by), and the server reads it from there (`server/tasks.js`): it watches the directory of every session the office knows (`fs.watch` plus a 2 s poll, from the session's first event until it ends), reads it once the writes settle (250 ms) and sends the page a `task_board` only when something changed. `TaskCreated` and `TaskCompleted` (the hook forwards the task id and subject) only make it look at once — nothing fires when a task goes *in progress*, so the files are the truth. On the board, To do post-its are yellow, In progress blue, Done green, one waiting on an unfinished task wears a red pin, and past six a column ends in *+N*; a post-it flashes when Claude picks it up and slides into Done when it is finished, and hovering one shows its subject (the *activeForm* while in progress). The board follows the session whose tasks changed last, with its name in the corner; when several sessions have task lists, click the board to page through them. Clicking it also sends the boss over to read it out — *3 to do, 1 in progress: Fix the parser*. A session without tasks leaves the wall's decorative board exactly as it was. `GET /tasks?sessionId=<id>` lists the boards (the descriptions only with the token, see [Security](#security)). Agent teams (`~/.claude/teams`, a team's shared task list) are not shown yet.

**Uninstall.** `npm run uninstall-hooks` (or `bash hooks/install-hooks.sh --uninstall`) takes the office back out of `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR/settings.json` when that is set): it backs the file up (`settings.json.backup.<timestamp>`), removes every hook entry whose command runs `hooks/agent-tracker.sh` — under all 19 events, whatever checkout the path points at, duplicates included — and puts `statusLine` / `subagentStatusLine` back: a status line the installer chained is restored from `~/.agent-office/statusline-prev` (and `subagent-statusline-prev`), which are then deleted; one the installer added is removed. Hooks and settings that are not the office's are not touched, a file with nothing of ours in it is left as it is (exit 0), and one that is not valid JSON is refused with the parse error (exit 1, nothing changed). `--uninstall --no-status-line` removes the hooks only, `--uninstall --status-line-only` the status line only. The plugin install is removed with `/plugin uninstall agent-office` (see below).

### Install as a Claude Code plugin

The repository is also a [Claude Code plugin](https://code.claude.com/docs/en/plugins) (`.claude-plugin/plugin.json`) and its own marketplace (`.claude-plugin/marketplace.json`), so the hooks can be installed without the installer touching `~/.claude/settings.json`. In a Claude Code session:

```text
/plugin install agent-office --marketplace W17ant/Claude-Office
```

or from your shell, where it needs no confirmation:

```bash
claude plugin marketplace add W17ant/Claude-Office
claude plugin install agent-office@agent-office
```

`hooks/hooks.json` registers `hooks/agent-tracker.sh` from the installed copy (`${CLAUDE_PLUGIN_ROOT}`) for the same 19 events as the installer, with no matchers (the tracker acts on every tool call, and exits silently on anything it does not act on). `/agent-office:office` checks `http://127.0.0.1:3334/health` and prints how to start the server, which still runs from a clone or from the installed plugin directory (`npm install && npm run build && npm run server`). To remove it: `claude plugin uninstall agent-office@agent-office` (and `claude plugin marketplace remove agent-office` to drop the marketplace too).

Two things to know. Plugin hooks merge with the ones in your settings, so pick one path: if you ran `npm run install-hooks` earlier, take its hooks out with `npm run uninstall-hooks -- --no-status-line` (the status line stays), or every agent arrives twice; `npm run doctor` warns when both are active, and so does the installer. And a plugin can set [`subagentStatusLine` but not `statusLine`](https://code.claude.com/docs/en/plugins/components#default-settings): the MEMORY meter works without the status line (estimated from the session transcript, marked *est.*); payroll and electricity need it, and `npm run install-status-line`, run from the clone or the installed plugin directory, registers the status line and nothing else. Not `npm run install-hooks`: that registers every hook a second time, next to the plugin's. `claude plugin validate . --strict` runs in CI, and plugins do not load in cloud sessions.

### Troubleshooting

"Nothing appears" is almost always one of three things: the server is not running, the hooks are not installed (or point at a checkout that has since moved), or Claude Code simply has not run a tool yet. Two places tell you which:

- **The status strip** along the bottom of the office (hidden under `?sim` / `?video`, which get a `SIM` badge instead) shows `ONLINE` / `RECONNECTING…` / `OFFLINE` for the WebSocket to the office server (the page's own origin when the server serves it, `127.0.0.1:$AGENT_OFFICE_PORT` under Vite), then `hooks: last seen 12 s ago` once a hook event has reached the server — or, after a minute online with nothing heard (and the server up that long), `no hook events yet — run npm run install-hooks` — then the sessions, as in `3 sessions · 1 not hooked · 2 need you` (a session Claude Code runs without the hooks reporting it, and one waiting on a permission dialog or a question; each part is left out at zero), and the server version. Hover it for the details and the command to type, including which sessions are not hooked and what each waiting one waits on; while the server is down the strip says so and shows `npm run server`. A page without the office token (opened from a bare address rather than the link) says *read-only: open the link from `npm run open`* in amber — see [Security](#security).
- **The session strip** in the title bar lists every running Claude Code process within two seconds, hooks or no hooks, straight from Claude Code's own registry (`~/.claude/sessions`, see **Sessions without hooks** above). A grey, dashed *not hooked* pill means the session is running and only the hooks are missing; no pill at all means Claude Code is not running (or writes its registry somewhere else — `GET /registry` shows the directory the server reads).
- **`npm run doctor`** prints a `PASS` / `WARN` / `FAIL` line per link in the chain: the Node version; the hook entries in `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`) running an `agent-tracker.sh` that exists — the installer's own rule — or the `agent-office` plugin being installed; the status line; `python3` / `bash` / `curl` on the PATH; the server answering `GET /health` on `AGENT_OFFICE_PORT` and whether hooks have reached it since it started; the auth token (present, mode `0600`); `dist/` built. It ends with the install, uninstall and start commands and exits 1 on any `FAIL`, so it works in a script too (`--json` for machine-readable output).

`GET /health` returns `{ status, agents, clients, sessions, lastHookAt, hooksSeen, uiAvailable, version, uptimeMs }`; the server also sends it in the WebSocket snapshot and as a `health` event, at most one every 5 s while hooks arrive.

## Platform support

| Platform | Office in the browser | Claude Code hooks + status line | Desktop app (Electron) |
|---|---|---|---|
| **macOS** | Yes — `start-office.sh` opens the browser with `open`; notifications via `osascript` | Yes — the hooks are bash scripts that call `python3` and `curl`; macOS ships `bash` and `curl`, `python3` comes with the Xcode command-line tools | Unsigned `.dmg` for Apple silicon and Intel on the [releases page](https://github.com/W17ant/Claude-Office/releases), built by the release workflow (first launch: see [Download](#desktop-app-electron)); not launched by hand this week |
| **Linux** | Yes (verified) — `xdg-open` opens the browser; notifications via `notify-send` when present | Yes | Yes — `.AppImage` on the releases page; the self-contained bundle was built, launched and screenshotted on Linux this week |
| **Windows** | Node runs the server natively: `npm run build && npm run server`, then open `http://127.0.0.1:3334` yourself | Through **WSL** or **Git Bash**, with `python3` and `curl` on the PATH: the installer and the hooks are bash scripts. A native Node hook is on the [roadmap](#roadmap) | NSIS `.exe` installer on the releases page, built by the release workflow; not launched by hand yet |

Requirements everywhere: Node 22 (what CI runs; `better-sqlite3` is a native module), `bash`, `python3` and `curl` for the hooks and the installer, and the Claude Code CLI (`claude`) for the chat AI watcher.

## The start/stop scripts

`start-office.sh` starts the server, Vite and the chat AI watcher, each in its own process group, and records their pids in `~/.agent-office/server.pid`, `vite.pid` and `chat-watcher.pid`. `stop-office.sh` stops exactly those processes — a browser holding a WebSocket to `:3334`, the Electron app or an unrelated Vite on `:3333` are never touched. If you started the server some other way, `bash scripts/stop-office.sh --force` additionally kills whatever is *listening* on the office ports. Ctrl+C in `start-office.sh` stops everything it started; on a box without `open`/`xdg-open` it prints the URL instead of aborting.

The chat AI watcher (`scripts/chat-ai-watcher.sh`, log in `~/.agent-office/chat-ai.log`) only answers messages a person typed in the office chat — its own replies, the agents' `starting:`/`done:` announcements, agent-to-agent messages and `/commands` are never answered — and runs `claude -p` with `--max-turns 1 --model claude-haiku-5-5 --safe-mode --strict-mcp-config --tools "" --no-session-persistence` under a timeout, so a reply never fires the office's own hooks or loads your project's MCP servers. Knobs (all optional): `CHAT_AI_MODEL`, `CHAT_AI_TIMEOUT` (seconds, default 60), `CHAT_AI_MAX_REPLIES_PER_MIN` (default 5), `CHAT_AI_POLL_INTERVAL` (default 8). Every script honours `AGENT_OFFICE_HOME` (state dir) and `AGENT_OFFICE_PORT` (default 3334); `start-office.sh`/`stop-office.sh` also take `AGENT_OFFICE_UI_PORT` (default 3333). The server, the hook, the status line, the page and the desktop app read the same `AGENT_OFFICE_PORT`, so one export moves the whole office — see [Configuration](#configuration).

## Running tests

`npm test` runs the Vitest suite in `tests/` (server API, WebSocket, sessions, status/meters, health, incident commands, the office reducer, hook script, status line, installer, doctor, shell scripts, runtime config — 902 tests) against a temp `AGENT_OFFICE_HOME`, so your real `~/.agent-office` is never touched; `npm run test:watch` keeps it running. CI (`.github/workflows/ci.yml`) runs `tsc --noEmit`, `claude plugin validate . --strict`, `npm test`, `vite build` and `npm run check-assets` on every push to `main` and every pull request.

`npm run check-assets` guards `public/`: every sprite and room the code can ask for must exist (a missing one fails), files nothing references are listed, and `public/` must stay under a size budget. To add a sprite, drop the PNG under `public/sprites/` and reference it from the code — a literal path or one of the dynamic patterns documented at the top of `scripts/check-assets.mjs` — so the check sees it; rooms are exported at twice the 754 px they are drawn at.

## Auto-permissions

The repo includes `.claude/settings.json` which auto-allows curl commands to the local office server (`127.0.0.1:3334`) and the start/stop scripts. This means the chat monitor cron and office commands run without permission prompts.

## Payroll, electricity and memory

A wall panel appears above the chat the moment Claude Code sends its first status line — or, for a session without one, once its transcript has a reply in it (see below) — and not before. **PAYROLL** is what the open sessions have cost, with the $/min burn over the last five minutes underneath; **ELECTRICITY** is the tokens the API chews through per minute (context re-reads included — that is what you pay for) as a gauge whose stripes flow faster the harder it burns; **MEMORY** is the context-window fill — amber past 70 %, red past 90 %, and once a session passes 85 % the chat gets a "Claude's desk is getting cluttered" line (once per session). claude.ai subscribers also get a **5h** pill with the five-hour rate-limit utilisation. Hover any meter for the exact numbers and the model; with several terminals open the panel stacks one row per session (up to four).

The numbers are Claude Code's own: `npm run install-hooks` registers `hooks/status-line.sh` as the [`statusLine`](https://code.claude.com/docs/en/statusline) command (and as `subagentStatusLine`, which adds per-worker token counts) next to the hooks. It forwards the JSON to `POST /status` (same bearer token as `/event`) and prints `<model> · ctx <used>% · $<cost>`. **If you already had a status line, you keep it**: the installer saves your command in `~/.agent-office/statusline-prev` and `status-line.sh` runs it with the same input and prints its output, so what you see does not change. A command only counts as the office's when it runs a path ending in `hooks/status-line.sh`; anything else, `my-status-line.sh` and `~/.claude/status-line.sh` included, is yours and gets chained. `bash hooks/install-hooks.sh --no-status-line` skips the status line altogether, and `npm run install-status-line` registers it alone (no hooks), which is what a plugin install wants. `GET /status` returns the sessions and the totals (cost today, tokens/min, $/min); nothing is persisted, and a session that goes quiet for `AGENT_OFFICE_STALE_MINUTES` drops off the panel. Claude Code re-runs the status line only when something changes, so an idle session reports nothing: the server re-reads the burn once a minute and the panel follows it down to zero as the five-minute window empties. Cost today counts a session that dropped off and came back later the same day (a long lunch, `claude --resume`) once, not twice.

**Without the status line.** Two common setups never send one: the plugin install (a plugin cannot register `statusLine`) and headless `claude -p` runs (no status line is rendered at all). Their hooks still report, and every hook event names the session's transcript, so for such a session the server estimates **MEMORY** from it (`server/meterEstimate.js`): the context in use is the last reply's `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens` (the number Claude Code itself reports as a resumed session's `context_tokens` and a compaction's `preTokens`), and the window is the model's:

| Model | Window | Where the number comes from |
|---|---|---|
| any model id with a `[1m]` tag (`requestedModel` in the transcript keeps it) | 1,000,000 | Claude Code's own rule for the status line's `context_window_size` |
| `claude-haiku-5-5`, `claude-sonnet-5`, `claude-sonnet-5-5`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`, `claude-opus-5-5`, `claude-fable-5`, `claude-fable-5-1`, `claude-mythos-5`, `claude-mythos-5-1`, `claude-mythos-preview` | 1,000,000 | native 1M context in Claude Code 2.1.300's model table; for `claude-haiku-5-5` also the `-p` result's `modelUsage[…].contextWindow` and the status line's `context_window_size` |
| `claude-haiku-4-5`, `claude-3-5-haiku`, `claude-3-5-sonnet`, `claude-3-7-sonnet`, `claude-sonnet-4(-0)`, `claude-sonnet-4-5`, `claude-sonnet-4-6`, `claude-opus-4(-0)`, `claude-opus-4-1`, `claude-opus-4-5`, `claude-opus-4-6` | 200,000 | the same table |
| anything else | 200,000, marked approximate (`≈`) | the default; more than 200k tokens in use means the 1M variant, so the window becomes 1M (also approximate) |

Dated, Bedrock and Vertex spellings of an id count as the id. The reading refreshes when a hook event for the session arrives, at most once every 5 s per session (a burst ends in one trailing read), from the end of the file only, after the server has answered the hook. The panel draws it with a small **est.** marker; its tooltip says it comes from the transcript because no status line is registered. **PAYROLL** and **ELECTRICITY** are not estimated — the transcript has no cost and no rate limits, and the office does not price tokens or invent limits — so when no session reports them the tiles say *needs the status line* (hover for `npm run install-status-line`), and an estimated session's row shows no cost. The moment a real status line reports for that session it wins and the estimate stops for good. The estimate is numbers and a model id only, never what was said, so it is on the open `GET /status` with `source: "transcript"` and an `estimate` block (`tokens`, `basis`: `model` / `1m-tag` / `unknown` / `overflow`, `approximate`); status-line sessions carry `source: "statusline"`.

## Incident mode — "Prod Is Down"

The office declares an incident **by itself** when real failures happen: a deploy that fails (a `deploy_fail` [signal](#connect-claude-code) — `vercel deploy`, `fly deploy`, `kubectl apply`, ... exiting non-zero) switches it on at once, and three failed tool calls (`PostToolUseFailure`) inside five minutes do too — a failed build or test run counts as one under its own name (*tests failed in api: 3 failing*), never twice. A `deploy-fail` or `who-broke-build` random event starts a 90 s mini-incident instead, and `/incident` in the chat declares one by hand (relayed to every open office).

While it is on, the room is forced to night and tinted red, a beacon flashes over the door, the wall TV shows the rollback status page, the "days since last incident" sign flips to 0, agents whose last tool call failed carry a build-failed bubble, the chat header shows a live incident timer, and the spawn / working / done / boss lines come from an incident pool.

It ends with `/all-clear`, ten minutes without a new failure, a deploy that goes out (`deploy_success`), the last red build or test run going green again (`build_ok` / `test_ok`), or a `deploy-success` random event during a mini-incident, and posts a one-line postmortem (duration, failures by tool, who was involved, and the root cause — the last named failure, such as *deploy of api failed: Error: 503*, else the last failing tool). A green run while no incident is on clears the five-minute failure window instead. The sign then counts the days from `localStorage['agent-office-last-incident']`. `?variant=incident` pins it on with auto-exit off, for screenshots. Incident mode is a *variant*, so it stacks with the Dunder Mifflin skin.

The dedicated incident art (beacon frames, pizza tower, incident board, per-role props) is a follow-up: `src/incidentAssets.ts` lists the slots and today's fallbacks, and `public/sprites/incident/README.md` lists the files to draw. The office picks them up with no code change.

## Agent-to-agent messages

Agents can talk to each other, not just to you. A directed message shows up in the chat as `→ @Debugger`, and the sender walks over to the recipient's desk.

```bash
# Who is in the office?
python3 scripts/agent-message.py --who

# Send a directed message (type: message | question | review_request | task_handoff)
python3 scripts/agent-message.py --from Reviewer --role code-reviewer \
  --to Debugger --type review_request 'can you check the token refresh in auth.ts?'

# Read your inbox (clears the unread badge on your desk; --peek to leave it)
python3 scripts/agent-message.py --inbox Debugger
```

Agents with unread messages get a red ✉ badge over their head until they read their inbox.

Under the hood: `POST /chat/reply` takes `recipient`, `type` and `replyTo` (a leading `@Name` in the text works too), `GET /chat?recipient=<name>` returns a recipient's messages, `GET /agents` lists who's in the office, and the latest message per recipient is written to `~/.agent-office/inbox/<name>.json` for sessions that poll. Agents can't message themselves, and a pair of agents is limited to 10 messages a minute (`AGENT_OFFICE_A2A_LIMIT`) so two bots can't loop forever. `POST /chat/reply` and `POST /chat/inbox/read` speak for an agent, so they need the office bearer token (`Authorization: Bearer $(cat ~/.agent-office/auth-token)`); `scripts/agent-message.py` reads the token file for you. The read-only `--who` and `--inbox` listings do not.

### A2A protocol

The office also speaks a subset of the [Agent2Agent (A2A) protocol](https://a2a-protocol.org), so A2A clients can reach office agents directly:

| Endpoint | What it does |
|----------|--------------|
| `GET /.well-known/agent-card.json` | Agent card for the office |
| `GET /a2a/agents` | One agent card per agent in the office (with `metadata.officeId` and `unread`) |
| `POST /a2a` | JSON-RPC 2.0 `message/send` (needs the bearer token) |

`GET /.well-known/agent-card.json` and `GET /a2a/agents` are open (and the cards advertise a `bearer` security scheme). `POST /a2a` delivers a message as an agent, so it needs the office token — send it as `Authorization: Bearer <token>`, the contents of `~/.agent-office/auth-token`:

```bash
curl -s 127.0.0.1:3334/a2a \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $(cat ~/.agent-office/auth-token)" -d '{
  "jsonrpc": "2.0", "id": 1, "method": "message/send",
  "params": { "message": {
    "kind": "message", "messageId": "m1", "role": "agent",
    "parts": [{ "kind": "text", "text": "can you check token refresh?" }],
    "metadata": { "from": "Reviewer", "to": "Debugger", "type": "review_request" }
  } }
}'
```

The recipient goes in `metadata.to` (name, role or office id); replies thread through `referenceTaskIds` or `metadata.replyTo`. Tasks and streaming aren't supported: every message is delivered as-is and the stored message comes back as the result. Without the token the call returns a JSON-RPC error with code `-32001`.

## Desktop app (Electron)

The desktop app is self-contained: it bundles the office server, the built UI and `node_modules`, runs the server on the Node that ships inside Electron (nothing needs to be installed, and no `node` on the PATH), and loads the office from `http://127.0.0.1:3334/` — one port for the page, its assets and the WebSocket — with the office token from `~/.agent-office/auth-token` in the URL fragment, read once the server answers (see [Security](#security)). Launched with `AGENT_OFFICE_PORT` in its environment (from a terminal, say), the app starts its server, loads the page and points the tray at that port instead. If something else already answers on that port without the office's page (a checkout server with no `npm run build`, say), the packaged app says so in a dialog naming the port instead of loading a blank window.

**Download.** Every tagged release carries installers built by the [release workflow](../.github/workflows/release.yml); the [releases page](https://github.com/W17ant/Claude-Office/releases) has them, named `Agent-Office-<version>-<os>-<arch>`:

- **macOS** — `…-mac-arm64.dmg` (Apple silicon) or `…-mac-x64.dmg` (Intel); drag the app into Applications. The app is not signed or notarised, so macOS refuses it on first launch: right-click (Control-click) the app and choose **Open**; if it says the app is damaged, clear the quarantine flag with `xattr -dr com.apple.quarantine "/Applications/Agent Office.app"` and open it again.
- **Windows** — `…-win-x64.exe`, an ordinary installer that asks where to install. SmartScreen warns about an unknown publisher: **More info → Run anyway**.
- **Linux** — `…-linux-x86_64.AppImage`: `chmod +x` it and run it. Like any AppImage it needs FUSE 2 (`libfuse2` on Debian and Ubuntu); without it, `./Agent-Office-*.AppImage --appimage-extract-and-run` works.

The app is the office, not the hooks: agents only show up once the hooks are installed from a checkout with `npm run install-hooks` (see [Connect Claude Code](#connect-claude-code)).

```bash
npm run dev:electron    # Development: Vite on 3333 + an Electron window; the server runs on your Node
npm run pack            # Unpacked build in release/<platform>-unpacked (quick smoke test)
npm run build:electron  # Installer for this OS (.dmg, .exe or .AppImage) in release/
```

**The window.** The office is a fixed 1056×682 layout, so the window opens at exactly that size, centred on the screen, and scales the office to fit whatever size you drag it to — the layout never reflows, it is zoomed and letterboxed, down to half size. The window remembers its size and position in `window-state.json` under the app's user-data directory (`~/Library/Application Support/Agent Office`, `%APPDATA%\Agent Office` or `~/.config/Agent Office`) and restores them clamped to the display's work area, so it cannot come back off-screen after a monitor is unplugged or a resolution changes. The office draws its own title bar: drag it to move the window, right-click anywhere else for the menu described under the tray below. `Office → Reset window size` (also in the tray and right-click menu, and `Cmd/Ctrl+Shift+0`, which works without a menu bar) puts the window back to its default size and spot.

**Compact widget** — `Office → Compact widget`, `Cmd/Ctrl+Shift+C`, the tray menu, or `--compact` on the command line — turns the window into a small always-on-top widget showing just the room. The layout is scaled to 60 % and shifted so the chat panel sits off the right edge: the agents keep moving in a 452×409 corner of the screen (top-right the first time) that follows you across virtual desktops and full-screen apps. It resizes (the room scales with it), has its own remembered size and spot, and the title bar is still the drag handle. Toggle it off and the full office comes back where it was. **Always on top** (`Cmd/Ctrl+Shift+T`) is a separate toggle for the full window; the widget is always on top by nature.

**Tray / menu bar.** The app puts a pixel-art desk in the tray (the menu bar on macOS) and reads `GET /agents` and `GET /sessions` every 5 s: the tooltip says `Agent Office — 2 working, 1 needs you` (or `the office is empty`, `server not reachable`), the window title carries the same line, and on macOS the number of working agents — plus `1!` when a session waits on you — sits beside the icon. Its menu, also on right-click in the window: the status line, **Show/Hide office**, **Compact widget**, **Always on top**, **Reset window size**, **Open in browser** (the same office at `http://127.0.0.1:3334/`, or the `AGENT_OFFICE_PORT` it runs on, opened with the office token through the redirect page `npm run open` uses), **Quit**. On macOS and Windows closing the window keeps the app in the tray (the Dock icon, the tray or opening the app again brings the window back); on Linux, where not every desktop shows a tray, closing the window quits.

**Icons.** `scripts/generate-icons.mjs` draws the tray glyph and the app icon as pixel maps and writes the PNGs with no image tooling: `electron/assets/` holds the tray icons and the Linux window icon, `build/icon.png` (512×512) is what electron-builder turns into the `.icns`, `.ico` and Linux icon set. The macOS tray icon is a monochrome template image (`trayTemplate.png` and `@2x`), tinted by the menu bar for light and dark mode. Re-run the script after editing the maps; a test fails when the committed files are stale.

How a build is put together (the `build` section of `package.json`):

- `vite build` writes the UI and everything in `public/` to `dist/`; the server serves `dist/` from `/` when it exists, so the sprites ship once.
- `asar` is off: the server is a plain Node child process that reads `dist/`, `server/` and `node_modules` with ordinary `fs` calls.
- `npmRebuild` is off, so the checkout's `node_modules` stay built for your system Node and `npm test` / `node server/index.js` keep working after a pack. `electron/after-pack.cjs` fetches the Electron build of `better-sqlite3` (through its own `prebuild-install`) into the packaged copy only.
- `build/icon.png` is the app icon (see Icons above); electron-builder reads it from `build/`, its `buildResources` directory, and the tray icons ship with `electron/**`.
- `mac.target` is one `dmg` per architecture (`arm64` and `x64`) rather than a universal app: `after-pack.cjs` fetches one `better-sqlite3` prebuilt per architecture and refuses `universal`, and a single-architecture download is half the size. `win.target` is an NSIS installer that asks where to install (and no `.blockmap` next to it: there is no auto-updater to use one), `linux.target` an AppImage. `artifactName` fixes the file names to `Agent-Office-<version>-<os>-<arch>.<ext>`, and `publish` names the GitHub draft release the release workflow uploads to — a local `npm run build:electron` never publishes; electron-builder only does that on CI or when asked with `--publish`.
- Debugging a build headlessly: `AGENT_OFFICE_SCREENSHOT=/tmp/office.png` makes the app save a screenshot of its window a few seconds after the page loads, then quit (works under `xvfb-run`); add `--compact` to capture the widget.

The same single-port mode works without Electron: `npm run build && npm run server`, then `npm run open` (or the link the server printed). The Linux bundle was built, launched and screenshotted (full window and compact widget) under xvfb; the tray icon was created there but a headless X server has no panel to show it in, and the macOS and Windows packages come out of the release workflow but have not been launched by hand since the bundle became self-contained — see [Platform support](#platform-support).

**Cutting a release** (maintainers). `npm version minor` (or `patch` / `major`) bumps `package.json` and `package-lock.json` and — through the `version` script, `scripts/sync-plugin-version.mjs` — `.claude-plugin/plugin.json`, then commits and tags `vX.Y.Z`; `git push --follow-tags` pushes the commit and the tag. The tag starts [`release.yml`](../.github/workflows/release.yml): it checks that the tag matches `package.json`, creates a **draft** release for it, then builds on macOS, Windows and Linux runners and uploads the installers (and electron-builder's `latest*.yml` update metadata) to that draft. Nothing is public until you open the draft on the releases page, edit the notes and publish it. A failed leg can be re-run from the Actions tab, and **Run workflow** on the tag rebuilds everything; both upload to the same draft. A tag whose release is already published is left alone. Nothing in the pipeline signs — there is no Apple or Windows certificate — hence the first-launch steps under Download.

## Configuration

Everything is optional; the defaults are the office as described above. Set these in the shell that starts the office **and** in the one that starts Claude Code (the hook and the status line run inside Claude Code and read them there).

| Variable | Default | Read by | What it does |
|---|---|---|---|
| `AGENT_OFFICE_PORT` | `3334` | server, hook, status line, office scripts, `npm run doctor`, Vite dev (proxy and page), desktop app and tray | The office server's port. Not a port (letters, `0`, `70000`)? The server warns and uses 3334, as do Vite and the desktop app; the shell hooks and scripts use the value as given, so fix it rather than rely on that. The page served by the server needs nothing: it talks to the origin it was loaded from |
| `AGENT_OFFICE_HOST` | `127.0.0.1` | server | The bind address, **IPv4 loopback only**: `127.0.0.1` or `localhost`, and both bind `127.0.0.1` (`localhost` is not left to the resolver, which may answer `::1`). `::1` is refused too, with the reason logged: the office scripts, `npm run doctor`, the desktop app and `/agent-office:office` all dial `127.0.0.1`, which a server on `[::1]` alone would refuse. Anything else (`0.0.0.0`, a LAN address) is refused with the reason logged and the server binds `127.0.0.1` — see [Security](#security) |
| `AGENT_OFFICE_UI_PORT` | `3333` | `start-office.sh`, `stop-office.sh`, the server's origin allowlist | The Vite dev server's port (`start-office.sh` runs `vite --port`); `npm run dev` always uses 3333 |
| `AGENT_OFFICE_HOME` | `~/.agent-office` | server, hook, status line, scripts | The runtime dir: auth token, `agents.json`, `chat.db`, inbox files, pid files |
| `AGENT_OFFICE_EVENT_URL` | `http://localhost:$AGENT_OFFICE_PORT/event` | hook (`agent-tracker.sh`) | The full event URL; wins over `AGENT_OFFICE_PORT` |
| `AGENT_OFFICE_STATUS_URL` | `http://localhost:$AGENT_OFFICE_PORT/status` | status line (`status-line.sh`) | The full status URL; wins over `AGENT_OFFICE_PORT` |
| `AGENT_OFFICE_CONFIG_DIR` | the directory holding `package.json` | server | Where `office.config.json` is read from (see [Customise your character](../README.md#customise-your-character)) |
| `AGENT_OFFICE_REGISTRY_DIR` | `$CLAUDE_CONFIG_DIR/sessions` | server | Claude Code's session registry, the source of the *not hooked* pills (see [Sessions without hooks](#connect-claude-code)) |
| `AGENT_OFFICE_TASKS_DIR` | `$CLAUDE_CONFIG_DIR/tasks` | server | Where Claude Code keeps each session's task list, the source of the task board (see [Task board](#connect-claude-code)) |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | server, `npm run doctor`, the installer | Claude Code's config dir: the server reads the session registry and the task lists under it, the doctor reads `settings.json` there, and `npm run install-hooks` / `uninstall-hooks` write that `settings.json` (an older installer wrote `~/.claude/settings.json` regardless; the doctor points those entries out) |

`office.config.json` (the boss's name, sprite, colour and emoji) is read by the server at runtime and applied by the page on load, so changing it needs a reload, not a rebuild; `GET /config` shows what the server read. Other knobs (`AGENT_OFFICE_STALE_MINUTES`, `AGENT_OFFICE_A2A_LIMIT`, the `CHAT_AI_*` settings) are described where they apply.

## Security

The server always binds `127.0.0.1` (IPv4 loopback): `AGENT_OFFICE_HOST` may
spell it `127.0.0.1` or `localhost`, both of which bind `127.0.0.1`, and `::1`
and anything else are refused with the reason and `127.0.0.1` bound. So it is
never on the network. The threat it defends against is therefore what else
runs on the same machine: a malicious npm dependency, or another local user on
a shared host. Loopback is not user-isolated — any local process can reach the
port, open the WebSocket and send any `Origin` or `Host` header it likes
(`Origin` only binds browsers). Three separate defences follow from that:

- **Browsers on other origins** are kept out by the origin allowlist, which
  refuses every origin but the loopback UI (the Vite port, 3333, and the
  server's own port, 3334 or `AGENT_OFFICE_PORT`) with a 403 or a 1008 close,
  and by the JSON content type, which makes a cross-site POST preflight.
- **DNS-rebinding pages** — which reach `127.0.0.1` on a GET that carries no
  `Origin` — are kept out by a **Host-header guard**: the first middleware (and
  the WebSocket handler) serve a request only when its `Host` names a loopback
  host (`localhost`, `127.0.0.1` or `[::1]`, any port); anything else is `421`
  / a `1008` close. A rebinding page's `Host` is still its own domain, so it
  can no longer read the pending command lines, cwds, titles or agent tasks on
  the open GETs.
- **Other local processes and users** are kept out of the conversation and of
  every route that acts by the **office token**: the contents of
  `~/.agent-office/auth-token`, a `0600` file only you can read. The hook and
  the status line never send the token — they **sign** each request with it
  (below); the office scripts and A2A clients send it as a bearer token from
  their own memory; the office page gets it through a link only you see
  (below). Without it, a connection still sees the office — read-only.

A non-loopback bind is refused on purpose, not merely unsupported: the
read-only view and every open `GET` would hand every agent's task and status
line to the network, and the token travels in clear HTTP.
`AGENT_OFFICE_HOST=0.0.0.0` therefore logs that reason and binds `127.0.0.1`.

**The office link.** When the server starts it prints, to its own output only,

```
  Agent Office: http://127.0.0.1:3334/#token=<the office token>
```

Open that link once per browser and the office is fully yours: the page takes
the token out of the URL fragment — which a browser never sends to a server, so
it is in no request and no server log — keeps it in that browser profile's
`localStorage` (per browser profile, so per OS user in practice; `sessionStorage`
or memory when storage is blocked), strips it from the address bar, and
presents it each time its WebSocket connects. Browsers cannot set headers on a
WebSocket, so it travels as a subprotocol value
(`Sec-WebSocket-Protocol: agent-office, agent-office.token.<token>`), never as
part of a URL; the server answers with plain `agent-office`. Because the token
stays in that origin's storage, there is one case this does not cover: if the
office is down, another user's process holds its port and you open the bare
address in that browser, that process's page runs on the same origin and can
read the stored token. On a shared machine, prefer `npm run open` (it checks the
server first) and run `npm run rotate-token` if you ever opened the office while
it was not running. You rarely type the link:

- **`npm run open`** prints the link and opens it (`open` / `xdg-open` /
  `explorer`; it just prints it when there is no opener). The browser is handed
  a small redirect page, `~/.agent-office/open-office.html` (`0600`), rather
  than the link itself, because an opener's command line — and that of a
  browser it starts — is readable by every local user in `ps` while it runs.
  Before it prints or opens anything it sends `GET /health?challenge=<random>`
  and checks the `proof` in the answer, `HMAC-SHA256(token, "office-health:" +
  challenge)`: a process that took the port while the office was down cannot
  make it, so it is never handed the link (exit 1, "it is not this office").
  The desktop app does the same before it puts the token in its window or in
  "Open in browser", and shows the office read-only otherwise.
  (A Snap-confined browser cannot read hidden folders in your home; paste the
  printed link there.) `--dev` opens the Vite dev server's page instead,
  `--print` only prints.
- **`bash scripts/start-office.sh`** does the same for the page it starts.
- **The desktop app** reads the token file once its server answers `/health`
  and loads the window with the link; *Open in browser* in its menu goes
  through the same redirect page.

The token is **stable across restarts**: a start reuses the file when it is
still safe to trust — a regular file (a symlink is not followed), owned by
you, mode `0600` with no group or other bits, holding a well-formed token — so
a browser that opened the link keeps working after the office restarts.
Anything else (missing, malformed, readable by others, owned by someone else)
is replaced by a new token, written only once the port is bound, so starting a
second server while one is running never clobbers the live token. To
**rotate** it, stop the office and run `npm run rotate-token` (it deletes the
file; it refuses while the office is running, `--force` overrides) or delete
`~/.agent-office/auth-token` yourself; the next start writes a new one, and
pages that kept the old one drop to read-only until they get the new link.

**Without the token** — a bare `http://127.0.0.1:3334/` bookmark, another
browser, another local user — the WebSocket still serves the office,
read-only, and the page says so in the status strip (*read-only: open the link
from `npm run open`*): agents, tasks, states, status lines, sessions, counts,
meters and signals — what `GET /agents` and `GET /sessions` show — and no
conversation. In detail, a read-only connection gets no UI token, no
`main.lastPrompt` / `main.lastReply` on any session or event, no `text` on
`session_prompt` / `session_turn_end` (and no chat row with `msg_type`
`prompt` / `reply`), no `detail` (the command line, path or tool input) or
`suggestions` on a permission dialog, and no `error` / `detail` (the
command's output) on a signal. What stays is the office's one-line labels:
a status line such as `running: npm test` and a dialog's tool and summary show
the start of a command, as `GET /agents` always has. Permission cards on a
read-only page show which tool waits but offer no buttons, and the chat's
*Answer here* toggle is hidden: the server would refuse both.

So every route that **acts as an agent, answers for you or destroys state**
requires the token, conversation text requires it, and the rest stay open:

| | Routes | Why |
|---|---|---|
| **Token required** (bearer **or** a valid request signature) | `POST /event`, `POST /status`, `/chat`, `/chat/reply`, `/a2a`, `/chat/inbox/read`, `/chat/seen`, `/chat/react`, `/chat/video-mode`, `GET /permission/:id` (the hook's long-poll for a decision) | Speaks for an agent, accepts conversation input, writes another agent's inbox, feeds the meters, learns how a permission was decided, or wipes history. The hook and status line authenticate here by **signing** (below); the page and scripts send the bearer token |
| **UI token or token** | `POST /permission/:id` (answer a permission dialog), `POST /settings` | The two things the office page itself may change. The server mints a second secret per process, the UI token, and hands it out in one place only: the WebSocket snapshot of a connection that presented the office token. Nobody without the token file can obtain it. It lives in memory, changes on every restart and is compared in constant time |
| **Open** | every other `GET` (with sensitive conversation fields filtered without the token), the read-only `/status` · `/agents` · `/help` · `/incident` · `/all-clear` commands, `POST /chat/typing`, `POST /chat/cron-state` | These do not accept conversation text or act as an agent |
| **Open, but the conversation needs the token** | `GET /chat`, `GET /sessions`, `GET /permissions`, `GET /signals`, the WebSocket | Without the token: no chat rows with `msg_type` `prompt` / `reply`, no `main.lastPrompt` / `main.lastReply`, no permission `detail` / `suggestions`, no signal `command` / `error` / `detail`, and the WebSocket is read-only as above. With it (the office page, the office scripts), they are included |
| **Open, but the descriptions need the token** | `GET /tasks` (the task boards) | Anyone on loopback gets each session's task subjects, *activeForm*s, states, blockers and owners — as open as an agent's task on `GET /agents`. A task's description is longer text written from the conversation: only a token holder gets it. The `task_board` broadcasts and the snapshot's `taskBoards` never carry it, so a read-only WebSocket gets them unchanged |
| **Open, but the transcript needs the UI token or the token** | `GET /agents/:id` (the inspector card) | Anyone on loopback gets the card's history, tool counts and stats — tool names and status lines, what `GET /agents` and `GET /sessions` already show. The transcript tail (what the agent said, the commands it ran) and a session Claude's last prompt and reply go only to the office page, which sends the UI token, or a token holder; anyone else gets `transcriptAvailable: false` with the reason `needs the office token`. A wrong token counts as none. With a token the tail still follows `logPrompts` |

- The token is 32 random bytes, checked in constant time. **Request signing:**
  the hook and the status line never put the token on a command line, where
  every local user can read it in `ps` / `/proc` (and it is stable across
  restarts, so a leak would stay valid). They **sign** each request instead —
  `HMAC-SHA256(token, method + path + timestamp + body)` — and send the
  timestamp and signature as `X-Office-Timestamp` / `X-Office-Signature`
  headers; the token stays in the file and the process's own memory. The server
  verifies the signature over the raw body, in constant time, for a timestamp
  within ±60 s, so a signature a reader scrapes from `ps` is useless beyond
  replaying that one request inside the window (the victim's own event). The
  office scripts (`chat-post.py`, `chat-reply.py`, `agent-message.py`, the chat
  watchers) and A2A clients instead send `Authorization: Bearer <token>` from
  their own memory (never argv), and the server accepts either. The link the
  server prints carries the token, so if you redirect the server's output to a
  file, keep that file private.
- Everything the server writes under `~/.agent-office` (the token, `agents.json`,
  `chat.db` and its `-wal` / `-shm` siblings, the A2A inbox files, `last-chat`,
  the chat-monitor state, the redirect page) is mode `0600` and the dir is
  `0700`, so another local user can't read directed messages, the stored
  prompts or the latest chat. SQLite would otherwise create `chat.db` under the
  process umask (often `0644`), and a dir the installer or `start-office.sh`
  made first stays `0755`, so the server tightens both — and any already-loose
  `chat.db*` — on every start, repairing an older install.
- The chat AI watcher authenticates its read with the office token and never
  includes local persona files or development context in Claude prompts. Chat
  text is delimited and marked as untrusted content so it cannot override the
  prompt's privacy instructions.
- Electron packaging fails closed unless `BETTER_SQLITE3_PREBUILD_SHA256` is
  set to the expected 64-character SHA-256 digest. The downloaded native
  `better_sqlite3.node` is hashed before the package is accepted.
- **Your prompts and Claude's replies are stored locally**, in `~/.agent-office/chat.db`
  (mode `0600`) and in `agents.json`, at the level `logPrompts` sets:
  `summary` (the default) keeps the first 200 characters of each, `full` keeps up
  to 2000, `off` keeps nothing — state transitions only, no text stored or
  broadcast. Change it with
  `curl -X POST http://127.0.0.1:3334/settings -H "Authorization: Bearer $(cat ~/.agent-office/auth-token)" -H 'Content-Type: application/json' -d '{"logPrompts":"off"}'`
  (it persists in `~/.agent-office/settings.json`; `GET /settings` shows it, and
  the chat header shows the current level — `prompts: summary` — with that
  command in its tooltip). Lowering the level also trims what the sessions
  already hold — each one's last prompt and reply, in memory and in
  `agents.json` — so `off` stops an earlier prompt riding on later broadcasts.
  The hook itself never forwards more than 2000 characters, nor a compaction
  summary or a worker's result. Rows already stored in `chat.db` are removed
  with `/clear` (token required) — e.g. `python3 scripts/chat-post.py /clear`,
  which sends the token from its own memory — and that blanks each session's
  last prompt and reply as well.
- **Answering a permission dialog** is the one action the office page takes
  on a Claude Code session, so its path is narrow. A dialog can be answered
  only with the UI token — which only a page holding the office token
  receives — or with the office token itself; nothing is ever auto-allowed.
  The hook does not trust the answer on the port's say-so: it **builds the hook
  output itself** from a single decision word (`allow` | `allow-remember` |
  `deny`) and never prints server-supplied JSON, so a process squatting the
  port while the office is down cannot slip in an `updatedInput` or a rule the
  dialog never offered; `allow-remember` echoes only the dialog's own
  `permission_suggestions`. And it prints nothing until the office **proves it
  holds the token**: the hook sends a random nonce on the POST and the server
  returns `HMAC(token, nonce + permissionId + decision)`, which the hook
  verifies in constant time. A squatter has never seen the token and cannot
  forge that proof, so its answers print nothing and the terminal dialog stays
  in charge — as it also does when the server is down, unreachable mid-wait, or
  says the dialog was answered elsewhere. The whole path is off when
  `answerPermissions` is false (the `~/.agent-office/answer-permissions` marker
  is removed and the hook behaves as before); the server also removes that
  marker when it stops (SIGINT / SIGTERM / exit), so a stopped office never
  leaves the hook waiting on whatever now holds the port.
- Errors are returned as `{ "error": ... }` with no stack trace or absolute
  path; message ids are validated and a message's reactions are capped.
- `GET /roster`, `GET /agents` and the inspector's `GET /agents/:id` do expose
  each agent's task text (the first 80 characters of the subagent's
  description), its tool calls and status lines, and the names of the
  configured MCP servers. `GET /agents/:id` also serves the **transcript
  tail** — the last few things the agent itself said and the tools it called,
  read from the end of its own Claude Code transcript — but only to the office
  page (UI token) or a token holder, as in the table above, and it follows
  `logPrompts` exactly like the prompts: `off` serves none of it, `summary`
  200 characters per entry, `full` 2000. The rest is the office's purpose, it
  is localhost only, and anything on the machine can already read
  `~/.claude/settings.json`.

## Roadmap

Open and planned work lives in [GitHub issues](https://github.com/W17ant/Claude-Office/issues). Next up, roughly in order:

- **OS notification** when a permission wait starts, now that the office can answer the dialog itself (`notify.sh` already covers macOS and Linux; the server only calls it for chat mentions and failed agents today)
- **`npx` one-liner** to start the office without a checkout
- **Spooky Sprint**, a seasonal variant on the incident-mode axis — art-gated
