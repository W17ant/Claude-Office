# Agent Office — Comprehensive Test Plan

## Status

Run with `npm test` (Vitest, Node environment, `tests/`). CI (`.github/workflows/ci.yml`) runs `tsc --noEmit` and `npm test` on pushes to `main` and on pull requests. Its `hook-smoke` job also runs the real `hooks/agent-tracker.sh` end to end on Windows (Git Bash, an autocrlf checkout) and macOS (`/bin/bash` 3.2) against a stub office (`tests/hook-smoke.mjs`; run it locally with `node tests/hook-smoke.mjs`): it fails on CRLF hook files, a hang, a non-zero exit, stderr output, or no event reaching the office.

**Covered now**

- `server/index.js` — `POST /event` auth + validation + string clamping; `processEvent` for `agent_spawned` (incl. general-purpose sprite spreading), `agent_linked`, `agent_working` (subagent id routing, foreground binding, auto-spawn), `agent_completed` (dedupe + grace period), `mcp_call`/`mcp_done`; `GET /agents`, `GET /roster`, `GET /health`; origin checks — `tests/events.test.ts`
- Agent persistence — `agents.json` written on change, restored on a fresh import of the same runtime dir, stale entries dropped (`AGENT_OFFICE_STALE_MINUTES`) — `tests/persistence.test.ts`
- Chat + A2A — `POST /chat/reply` (recipient, `@Name` mention, self-message, loop budget `AGENT_OFFICE_A2A_LIMIT`), `GET /chat?recipient=`, unread + `POST /chat/inbox/read`, inbox files, `GET /.well-known/agent-card.json`, `GET /a2a/agents`, `POST /a2a` (`message/send` + JSON-RPC errors), `POST /chat` + slash commands — `tests/chat-a2a.test.ts`
- WebSocket — snapshot on connect, broadcast to all clients, origin rejection — `tests/websocket.test.ts`
- `hooks/agent-tracker.py` (run by `hooks/agent-tracker.sh`) against real Claude Code 2.1.x payloads — `tests/hook-script.test.ts`
- `hooks/install-hooks.sh` — fresh install, upgrade from PostToolUse-only, idempotent re-run — `tests/install-hooks.test.ts`
- Rooms — the star of five places, `findRoomPath`, the provisional layouts (every door, spot and waypoint on the floor), open/closed (`DRAWN_ROOMS`, `?rooms=all`) and the room rules — `tests/rooms.test.ts`; the reducer with rooms open and closed (nothing changes with none open, the front door, office → server room leg by leg, MCP workers, the meeting room and its hysteresis, a full room, completing mid-transfer, lunch breaks, the boss hand-over) — `tests/roomTransfer.test.ts`; the floor plan's model and the placement helper's export — `tests/roomSwitcher.test.ts`
- Desktop updates — the release check, version comparison and the *Update automatically* setting (`tests/update-check.test.ts`); which updater a platform gets, when it falls back to the download link, `latest-mac.yml` parsing, asset choice per architecture, the URL allowlist, never downgrading (`tests/update-plan.test.ts`); the download-then-ready state machine, menu labels, the single notification, three download tries (`tests/auto-update.test.ts`); on macOS the download, size cap, sha512, unpack, bundle id and version checks, and the real `electron/mac-swap.sh` against a fake `.app` in a temp dir, including the roll-back when the new bundle cannot be moved in (`tests/mac-update.test.ts`, the swap tests skip on other platforms). `electron-updater` itself is only ever a fake here. The manual checks are under *Desktop updates* below.
- Phone full mode, the listener (`npm run lan -- --full`) — `AGENT_OFFICE_LAN=full` parsing; exact Host (421) and `https://` Origin (403); nothing answers over plain HTTP; the built UI without the secret; every route a 401 without the phone secret, with a wrong one, with the office token, the UI token or the viewer key; each allowlisted route as the page uses it and a 404 for the rest (`LAN_FULL_ROUTES` checked against every path the page fetches and against the token-guarded routes); `/clear` refused; the WebSocket refused before the upgrade (401 / 421 / 403 / 404), the trusted stream with the secret and no UI token, the ninth phone 503; a permission answered from the LAN end to end; lockout after 20 wrong secrets, HTTP and WebSocket; secret and certificate reused across restarts, `--rotate`, a second office that loses the port; watch-only mode unchanged after full mode ran — `tests/lan-full.test.ts`
- Phone full mode, the certificate (`server/lan-cert.js`) — parsed with `crypto.X509Certificate` (v3, self-signed, ECDSA P-256, SAN = the LAN IP, validity, serial, GeneralizedTime past 2049); a real TLS handshake that succeeds only for a client trusting this certificate at this address; reuse, and regeneration on a changed address, near expiry, a mismatched or missing half; `0600` files, nothing written until the port is bound — `tests/lan-cert.test.ts`
- Phone full mode, the page — which location may keep and present the phone secret (https on a private IPv4 literal only), capture from the fragment, `#phone=off`, the secret never offered on a plain-HTTP or loopback page, the office token and viewer key never offered on the phone page, the page dialling only its own origin; the phone layout's arithmetic (room size, portrait or landscape with the keyboard up) and `phone.css` scoped under `.phone-wrapper`, with safe-area insets, reduced motion, a 16 px chat field and 44 px answer buttons — `tests/phone-secret.test.ts`

