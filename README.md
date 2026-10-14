# Claude Office

A pixel art virtual office that visualizes your AI agents working in real-time. Watch Claude Code agents spawn, sit at desks, take coffee breaks, and chat in a Slack-inspired office chat panel — all rendered in an isometric pixel art office.

## Update — Dunder Mifflin mode

Type `/the-office` in the Slack chat panel to flip the whole office into a Scranton-branch tribute. The room, the cast, and the chatter all swap over — Michael Scott runs the place, Jim is your assistant, and Dwight guards the beet cellar.

### Pretzel day, every day
<p>
  <img src="docs/images/dunder-mifflin-day.png" alt="Dunder Mifflin — Day" width="48%">
  <img src="docs/images/dunder-mifflin-night.png" alt="Dunder Mifflin — Night" width="48%">
</p>

**What changes when you toggle it on**
- 27 cast members (Michael, Jim, Pam, Dwight, Kevin, Angela, Stanley, Creed, David Wallace, Bob Vance — the whole office) dealt to agent roles
- Role chatter swaps to in-character lines (`"Bears. Beets. Battlestar Galactica."`, `"selling paper"`, `"Schrute bucks awarded"`)
- Michael occasionally lands his signature `"That's what she said 😏"` when replying to finished work
- Character prop overlays — Michael rotates World's Best Boss mug / Dundie / Golden Ticket / Prison Mike bandana / "NO GOD PLEASE NO", Dwight gets the CPR dummy mask or a Schrute Buck, Jim keeps his jello stapler, Stanley gets a pretzel, Jan gets a Serenity by Jan candle, Oscar / Pam / Toby share the Finer Things Club
- Angela gets a follower cat *and* a head-cat (randomized from 12 cat sprites)
- Kevin's chili, pretzel day, and Finer Things Club references sprinkled through the break-room chatter

### The cast
<p align="center">
  <img src="docs/images/michael-scott.png" alt="Michael Scott" height="140">
  <img src="docs/images/jim-halpert.png" alt="Jim Halpert" height="140">
  <img src="docs/images/pam-beesly.png" alt="Pam Beesly" height="140">
  <img src="docs/images/dwight-schrute.png" alt="Dwight Schrute" height="140">
  <img src="docs/images/angela-martin.png" alt="Angela Martin" height="140">
  <img src="docs/images/kevin-malone.png" alt="Kevin Malone" height="140">
  <img src="docs/images/stanley-hudson.png" alt="Stanley Hudson" height="140">
  <img src="docs/images/andy-bernard.png" alt="Andy Bernard" height="140">
  <img src="docs/images/kelly-kapoor.png" alt="Kelly Kapoor" height="140">
  <img src="docs/images/ryan-howard.png" alt="Ryan Howard" height="140">
  <img src="docs/images/creed-bratton.png" alt="Creed Bratton" height="140">
  <img src="docs/images/robert-california.png" alt="Robert California" height="140">
  <img src="docs/images/david-wallace.png" alt="David Wallace" height="140">
  <img src="docs/images/bob-vance.png" alt="Bob Vance, Vance Refrigeration" height="140">
</p>

### Easter-egg props
Each cast member gets a signature prop floating above their desk in place of the usual coffee/Red Bull bubble.

