# Agent Office — Comprehensive Test Plan

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
| Guard behaviour | `playTyping`, `playCoffee`, `playAlarm`, `playPowerDown`, `playKeyboardClatter` do not throw when `masterVolume === 0` |
| `playAmbientHum` / `stopAmbient` | Do not throw; idempotent (calling stop when not running is safe) |

### Test cases (unit) — effort: **XS (2 hours)**

```
setVolume(0.7) → getVolume() === 0.7
setVolume(2) → getVolume() === 1 (clamp max)
setVolume(-1) → getVolume() === 0 (clamp min)
toggleMute when volume > 0 → isMuted() === true
toggleMute twice → restores original volume
playTyping with masterVolume === 0 → does not throw
playAmbientHum called twice → second call is no-op
stopAmbient when not running → does not throw
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
RANDOM_EVENTS — 'fire-drill' has sound === 'alarm'
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