**Not covered by any test** (manual, see [Manual checks: phone full mode](#manual-checks-phone-full-mode)): a real phone's browser. The listener tests reach the LAN address from the same machine, and the layout was checked in desktop Chromium at 390 × 844 with the certificate error ignored.

**Still planned** (see modules below): `chat-db.js` unit tests, all `src/` modules (jsdom + Testing Library), `useAgentSocket` reconnect logic, React components, Playwright E2E, coverage thresholds.

The server is importable without side effects: `start()` is only called when `server/index.js` is the main module, and everything on disk goes under `AGENT_OFFICE_HOME` (default `~/.agent-office`). Tests point that at a temp dir per file — see `tests/helpers.ts`.

## Overview

This document covers all source modules in `src/` and `server/`. There are currently zero test files in the repository. The recommended test stack is **Vitest** (unit + integration, compatible with Vite's config) and **Playwright** (E2E). No test runner is installed yet — setup steps are included per section.

---

## Setup Required

Add to `package.json` devDependencies:
```json
"vitest": "^1.6.0",
"@vitest/ui": "^1.6.0",
"@testing-library/react": "^16.0.0",
"@testing-library/user-event": "^14.5.0",
"@testing-library/jest-dom": "^6.4.0",
"jsdom": "^24.0.0",
"@playwright/test": "^1.44.0",
"supertest": "^7.0.0"
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}', 'server/**/*.js'],
      thresholds: { lines: 80, functions: 80, branches: 75 },
    },
  },
})
```

`src/test/setup.ts`:
```ts
import '@testing-library/jest-dom'
import { vi } from 'vitest'

// Stub Web Audio API (not available in jsdom)
global.AudioContext = vi.fn().mockImplementation(() => ({
  createOscillator: vi.fn().mockReturnValue({ type: '', frequency: { value: 0, exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() }),
  createGain: vi.fn().mockReturnValue({ gain: { value: 0, exponentialRampToValueAtTime: vi.fn(), setTargetAtTime: vi.fn() }, connect: vi.fn() }),
  currentTime: 0,
  destination: {},
})) as any
```

---

## Module 1: `src/agentManager.ts`

**Risk: HIGH** — core business logic, pure functions, no side effects. Highest ROI for unit tests.

### What to test

| Function | Behaviour |
|---|---|
| `assignSpot` | Returns first free desk; returns null when all taken; ignores non-desk spots |
| `stepToward` | Arrives exactly when dist <= speed; interpolates correctly; handles zero-distance |
| `findWaypointPath` | Returns empty array for empty waypoints; uses nearest waypoint as start; BFS shortest path; jitter keeps values within ±1.5 of waypoint coords |
| `bfsWaypoints` (internal) | Same-node returns immediately; disconnected graph returns null; multi-hop path |
| `maybeTakeLongWay` (internal) | Short paths (<=4) have 20% detour chance; long paths always use shortest |
| `getEffect` | Boss gets Red Bull on coffee-break; ultra/deep-analysis text returns energy drink; water keywords return glass-water; idle >30s returns sleeping; new-hire returns star; completed returns thumb-up |
| `createAgent` | Sets state to new-hire; position at room entryPoint; uses AGENT_CONFIGS for color/emoji; falls back to 'default' config for unknown role |
| `spawnMessage` / `workMessage` / `doneMessage` / `coffeeMessage` / `waterMessage` | Return strings from their respective arrays |
| `pickEnergyDrink` | Deterministic per agentId (same id → same drink); covers both ENERGY_DRINKS values |

### Test cases (unit) — effort: **S (0.5 day)**

```
assignSpot
  - returns null when agents array is empty and spots array is empty
  - returns null when all desk spots are taken
  - skips non-desk spot types (coffee, water, etc.)
  - returns first unoccupied desk spot
  - handles agents with undefined assignedSpotId

stepToward
  - arrived=true when distance <= speed
  - arrived=false when distance > speed
  - new position is exactly targetPosition when arriving
  - movement distance equals speed when not arriving
  - handles identical start and target positions

findWaypointPath
  - returns [] for empty waypoints array
  - returns path starting with nearest waypoint to fromX/fromY
  - jittered values are within ±1.5 of waypoint coords
  - returns at least one waypoint even for same-node start/end

getEffect
  - 'new-hire' → '/sprites/effects/star.png'
  - 'completed' → '/sprites/effects/thumb-up.png'
  - 'idle' + 0ms → null
  - 'idle' + 31000ms → '/sprites/effects/sleeping.png'
  - 'coffee-break' → '/sprites/effects/need-coffee.png'
  - 'coffee-break' + statusText 'hydrated' → glass-water
  - 'coffee-break' + boss agentId → redbull
  - 'working' + no keywords → null
  - 'working' + 'ultra' in task → energy drink
  - 'working' + 'deep analysis' in statusText → energy drink
  - 'walking-to-desk' + 'pizza' in statusText → pizza sprite
  - 'walking-to-desk' + 'birthday' → cake sprite
  - 'walking-to-desk' + 'deploy' → party sprite

createAgent
  - state is 'new-hire'
  - position matches ROOMS['main-office'].entryPoint
  - unknown role falls back to AGENT_CONFIGS['default']
  - known role gets correct color and emoji
```

---

## Module 2: `src/rooms.ts`

**Risk: MEDIUM** — data integrity + navigation functions. Bugs here break all agent movement.

### What to test

| Function | Behaviour |
|---|---|
| `findRoomPath` | Same room returns [room]; direct connection returns 2-item path; multi-hop BFS; unreachable room returns [from] |
| `getConnectedRooms` | Returns correct neighbour RoomIds |
| `getFreeSpot` | Returns null when all spots occupied; filters by type; returns first free spot |
| ROOMS data integrity | All rooms have valid entryPoint; all waypoint connections reference existing waypoint ids; no spot id collisions within a room |

### Test cases (unit) — effort: **S (0.5 day)**

```
findRoomPath
  - findRoomPath('main-office', 'main-office') → ['main-office']
  - findRoomPath('main-office', 'manager-office') → ['main-office', 'manager-office']
  - findRoomPath('kitchen', 'rooftop') → ['kitchen', 'rooftop']
  - findRoomPath('main-office', 'parking') returns a path (multi-hop via lobby)
  - findRoomPath('main-office', 'gym') returns ['main-office', 'gym']
  - unreachable room returns [from]

getFreeSpot
  - returns null when occupiedSpotIds contains all spot ids
  - returns first spot when occupiedSpotIds is empty
  - filters by type correctly

ROOMS data integrity
  - every waypoint connection id exists as a waypoint id in that room
  - no two agentSpots share the same id within one room
  - all rooms have positive width and height
  - entryPoint x and y are between 0 and 100
```

---

## Module 3: `src/daylight.ts`

**Risk: LOW-MEDIUM** — affects visual output; solar math must be correct.

### What to test

| Function | Behaviour |
|---|---|
| `getSunTimes` | Sunrise before noon, sunset after noon for mid-latitude; polar clamping at ±90 lat |
| `getCurrentPhase` | Returns correct DayPhase for time of day (needs clock mocking) |
| `isDark` | Returns true for night, dusk, dawn; false for morning, afternoon, evening |
| `getPhaseLabel` | Returns a non-empty string for every DayPhase value |

### Test cases (unit) — effort: **XS (2 hours)**

```
getSunTimes
  - sunrise < 12 and sunset > 12 for latitude 51.5 on summer solstice
  - sunrise < 12 and sunset > 12 for latitude 51.5 on winter solstice
  - extreme latitude (89) clamps cosHourAngle to [-1, 1] without NaN

getCurrentPhase
  - returns 'night' when hour is 2am
  - returns 'morning' when hour is 9am
  - returns 'afternoon' when hour is 14:00
  - returns 'dawn' just before sunrise

isDark
  - true for 'night', 'dusk', 'dawn'
  - false for 'morning', 'afternoon', 'evening'

getPhaseLabel
  - returns non-empty string for all 6 DayPhase values
```

---

## Module 4: `src/sounds.ts`

**Risk: LOW** — AudioContext is browser-only; stub it in tests.

### What to test

| Area | Behaviour |
|---|---|
| `setVolume` / `getVolume` | Clamps to [0,1]; getter returns set value |
| `toggleMute` | Mutes when on; restores previous volume when unmuting; returns boolean |
| `isMuted` | Returns true when volume is 0 |
| Event cues | `playNeedsYou`, `playAlarm`, `playError`, `playCelebration`, `playBell` are silent when muted, play once per cooldown (`cueAllowed`), and use sine tones only |
| Ambient bed | `playAmbientHum` / `stopAmbient` wait for a gesture (`unlockAudio` / `attachAmbience`), follow mute, Ambience and a hidden tab, and survive a stop/restart race |
| Policy | `incidentHasCue`, `ambienceGain`, `nextTextureDelayMs`, `loopedBrownNoise` (seamless loop) |

### Test cases (unit) — effort: **XS (2 hours)**

```
setVolume(0.7) → getVolume() === 0.7
setVolume(2) → getVolume() === 1 (clamp max)
setVolume(-1) → getVolume() === 0 (clamp min)
toggleMute when volume > 0 → isMuted() === true
toggleMute twice → restores original volume
playNeedsYou twice inside 8 s → one chime
playAmbientHum before any gesture → no AudioContext
incidentHasCue('event') → false (a random event's mini-incident is silent)
```

---

## Module 5: `src/assets.ts`

**Risk: LOW** — data integrity only.

### What to test

| Function | Behaviour |
|---|---|
| `getAssetPath` | Returns path for known key; returns null for unknown |
| `hasAsset` | Returns true for known; false for unknown |
| `getAssetsByCategory` | Returns only assets matching the category; all entries belong to that category |
| Data integrity | All asset paths start with `/`; width and height are positive numbers |

### Test cases (unit) — effort: **XS (1 hour)**

```
getAssetPath('coffee-off') → '/sprites/appliances/coffee-off.png'
getAssetPath('nonexistent') → null
hasAsset('plant-monstera') → true
hasAsset('fake-key') → false
getAssetsByCategory('effect') → all values have category === 'effect'
all ASSETS entries have width > 0 and height > 0
all ASSETS paths start with '/'
```

---

## Module 6: `src/events.ts`

**Risk: LOW-MEDIUM** — `pickEvent` randomness makes it tricky; data shape matters for rendering.

### What to test

| Area | Behaviour |
|---|---|
| `RANDOM_EVENTS` data | All events have required fields: id, name, slackAnnouncement, duration, type |
| `DRAMA_CONVERSATIONS` | All conversations have at least one message; each message has sender and text |
| `pickEvent` | Never returns undefined; always returns a RandomOfficeEvent; over many calls, deploy-success and deploy-fail are both returned |

### Test cases (unit) — effort: **XS (1 hour)**

```
RANDOM_EVENTS — every item has id, name, slackAnnouncement, duration, type
DRAMA_CONVERSATIONS — every conversation has messages.length >= 1
pickEvent() — returns a defined object with an 'id' field (run 100 times)
pickEvent() — both 'deploy-success' and 'deploy-fail' appear across 200 calls
```

---

## Module 7: `src/interactions.ts`

**Risk: LOW-MEDIUM** — maps furniture clicks to boss behaviour.

### What to test

| Function | Behaviour |
|---|---|
| `getInteraction` | Returns null for unknown id; returns Interaction with all required fields for known ids |
| Known interactions | coffee has furnitureState; bell has sound === 'bell'; all have positive cooldown and duration |

### Test cases (unit) — effort: **XS (1 hour)**

```
getInteraction('nonexistent') → null
getInteraction('coffee') → has walkTo, effect, duration, chatMessage, cooldown, furnitureState
getInteraction('bell') → sound === 'bell'
getInteraction('fire-extinguisher') → walkTo is within 0-100 range
all known ids return interactions where cooldown > 0 and duration > 0
```

---

## Module 8: `src/types.ts`

**Risk: LOW** — type definitions + AGENT_CONFIGS data.

### What to test

| Area | Behaviour |
|---|---|
| `AGENT_CONFIGS` | Every entry has color, emoji, title; 'default' entry exists |
| Color format | All colors are valid CSS hex strings |

### Test cases (unit) — effort: **XS (30 min)**

```
AGENT_CONFIGS['default'] is defined
AGENT_CONFIGS['boss'] uses BOSS_COLOR from config
every AGENT_CONFIGS entry has non-empty color, emoji, title
```

---

## Module 9: `server/chat-db.js`

**Risk: HIGH** — persistence layer; bugs cause silent data loss or corrupt reactions.

Uses an in-memory SQLite DB (`:memory:`) for tests — the module needs to export the db path as a configurable option, or tests instantiate their own DB.

### What to test

| Function | Behaviour |
|---|---|
| `addMessage` | Inserts and returns row with auto-generated id and timestamp; defaults role to 'default'; isSystem stored as 0/1 |
| `getMessages` | Returns messages in ascending timestamp order; `since` filter excludes older messages; `limit` caps results |
| `markSeen` | Sets seen=1 on the given message id; does not affect other rows |
| `addReaction` | Adds emoji to empty reactions; toggles off when emoji already present; handles malformed JSON in DB gracefully; returns updated array |
| `getThread` | Returns only messages with matching thread_id; empty when none match |

### Test cases (integration) — effort: **M (1 day)**

```
addMessage inserts row with correct sender, role, text
addMessage returns row with numeric id and timestamp close to Date.now()
addMessage with isSystem=true stores is_system=1
getMessages with no args returns up to 50 messages ordered by timestamp ASC
getMessages with since=T returns only messages with timestamp > T
getMessages limit=3 returns at most 3 rows
markSeen sets seen=1 on target row; other rows remain seen=0
addReaction on new message adds emoji; returns ['emoji']
addReaction same emoji again removes it; returns []
addReaction with corrupt reactions column returns [] without throwing
getThread returns only rows with matching thread_id
```

---

## Module 10: `server/index.js`

**Risk: HIGH** — security (auth token), input validation, event processing, WebSocket broadcast. Most complex module.

Test with `supertest` for HTTP routes. WebSocket behaviour tested with the `ws` client library.

### What to test

#### Authentication
```
POST /event without Authorization → 401
POST /event with wrong token → 401
POST /event with correct token → 200
```

#### Input validation (`validateEvent`)
```
POST /event with missing type → 400
POST /event with unknown type → 400 "Unknown event type"
POST /event with body > 10kb → 413 (express limit)
```

#### String clamping (`clampString`)
```
agent.name longer than 200 chars is truncated to 200
agent.task longer than 200 chars is truncated to 200
chat text longer than 2000 chars is truncated to 2000
```

#### Origin validation
```
Request with Origin: http://evil.com → 403
Request with no Origin header → allowed (Electron/curl)
Request with Origin: http://localhost:3333 → allowed
```

#### `isAllowedOrigin`
```
null origin → true
'http://localhost:3333' → true
'http://localhost:3334' → true
'http://attacker.com' → false
```

#### Event processing (`processEvent`)
```
agent_spawned — creates entry in activeAgents with correct name/role/state
agent_spawned — resolveAgentId uses agent.id if present
agent_spawned — resolveAgentId derives id from name+role when id absent
agent_spawned — special chars in name/role are replaced with hyphens
agent_working — updates state and status on existing agent
agent_working — returns event even when agentId not in activeAgents
agent_completed — sets agent state to 'completed'; deletes after 10s
agent_completed — result containing 'error' triggers sendNotification (mock)
mcp_call — adds transient mcp agent to activeAgents
mcp_done — removes matching mcp agents from activeAgents
unknown type → returns null
```

#### `GET /health`
```
returns { status: 'ok', agents: <number>, clients: <number> }
```

#### `GET /roster`
```
returns { mcpServers: [...], activeAgents: [...] }
```

#### Chat endpoints
```
POST /chat missing sender → 400
POST /chat missing text → 400
POST /chat valid → 200, message stored and broadcast
POST /chat with '/status' → returns system message with agent count
POST /chat with '/agents' → lists active agents
POST /chat with '/clear' → deletes all messages
POST /chat/reply missing text → 400
POST /chat/reply valid → 200
GET /chat → returns messages array
GET /chat?since=T → filters by timestamp
POST /chat/seen missing messageId → 400
POST /chat/seen valid → 200, markSeen called
POST /chat/react missing messageId → 400
POST /chat/react missing emoji → 400
POST /chat/react valid → 200, returns updated reactions
POST /chat/typing missing sender → 400
POST /chat/typing valid → 200
POST /chat/video-mode { enabled: true } → videoPaused = true
GET /chat when videoPaused — hides messages created after pause
```

#### `discoverMcpServers`
```
returns [] when no config files exist
parses mcpServers keys from ~/.claude/settings.json (mocked fs)
parses mcp_servers keys (alternate key name)
skips malformed JSON files gracefully
deduplicates servers found across multiple files
```

#### `handleSlashCommand`
```
'/status' → contains agent count string
'/agents' → lists agent name/role/state
'/agents' when empty → 'Office is quiet' message
'/clear' → returns clear confirmation string
'/help' → contains '/status'
unknown command → returns null
```

### Effort: **L (2 days)**

---

## Module 11: `src/hooks/useAgentSocket.ts`

**Risk: HIGH** — reconnection logic, snapshot handling, event dispatching. Bugs cause the entire UI to go offline silently.

Test with `@testing-library/react` and a mock WebSocket server.

### What to test

```
Initial state: connected=false, offline=false, events=[], mcpServers=[]
After WS connects: connected=true, offline=false
After WS closes: connected=false, scheduleReconnect called
First error before any connection: offline=true
Backoff delay doubles each retry attempt
Backoff capped at BACKOFF_MAX (30 000ms)
Retry count resets to 0 on successful reconnect
snapshot message with activeAgents emits agent_spawned events for each agent
snapshot message sets mcpServers state
Regular OfficeEvent dispatched via onEvent callback
Regular OfficeEvent appended to events array
events array capped at 50 items
disabled=true prevents WebSocket construction
Unmounting cancels pending retry timer
Unmounting closes open WebSocket
onEvent ref update is stable (new callback used without re-subscribing)
```

### Effort: **M (1 day)**

---

## Module 12: React Components

### `Character.tsx` — effort: **M (1 day)**

```
renders img with correct sprite path based on role
renders img with correct path for unknown role (fallback employee-3)
boss character has height 85; others have height 78
EffectBubble rendered when getEffect returns non-null
EffectBubble not rendered when getEffect returns null
typing prop=true shows typing.png effect regardless of state
SpeechBubble only rendered when state === 'talking-to-manager'
moving agent (new-hire state) updates directionRef from dx/dy
idle agent uses spriteFacing from spot
turnedAround toggles direction to OPPOSITE[spriteFacing] during working state
cleanup on state change cancels pending turn timeout
```

### `SpeechBubble.tsx` — effort: **XS (1 hour)**

```
renders text content
disappears after duration ms (fake timers)
resets timer when text prop changes
isManager=true adds manager-bubble class
```

### `EffectBubble.tsx` — effort: **XS (30 min)**

```
renders img with provided src
renders img with provided alt
renders with default alt 'effect' when not provided
```

### `FurnitureRenderer.tsx` — effort: **S (3 hours)**

```
renders nothing for empty items array
hotspot item renders as div (no img)
item with sprite in ASSETS renders img with asset path
item with unknown sprite and no ':' renders img using sprite as direct path
item with sprite containing ':' (legacy format) renders nothing (null)
clickable type triggers onItemClick with item.id
non-clickable item does not trigger onItemClick
hotspot click triggers onItemClick
interactive=true makes any item clickable
zIndex falls back to Math.round(item.y) when not specified
```

### `SlackChat.tsx` — effort: **M (1 day)**

```
renders channel name 'office-general'
displays last 12 messages only
sends message on Enter key press
clears input after send
does not send on empty/whitespace input
Escape key clears slash hint
'/' input shows slash hint with /status, /agents, /help
typing indicator shown when typingUser is set
typing indicator hidden when typingUser is null
seen avatar rendered next to message matching lastSeenId
autoTypeText triggers character-by-character typing and auto-sends
volume slider calls onVolumeChange with value / 100
mute button calls onToggleMute
avatar falls back to colored div on image error
proactive message text (matching PROACTIVE_PATTERN) gets slack-msg-proactive class
```

---

## Integration Tests

### Server + DB integration — effort: **M (1 day)**

Start a real server instance (or use supertest against the Express app) with an in-memory SQLite DB.

```
POST /event agent_spawned then GET /roster shows agent in activeAgents
POST /event agent_completed removes agent from GET /roster after 10s delay
POST /chat then GET /chat returns the message
POST /chat with /clear then GET /chat returns empty messages
POST /chat/react then GET /chat shows updated reactions field
Full slash command flow: /status reflects live agent count
```

### WebSocket snapshot integration — effort: **S (0.5 day)**

```
Connecting WS client receives snapshot immediately with activeAgents
Agent spawned via POST /event is broadcast to connected WS client
Multiple WS clients all receive broadcast
Disconnected client is not included in broadcast (no error thrown)
```

---

## E2E Tests (Playwright)

**Effort: L (2 days)**

### Setup

```ts
// playwright.config.ts
webServer: {
  command: 'npm run dev:all',
  port: 3333,
  reuseExistingServer: false,
}
```

### Scenarios

```
Office loads with two permanent agents (Boss and Claude) visible
Both agents walk to their desks from the entry point
Sending a message via the Slack panel shows it in the message list
Typing '/' in the Slack input shows the slash hint
'/status' command returns a system message containing 'agents'
Agent spawned via POST /event appears on screen within 3s
Agent completed via POST /event starts walking to door
Coffee machine click walks boss to coffee area
Day/night overlay transitions over time (nightOpacity changes)
Volume slider changes rendered mute button icon
App is stable after 30s in sim mode (?sim) — no console errors
```

---

## Manual checks: seasons

The date rules, the lookup chain and the overrides are unit-tested (`tests/season.test.ts`, `tests/settings.test.ts`). These are the parts only a browser shows. Only Christmas has art so far, so most of them check that an undrawn season changes nothing.

```
?season=christmas shows the Christmas office, the Santa hats and the advent calendar, as before
?season=halloween, easter, valentine, spring, summer, autumn and winter each look exactly like ?season=none
  (no broken images, no hats, no advent calendar)
?season=none in December shows the normal office
?season=midsummer (not a season) behaves like no ?season= at all
Network tab, ?season=autumn: one request for rooms/office-day-autumn.webp and no other *-autumn.webp
Network tab, ?season=halloween: rooms/office-day-halloween.webp and the date's season's key file
  (rooms/office-day-summer.webp in July), nothing else with either suffix
Network tab, ?season=christmas: the only *-winter.webp request is rooms/office-day-winter.webp
Settings > Season is a drop-down: Auto (by date), Holidays (4), Seasons (4), Off; it opens, closes and
  takes the keyboard like any select, and matches the panel in both themes
Choosing a season there offers a reload; after it the choice is still selected, and it survives a restart
On Auto the note names what is on now ("Autumn", "Christmas over Winter") and says "(no art yet)"
  for a layer that has none
With ?season= in the address a note under the control says the URL wins over it
Key file: copy public/rooms/office-day-xmas.webp to public/rooms/office-day-autumn.webp, load
  ?season=autumn: the day room changes, and requests for the other -autumn.webp files appear and fail
  quietly (everything else stays normal). Delete the copy afterwards; do not commit it
A character walking under ?season=christmas keeps its jumper mid-step (its -xmas walk frames)
```

## Desktop updates (manual)

Nothing here runs in CI: the updater only exists in a packaged app, and the real thing needs a published GitHub release. What the unit tests cover is in *Covered now* above.

### One command, on a Mac

```bash
node scripts/e2e-mac-update.mjs          # --keep keeps the work dir, --reuse skips the two builds
```

It packages the app twice (the current version and the next patch), serves the newer build's `latest-mac.yml` and zip on 127.0.0.1, starts the older build from a temp `Applications` folder and checks 17 things: the menu goes *Downloading update* → *Restart to update* and never shows *Download*, exactly one *is ready* notification, the requests went to the real `github.com` URLs, the click quits the app, `update-swap.log` says `updated`, the bundle at the same path is the newer version and is running, its server answers `/health`, nothing is left beside the app. It opens the app's window twice, uses its own user-data dir, `AGENT_OFFICE_HOME` and a free port (never 3333, 3334 or 3335), and exits non-zero on any failed check. The feed is injected through an entry file in a throwaway copy of the app, never through the environment; the script's header lists what that replaces.

It does not cover a real release and TLS, the notification actually appearing, `/Applications` and its permissions, a quarantined or translocated download, an Intel Mac, or Windows and Linux. Those are by hand, below.

### By hand, against a real release

Install release N, publish release N+1 (the draft has to be published: neither the check nor electron-updater sees a draft), start the app. The check runs at start; started from a terminal the app prints `[update] vN+1 is available`.

```
macOS (arm64 and x64), app dragged to /Applications
  menu shows "Downloading update vN+1…" (greyed), then "Restart to update to vN+1"
  one "is ready" notification, no "is available" one; none again on the next start
  "Restart to update" → app quits, comes back as vN+1 at the same path, the office (port, agents, chat) is as it was
  update-swap.log in the user-data directory has one "updated" line; no ".agent-office-update-*" folder or old bundle left in /Applications
  with an update ready, Quit instead → next start is vN+1
  if macOS asks to let the app "manage other apps" (App Management): allow → updated; deny → expected: the old version starts again and the menu shows "Download" for vN+1 (never tried; note what really happens)
  a standard (non-admin) user whose app an admin installed → "Download", no download attempted
macOS, app opened straight from the dmg or from Downloads (translocated)
  no "Update automatically" checkbox; "Update available: vN+1 — Download" opens the release page
Windows (nsis), installed for the current user
  "Restart to update" → installer runs without its wizard, app starts again as vN+1
  with an update ready, Quit → next start is vN+1
Windows, installed for all users
  as above with one elevation (UAC) prompt; decline it → the app is still vN, and on its next start the menu shows "Download" for vN+1
Linux (AppImage in a folder the user owns)
  "Restart to update" → the AppImage file is replaced, the app starts again as vN+1
  Quit with an update ready → nothing is installed; the next start offers it again
Linux, AppImage in a read-only folder, or the unpacked directory build
  "Download" only
Every platform
  untick "Update automatically" → the menu shows "Download" at once and nothing more is fetched; tick it → "Restart to update" is back without a second download when one had finished, otherwise the download starts
  the setting survives a restart ("autoUpdate" in update-check.json)
  the zip or installer missing from the release, or the network cut mid-download → "Download" and one "is available" notification after the first failed try; it tries again at the next two six-hourly checks, then not until the app is restarted
  release N+1 deleted or made a draft again → no update offered; a release older than the running app is never installed
  a dev run (npm run dev:electron) has no update items at all
```

## Manual checks: phone full mode

`npm run lan -- --full` (docs/reference.md › Phone mode). The automated tests cover the listener, the certificate and the page's rules for the secret; these need a real phone on the same Wi-Fi and are done by hand. Use a throwaway `AGENT_OFFICE_HOME` and other ports (`AGENT_OFFICE_PORT`, `AGENT_OFFICE_LAN_PORT`) if an office you care about is running.

**Never yet run on a real phone** — the first two decide whether full mode works on an iPhone at all:

1. **iOS Safari, WebSocket after the warning.** Scan the QR code, accept the certificate warning, and check the header reads *online* and the server logs `Phone connected … (full mode, phones: 1)`. Unverified: whether Safari lets the page's `wss://` connection use a certificate accepted through that warning. If the page loads and stays *Not connected*, it does not; note the iOS version.
2. **The fragment survives the warning.** After accepting, the page must not show *NO KEY*. If it does, the browser dropped `#phone=…` on the way through the warning: open the link a second time and note which browser.
3. **The fingerprint can be compared.** From the warning, open the certificate's details and find the SHA-256 fingerprint; it must equal the one the server printed. Write down the taps for iOS Safari and Android Chrome (the reference does not give them yet).
4. Repeat 1–3 in Chrome on Android.

**Layout, portrait 390 × 844 or the phone's own size**

5. The room spans the width at the top; nothing scrolls sideways in any tab (Chat, Meters, Today, Settings).
6. With a permission pending (run a tool that asks, with **Answer here** on): the card is on screen under the room without scrolling or zooming; *Allow*, *Allow & remember* and *Deny* are each easy to hit; the hook is released with the answer given; the card leaves.
7. Chat: tap the field — with the keyboard up the field and the last lines stay visible (the room is put away); post a line and see it in the desktop office. `/clear` is refused.
8. Meters and Today show live numbers; Settings' three switches change the server's settings (check on the desktop page) and the chat monitor pauses.
9. Tap a character: the inspector opens over the lower half with a transcript tail; its close button is at the right edge.
10. Rotate to landscape: the room on the left, the rest on the right, clear of the notch and the home bar.
11. With *Reduce Motion* on (iOS: Settings › Accessibility › Motion): cards and the inspector appear without sliding, session pills do not pulse.

**The secret and the certificate**

12. `https://<lan ip>:<port>/` without the fragment in a fresh browser: the *NO KEY* notice, no tabs, no chat field.
13. `#phone=off` forgets the secret: the same notice, and a reload stays there.
14. Restart with `--full --rotate`: the phone shows *Not connected*; the new link works; the certificate warning does **not** come back (the certificate is kept).
15. Restart with nothing changed: no new warning, the same fingerprint, the old link still works.
16. Change this machine's LAN address (another network), restart: the server prints `New certificate (the LAN address changed)` and a new fingerprint; the phone warns once more.
17. Open the full-mode link's address with `http://` instead of `https://`: no page, no answer.
18. In a browser holding no phone secret, the office link's `#token=…` and the watch-only link's `#viewer=…` put on the `https://<lan ip>:<port>/` address: the *NO KEY* notice both times, the fragment gone from the address bar, and neither value stored (Safari › Develop, or Chrome's remote inspector: of the office's three secrets only `agent-office.phone` may ever appear in that origin's storage).

**Watch-only is unchanged**

19. `npm run lan` with no flag, also with `AGENT_OFFICE_LAN=full` left in the shell: the banner says *watch-only*, the link is `http://…/#viewer=…`, the phone shows the scene alone, and `curl http://<lan ip>:<port>/settings` is a 404.

---

## Effort Summary

| Area | Tests | Effort |
|---|---|---|
| agentManager.ts | ~30 unit tests | 0.5 day |
| rooms.ts | ~15 unit tests | 0.5 day |
| daylight.ts | ~10 unit tests | 2 hours |
| sounds.ts | ~8 unit tests | 2 hours |
| assets.ts | ~8 unit tests | 1 hour |
| events.ts | ~8 unit tests | 1 hour |
| interactions.ts | ~8 unit tests | 1 hour |
| types.ts | ~5 unit tests | 30 min |
| chat-db.js | ~15 integration tests | 1 day |
| server/index.js | ~45 integration tests | 2 days |
| useAgentSocket.ts | ~15 unit tests | 1 day |
| Character.tsx | ~12 component tests | 1 day |
| SpeechBubble.tsx | ~4 component tests | 1 hour |
| EffectBubble.tsx | ~3 component tests | 30 min |
| FurnitureRenderer.tsx | ~10 component tests | 3 hours |
| SlackChat.tsx | ~15 component tests | 1 day |
| Server+DB integration | ~10 tests | 1 day |
| WS integration | ~5 tests | 0.5 day |
| E2E (Playwright) | ~12 scenarios | 2 days |
| **Total** | **~238 tests** | **~16 days** |

---

## Priority Order

1. `server/chat-db.js` — persistence, silent data loss risk
2. `server/index.js` auth + validation — security boundary
3. `agentManager.ts` — all movement logic is here; pure functions, easy wins
4. `useAgentSocket.ts` — reconnect bugs cause invisible failures
5. `server/index.js` event processing + chat endpoints
6. `rooms.ts` + waypoint data integrity
7. React components (Character, SlackChat)
8. Remaining pure-function modules (daylight, sounds, assets, events, interactions)
9. E2E scenarios

---

## Notes on Testability Gaps

- **`sounds.ts`** uses module-level mutable state (`masterVolume`, `ambientRunning`). Tests must reset state between runs by re-importing the module or exporting a `_resetForTesting()` helper.
- **`server/index.js`** has module-level mutable state (`activeAgents`, `videoPaused`). Tests need to either restart the server or export reset helpers.
- **`chat-db.js`** hard-codes the DB path to `~/.agent-office/chat.db`. To make it testable without touching the real file, extract the path to a parameter or environment variable (`AGENT_OFFICE_DB_PATH`).
- **`config.ts`** uses a top-level `await import()` which is valid ESM but means tests must provide `office.config.json` or mock the import. Vitest's module mocking handles this cleanly.
- **`App.tsx`** is a 900-line component. The animation loop (requestAnimationFrame via setInterval) and heavy use of refs make it hard to unit test directly. Focus component tests on the sub-components and integration/E2E for App-level behaviour.

---

## Manual checks: rooms

The rooms' logic is covered by `tests/rooms.test.ts`, `tests/roomTransfer.test.ts` and `tests/roomSwitcher.test.ts`. What a test cannot see is how it looks; check these by eye, in both themes (`&theme=office`) and by day and night.

**No room open (today, until the art lands)** — `127.0.0.1:3333?sim` and the live office

- [ ] The office looks and behaves as before: no floor plan anywhere, agents come and go by the office door, MCP calls show no character.
- [ ] `/?helper` opens on the office with its art, and its export is what it was.

**Preview** — `127.0.0.1:3333?sim&rooms=all`

- [ ] The floor plan sits in the bottom-left corner of the stage, clear of the status strip and the chat, with Office, Meeting, Server and Lunch standing on a Corridor strip, and the office ringed.
- [ ] New agents appear in the corridor (pick it on the plan) at the front door on the left, walk to the office door, and appear at the office's door a moment later. Leavers do the reverse and vanish at the front door.
- [ ] Within about half a minute two server workers stand at racks in the server room with their call as status; they leave about 30 s after their last call.
- [ ] Within about 15 s of the demo's three workers sitting down they get up, cross the corridor and sit at the meeting table; they go back when two of them have left.
- [ ] A worker on a break walks to the lunch room's machine or cooler and back; the boss's break stays in the office.
- [ ] Nobody walks through a wall or stands on a door for long in any room; in the corridor people walk visibly faster.
- [ ] Each placeholder shows its room's name, its door (and where it leads), and in the corridor the front door and the manager's nameplate door.
- [ ] With another room in view the desk screens, wall props, task board, advent calendar (`&season=christmas`) and incident layer are not drawn, and they are back, up to date, when the office is in view again.
- [ ] `/incident` in the live office with `?rooms=all`: the red tint and beacon show only in the office; the plan marks the office with a red ×.
- [ ] A pending permission (live, `?rooms=all`): after about 10 s that session's Claude walks to the meeting room and the plan shows an amber ! there. The stage does not switch by itself.
- [ ] Keyboard: Tab reaches the plan, the arrow keys move between rooms, Enter or Space shows one, and the focus ring is visible in both themes.
- [ ] `prefers-reduced-motion`: the plan's marks do not pulse.
- [ ] Desktop compact mode: the plan fits and does not cover the characters' status.
- [ ] Phone view (`npm run lan`): the office only, no plan; agents in other rooms are simply not shown.

**Placing a layout** — `127.0.0.1:3333?helper&room=meeting-room` (and `corridor`, `server-room`, `lunch-room`)

- [ ] The room opens on its placeholder with its current door, spots, floor and waypoints loaded; the Room and BG selects switch room and background.
- [ ] A door placed in a side room exports with `toRoom: 'corridor'`; in the corridor the door's target can be chosen, and the front door and the manager's door export under `landmarks`.

**When a room's art lands**

- [ ] Its four files are in `public/rooms/`, its id is in `DRAWN_ROOMS`, its entries are gone from `PLANNED`, and `npm run check-assets` passes.
- [ ] The layout has been re-placed over the art and `provisional: true` removed; nobody sits beside a chair or walks across a table.