<p align="center">
  <img src="docs/images/prop-worlds-best-boss.png" alt="World's Best Boss mug (Michael)" height="70">
  &nbsp;&nbsp;
  <img src="docs/images/prop-dundie.png" alt="Dundie Award (Michael)" height="70">
  &nbsp;&nbsp;
  <img src="docs/images/prop-golden-ticket.png" alt="Golden Ticket (Michael)" height="70">
  &nbsp;&nbsp;
  <img src="docs/images/prop-prison-mike.png" alt="Prison Mike bandana (Michael)" height="70">
  &nbsp;&nbsp;
  <img src="docs/images/prop-no-god.png" alt="NO GOD PLEASE NO (Michael)" height="70">
  &nbsp;&nbsp;
  <img src="docs/images/prop-cpr-mask.png" alt="CPR Dummy Mask (Dwight)" height="70">
  &nbsp;&nbsp;
  <img src="docs/images/prop-schrute-buck.png" alt="Schrute Buck (Dwight)" height="70">
  &nbsp;&nbsp;
  <img src="docs/images/prop-jello-stapler.png" alt="Jello Stapler (Jim)" height="70">
  &nbsp;&nbsp;
  <img src="docs/images/prop-pretzel.png" alt="Pretzel Day (Stanley)" height="70">
  &nbsp;&nbsp;
  <img src="docs/images/prop-serenity-candle.png" alt="Serenity by Jan (Jan)" height="70">
  &nbsp;&nbsp;
  <img src="docs/images/prop-finer-things.png" alt="Finer Things Club (Oscar / Pam / Toby)" height="70">
  &nbsp;&nbsp;
  <img src="docs/images/prop-paper-box.png" alt="Dunder Mifflin Paper Box" height="70">
  &nbsp;&nbsp;
  <img src="docs/images/prop-dunder-logo.png" alt="Dunder Mifflin Logo" height="70">
  &nbsp;&nbsp;
  <img src="docs/images/prop-angela-cat.png" alt="Angela's cat" height="70">
</p>

Toggle it off any time with `/the-office` again — state persists in `localStorage`.

---

### Full office — agents working, chatting, and taking coffee breaks
![Day Mode](docs/images/Day-Mode.png)

## Features

**Live Agent Visualization**
- Agents appear as pixel art characters that walk into the office through the door
- Each agent type gets a unique character sprite and desk assignment
- Agents show typing bubbles, take coffee/water breaks, and leave when done
- Boss character (you) with Red Bull, Claude with coffee
- Random office events: pizza deliveries, fire drills, power flickers, printer jams
- Day/night cycle with smooth transitions

**AI-Powered Office Chat**
- Back-and-forth conversation with Claude through the office chat panel
- Claude has a witty office manager personality with running jokes
- Multi-agent routing — mention a bug and the Debugger responds, ask about UI and Frontend answers
- Typing indicators, emoji reactions, read receipts
- Slash commands: `/status`, `/agents`, `/help`, `/incident`, `/all-clear`
- Chat history persists across restarts (SQLite)
- Proactive messages — agents announce when they start and finish work
- Smart macOS notifications for important events

**Context-Aware AI**
- Claude knows your current git branch and active agents
- Conversation memory — remembers the last 10 messages
- AI On/Off toggle to control token usage

**Sessions**
- One pill per Claude Code session in the title bar: the project (folder the terminal was opened in), how many agents work for it, and a dot — green while an agent is working or Claude itself just used a tool, dim when idle, red once the session ends
- Multiple terminals = multiple pills; each session's agents stay its own, and when several sessions share the office every character wears its project name
- Claude's own tool calls (no subagent) are shown on that session's pill when none of its agents is at a desk, never on another terminal's worker
- `GET /sessions` lists them (project, cwd, model, agent counts, last main-thread status); sessions survive a server restart and are forgotten a minute after they end

### Night mode — the office after dark, agents still grinding
![Night Mode](docs/images/night-mode.png)

### Waiting for tokens... the office keeps itself entertained
![Waiting for tokens](docs/images/entertainment-waiting-tokenreset.png)

## How It Works

Claude Code hooks capture agent spawns, tool calls, and completions via `PreToolUse` and `PostToolUse` hooks. Events are sent to a local Express + WebSocket server, which broadcasts them to the React frontend.

```
Claude Code ──hook──> Express Server ──WebSocket──> React Frontend
                           │
                     SQLite (chat)
                           │
                   Chat AI Watcher ──claude -p──> Reply
```

## Quick Start

