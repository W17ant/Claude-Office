# Claude Office — reference

Everything the [README](../README.md) leaves out: how the hooks work, every setting, the security model and the details behind each feature.

- [Connect Claude Code](#connect-claude-code)
- [Platform support](#platform-support)
- [The start/stop scripts](#the-startstop-scripts)
- [Run it with npx](#run-it-with-npx)
- [Running tests](#running-tests)
- [Auto-permissions](#auto-permissions)
- [Payroll, electricity and memory](#payroll-electricity-and-memory)
- [Seasons](#seasons)
- [Christmas](#christmas)
- [Settings panel](#settings-panel)
- [Sound](#sound)
- [End-of-day recap](#end-of-day-recap)
- [Incident mode — Prod Is Down](#incident-mode--prod-is-down)
- [Agent-to-agent messages](#agent-to-agent-messages)
- [Desktop app (Electron)](#desktop-app-electron)
- [Configuration](#configuration)
- [Security](#security)
- [Roadmap](#roadmap)

## Connect Claude Code

Run the installer (registers the 23 hook events below plus the status line, safe to re-run):

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
    ],
    "Elicitation": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "ElicitationResult": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "PermissionDenied": [
      {
        "hooks": [{ "type": "command", "command": "bash /path/to/Claude-Office/hooks/agent-tracker.sh" }]
      }
    ],
    "TeammateIdle": [
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

**MCP questions, auto-mode denials, teammates.** Four more events, all with the shapes the [hooks reference](https://code.claude.com/docs/en/hooks) documents (none could be fired on the machine this was built on). `Elicitation` — an MCP server asking you something in the middle of a tool call, a form or a URL to open — raises the session's hand like a permission does (kind `elicitation`: a chime, the amber pill, *✋ github is asking you something*); `ElicitationResult` (you answered, declined or pressed Esc), that MCP call finishing, the turn ending or the ten-minute timeout lowers it, and other tool calls running beside it do not. Only the server's name travels: the question, its URL and its form fields stay in the hook, the answer you typed is never read, and the server drops a question text should anything else post one — so no view, trusted or read-only, ever carries it. `PermissionDenied` (auto mode's classifier refused a call; it never fires for a dialog you deny yourself) is shown like a failed tool call on the character that asked — *🚫 denied: Bash (auto mode — Irreversible Local Destruction)*: the tool's name and the classifier's bracketed category, never the command. `TeammateIdle` (an agent-team teammate finished its turn) makes the server read that team's task list at once (see the task board below). The hook prints nothing on any of them and exits 0 — on these events stdout would answer the MCP question, replace your answer or stop the teammate. Not registered, on purpose: `WorktreeCreate` (a command hook there *replaces* git's worktree creation and must print the new path, so registering the tracker would break `--worktree` and `isolation: "worktree"`), `WorktreeRemove` (fires only for worktrees such a hook made), and `FileChanged`, `ConfigChange` and `InstructionsLoaded` (file and settings churn with nothing to draw).

In the office that record is one Claude per terminal (`main-<session id>`, created by the session's first event or the snapshot, seated by the boss when that desk is free): the boss gets up and hands each prompt over at its desk, it types through the turn with its tool calls as its status line, its reply is a chat row (prompt and reply rows are tagged, under the boss and that session's Claude — never fetched from `GET /chat`), it dozes off 30 s after an idle turn end, holds a glass of water while background workers are still out, sweeps its desk during a compaction, wears a red ⚠ badge after an API error, and raises a hand while it waits on you — a chime, an amber *needs you* pill and a ✋ in front of the window title, all of which go when the server's record moves on (the granted tool, the batch end, the ten-minute timeout, your next prompt). An idle prompt and a quota pause are soft: no chime, no title prefix. Hand-overs, visits and timers are reducer effects (`src/officeReducer.ts`), so every one of these is unit-tested with synthetic events.

**Answer permissions from the office.** What a `PermissionRequest` hook prints decides the dialog, so the office can answer it for you. While a session waits on "Do you want to run this command?" a card appears beside the chat column — *Claude wants to run Bash* / *write probe.txt*, the project and session, the command or path in a monospace box, a thin bar for the time left — with **Allow** (dialog option 1), **Allow & remember** (option 2: the dialog's own suggestion, say *switch this session to accept-edits*, shown in the tooltip; only offered when the dialog made one) and **Deny** (option 3, which tells Claude "Denied from Claude Office" and lets it carry on); with one card up, `y` and `n` work too. The tracker POSTs that one event in the foreground and long-polls `GET /permission/<id>` until the server has an answer, then prints the exact hook output; every other event is still a backgrounded curl. The terminal always wins: Claude Code never cancels the hook when you answer the dialog yourself, so any later activity of the session — the tool running, the batch ending, your next prompt, a new permission request, the session ending — releases the wait and the card fades with *answered in the terminal*. A headless `claude -p` session fires no `Notification` and auto-denies the call the moment the hook returns, so a pending permission expires after **15 s** unless the session is known to be interactive — a `Notification` (`permission_prompt` fires about 6 s in, whenever you are not looking at the terminal) has been seen for it, now or earlier — in which case it may wait **10 minutes**, inside the hook's default 600 s timeout; the card's bar stretches when that happens. The whole thing is a setting, `answerPermissions` (default on, `GET`/`POST /settings`, the **Answer here** toggle in the chat header or in [Settings](#settings-panel)): the server mirrors it as the marker file `~/.agent-office/answer-permissions`, which the hook checks before deciding to wait, so turning it off costs no round trip and leaves the hook exactly as it was. The hook never answers when the server is down or says nothing, nothing is ever auto-allowed, and who may click is covered under [Security](#security).

**A notification when Claude starts waiting.** When such a permission is created the server also raises one desktop notification through `scripts/notify.sh` (macOS and Linux): *Claude needs you* — `alpha · Bash wants to run a command`. It names the project and the tool and nothing else — never the command line, the path or any other tool input, because notifications show on the lock screen; the card in the office has the detail. It waits out the same 300 ms as the needs-you hand and fires only if the permission is still pending then, so a headless `claude -p` session that auto-denies never notifies, and it sends at most one per session per minute, so a burst of tool calls that each ask raises one banner, not five. It is a setting, `notifyPermissions` (default on, the **Notify** toggle beside **Answer here**); with `answerPermissions` off no permission is created and nothing is notified.

**Signals.** The office also reads what your Bash commands *mean*. The tracker classifies each command (`classify_command` in `hooks/agent-tracker.sh`, after stripping `cd x &&`, env assignments, `sudo`, `npx`, `timeout` and friends, and splitting on `&&`, `||`, `;`, `|`): a **deploy** (`vercel deploy` / `--prod`, `netlify deploy`, `fly deploy`, `railway up`, `gcloud run|app deploy`, `aws … deploy`, `sam`/`serverless deploy`, `kubectl apply|rollout`, `helm upgrade|install`, `terraform apply`, `pulumi up`, `cdk deploy`, `wrangler deploy`, `firebase deploy`, `npm publish`, `gh release create`, `docker push`, a tag push), a **build** (`npm run build*`, `pnpm`/`yarn build`, `vite build`, `tsc`, `next build`, `cargo`/`go build`, `make`, `gradle`, `mvn package`, `docker build`, `webpack`, `esbuild`), a **test run** (`npm test`, `vitest`, `jest`, `pytest`, `cargo`/`go test`, `mvn`/`gradle test`, `rspec`, `phpunit`, `playwright test`) or a **push** (`git push`, to `main`/`master` or not). Its start (PreToolUse), success (PostToolUse) or failure (PostToolUseFailure, with the first meaningful error line, the exit code and a count such as *3 failing*) travels as `signals` on the event that call sends anyway, and the server broadcasts one `signal` per signal right after it, keeps the last 100 in memory (`GET /signals?since=<ms>&sessionId=<id>`, the last 20 in the WebSocket snapshot) and persists nothing. In the office a deploy in flight puts a rocket over the Claude (or worker) that ran it, a deploy that lands gets a cheer and *🚀 api deployed*, a failed deploy opens incident mode at once, a failed build or test run flashes that character red with *❌ tests failed in api — 3 failing*, the next green run posts *✅ tests green again*, and a push to main gets a small celebration; those chat lines are system rows the chat bot never answers. A segment whose exit status the shell hides (`npm test | tail`, `|| true`) is judged by its output instead, `--dry-run` never counts, and a command that names none of the table's programs never even loads the classifier, so ordinary Bash calls cost nothing extra. To teach it a tool, add a row to `SIGNAL_RULES` (programs, the subcommand words that make it count, its kind, the flags that take a value, where the target is) and the program's name to `SIGNAL_PROGRAMS` or `SIGNAL_NO_VERB` beside it, then a line to the table in `tests/hook-script.test.ts`.

**Task board.** The kanban whiteboard on the wall shows the real task list of a session — the one Claude Code keeps with its `TaskCreate` / `TaskUpdate` tools, which the terminal draws as a checklist. Claude Code writes that list to `~/.claude/tasks/<session id>/<n>.json` (`$CLAUDE_CONFIG_DIR/tasks` if you moved it; one file per task with its subject, description, the spinner's *activeForm*, the status and what it is blocked by), and the server reads it from there (`server/tasks.js`): it watches the directory of every session the office knows (`fs.watch` plus a 2 s poll, from the session's first event until it ends), reads it once the writes settle (250 ms) and sends the page a `task_board` only when something changed. `TaskCreated` and `TaskCompleted` (the hook forwards the task id and subject) only make it look at once — nothing fires when a task goes *in progress*, so the files are the truth. On the board, To do post-its are yellow, In progress blue, Done green, one waiting on an unfinished task wears a red pin, and past six a column ends in *+N*; a post-it flashes when Claude picks it up and slides into Done when it is finished, and hovering one shows its subject (the *activeForm* while in progress). The board follows the session whose tasks changed last, with its name in the corner; when several sessions have task lists, click the board to page through them. Clicking it also sends the boss over to read it out — *3 to do, 1 in progress: Fix the parser*. A session without tasks leaves the wall's decorative board exactly as it was. `GET /tasks?sessionId=<id>` lists the boards (the descriptions only with the token, see [Security](#security)). **Agent teams** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) get a board of their own in the same cycle: Claude Code sets a team up at session start under a session-derived name (`session-` and the first eight characters of the session id), writes its config to `~/.claude/teams/<team>/config.json` (`$CLAUDE_CONFIG_DIR/teams`, `AGENT_OFFICE_TEAMS_DIR`; members, the lead session) and *moves* the lead's task list to `~/.claude/tasks/<team>/`, the team's shared list, in the same file format. The server watches that directory for every session it knows (the team whose config names the session as its lead, else the derived name), the board is labelled *👥 session-1a2b3c4d* with the members' names in its tooltip, and the post-its show who owns them; the board carries `boardId: "team:<team>"` and `team: { name, members }`. Only the members' names are read from the config — never their working directories, pane ids or spawn prompts — and the descriptions follow the same token rule. Built from the agent-teams docs and the Claude Code 2.1.321 binary; never run against a live team.

**Uninstall.** `npm run uninstall-hooks` (or `bash hooks/install-hooks.sh --uninstall`) takes the office back out of `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR/settings.json` when that is set): it backs the file up (`settings.json.backup.<timestamp>`), removes every hook entry whose command runs `hooks/agent-tracker.sh` — under all 23 events, whatever checkout the path points at, duplicates included — and puts `statusLine` / `subagentStatusLine` back: a status line the installer chained is restored from `~/.agent-office/statusline-prev` (and `subagent-statusline-prev`), which are then deleted; one the installer added is removed. Hooks and settings that are not the office's are not touched, a file with nothing of ours in it is left as it is (exit 0), and one that is not valid JSON is refused with the parse error (exit 1, nothing changed). `--uninstall --no-status-line` removes the hooks only, `--uninstall --status-line-only` the status line only. The plugin install is removed with `/plugin uninstall agent-office` (see below).

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

`hooks/hooks.json` registers `hooks/agent-tracker.sh` from the installed copy (`${CLAUDE_PLUGIN_ROOT}`) for the same 23 events as the installer, with no matchers (the tracker acts on every tool call, and exits silently on anything it does not act on). `/agent-office:office` checks `http://127.0.0.1:3334/health` and prints how to start the server, which still runs from a clone or from the installed plugin directory (`npm install && npm run build && npm run server`). To remove it: `claude plugin uninstall agent-office@agent-office` (and `claude plugin marketplace remove agent-office` to drop the marketplace too).

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

## Run it with npx

*After the first npm release.* The package is `@w17ant/agent-office` (the plain name `agent-office` belongs to another project on npm); its command is `agent-office` (`cli/agent-office.mjs`):

```bash
npx @w17ant/agent-office install-hooks   # hooks + status line in ~/.claude/settings.json (--no-status-line | --status-line-only)
npx @w17ant/agent-office                 # = start: serve the office on :3334 and open it; Ctrl+C stops it
npx @w17ant/agent-office start --detach  # in the background (log in ~/.agent-office/server.log, 0600)
npx @w17ant/agent-office open            # open it in another browser (--print: just print the link)
npx @w17ant/agent-office stop            # stop it (--force: whatever listens on the office ports)
npx @w17ant/agent-office doctor          # the same checks as npm run doctor, with npx fix commands
npx @w17ant/agent-office uninstall-hooks
```

`--port <n>` on any command sets `AGENT_OFFICE_PORT` for it; `AGENT_OFFICE_HOME` and `CLAUDE_CONFIG_DIR` are honoured as everywhere else. `start` serves the `dist/` built into the package from the office server's own port — no Vite, no checkout — writes `~/.agent-office/server.pid` the way `start-office.sh` does (so `stop`, and `stop-office.sh`, stop it), and prints and opens the office link the way `npm run open` does. If an office already answers on the port it only opens the link (after the token proof `npm run open` makes). The chat AI watcher is not started; it stays a checkout feature (`start-office.sh`). The boss character comes from `~/.agent-office/office.config.json` (`$AGENT_OFFICE_HOME`) rather than a file next to `package.json`, which in an npx install is in npm's cache.

**Where the hooks live.** npx unpacks the package into `~/.npm/_npx/<hash>/`, which npm may clean at any time and which a newer version replaces with another directory. A hook command pointing there would turn into a hook error on every Claude Code tool call the day the cache goes. So `install-hooks` copies the hook scripts (`agent-tracker.sh`, `agent-tracker.py`, `status-line.sh`, `install-hooks.sh`, `hooks.json`) to `~/.agent-office/hooks/` — the office's own state dir, next to the token and `chat.db` — and runs the installer from that copy, so `settings.json` names `~/.agent-office/hooks/agent-tracker.sh`. Each file is written to a temp name and renamed into place, so a hook firing mid-update never reads half a script. Re-running `install-hooks` from a newer version refreshes the copy; `uninstall-hooks` removes the entries and then the copy (a partial `--no-status-line` / `--status-line-only` uninstall keeps it, since what is left still runs it). Run from a git checkout (`node cli/agent-office.mjs install-hooks`), the hooks stay in the checkout, exactly as with `npm run install-hooks`. Either way the installer's rule for "ours" (a path ending in `hooks/agent-tracker.sh`) is unchanged, so switching between a checkout install and the npx one repoints the entries rather than adding a second set.

**Install size and Node.** The package is about 48 MB (256 files; nearly all of it is the sprites and rooms in `dist/`) and pulls in `express`, `ws` and `better-sqlite3` (about 105 packages; 65 MB on disk with the package itself); from a local tarball with a cold npm cache the install took 5 s on macOS arm64. `better-sqlite3` is native: on Node 22, 24 and 26 npm downloads a prebuilt binary for macOS (arm64 and x64) and Linux (x64, arm64, musl). Node 20 is end-of-life and `better-sqlite3` 12.10 and later ship no prebuild for it, so on Node 20 npm compiles it from source, which takes a minute or so and needs `python3` and a C++ toolchain (Xcode command-line tools, `build-essential`). Use Node 22 or newer. The hooks still need `bash`, `python3` and `curl`; Windows is not covered (use WSL).

**Publishing** (maintainer): `npm publish` runs `prepublishOnly` (`npm run build`: `tsc` and `vite build`, so `dist/` is fresh) and ships only what `files` in `package.json` lists: `cli/`, `server/`, `dist/`, `hooks/`, the three scripts the CLI runs (`open-office.mjs`, `doctor.mjs`, `stop-office.sh`), `electron/helpers.cjs` (the token helpers `open-office.mjs` uses) and `NOTICE.md`. `npm pack --dry-run` lists them; `npm pack` alone does not build, so run `npm run build` first when packing by hand. Publishing needs an npm account that owns the `@w17ant` scope (`publishConfig.access` is `public`, which a scoped package needs). The desktop build keeps its old name: `build.extraMetadata.name` is `agent-office`, so the installers and the app's data folders do not move.

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

## Seasons

The office follows the calendar all year round: one of the four seasons is always on, and a holiday sits on top of it for a few days. Each has its own art, saved under its own file suffix.

| | On (Auto, local time) | Suffix | `?season=` |
|---|---|---|---|
| Spring | March to May | `-spring` | `spring` |
| Summer | June to August | `-summer` | `summer` |
| Autumn | September to November | `-autumn` | `autumn` |
| Winter | December to February | `-winter` | `winter` |
| Valentine's Day | 7 to 14 February | `-valentine` | `valentine` |
| Easter | Good Friday to Easter Monday (Western Easter, worked out for the year) | `-easter` | `easter` |
| Halloween | 25 to 31 October | `-halloween` | `halloween` |
| [Christmas](#christmas) | 1 December to 6 January | `-xmas` | `christmas` |

The four seasons are the meteorological ones (whole months) for the **northern hemisphere**. South of the equator, pick your season by hand in [Settings](#settings-panel): it stays until you change it.

**All eight have art for the office:** the room (day and night, in both themes), the four desks and the three plants. Christmas also dresses the cast (jumpers, the elf and Santa, hats) and hangs the advent calendar; at Halloween Claude is a vampire and the boss a wizard, the Dunder Mifflin leads have costumes of their own (Michael's monster, Dwight's dark lord, Jim's three-hole punch, Pam's cat) and everyone else wears a witch hat or one of six masks, chosen from the character's name (`halloweenPiece` in `src/hat.ts`; a mask covers the face, so it is not drawn from behind); the other six leave the characters as they are. The corridor, meeting, server and lunch rooms keep their normal pictures in every season.

**The lookup.** A seasonal image is an optional copy saved next to the one it replaces, `<name><suffix>.webp` beside `<name>.png` (`src/season.ts`), and the first file that exists wins:

- on a holiday: the holiday's copy, else the season's copy, else the normal image
- otherwise: the season's copy, else the normal image

So on 25 December `rooms/office-day.png` is drawn from `office-day-xmas.webp` if there is one, else `office-day-winter.webp`, else itself. A holiday therefore only needs the pieces it changes; whatever it leaves alone shows the season underneath. The swap covers the room backgrounds (day and night, both themes), the furniture the room draws (desks, plants, the coffee machine, the filing cabinet, the printer) and every character sprite in both casts. A character's copy can have walk frames of its own beside it (`<name><suffix>-walk1.webp` to `-walk4.webp`; `scripts/walk-cycle.py --season NAME` makes them), so nobody changes clothes mid-step.

**Draw the key file first.** A season counts as drawn only once `public/rooms/office-day<suffix>.webp` exists (the default theme's day room: `office-day-autumn.webp` for autumn). Until then none of that season's other files are looked for. That is what keeps an undrawn season cheap: one request for the key file per page load (two on a holiday, one for the holiday and one for the season under it) instead of one failed request for every image in the office. After that, files can arrive one at a time with no code change.

**Choosing a season.** `?season=<name>` in the address forces any of the eight on any day (a demo, a screenshot), and `?season=none` turns seasonal art off. **Season** in [Settings](#settings-panel) offers the same without a URL: Auto, the eight, or Off, remembered in this browser as `agent-office-season`. The URL wins over the stored choice, which wins over the date; a `?season=` value the office does not know is ignored. A holiday picked by hand still sits on the season the date is in (`?season=halloween` in July is Halloween over summer). A season picked by hand shows no holiday at all, even on Christmas Day. The season is judged once per page load, so a change in Settings offers a reload.

The advent calendar and the Santa hats belong to Christmas alone; no other season brings them out.

Copies must keep the original's canvas size and anchor (a character's feet, a desk's footprint) exactly, or the sprite shifts in the office. `npm run check-assets` counts a copy as referenced through its original, for any of the eight suffixes, and still lists a file with a suffix it does not know or a copy of nothing. `public/` is close to its size budget, so a season's art will need `BUDGET_BYTES` in `scripts/check-assets.mjs` raised on purpose when it lands.

## Christmas

From 1 December to 6 January the office decorates itself: tinsel, fairy lights and snow outside in all four rooms (day and night, both themes), Christmas trees in the plant pots, garlands and a mug on every desk, and a Santa hat on everyone. The hat is one sprite (`public/sprites/effects/santa-hat.png`) placed on each character's head as measured from that sprite's own pixels (`src/hat.ts`: the top of the hair, and the head's width 8% of the sprite's height below it), so the whole cast, the Dunder Mifflin cast and a custom boss sprite all get one with no per-sprite numbers. Every character also has a festive sprite (a `-xmas.webp` copy, 270 px tall): a Christmas jumper for the whole cast, three of them meme jumpers (an 80s action-movie tower, *Birthday Boy*, *Not the worst employee*), an elf costume for Claude and a Santa hat in place of the boss's cap. The overlay hat goes on top of the jumpers, except for the characters in `NO_HAT` (`src/hat.ts`): ponytails and big hair it sits badly on, and the two whose costume already has a hat. `?season=christmas` turns it on any day (a demo, a screenshot), `?season=none` keeps it off in December, and **Season** in [Settings](#settings-panel) does the same without a URL; [Seasons](#seasons) has the rules. Christmas is one of four holidays that sit on top of the season of the year: a sprite or room with no Christmas copy shows its winter one, once winter is drawn.

![The office at Christmas](images/christmas.jpg)

Each festive image is an optional copy saved next to the one it replaces, `<name>-xmas.webp` beside `<name>.png` (`src/season.ts`): until a copy exists the next one down shows (the winter copy, else the normal art), so festive art can be added one file at a time with no code change. WebP, not PNG, because at quality 90 a room is ~200 KB instead of ~2 MB, which keeps `public/` inside its size budget; `npm run check-assets` counts a copy as referenced through its original. Copies must keep the original's canvas size and anchor (a character's feet, a desk's footprint) exactly, or the sprite shifts in the office.

## Settings panel

The ⚙ at the right of the title bar opens one panel for the settings that used to be scattered (`src/components/SettingsPanel.tsx`):

| Setting | Where it lives | Notes |
|---|---|---|
| Theme — Default / Dunder Mifflin | this browser (`agent-office-theme`) | Same as `/the-office`; `?theme=office` still preloads it |
| Day / night — Auto / Day / Night | this browser (`agent-office-daynight`) | Same as the AUTO / DAY / NIGHT button in the title bar, now remembered |
| Season — Auto / a holiday (Christmas, Halloween, Easter, Valentine's Day) / a season (Spring, Summer, Autumn, Winter) / Off | this browser (`agent-office-season`) | A drop-down, ten choices being too many for a row of buttons. Auto goes by the date (northern-hemisphere seasons: pick yours by hand south of the equator). `?season=` wins; applies on reload. The note under it says what is on now and whether it has art yet (see [Seasons](#seasons)) |
| Sound — mute + volume | this browser (`agent-office-volume`, `agent-office-muted`) | Same as the chat header's controls, now remembered |
| Ambience — On / Off | this browser (`agent-office-ambience`) | The quiet office bed under the event sounds (see [Sound](#sound)); it plays at the volume above and goes with mute, so this only turns it off while keeping the event sounds |
| Answer permissions here | server (`POST /settings`, UI token) | Same as the chat header's **Answer here** pill |
| Notify on permission waits | server (`POST /settings`, UI token) | Same as the chat header's **Notify** pill: a desktop notification when Claude starts waiting on a permission |
| Prompt logging — Off / Summary / Full | server (`POST /settings`, UI token) | The header pill shows the level; the panel can change it. Rows already in `chat.db` stay until `/clear` |
| AI chat monitor | server (`POST /chat/cron-state`) | Same as the header's **AI On / Off** toggle |

The chat header's pills stay as they were and show the same state: both read one store (`src/serverSettings.ts`), so a change in either shows in both. The server settings are disabled, with the reason, on a read-only page (no office token, so no UI token — the server would refuse), under `?sim` / `?video` (no server) and until the server has answered. The boss sprite is not in the panel: it is `boss.sprite` in `office.config.json`, read when the server starts. The panel's open animation is off under `prefers-reduced-motion`.

## Sound

Everything you hear is made in code with Web Audio (`src/sounds.ts`); there are no audio files. The office is an ambient bed plus a few soft cues for what matters.

**The ambient bed** loops while the page is open: room tone (brown noise low-passed at 300 Hz), air from the vents (a band of the same noise around 700 Hz, swelling slowly every ~14 s), a barely-there 50/100 Hz mains hum, and every 25–70 s something distant and muffled — typing two desks over, a drawer closing, paper shuffled. It starts after your first click, tap or key on the page (browsers keep audio locked until then), fades in over a few seconds, plays at the main volume, and fades out and stops entirely when you mute, turn **Ambience** off in Settings, or switch to another tab. At dusk and night it is about 5 dB quieter and the distant noises come half as often. Measured offline it sits near -48 dBFS RMS at 50 % volume, about 20 dB under the cues. It costs one 6 s noise buffer made once, looping buffer sources, a few oscillators and filters — no per-sample JavaScript.

**Event cues** are soft sine notes with a gentle attack, never square-wave bleeps:

| Cue | When | Sound | At most once per |
|---|---|---|---|
| Needs you | A session starts waiting on a person (a permission, a question, an MCP elicitation), or a permission card appears | E5 → A5, rising | 8 s — the card and the session's hand for one wait make one chime |
| Incident | Incident mode opens from real failures (three red runs in five minutes, a failed deploy) or `/incident` | E4 → C4 → A3, once | 60 s |
| Error | A session hits an API error | A3 → F3 | 15 s |
| Celebration | A deploy lands, or an agent finishes its task | C5 E5 G5 C6 arpeggio | 20 s — a burst of finishing subagents is one cheer |
| Bell | You click the bell and the boss rings it | two soft metallic strikes, C6 then A5 | (the bell's own 20 s cooldown) |

Silent on purpose: arrivals and departures, typing, coffee and water breaks, pushes to main, a single red build or test run (repeated ones open an incident), the end of an incident, the random office events and the mini-incidents they start, and an incident restored by a reload or forced by `?variant=incident`. Each of these still shows in the room and the chat.

## End-of-day recap

The office persists one small row per day in `chat.db` (`daily_stats`, `server/recap.js`) so "what happened today" survives a restart. It is counted from the paths the server already runs — every processed event, every relayed signal, the `/incident` · `/all-clear` commands and `POST /status` — without changing what they do (a failure to count is logged and dropped). The day is the server's local calendar date; counts roll over at local midnight.

| Column | Counts |
|---|---|
| `sessions` | distinct sessions that sent a hook event (other than SessionEnd) that day |
| `agents_spawned` / `agents_completed` | distinct agents that clocked in / out (a replayed spawn or a doubly reported finish counts once; agents sent home by a session ending count) |
| `tasks_completed` | distinct task-board tasks completed (session + task id) |
| `deploys` · `pushes` | `deploy_success` · `push_done` signals |
| `builds_failed` · `tests_failed` | `build_failed` · `test_failed` signals, not counting a run stopped with Esc |
| `incidents` | a `/incident` or a failed deploy while no incident is open; one closes on `/all-clear`, a successful deploy or 10 min without another failed deploy, build or test. The page's own triggers (3 failed tool calls in 5 min, the random events) are decided in the browser and not counted |
| `cost_usd` | per session reported by the status line: its highest cumulative cost that day minus what it had cost by the previous day it was seen, summed — so a session running past midnight books only its after-midnight spend on the new day |

`GET /recap?date=YYYY-MM-DD` (default today) returns those counts in camelCase plus `today`; numbers only, so it is open like the other read-only GETs. Two helper tables (`daily_seen`, `daily_session_cost`) hold the session and agent ids used to count each thing once and are pruned after 7 days. `/recap` in the chat posts the day as one office-manager line, and **today** at the right of the status strip shows the numbers.

## Incident mode — "Prod Is Down"

The office declares an incident **by itself** when real failures happen: a deploy that fails (a `deploy_fail` [signal](#connect-claude-code) — `vercel deploy`, `fly deploy`, `kubectl apply`, ... exiting non-zero) switches it on at once, and three failed tool calls (`PostToolUseFailure`) inside five minutes do too — a failed build or test run counts as one under its own name (*tests failed in api: 3 failing*), never twice. A `deploy-fail` or `who-broke-build` random event starts a 90 s mini-incident instead, and `/incident` in the chat declares one by hand (relayed to every open office).

While it is on, the room is forced to night and tinted red, a beacon flashes over the door, the wall TV shows the rollback status page, the "days since last incident" sign flips to 0, agents whose last tool call failed carry a build-failed bubble, the chat header shows a live incident timer, and the spawn / working / done / boss lines come from an incident pool.

It ends with `/all-clear`, ten minutes without a new failure, a deploy that goes out (`deploy_success`), the last red build or test run going green again (`build_ok` / `test_ok`), or a `deploy-success` random event during a mini-incident, and posts a one-line postmortem (duration, failures by tool, who was involved, and the root cause — the last named failure, such as *deploy of api failed: Error: 503*, else the last failing tool). A green run while no incident is on clears the five-minute failure window instead. The sign then counts the days from `localStorage['agent-office-last-incident']`. `?variant=incident` pins it on with auto-exit off, for screenshots. Incident mode is a *variant*, so it stacks with the Dunder Mifflin skin.

The dedicated incident art (beacon frames, pizza tower, incident board, per-role props) is a follow-up: `src/incidentAssets.ts` lists the slots and today's fallbacks, and `public/sprites/incident/README.md` lists the files to draw. The office picks them up with no code change.

## Rooms

The building is five places in a star (`src/rooms.ts`): the **office**, whose one door opens onto a **corridor**, and a **meeting room**, a **server room** and a **lunch room**, each one door off that corridor. Every room is the same isometric box as the office. The corridor has the lift and the meeting room's door on its left wall, and along its right wall the manager's door (a nameplate, decoration only: no room is behind it, the boss keeps his desk in the office), the server room, the lunch room and, at the far end, the office.

**A room is closed until its art is drawn.** `DRAWN_ROOMS` in `src/roomAccess.ts` lists the rooms whose backgrounds are in `public/rooms/`: all five today. With only the office in it there is no floor plan and no corridor, everybody comes and goes by the office door and MCP calls have no character. It is a list in code and not a probe for the image files (the way the festive art is found) because a room changes who walks where: the answer has to be known before the first event and be the same on every frame and in every test. A side room also needs the corridor drawn, since the corridor is the only way to it.

| Room | Who is there | When |
|---|---|---|
| Office | Everyone's desk; the boss never leaves it | Always |
| Corridor | Whoever is on the way | New agents come in by the front door and walk to their room's door; leavers go out the same way; anyone changing room crosses it |
| Server room | One worker per MCP server, named after the server, at a rack | From the first call to that server (from any session) until 30 s after the last one finishes (`MCP_LINGER_MS`). Six racks: a seventh server at once has no character |
| Meeting room | A session's Claude and its workers | While the session runs three or more workers at once (they stay until it is down to one: `MEETING_MIN_WORKERS` 3, `MEETING_STAY_WORKERS` 2, so a batch finishing seconds apart does not walk out and straight back), or while it waits on you for a permission, a plan approval or a question. Eight seats |
| Lunch room | Anyone on a coffee or water break; a session's Claude with nothing to do | Breaks are taken at its machine or cooler, or at a table (the boss keeps his Red Bull at the office machine). A Claude goes to sit there two minutes after its turn ended (`LUNCH_IDLE_MS`) and walks back when the next prompt arrives |

The rules are one small pure module, `src/roomRules.ts`, with the reasons for each number beside it. A reason has to hold for a moment before anyone gets up (10 s for a wait on you, since most permission dialogs are answered within seconds; 5 s for a team; 3 s to go back), a visitor keeps its desk while it is away, and a full room changes nothing: the team stays at its desks, the break is taken at the office machine. A room that is closed is never wanted, so each room can be drawn and opened on its own (after the corridor). Agents with no session never count as a team. The boss's walk to Claude's desk with a prompt is skipped while that Claude is in another room: the prompt still arrives, and it walks back by itself.

**Changing room** (`src/roomTransfer.ts`): the agent walks to its room's door, is handed to the corridor at the matching door, crosses it at twice the usual pace, is handed into the other room at its door and walks to its place. The two hand-offs between pictures of the same doorway are the only jumps. The whole change is capped at 20 s (`TRANSFER_MAX_MS`), spent on the corridor alone: when the walks inside the two rooms have used the budget, the rest of the corridor is skipped. An agent that finishes on the way turns for the front door from wherever it is.

**The view.** The stage shows one room at a time, the office unless you choose another. With more than the office open, a small floor plan sits in the stage's bottom-left corner: the rooms as boxes on the corridor strip, a dot per agent in each, an amber **!** on a room where a session waits on you and a red **×** where something went wrong (a failed tool call, a red build, an API error, or Prod Is Down in the office), and a ring around the room in view. Click a room, or Tab to it and press Enter; the arrow keys move between rooms. It never switches by itself. The desk screens, the room's props, the advent calendar, the task board and the incident layer belong to the office: they are drawn only while the office is in view and keep running while it is not. Prod Is Down stays an office affair. The phone view (`npm run lan`) shows the office only.

**Furniture.** Each room's furniture is listed in `src/rooms.ts` like the office's and drawn by `FurnitureRenderer`: the meeting table with eight chairs and a wheeled whiteboard, six racks with a network cabinet and a crash cart, and the lunch room's vending machine, fridge, water cooler, counter (with the coffee machine) and two café tables of four. The sprites are in `public/sprites/rooms/`, cut from ChatGPT sheets drawn in the office's style; their sizes in `src/assets.ts` are set against a 78 px character and a 106 px desk on the 754 px stage. Each room has a Dunder Mifflin pair too (`backgroundDm`: beige walls, worn carpet, windows onto brick buildings and a car park), drawn from its default day picture with `office-day-dm.png` as the style; a room without one shows its default pictures in that theme.

**Preview:** `?sim` plays a short loop of ordinary events (`src/roomsDemo.ts`: two MCP servers taking calls, one session running three workers) so every room has somebody in it. A room that is not drawn (a new one, before its art) shows a placeholder drawn in code (`RoomBackdrop.tsx`) under `?rooms=all`.

**Placing a layout.** The four new rooms' furniture, seats and waypoints were computed on each room's measured floor corners (`B`ack, `R`ight, `F`ront, `L`eft), and the meeting seats from the table sprite's own edges. To fine-tune one, `/?helper&room=<id>` (`corridor`, `meeting-room`, `server-room`, `lunch-room`, or `main-office`) opens the placement helper on that room; the **Room** and **BG** selects switch room and background. Place the door, spots, entry, floor corners and waypoints, then **Export** gives the text for that room's entry in `src/rooms.ts`. A door placed in a side room is written with `toRoom: 'corridor'`; in the corridor the helper asks what is behind each door (a room, the front door, or the manager's nameplate door, which goes to `landmarks`).

**Adding a room.** Draw it by giving ChatGPT `office-day.png` to edit ("make a … in this style with no furniture"), so it keeps the office's box and camera; make the night picture from the day one. Save each at 1508 × 1126 as WebP in `public/rooms/`: `<room>-day.webp`, `<room>-night.webp`, and optionally `<room>-day-dm.webp`, `<room>-night-dm.webp` for the Dunder Mifflin theme (listed in `backgroundDm`). Then:

1. Add the room's id to `DRAWN_ROOMS` in `src/roomAccess.ts`. The corridor first: a side room without it stays closed.
2. Take its entries off `PLANNED` in `scripts/check-assets.mjs`, and raise `BUDGET_BYTES` there if it no longer fits.
3. Place the layout over the art with `/?helper&room=<id>` and paste the export into `src/rooms.ts`.
4. `npm run check-assets` and `npm test` (`tests/rooms.test.ts` checks that every drawn room's files exist and that every door, spot and waypoint is on the floor).

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

## Prompts from the chat

Type `@<session> <prompt>` in the office chat — `@agent-office fix the failing test` — and that Claude Code session takes it as its next prompt when its current turn ends, as if you had typed it in its terminal. The chat offers the names as you type `@` (Tab completes the first); each is the session's own name in Claude Code (`claude-office-75`, or what `/rename` set), else its title or project. Nothing is sent to Claude straight away: the prompt waits in the office until the session's **Stop** hook runs, and the chat says when it was picked up (*📬 agent-office picked up the prompt from the chat*).

**The limitation: an idle session waits.** A session sitting at its input box runs no hook, and nothing in Claude Code's hook contract starts a turn from outside with a prompt, so a prompt queued for an idle session is delivered when its *next* turn ends — give it anything in its terminal (or wait for a background task to wake it). The queued line says which case you are in. A session that is working gets it the moment it would otherwise stop.

How it works, end to end:

1. `POST /chat` sees the leading `@name` and resolves it to one live session (`resolveMention` in `server/prompt-queue.js`): the Claude Code name or title first, then the project, then a 6+ character prefix of the session id. A mention that names no session (`@claude`) is an ordinary chat line, as before; one that names several is refused with the ids to use instead.
2. Only **the office page on this Mac** may queue: the request must carry the UI token (the page's own, from its trusted snapshot) or the office token (a local script), and it must not have come through the phone's full-mode LAN gate or an HTTPS proxy name (`mayQueuePrompt`). The phone, a page through `tailscale serve`, a read-only page and any other local process get *🔒 Only the office page on this Mac can queue a prompt for …* and a 401; the prompt text is not stored. A session the hooks do not report (only Claude Code's registry knows it) is refused too: nothing would deliver the prompt.
3. The prompt is queued in the server's memory (at most **5** per session, **2000** characters each, expiring after **an hour** undelivered; a session's prompts go when it ends), and while anything waits an empty marker file `~/.agent-office/prompt-queue/<session id>` exists.
4. On **Stop** the hook checks for its session's marker (a `stat`; a Stop with nothing queued stays a background POST). With the marker, it POSTs its `session_turn_end` in the foreground (signed, as always, `--max-time 2`) with `claim: true` and a fresh nonce. The server hands over the oldest prompt — removing it, so it is delivered once — with a proof, `HMAC-SHA256(token, "office-prompt\n" + nonce + "\n" + id + "\n" + text)`.
5. The hook checks the proof and prints `{"decision": "block", "reason": "The user queued this prompt … :\n\n<prompt>"}`; Claude Code continues the turn with that as its next instruction. A wrong or missing proof, no prompt, or an office that is down or silent prints nothing and the turn ends as usual. The session shows as working again and its last prompt is the queued one.

Why it cannot loop: each claim removes the prompt it gets, so a run of continuations ends when the queue is empty (five at most, inside Claude Code's own cap of eight Stop-hook continuations in a row). A second queued prompt is claimed on the Stop that follows the first, `stop_hook_active` or not.

Why in memory: a queued prompt is an instruction a session runs with its permissions; one that outlived a restart could fire into a conversation that has moved on. The markers are cleared when the server starts and stops.

What others see: your `@…` line is stored as a transcript row (`msg_type` `prompt`, at the `logPrompts` level), so read-only pages, the LAN viewer and the AI chat watcher never get its text, like any other prompt; the *queued*, *picked up*, *expired* and *dropped* lines name the session and nothing of the prompt. Hooks installed before this feature never claim: re-run `npm run install-hooks` (or `npx @w17ant/agent-office install-hooks`, which copies the hook scripts).

## Desktop app (Electron)

The desktop app is self-contained: it bundles the office server, the built UI and `node_modules`, runs the server on the Node that ships inside Electron (nothing needs to be installed, and no `node` on the PATH), and loads the office from `http://127.0.0.1:3334/` — one port for the page, its assets and the WebSocket — with the office token from `~/.agent-office/auth-token` in the URL fragment, read once the server answers (see [Security](#security)). Launched with `AGENT_OFFICE_PORT` in its environment (from a terminal, say), the app starts its server, loads the page and points the tray at that port instead. If something else already answers on that port without the office's page (a checkout server with no `npm run build`, say), the packaged app says so in a dialog naming the port instead of loading a blank window.

**Download.** Every tagged release carries installers built by the [release workflow](../.github/workflows/release.yml); the [releases page](https://github.com/W17ant/Claude-Office/releases) has them, named `Agent-Office-<version>-<os>-<arch>`:

- **macOS** — `…-mac-arm64.dmg` (Apple silicon) or `…-mac-x64.dmg` (Intel); drag the app into Applications (the `…-mac-<arch>.zip` beside it is what the app's own updater downloads; you do not need it). The app is not signed or notarised, so macOS refuses it on first launch: right-click (Control-click) the app and choose **Open**; if it says the app is damaged, clear the quarantine flag with `xattr -dr com.apple.quarantine "/Applications/Agent Office.app"` and open it again.
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

**Updates.** The packaged app reads `https://api.github.com/repos/W17ant/Claude-Office/releases/latest` when it starts and every 6 hours — unauthenticated, a 10 s timeout, nothing sent but a `User-Agent: Agent-Office/<version>` — and compares the release's `tag_name` with the running version (semver, drafts and prereleases ignored). What happens when it is newer depends on **Update automatically**, a checkbox in the tray and right-click menus (there wherever the app can update itself; on by default, remembered in `update-check.json` in the user-data directory):

- **On.** The update is downloaded in the background (the menu shows a greyed *Downloading update vX.Y.Z…*) and verified, then the menus offer **Restart to update to vX.Y.Z** and one notification says it is ready. Clicking either installs it and starts the new version. On macOS and Windows, quitting with an update ready installs it on the way out, so the next start is the new version; on Linux only **Restart to update** installs it.
- **Off**, or whenever the app cannot update itself from where it is: the menus gain **Update available: vX.Y.Z — Download**, which opens that release's page in the browser (only an `html_url` under `https://github.com/W17ant/Claude-Office/releases/` is ever opened), with one notification per new version. Up to 1.1.2 this was all the app did.

How it installs:

- **macOS** — the app's own updater (`electron/mac-update.cjs`), because the one electron-updater drives there (Squirrel.Mac) refuses an app with no Developer ID signature. It fetches the release's `latest-mac.yml` and the `Agent-Office-<version>-mac-<arch>.zip` for this Mac's architecture — https only, from `github.com/W17ant/Claude-Office/releases/download/` and the two GitHub asset hosts that redirects to, 512 MB at most — checks the zip's size and sha512 against the feed, unpacks it with `ditto` into a hidden folder next to the app, and checks that what came out is one `.app` with the bundle id `com.agentoffice.app` and exactly the expected version. **Restart to update** then quits the app, and a small helper (`electron/mac-swap.sh`) waits for it to exit, moves the old bundle aside, moves the new one into its place and starts it with the arguments and environment the old one had. If the new bundle cannot be moved in, the old one is put back and started instead. The helper writes one line per run to `update-swap.log` in the user-data directory.
- **Windows and Linux** — [electron-updater](https://www.electron.build/auto-update), which reads `latest.yml` / `latest-linux.yml` from the same release and verifies the download's sha512 against it. On Windows it runs the new installer silently and starts the app again (an install for all users still shows Windows' elevation prompt); on Linux it replaces the AppImage file.

The download item is the fallback everywhere, so the app is never left without a way to update. It is what you get when the app runs from somewhere it cannot replace — macOS app translocation (the app opened straight from Downloads or the disk image: move it to Applications), a folder or bundle this user cannot write to (another user's install in `/Applications`), a Linux build that is not an AppImage or sits in a read-only folder — when the download, the checksum or the unpacked bundle does not check out (three tries per run), and when an install was started but the app came back at the old version (that version is then offered as a download only; the next one is tried afresh). Nothing whose checksum did not match is unpacked or run, an older version is never installed, and no environment variable or argument changes where a packaged app looks for updates. The checksum catches a corrupted or truncated download; it is no defence against someone who can publish to the GitHub release, because the builds are unsigned (see Download). A failed check (offline, rate-limited) is logged and otherwise silent. A dev run (`npm run dev:electron`) and the screenshot run neither check nor update.

The macOS path is exercised for real by `node scripts/e2e-mac-update.mjs` (by hand, on a Mac): it packages the app twice, a version apart, serves the newer build's `latest-mac.yml` and zip on 127.0.0.1, starts the older one and checks that it downloads, verifies, swaps and comes back as the newer version. The script's header says what it replaces to do that (the release lookup and the socket, in a throwaway copy of the app) and what it does not cover. The Windows and Linux paths have unit tests around electron-updater's interface only; neither has been run against a real release yet.

**Notifications.** The app shows no notifications of its own about the office: chat mentions, failed agents and permission waits come from the server it runs, through `scripts/notify.sh`, exactly as they do without the app, so nothing is shown twice. The two update notifications above (*is ready* and *is available*, at most one of each per version) are the app's only ones.

**Icons.** `scripts/generate-icons.mjs` draws the tray glyph and the app icon as pixel maps and writes the PNGs with no image tooling: `electron/assets/` holds the tray icons and the Linux window icon, `build/icon.png` (512×512) is what electron-builder turns into the `.icns`, `.ico` and Linux icon set. The macOS tray icon is a monochrome template image (`trayTemplate.png` and `@2x`), tinted by the menu bar for light and dark mode. Re-run the script after editing the maps; a test fails when the committed files are stale.

How a build is put together (the `build` section of `package.json`):

- `vite build` writes the UI and everything in `public/` to `dist/`; the server serves `dist/` from `/` when it exists, so the sprites ship once.
- `asar` is off: the server is a plain Node child process that reads `dist/`, `server/` and `node_modules` with ordinary `fs` calls.
- `npmRebuild` is off, so the checkout's `node_modules` stay built for your system Node and `npm test` / `node server/index.js` keep working after a pack. `electron/after-pack.cjs` fetches the Electron build of `better-sqlite3` (through its own `prebuild-install`) into the packaged copy only.
- `build/icon.png` is the app icon (see Icons above); electron-builder reads it from `build/`, its `buildResources` directory, and the tray icons ship with `electron/**`.
- `mac.target` is a `dmg` (the download) and a `zip` (what the app's updater fetches, listed with its sha512 in `latest-mac.yml`) per architecture (`arm64` and `x64`) rather than a universal app: `after-pack.cjs` fetches one `better-sqlite3` prebuilt per architecture and refuses `universal`, and a single-architecture download is half the size. `win.target` is an NSIS installer that asks where to install (and no `.blockmap` next to it, `differentialPackage: false`: the updater downloads the whole installer), `linux.target` an AppImage. `artifactName` fixes the file names to `Agent-Office-<version>-<os>-<arch>.<ext>`, and `publish` names the GitHub draft release the release workflow uploads to — a local `npm run build:electron` never publishes; electron-builder only does that on CI or when asked with `--publish`.
- `electron-updater` is a production dependency because electron-builder packages only those. It is loaded in one place (`electron/auto-update.cjs`), lazily, in a packaged Windows or Linux app; the npm package (`npx`) installs it and never loads it.
- Debugging a build headlessly: `AGENT_OFFICE_SCREENSHOT=/tmp/office.png` makes the app save a screenshot of its window a few seconds after the page loads, then quit (works under `xvfb-run`); add `--compact` to capture the widget.

The same single-port mode works without Electron: `npm run build && npm run server`, then `npm run open` (or the link the server printed). The Linux bundle was built, launched and screenshotted (full window and compact widget) under xvfb; the tray icon was created there but a headless X server has no panel to show it in, and the macOS and Windows packages come out of the release workflow but have not been launched by hand since the bundle became self-contained — see [Platform support](#platform-support).

**Cutting a release** (maintainers). `npm version minor` (or `patch` / `major`) bumps `package.json` and `package-lock.json` and — through the `version` script, `scripts/sync-plugin-version.mjs` — `.claude-plugin/plugin.json`, then commits and tags `vX.Y.Z`; `git push --follow-tags` pushes the commit and the tag. The tag starts [`release.yml`](../.github/workflows/release.yml): it checks that the tag matches `package.json`, creates a **draft** release for it, then builds on macOS, Windows and Linux runners and uploads the installers, the macOS zips and electron-builder's `latest.yml`, `latest-mac.yml` and `latest-linux.yml` to that draft. Nothing is public until you open the draft on the releases page, edit the notes and publish it — and publishing is also what starts the update for installed apps: they read the latest *published* release, so a draft is invisible to them (to the check, and to electron-updater). Leave the `latest*.yml` files and the zips on the release; they are what the apps update from. A failed leg can be re-run from the Actions tab, and **Run workflow** on the tag rebuilds everything; both upload to the same draft. A tag whose release is already published is left alone. Nothing in the pipeline signs — there is no Apple or Windows certificate — hence the first-launch steps under Download.

## Configuration

Everything is optional; the defaults are the office as described above. Set these in the shell that starts the office **and** in the one that starts Claude Code (the hook and the status line run inside Claude Code and read them there).

| Variable | Default | Read by | What it does |
|---|---|---|---|
| `AGENT_OFFICE_PORT` | `3334` | server, hook, status line, office scripts, `npm run doctor`, Vite dev (proxy and page), desktop app and tray | The office server's port. Not a port (letters, `0`, `70000`)? The server warns and uses 3334, as do Vite and the desktop app; the shell hooks and scripts use the value as given, so fix it rather than rely on that. The page served by the server needs nothing: it talks to the origin it was loaded from |
| `AGENT_OFFICE_HOST` | `127.0.0.1` | server | The bind address, **IPv4 loopback only**: `127.0.0.1` or `localhost`, and both bind `127.0.0.1` (`localhost` is not left to the resolver, which may answer `::1`). `::1` is refused too, with the reason logged: the office scripts, `npm run doctor`, the desktop app and `/agent-office:office` all dial `127.0.0.1`, which a server on `[::1]` alone would refuse. Anything else (`0.0.0.0`, a LAN address) is refused with the reason logged and the server binds `127.0.0.1` — see [Security](#security) |
| `AGENT_OFFICE_LAN` | off | server (`npm run lan` sets it) | `1` (or `true`) opens phone mode's **watch-only** second listener on this machine's private Wi-Fi address. `full` (`npm run lan -- --full`) opens the **full office** there instead, over HTTPS only, behind the phone secret and a route allowlist. Any other value leaves both off — see [Phone mode](#phone-mode). The loopback listener is unchanged |
| `AGENT_OFFICE_LAN_HOST` | the first private (RFC 1918) IPv4 of this machine | server | The LAN listener's address, in either mode. It must itself be a `10.x`, `172.16–31.x` or `192.168.x` address: `0.0.0.0`, loopback, public addresses and names are refused with the reason logged, and LAN mode stays off |
| `AGENT_OFFICE_LAN_PORT` | `3335` | server | The LAN listener's port, in either mode |
| `AGENT_OFFICE_ALLOWED_HOSTS` | none | server, `npm run open -- --host` (a hint only) | Comma-separated host names (`my-mac.tail1234.ts.net`, optionally `:port`) a local HTTPS proxy such as `tailscale serve` reaches the office by: the loopback listener's Host guard accepts them and the origin allowlist accepts `https://<name>[:port]`. Through such a name every route but the static UI needs a token, and the WebSocket the office token. Host names only — a wildcard, scheme, path or IP address is logged and ignored. Never with `tailscale funnel`. See [Phone mode](#phone-mode) |
| `AGENT_OFFICE_UI_PORT` | `3333` | `start-office.sh`, `stop-office.sh`, the server's origin allowlist | The Vite dev server's port (`start-office.sh` runs `vite --port`); `npm run dev` always uses 3333 |
| `AGENT_OFFICE_HOME` | `~/.agent-office` | server, hook, status line, scripts | The runtime dir: auth token, `agents.json`, `chat.db`, inbox files, pid files |
| `AGENT_OFFICE_EVENT_URL` | `http://localhost:$AGENT_OFFICE_PORT/event` | hook (`agent-tracker.sh`) | The full event URL; wins over `AGENT_OFFICE_PORT` |
| `AGENT_OFFICE_STATUS_URL` | `http://localhost:$AGENT_OFFICE_PORT/status` | status line (`status-line.sh`) | The full status URL; wins over `AGENT_OFFICE_PORT` |
| `AGENT_OFFICE_CONFIG_DIR` | the directory holding `package.json` | server | Where `office.config.json` is read from (see [Customise your character](../README.md#customise-your-character)) |
| `AGENT_OFFICE_REGISTRY_DIR` | `$CLAUDE_CONFIG_DIR/sessions` | server | Claude Code's session registry, the source of the *not hooked* pills (see [Sessions without hooks](#connect-claude-code)) |
| `AGENT_OFFICE_TASKS_DIR` | `$CLAUDE_CONFIG_DIR/tasks` | server | Where Claude Code keeps each session's task list, the source of the task board (see [Task board](#connect-claude-code)) |
| `AGENT_OFFICE_TEAMS_DIR` | `$CLAUDE_CONFIG_DIR/teams` | server | Where Claude Code keeps each agent team's config (its lead session and members); the team's shared task list is read from the tasks directory (see [Task board](#connect-claude-code)) |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | server, `npm run doctor`, the installer | Claude Code's config dir: the server reads the session registry and the task lists under it, the doctor reads `settings.json` there, and `npm run install-hooks` / `uninstall-hooks` write that `settings.json` (an older installer wrote `~/.claude/settings.json` regardless; the doctor points those entries out) |

**Office settings** live in `~/.agent-office/settings.json`, are read with `GET /settings` (open) and changed with `POST /settings` (the office page's UI token or the office token; a wrong type is a 400):

| Setting | Default | Toggle | What it does |
|---|---|---|---|
| `logPrompts` | `summary` | read-only `prompts:` pill in the chat | How much of the boss's prompts and Claude's replies is kept: `off`, `summary` (200 characters) or `full` (2000) — see [Security](#security) |
| `answerPermissions` | `true` | **Answer here** | Whether a permission dialog may be answered from the office — see [Answer permissions from the office](#connect-claude-code) |
| `notifyPermissions` | `true` | **Notify** | Whether a permission wait the office could answer raises one desktop notification (project and tool only, at most one per session a minute) |

`office.config.json` (the boss's name, sprite, colour and emoji) is read by the server at runtime and applied by the page on load, so changing it needs a reload, not a rebuild; `GET /config` shows what the server read. Other knobs (`AGENT_OFFICE_STALE_MINUTES`, `AGENT_OFFICE_A2A_LIMIT`, the `CHAT_AI_*` settings) are described where they apply.

## Security

The server always binds `127.0.0.1` (IPv4 loopback): `AGENT_OFFICE_HOST` may
spell it `127.0.0.1` or `localhost`, both of which bind `127.0.0.1`, and `::1`
and anything else are refused with the reason and `127.0.0.1` bound. So, unless
you opt into [phone mode](#phone-mode), it is never on the network. (Phone
mode adds three opt-in exceptions, each with its own rules below: a separate
watch-only listener on your LAN address; in its place, when asked for, an
HTTPS listener there that serves the full office behind its own secret and a
route allowlist; and host names a local HTTPS proxy may use to reach the
loopback listener. None changes anything in this section for the loopback
listener itself.) The threat it defends against is therefore what else
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
  host (`localhost`, `127.0.0.1` or `[::1]`, any port) — or, when you set it,
  an `AGENT_OFFICE_ALLOWED_HOSTS` name with exactly its port, whose
  `https://` origin the allowlist then accepts too; anything else is `421`
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
Phone mode's LAN listener is the answer to "but I want to see it on my
phone": a *second* listener that serves no API route, never accepts the
office token, and carries a stream with that task and status text taken out
([Phone mode](#phone-mode)). Its full mode is the answer to "and answer
from it": the same address, HTTPS only, a secret of its own instead of the
office token, and a short list of routes — nothing trusted crosses the Wi-Fi
in clear in either mode.

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
| **Token required** (bearer **or** a valid request signature) | `POST /event`, `POST /status`, `/chat/reply`, `/a2a`, `/chat/inbox/read`, `/chat/seen`, `/chat/react`, `/chat/video-mode`, `GET /permission/:id` (the hook's long-poll for a decision), and `POST /chat` for a destructive slash command (`/clear`) | Speaks for an agent, writes another agent's inbox, feeds the meters, learns how a permission was decided, or wipes history. The hook and status line authenticate here by **signing** (below); the scripts send the bearer token |
| **UI token or token, on this machine** | `POST /chat` with a leading `@<session>` (queue a prompt for that session, see [Prompts from the chat](#prompts-from-the-chat)) | Becomes an instruction a Claude Code session acts on, so on top of the token the request must not come through the phone's LAN gate or an HTTPS proxy name |
| **UI token or token** | `POST /permission/:id` (answer a permission dialog), `POST /settings` | The two things the office page itself may change. The server mints a second secret per process, the UI token, and hands it out in one place only: the WebSocket snapshot of a connection that presented the office token. Nobody without the token file can obtain it. It lives in memory, changes on every restart and is compared in constant time |
| **Open** | every other `GET` (including `GET /recap`: counts only), `POST /chat` (a plain line a person typed, and the read-only `/status` · `/agents` · `/recap` · `/help` · `/incident` · `/all-clear` commands), `POST /chat/typing`, `POST /chat/cron-state` | The worst these do is read what the read-only office shows or post a chat line |
| **Open, but the conversation needs the token** | `GET /chat`, `GET /sessions`, `GET /permissions`, `GET /signals`, the WebSocket | Without the token: no chat rows with `msg_type` `prompt` / `reply`, no `main.lastPrompt` / `main.lastReply`, no permission `detail` / `suggestions`, no signal `command` / `error` / `detail`, and the WebSocket is read-only as above. With it (the office page, the office scripts), they are included |
| **Open, but the descriptions need the token** | `GET /tasks` (the task boards) | Anyone on loopback gets each session's (and agent team's) task subjects, *activeForm*s, states, blockers and owners, and a team's member names — as open as an agent's task on `GET /agents`. A task's description is longer text written from the conversation: only a token holder gets it. The `task_board` broadcasts and the snapshot's `taskBoards` never carry it, so a read-only WebSocket gets them unchanged |
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
- **Your prompts and Claude's replies are stored locally**, in `~/.agent-office/chat.db`
  (mode `0600`) and in `agents.json`, at the level `logPrompts` sets:
  `summary` (the default) keeps the first 200 characters of each, `full` keeps up
  to 2000, `off` keeps nothing — state transitions only, no text stored or
  broadcast. Change it with
  `curl -X POST http://127.0.0.1:3334/settings -H "Authorization: Bearer $(cat ~/.agent-office/auth-token)" -H 'Content-Type: application/json' -d '{"logPrompts":"off"}'`
  (it persists in `~/.agent-office/settings.json`; `GET /settings` shows it, and
  the chat header shows the current level — `prompts: summary` — with that
  command in its tooltip). The office page can also change it, from
  [Settings](#settings-panel), with its UI token. Lowering the level also trims what the sessions
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

## Phone mode

See the office on a phone mounted next to your monitor. Three ways, all off
unless you turn them on; pick one.

| Route | Start it with | The phone gets | On the wire |
|---|---|---|---|
| [Watch-only over Wi-Fi](#watch-only-over-wi-fi-npm-run-lan) | `npm run lan` | the scene alone, with the text taken out | plain HTTP |
| [The full office over Wi-Fi](#the-full-office-over-wi-fi-npm-run-lan------full) | `npm run lan -- --full` | chat, permission cards it can answer, meters, settings, inspector | HTTPS with a certificate made on this machine |
| [Full control through Tailscale](#full-control-through-tailscale) | `tailscale serve` and `AGENT_OFFICE_ALLOWED_HOSTS` | the desktop page, as on this machine | Tailscale's HTTPS |

Watch-only is the default and the least to trust. The full office over Wi-Fi
needs no account and no extra software, at the price of a certificate nobody
signed (you compare a fingerprint once). Tailscale gives a certificate the
phone already trusts and works away from home, and needs a tailnet.

### Watch-only over Wi-Fi: `npm run lan`

```
npm run build              # once: the LAN listener serves the built UI
npm run lan                # the office, plus the phone link and its QR code
npm run lan -- --rotate    # the same with a new viewer key (old phone links stop working)
```

`npm run lan` is `npm run server` with `AGENT_OFFICE_LAN=1` (set that yourself
for `start-office.sh` or any other launcher). The loopback listener on
`127.0.0.1:3334` is exactly as before; next to it the server opens a
**second listener on this machine's private LAN address** — the first
`10.x` / `172.16–31.x` / `192.168.x` IPv4 of a non-internal interface, or
`AGENT_OFFICE_LAN_HOST`; never `0.0.0.0` — on port 3335
(`AGENT_OFFICE_LAN_PORT`), and prints, to its own output only,

```
  Phone (watch-only, this network): http://192.168.1.23:3335/#viewer=<viewer key>
```

with a QR code of it when the output is a terminal. Scan it with the phone's
camera. The page takes the key out of the address bar, keeps it in that
browser's storage for that address, and from then on shows the **phone
layout**: the office scene alone, the whole room scaled to fit inside the
screen's safe area and centred — in portrait (the usual way a phone sits on
a mount) it spans the width, in landscape the height — with no title bar,
chat, meters, permission cards, settings or inspector: nothing that needs the
office token or calls an API route, and nothing to scroll. Any page the LAN
listener serves gets this layout; opened without its `#viewer=` part it says
so instead of connecting. Open `http://<lan ip>:3335/#viewer=off` to forget
the key in that browser.

**The viewer key** is a second secret, 32 random bytes in
`~/.agent-office/lan-viewer-key` (`0600`, kept across restarts with the same
trust checks as the token file, replaced when they fail, never the office
token). It opens the LAN listener's WebSocket and nothing else. `npm run lan
-- --rotate` deletes it before starting (and full mode's phone secret with
it), so that start mints a new one; an office already running keeps the old
key until it restarts.

**What the LAN listener allows.** It is its own server with its own Express
app and WebSocket server; it shares no route with the loopback listener.

- Every request must carry `Host: <lan ip>:<lan port>` exactly (a
  DNS-rebinding page, another name, another port: `421`, or a `1008` close on
  the WebSocket), and an `Origin`, when sent, must be
  `http://<lan ip>:<lan port>` (`403` / `1008`).
- HTTP: `GET` / `HEAD` of the built UI's files (the page, its scripts,
  `/sprites`, `/rooms`). **Every API route is a 404** — `/event`, `/chat`,
  `/settings`, `/permission`, `/agents`, `/sessions`, `/tasks`, `/a2a`,
  `/.well-known`, `/health`, `/config` and the rest, any method, with or
  without a token. So a phone can never post a chat line, answer a
  permission dialog or change a setting. (The page therefore draws the boss
  from the bundle, not from `GET /config`.)
- The WebSocket `/ws` needs the viewer key as the subprotocol
  `agent-office.viewer.<key>` (constant-time compare); no key or a wrong one
  is a `1008` close. **The office token is never accepted there** — it would
  cross the Wi-Fi in clear — and a LAN connection is never trusted and never
  gets the UI token. The page itself never stores or offers the office token
  when it was served over plain HTTP from a non-loopback address. At most 8
  viewers at a time.
- The one thing a phone sends on that WebSocket is a **furniture tap**:
  tapping a plant, the coffee machine, the bell and so on sends the item's
  name, and the server passes it to every open office page, so the boss's
  errand plays on the desktop as well as the phone (and a tap on the desktop
  plays on the phone). The name must be one of the office's fifteen
  interactive items (`SHARED_INTERACTIONS`), a frame is at most 1 KiB, and
  one tap a second per connection is passed on; anything else is dropped
  unread. A tap changes nothing the server keeps.

**What a phone sees** is a stricter tier than the read-only view
(`redactForLan` in `server/index.js`, an allowlist per record and per event
type, so a field added later stays off the Wi-Fi until someone lists it, and
an event type nobody classified is not sent): agents (name, role, state,
timings, session), sessions (state, model, counts), a raised hand with its
kind and tool name, an API error's one-word kind, permission dialogs' tool and
deadline, signals' kind and exit code, task boards as post-it states and
counts, health, incident mode, and chat rows as metadata with empty text (so
a directed message still flies between desks). Taken out, on top of what the
read-only view already drops: agent task text and status lines, results and
errors; session cwds, project names, titles and transcript paths; every chat
message's text, system rows included; a needs-you's summary and notification
message; a permission's summary and the project / cwd / title on it; a
signal's target, branch, detail and error; task subjects and *activeForm*s;
background tasks' descriptions; the registry's session name. The meters
(`session_status` / `agent_status`: cost, context, model, workers' status
lines) are not sent at all. Project names go too: a directory name is often a
client or a product codename, and the scene does not need it.

**What this does not protect.** The LAN listener speaks plain HTTP. Anyone who
can read your Wi-Fi traffic (an open network, or anyone holding a shared
WPA2-PSK who captures the handshake) sees what the phone sees and can read the
viewer key from the WebSocket handshake — and with it watch the same
stripped scene. That is why the tier is what it is, and why the key opens
nothing else. Use it on a network you trust, rotate the key if you doubt it,
and stop `npm run lan` (use `npm run server`) when you do not need it. A
malicious web page on the phone or any other device cannot use the key it
does not have, and its WebSocket carries its own `Origin`, which is refused.

### The full office over Wi-Fi: `npm run lan -- --full`

```
npm run build                     # once: the LAN listener serves the built UI
npm run lan -- --full             # the office, plus the phone's link, QR code and certificate fingerprint
npm run lan -- --full --rotate    # the same with a new phone secret (old phone links stop working)
```

`npm run lan -- --full` is `npm run server` with `AGENT_OFFICE_LAN=full` (set
that yourself for any other launcher; `npm run lan` without `--full` sets `1`
outright, so a value left in the shell cannot turn it into full mode). The
loopback listener is unchanged. **In place of** the watch-only listener —
never beside it, and never on plain HTTP — the server opens an **HTTPS**
listener on the same private LAN address and port and prints, to its own
output only,

```
  Phone (FULL office, this network, HTTPS only): https://192.168.1.23:3335/#phone=<phone secret>
  Certificate SHA-256 fingerprint (made on this machine, signed by nobody):
    3F:9A:…:C1
```

with a QR code of the link between the two when the output is a terminal.

**The first visit, and the fingerprint.** Nobody signed the certificate, so
the phone's browser warns before it shows the page. Before you accept, open
the certificate's details from that warning and compare its SHA-256
fingerprint with the one the server printed. The same: go on, and from then
on the traffic between the phone and this machine is encrypted. Different:
something on the network answered in this machine's place — do not go on.
The browser keeps your exception for that address, so the warning comes back
only when the certificate is replaced (the server then prints `New
certificate (<why>): the phone will warn once more`, and the fingerprint is a
new one to compare). Where a browser shows the fingerprint differs by
browser and version; that step was not walked through on a real phone for
this release (see the last list of this section).

**The phone secret** is a third secret: 32 random bytes in
`~/.agent-office/lan-phone-secret` (`0600`, kept across restarts with the
same trust checks as the token and viewer-key files, replaced when they
fail). It is never the office token and never the viewer key, and the
full-mode listener refuses both of those like any other wrong value. It
travels in the link's **fragment**, which a browser never sends to a server:
the page takes it out of the address bar on load, keeps it in that browser's
storage for that address, and presents it as `Authorization: Bearer` on its
requests and as the WebSocket subprotocol `agent-office.phone.<secret>`,
compared in constant time. A page keeps or presents the phone secret only
when it was served over `https:` from a private IPv4 address; on any other
page a `#phone=` fragment is stripped and thrown away, so the secret is never
offered over plain HTTP whatever link is opened. On the full-mode page the
office token and the viewer key are in turn never kept or sent. Open
`https://<lan ip>:3335/#phone=off` to forget the secret in that browser;
`npm run lan -- --full --rotate` deletes the file before starting, so every
phone needs the new link.

**The certificate** is made on this machine the first time full mode starts
(`server/lan-cert.js`, Node's `crypto` and a small DER writer, no new
dependency): an EC P-256 key, self-signed with ECDSA-SHA256, its
`subjectAltName` the LAN IP and nothing else, marked `CA:FALSE` and for
server authentication only, valid 800 days. It lives in
`~/.agent-office/lan-cert.pem` and `lan-key.pem`, both `0600` and read back
only through the token file's trust checks, and is reused across restarts so
the phone warns once. A new one is made — and the phone warns again — when
the LAN address changed, when it is within 30 days of expiry, when it is not
valid yet (the clock moved), when the key does not match, or when the files
fail the trust checks. `--rotate` leaves it alone; delete the two files to
force a new one.

**What the full-mode listener allows.** It is its own HTTPS server (TLS 1.2
or newer); a plain-HTTP request to the port never gets an HTTP answer. Each
request then passes, in this order:

1. `Host` must be `<lan ip>:<lan port>` exactly — `421` otherwise (a
   DNS-rebinding page, another name, another port).
2. `Origin`, when sent, must be `https://<lan ip>:<lan port>` exactly — `403`
   otherwise. The watch-only `http://` origin is not accepted here, nor this
   one there.
3. `GET` / `HEAD` of the built UI's files are served without the secret: the
   page has to load before it can read its fragment. They are the same files
   as in the repository.
4. An address that sent 20 wrong secrets within a minute is refused for a
   minute — `429` with `Retry-After` — before its secret is even looked at.
   A request with no secret at all is refused but not counted: a page opened
   without its link is not a guess.
5. The phone secret — `401` without it or with a wrong one.
6. The route allowlist below — `404` for everything else, any method.
7. Only then is the request handed to the office's own routes, acting as the
   office page does (the page's UI tier), never with the office token's
   rights: `/clear` typed in the chat stays refused, as it is for the page on
   this machine.

| Route | Why the phone needs it |
|---|---|
| `GET /config` | the boss's name, sprite and colour, before the first frame |
| `GET /roster` | the MCP servers drawn on the wall rack |
| `GET /recap` | the Today tab's counts (numbers only) |
| `GET /settings` | the three switches' current state |
| `POST /settings` | changing them from the Settings tab |
| `GET /chat/cron-state` | whether the chat monitor is paused |
| `POST /chat/cron-state` | the pause button |
| `POST /chat` | posting a chat line |
| `GET /agents/:id` | the inspector card, with its transcript tail |
| `POST /permission/:id` | answering a permission card |

Kept off the Wi-Fi on purpose: hook ingestion and everything else only local
hooks and tools call (`POST /event`, `POST /status`, the hook's
`GET /permission/:id` long-poll, `/chat/reply`, `/chat/inbox/read`,
`/chat/seen`, `/chat/react`, `/chat/typing`, `/chat/video-mode`), the
agent-to-agent routes (`/a2a`, `/a2a/agents`,
`/.well-known/agent-card.json`), and the reads the page does not make
(`GET /chat`, `/agents`, `/sessions`, `/signals`, `/tasks`, `/registry`,
`/permissions`, `/health`, `GET /status`). Rotating the office token is not
a route on any listener: `npm run rotate-token` deletes its file on this
machine.

The WebSocket `/ws` passes the same checks — Host, Origin, lockout, secret —
**before** the upgrade, and is answered with that HTTP status when it fails:
a peer without the secret never holds a WebSocket. With the secret it gets
the trusted stream, what the office page on this machine sees, without the
UI token (the phone has no use for it). At most 8 phones at a time, and at
most 64 TLS connections to the listener.

**What the phone can do** is therefore: read the conversation, the agents'
tasks and status lines, the meters and the transcript tail in the inspector;
post in the chat; answer a permission dialog (allow, allow and remember,
deny); flip the three settings; pause the chat monitor. It cannot `/clear`,
send hook events, reach the agent-to-agent routes, or read or replace the
office token.

**The phone layout** (390 x 844, portrait): the room across the top, scaled
to the screen's width; pending permission cards right under it, on screen
without scrolling or zooming, with buttons a thumb can hit; then the tab's
content — Chat, Meters, Today or Settings — with the tabs at the bottom.
Tapping a character opens the inspector over the lower half. Nothing scrolls
sideways. Landscape puts the room on the left and the rest on the right;
with the keyboard up the room is put away so the chat keeps its lines. It
keeps clear of the notch and the home bar, and under
`prefers-reduced-motion` its own transitions and the session pills' pulse
stop (the scene's animations are the scene's, as on the desktop). Opened
without its `#phone=` part the page says so and calls nothing; with a
replaced secret or a stopped office it says *Not connected* and names both
causes — it cannot tell them apart without guessing at the lockout's
expense. After a reload the chat shows new lines only, as the desktop page
does.

**What this does not protect.**

- **The first visit is trust on first use.** The phone has nothing to check
  the certificate against but your eyes. Someone already able to intercept
  traffic on the Wi-Fi at that moment (ARP spoofing, a rogue access point)
  can present their own certificate; accept it and they see and can alter
  everything, the phone secret included once the page sends it. The printed
  fingerprint is the defence, and it works only if you compare it. The same
  holds each time the certificate is replaced.
- **The link is a key.** Whoever gets it — a photo of the terminal, a shared
  screen, the QR code — and is on the network can do everything listed
  above. Rotate when in doubt.
- **The secret sits in the phone's browser storage** until `#phone=off` or
  a rotation. A lost or lent phone on this Wi-Fi drives the office.
- **A permission card has no second step.** A mis-tap on *Allow* on the
  phone is an answer.
- **Anyone on the network can still reach the listener**: load the page's
  files, see that an office runs here, and hold some of the 64 connections.
  The lockout is per address, so a device that borrows the phone's address
  could keep it locked out a minute at a time; it slows guessing of a
  256-bit secret that could not be guessed anyway.
- **The certificate's key** is a file on this machine, `0600`. Whoever can
  read it can impersonate this listener to a phone that accepted the
  certificate; `--rotate` does not replace it.
- **Not verified on a real phone.** The page, a chat post and a permission
  answer were checked in desktop Chromium at 390 x 844 with the certificate
  error ignored. In the iOS simulator Safari reached the listener and showed
  its certificate warning; nothing past that warning was tested. In
  particular it is **unverified** whether iOS Safari lets the page's
  `wss://` connection use a certificate accepted through that warning, and
  whether the link's `#phone=` part survives the warning. If the page loads
  but stays *Not connected* on your phone, that is the likely reason: use
  the Tailscale route below, whose certificate the phone already trusts.
  The checks to run are in `TEST_PLAN.md`.

Use it on a network you trust, and stop it (`npm run lan`, or `npm run
server`) when you do not need it.

### Full control through Tailscale

To see and drive the whole office from a phone — chat, permission cards,
everything — through [Tailscale](https://tailscale.com), without binding any
LAN address: Tailscale's HTTPS proxy forwards to the loopback listener, and
the office accepts its host name.

```
tailscale serve --bg --https=443 http://127.0.0.1:3334
AGENT_OFFICE_ALLOWED_HOSTS=my-mac.tail1234.ts.net npm run server
npm run open -- --host my-mac.tail1234.ts.net
```

(`tailscale status` or the admin console shows your machine's name; HTTPS
certificates must be enabled for the tailnet.) The last command checks that
the office on `127.0.0.1` is yours, then prints
`https://my-mac.tail1234.ts.net/#token=<the office token>` — and a QR code of
it on a terminal — without opening anything. Open it on the phone once; the
page keeps the token as on the desktop and connects back over `wss://` to the
same name.

What changes: the loopback listener's Host guard also accepts
`my-mac.tail1234.ts.net` (or `name:port` exactly as listed), and the origin
allowlist accepts `https://my-mac.tail1234.ts.net`. Entries must be plain
host names with at least one dot — wildcards, schemes, paths and IP
addresses are logged and ignored.

**Through the proxy nothing is open.** Every request through the proxy
arrives from `127.0.0.1`, so on loopback's rules "any local process" would
mean every device your tailnet lets reach this machine. And the `Host` alone
cannot tell a proxied request apart: `tailscale serve` routes by the TLS
name and forwards the client's `Host` unchanged, so a tailnet device could
send `Host: localhost`. So a request counts as proxied when its `Host` is an
`AGENT_OFFICE_ALLOWED_HOSTS` name, **or** it carries a header a reverse
proxy adds — `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`,
`Forwarded`, `Tailscale-User-*` — **or** its peer address is not loopback.
That is reliable for `tailscale serve`: its proxy (Go's
`httputil.ReverseProxy` in Rewrite mode) first deletes any client-sent
`Forwarded` / `X-Forwarded-*`, then always sets `X-Forwarded-Host` and
`X-Forwarded-For` (and `X-Forwarded-Proto` over HTTPS) on every request it
relays, tagged and shared nodes included; the `Tailscale-User-*` identity
headers are set only for tailnet users with a login, so they are extra
markers, not the key (checked in `ipn/ipnlocal/serve.go` and
`net/http/httputil/reverseproxy.go`). This holds whether or not
`AGENT_OFFICE_ALLOWED_HOSTS` is set, so a `tailscale serve` pointed at the
office without it gets nothing open either (the Host guard refuses its name
anyway). A proxied request needs the office
token or the UI token as `Authorization: Bearer` for every route — the open
`GET`s (`/agents`, `/sessions`, `/tasks`, `/config`, `/health`, ...) and
`POST /chat` included — and gets a `401` without one; only the built UI's
static files load without it, so the page can start and read `#token=`. Its
WebSocket needs the office token and is refused with `1008` without it:
there is no read-only view through the proxy. The office page sends the
header itself when it was served over HTTPS from such a name (the UI token
once the WebSocket handed it over; the office token before that, on reads
only — a `POST` never carries the file token, so `/clear` typed in the chat
stays refused as on loopback). A request from loopback with a loopback
`Host` and none of those headers — the hook, the scripts, the desktop app,
a browser on this machine — works exactly as before. The office token crosses the tailnet only inside Tailscale's HTTPS.

**Use `tailscale serve`, never `tailscale funnel`.** Funnel publishes the
proxy on the internet. Tailscale marks each request Funnel relays with
`Tailscale-Funnel-Request: ?1` and strips that header from anything a
client sends (`addTailscaleIdentityHeaders` in `ipn/ipnlocal/serve.go`), so
the office refuses every request carrying it — `403`, or a `1008` close —
with a log line, whatever its `Host` or token. Treat that as a last line, not
a reason to try: a mistyped command should never be what stands between the
internet and your office.

`tailscale serve` forwards the browser's own `Host` header to the backend (it
sets the outgoing `Host` to the incoming one for a TCP backend, and adds
`X-Forwarded-*` and, for tailnet users, `Tailscale-User-*` headers) — checked
against `ipn/ipnlocal/serve.go` in Tailscale's source, and exercised here
through a stand-in HTTPS proxy that does the same, not against a live
tailnet. Keep the tailnet to your own devices, or restrict port 443 on this
machine with an ACL.

## Roadmap

Open and planned work lives in [GitHub issues](https://github.com/W17ant/Claude-Office/issues). Next up, roughly in order:

- **`npx` one-liner** to start the office without a checkout: built (`cli/agent-office.mjs`, see [Run it with npx](#run-it-with-npx)), waiting on the first npm release
- **Spooky Sprint**, a seasonal variant on the incident-mode axis — art-gated