```bash
# Clone
git clone https://github.com/W17ant/Claude-Office.git
cd Claude-Office

# Install
npm install

# Start everything (server + frontend + chat watcher)
bash scripts/start-office.sh

# Stop everything
bash scripts/stop-office.sh
```

Open `http://localhost:3333` — the office is ready.

### The start/stop scripts

`start-office.sh` starts the server, Vite and the chat AI watcher, each in its own process group, and records their pids in `~/.agent-office/server.pid`, `vite.pid` and `chat-watcher.pid`. `stop-office.sh` stops exactly those processes — a browser holding a WebSocket to `:3334`, the Electron app or an unrelated Vite on `:3333` are never touched. If you started the server some other way, `bash scripts/stop-office.sh --force` additionally kills whatever is *listening* on the office ports. Ctrl+C in `start-office.sh` stops everything it started; on a box without `open`/`xdg-open` it prints the URL instead of aborting.

The chat AI watcher (`scripts/chat-ai-watcher.sh`, log in `~/.agent-office/chat-ai.log`) only answers messages a person typed in the office chat — its own replies, the agents' `starting:`/`done:` announcements, agent-to-agent messages and `/commands` are never answered — and runs `claude -p` with `--model claude-haiku-5-5 --safe-mode --strict-mcp-config --tools "" --no-session-persistence` under a timeout, so a reply never fires the office's own hooks or loads your project's MCP servers. Knobs (all optional): `CHAT_AI_MODEL`, `CHAT_AI_TIMEOUT` (seconds, default 60), `CHAT_AI_MAX_REPLIES_PER_MIN` (default 5), `CHAT_AI_POLL_INTERVAL` (default 8). Every script honours `AGENT_OFFICE_HOME` (state dir) and `AGENT_OFFICE_PORT` (server port, default 3334); `start-office.sh`/`stop-office.sh` also take `AGENT_OFFICE_UI_PORT` (default 3333).

### Running tests

`npm test` runs the Vitest suite in `tests/` (server API, WebSocket, hook script, installer, shell scripts) against a temp `AGENT_OFFICE_HOME`, so your real `~/.agent-office` is never touched; `npm run test:watch` keeps it running. CI runs `tsc --noEmit` and `npm test` on every push to `main` and every pull request.

### Auto-Permissions

The repo includes `.claude/settings.json` which auto-allows curl commands to the local office server (`127.0.0.1:3334`) and the start/stop scripts. This means the chat monitor cron and office commands run without permission prompts.

### Connect Claude Code

Run the installer (registers the seven hook events below, safe to re-run):

```bash
npm run install-hooks
```

If you move, rename or re-clone the checkout, re-run the installer: entries that still name the old `agent-tracker.sh` / `status-line.sh` path are repointed at the current one, so Claude Code stops reporting a hook error on every tool call.

Or add the hook to `~/.claude/settings.json` yourself:

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
    ]
  }
}
```

Now spawn agents in Claude Code and watch them appear in the office.

**Background agents** (`run_in_background: true`) stay at their desk until they finish (the `SubagentStop` hook). Each worker is tied to its Claude Code subagent the moment it exists (`SubagentStart`), so tool calls made inside a subagent show up on that agent rather than a random one, and a tool call that errors (`PostToolUseFailure` — a non-zero Bash exit, say) shows as a `failed:` status on the agent that made it. Agents still working when the server restarts are restored from `~/.agent-office/agents.json`; agents that go quiet for 2 hours (`AGENT_OFFICE_STALE_MINUTES`) clock out on their own.

**Sessions.** Every hook payload names the Claude Code session it fired in (`session_id`, `cwd`, `transcript_path`), and the tracker forwards that on every event, so the office knows which terminal each agent works for. `SessionStart` adds a pill to the title bar (`SessionEnd` removes it and walks that session's agents out); a session the server first hears of mid-way — hooks installed while Claude was already running, or a server restart — is picked up from its next event. Sessions that go quiet for `AGENT_OFFICE_STALE_MINUTES` end the same way.

### Payroll, electricity and memory

A wall panel appears above the chat the moment Claude Code sends its first status line, and not before (an office without one looks exactly as it did). **PAYROLL** is what the open sessions have cost, with the $/min burn over the last five minutes underneath; **ELECTRICITY** is the tokens the API chews through per minute (context re-reads included — that is what you pay for) as a gauge whose stripes flow faster the harder it burns; **MEMORY** is the context-window fill — amber past 70 %, red past 90 %, and once a session passes 85 % the chat gets a "Claude's desk is getting cluttered" line (once per session). claude.ai subscribers also get a **5h** pill with the five-hour rate-limit utilisation. Hover any meter for the exact numbers and the model; with several terminals open the panel stacks one row per session (up to four).

The numbers are Claude Code's own: `npm run install-hooks` registers `hooks/status-line.sh` as the [`statusLine`](https://code.claude.com/docs/en/statusline) command (and as `subagentStatusLine`, which adds per-worker token counts) next to the hooks. It forwards the JSON to `POST /status` (same bearer token as `/event`) and prints `<model> · ctx <used>% · $<cost>`. **If you already had a status line, you keep it**: the installer saves your command in `~/.agent-office/statusline-prev` and `status-line.sh` runs it with the same input and prints its output, so what you see does not change. `bash hooks/install-hooks.sh --no-status-line` skips the status line altogether. `GET /status` returns the sessions and the totals (cost today, tokens/min, $/min); nothing is persisted, and a session that goes quiet for `AGENT_OFFICE_STALE_MINUTES` drops off the panel.

## Customise Your Character

The boss character (you) is configurable via `office.config.json`:

```json
{
  "boss": {
    "name": "YourName",
    "sprite": "MyChar-1",
    "color": "#ff4444",
    "emoji": "crown"
  }
}
```

### Creating a custom sprite

Use the Helper sprite sheet as a reference for the 4-direction layout — here's an example of mine next to it:

<p>
  <img src="docs/images/Helper.png" alt="Helper Sprite Template" height="250">
  <img src="docs/images/Me-1-front-right.png" alt="Custom Boss — Front Right" height="250">
  <img src="docs/images/Me-1-rear-left.png" alt="Custom Boss — Rear Left" height="250">
</p>

Here's Mini Claude — I asked Claude to describe itself after showing it the office with my avatar, then used the prompt to generate the sprite:

<img src="docs/images/mini-claude.png" alt="Mini Claude" height="500">

1. Open ChatGPT (with DALL-E image generation)
2. Upload `public/sprites/characters/Helper.png` as a reference
3. Ask it to generate a pixel art character in the same style and layout (4 directions: front-left, rear-right, front-right, rear-left)
4. Save the output and extract the sprites:

```bash
python3 scripts/extract-boss-sprite.py your-character.png MyChar-1
```

## Chat

| Command | Description |
|---------|-------------|
| `/status` | Office stats — agents, clients |
| `/agents` | List active agents |
| `/help` | Show available commands |

### Agent Routing

The chat AI routes your messages to specialist agents based on keywords:

| Topic | Agent |
|-------|-------|
| bugs, errors, crashes | Debugger |
| PRs, code review, git | Reviewer |
| UI, CSS, design | Frontend |
| tests, coverage, e2e | Tester |
| auth, security, tokens | Security |
| deploys, Docker, CI | DevOps |
| performance, caching | PerfEng |
| databases, SQL | DBA |
| TypeScript, types | TS Pro |
| AI, LLMs, prompts | AI Eng |
| APIs, REST, webhooks | Fullstack |
| architecture, patterns | Architect |

### Agent-to-agent messages

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

#### A2A protocol

The office also speaks a subset of the [Agent2Agent (A2A) protocol](https://a2a-protocol.org), so A2A clients can reach office agents directly:

| Endpoint | What it does |
|----------|--------------|
| `GET /.well-known/agent-card.json` | Agent card for the office |
| `GET /a2a/agents` | One agent card per agent in the office (with `metadata.officeId` and `unread`) |
| `POST /a2a` | JSON-RPC 2.0 `message/send` (needs the bearer token) |

`GET /.well-known/agent-card.json` and `GET /a2a/agents` are open (and the cards advertise a `bearer` security scheme). `POST /a2a` delivers a message as an agent, so it needs the office token — send it as `Authorization: Bearer <token>`, the contents of `~/.agent-office/auth-token`:

```bash
curl -s localhost:3334/a2a \
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

### Just me and Claude — chatting in the office
![Me & Claude](docs/images/Me%20&%20Claude.png)

## Modes

| URL | Mode |
|-----|------|
| `localhost:3333` | Live — connected to Claude Code via WebSocket |
| `localhost:3333?sim` | Simulation — scripted demo with fake agents |
| `localhost:3333?video` | Video — scripted recording mode |
| `localhost:3333?helper` | Placement helper — dev tool for positioning furniture |
| `localhost:3333?variant=incident` | Incident — pins "Prod Is Down" mode on (for screenshots) |
| `localhost:3334` | Built — the office server serving `dist/` after `npm run build`; what the desktop app loads. The `?` flags above work here too |

### Incident mode — "Prod Is Down"

The office declares an incident **by itself** when real failures happen: three failed tool calls (`PostToolUseFailure`) inside five minutes switch it on. A `deploy-fail` or `who-broke-build` random event starts a 90 s mini-incident instead, and `/incident` in the chat declares one by hand (relayed to every open office).

While it is on, the room is forced to night and tinted red, a beacon flashes over the door, the wall TV shows the rollback status page, the "days since last incident" sign flips to 0, agents whose last tool call failed carry a build-failed bubble, the chat header shows a live incident timer, and the spawn / working / done / boss lines come from an incident pool.

It ends with `/all-clear`, ten minutes without a new failure, or a `deploy-success` during a mini-incident, and posts a one-line postmortem (duration, failures by tool, who was involved). The sign then counts the days from `localStorage['agent-office-last-incident']`. `?variant=incident` pins it on with auto-exit off, for screenshots. Incident mode is a *variant*, so it stacks with the Dunder Mifflin theme.

The dedicated incident art (beacon frames, pizza tower, incident board, per-role props) is a follow-up: `src/incidentAssets.ts` lists the slots and today's fallbacks, and `public/sprites/incident/README.md` lists the files to draw. The office picks them up with no code change.

## Tech Stack

- **Frontend**: React + TypeScript + Vite
- **Server**: Express + WebSocket (ws)
- **Storage**: SQLite (better-sqlite3)
- **Chat AI**: Claude CLI (`claude -p`)
- **Sprites**: Custom pixel art (isometric)
- **Desktop**: Electron (optional)

## Project Structure

```
Claude-Office/
├── src/                    # React frontend
│   ├── components/         # Character, SlackChat, FurnitureRenderer
│   ├── hooks/              # useAgentSocket (WebSocket + reconnect)
│   ├── styles/             # office.css, rooms.css
│   └── App.tsx             # Main app (agent lifecycle, events, chat)
├── server/                 # Express + WebSocket server
│   ├── index.js            # HTTP endpoints + WS broadcast
│   ├── status.js           # /status: payroll / electricity / memory feed
│   └── chat-db.js          # SQLite wrapper
├── scripts/                # Shell scripts
│   ├── start-office.sh     # Start everything (writes pid files)
│   ├── stop-office.sh      # Stop everything (by pid file; --force for ports)
│   ├── chat-ai-watcher.sh  # Polls chat, generates Claude replies
│   ├── notify.sh           # Desktop notification (osascript / notify-send)
│   └── gather-context.sh   # Git/agent context for prompts
├── hooks/                  # Claude Code hooks
│   ├── agent-tracker.sh    # Forwards events to server
│   └── status-line.sh      # Claude Code status line → /status (meters)
├── public/                 # Static assets
│   └── sprites/            # Pixel art characters + effects
└── electron/               # Optional Electron wrapper
```

## Security

The server listens on `127.0.0.1` only, so it is never on the network. The
threat it defends against is therefore other processes on the same machine (a
malicious npm dependency, another local user on a shared host): loopback is not
user-isolated, and nothing stops a local process from reaching the port.
Browsers are kept out separately — the origin allowlist refuses every origin
but the loopback UI (ports 3333/3334), and the JSON content type makes a
cross-site POST preflight.

So every route that **acts as an agent or destroys state** requires a bearer
token, and the rest stay open:

| | Routes | Why |
|---|---|---|
| **Token required** | `POST /event`, `/chat/reply`, `/a2a`, `/chat/inbox/read`, `/chat/seen`, `/chat/react`, `/chat/video-mode`, and `POST /chat` for a destructive slash command (`/clear`) | Speaks for an agent, writes another agent's inbox, or wipes history — a local process must not be able to do these |
| **Open** | every `GET`, `POST /chat` (a plain line a person typed, and the read-only `/status` · `/agents` · `/help` · `/incident` · `/all-clear` commands), `POST /chat/typing`, `POST /chat/cron-state` | The office UI has no token; the worst these do is read what the office already shows or post a chat line |

- The token is 32 random bytes generated at startup and written to
  `~/.agent-office/auth-token` (mode `0600`) **only once the port is bound**, so
  starting a second server while one is running no longer clobbers the live
  token. Send it as `Authorization: Bearer <token>`; the hook and the office
  scripts (`chat-reply.py`, `agent-message.py`, the chat watchers) read the file
  and do this for you. The token check is constant-time.
- Everything the server writes under `~/.agent-office` (the token, `agents.json`,
  the A2A inbox files, `last-chat`, the chat-monitor state) is mode `0600` and
  the dir is `0700`, so another local user can't read directed messages or the
  latest chat.
- Errors are returned as `{ "error": ... }` with no stack trace or absolute
  path; message ids are validated and a message's reactions are capped.
- `GET /roster` and `GET /agents` do expose each agent's task text and the names
  of the configured MCP servers. That is the office's purpose, it is localhost
  only, and anything on the machine can already read `~/.claude/settings.json`.

## Desktop App (Electron)

The desktop app is self-contained: it bundles the office server, the built UI and `node_modules`, runs the server on the Node that ships inside Electron (nothing needs to be installed, and no `node` on the PATH), and loads the office from `http://127.0.0.1:3334/` — one port for the page, its assets and the WebSocket.

```bash
npm run dev:electron    # Development: Vite on 3333 + an Electron window; the server runs on your Node
npm run pack            # Unpacked build in release/<platform>-unpacked (quick smoke test)
npm run build:electron  # Installer (.dmg on macOS) in release/
```

How a build is put together (the `build` section of `package.json`):

- `vite build` writes the UI and everything in `public/` to `dist/`; the server serves `dist/` from `/` when it exists, so the sprites ship once.
- `asar` is off: the server is a plain Node child process that reads `dist/`, `server/` and `node_modules` with ordinary `fs` calls.
- `npmRebuild` is off, so the checkout's `node_modules` stay built for your system Node and `npm test` / `node server/index.js` keep working after a pack. `electron/after-pack.cjs` fetches the Electron build of `better-sqlite3` (through its own `prebuild-install`) into the packaged copy only.
- Debugging a build headlessly: `AGENT_OFFICE_SCREENSHOT=/tmp/office.png` makes the app save a screenshot of its window a few seconds after the page loads, then quit (works under `xvfb-run`).

The same single-port mode works without Electron: `npm run build && npm run server`, then open `http://localhost:3334`.

## License

MIT
