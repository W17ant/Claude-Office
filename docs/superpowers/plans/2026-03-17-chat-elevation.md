# Agent Office Chat Elevation — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the office chat from a basic reply system into a rich, persistent, context-aware communication hub with personality, typing indicators, reactions, read receipts, slash commands, proactive messages, multi-agent routing, and smart notifications.

**Architecture:** Four waves building on each other. Wave 1 (foundation) adds persistence and personality. Wave 2 (UX polish) adds typing, reactions, read receipts. Wave 3 (intelligence) adds context-aware replies, multi-agent routing, threaded memory. Wave 4 (power features) adds slash commands, proactive messages, smart notifications.

**Tech Stack:** TypeScript/React (frontend), Node.js/Express (server), bash/python (watcher), SQLite via better-sqlite3 (persistence), osascript (notifications)

---

## Wave 1: Foundation (Persistence + Personality)

### Task 1: Chat History Persistence (Feature 11)

**Files:**
- Modify: `server/index.js` — replace in-memory chatHistory with SQLite
- Create: `server/chat-db.js` — SQLite wrapper for chat storage
- Modify: `package.json` — add better-sqlite3 dependency

- [ ] **Step 1: Install better-sqlite3**

```bash
cd /Users/Antony/agent-office && npm install better-sqlite3
```

- [ ] **Step 2: Create server/chat-db.js**

SQLite wrapper with functions: `addMessage()`, `getMessages()`, `markSeen()`, `addReaction()`, `getThread()`. Schema includes: id, sender, role, text, timestamp, is_system, reactions (JSON), thread_id, seen.

Database stored at `~/.agent-office/chat.db` with WAL mode.

- [ ] **Step 3: Replace in-memory chatHistory in server/index.js**

Import from chat-db.js. Remove chatHistory array. Update POST /chat, GET /chat, POST /chat/reply to use DB functions.

Add new endpoints:
- `POST /chat/seen` — mark message as seen, broadcast `chat_seen`
- `POST /chat/react` — add emoji reaction, broadcast `chat_reaction`
- `POST /chat/typing` — broadcast `chat_typing` to all clients

- [ ] **Step 4: Verify persistence across server restarts**

- [ ] **Step 5: Commit** — `"feat: persist chat history to SQLite"`

### Task 2: Claude Personality & Memory (Feature 1)

**Files:**
- Create: `~/.agent-office/claude-persona.md` — personality prompt
- Modify: `scripts/chat-ai-watcher.sh` — load persona into prompt

- [ ] **Step 1: Create persona file** — witty office manager personality, running jokes (haunted printer, questionable coffee, "one more deploy"), 8-12 word reply limit

- [ ] **Step 2: Update watcher to load persona file into prompt**

- [ ] **Step 3: Commit** — `"feat: add Claude personality file for chat replies"`

---

## Wave 2: UX Polish (Typing, Reactions, Read Receipts, Threaded Memory)

### Task 3: Typing Indicator (Feature 2)

**Files:**
- Modify: `src/components/SlackChat.tsx` — typing indicator row
- Modify: `src/styles/office.css` — bouncing dots animation
- Modify: `scripts/chat-ai-watcher.sh` — POST /chat/typing before generating
- Modify: `src/App.tsx` — handle chat_typing event, track state, clear on reply

- [ ] **Step 1: Add `typingUser` prop to SlackChat, render typing row with Claude avatar + 3 bouncing dots**

- [ ] **Step 2: Add CSS keyframe animation for `.slack-typing-dots span` elements**

- [ ] **Step 3: Handle `chat_typing` WebSocket event in App.tsx — set state, auto-clear after 10s, clear on chat_message from Claude**

- [ ] **Step 4: Watcher posts `POST /chat/typing {"sender":"Claude"}` immediately on detecting new message**

- [ ] **Step 5: Commit** — `"feat: typing indicator with bouncing dots"`

### Task 4: Emoji Reactions (Feature 3)

**Files:**
- Modify: `scripts/chat-ai-watcher.sh` — 30% chance to react instead of reply
- Modify: `src/App.tsx` — handle chat_reaction WebSocket event
- Modify: `src/components/SlackChat.tsx` — render updated reactions

- [ ] **Step 1: Watcher rolls 30% chance — if yes, picks random emoji from pool, POSTs to /chat/react with latest message ID, then continues (skips reply)**

- [ ] **Step 2: Handle `chat_reaction` in App.tsx — update message reactions in state**

- [ ] **Step 3: Commit** — `"feat: emoji reactions — Claude sometimes reacts instead of replying"`

### Task 5: Read Receipts (Feature 4)

**Files:**
- Modify: `scripts/chat-ai-watcher.sh` — POST /chat/seen immediately on detection
- Modify: `src/App.tsx` — handle chat_seen, track lastSeenId
- Modify: `src/components/SlackChat.tsx` — show tiny Claude avatar under last seen message
- Modify: `src/styles/office.css` — seen indicator styling

- [ ] **Step 1: Watcher POSTs seen immediately when new message detected (before react/reply logic)**

- [ ] **Step 2: Handle `chat_seen` in App.tsx, pass `lastSeenId` to SlackChat**

- [ ] **Step 3: Render 14px Claude avatar aligned right below the last boss message that was seen**

- [ ] **Step 4: Commit** — `"feat: read receipts — Claude avatar shows when message seen"`

### Task 6: Threaded Conversation Memory (Feature 8)

**Files:**
- Modify: `scripts/chat-ai-watcher.sh` — fetch last 10 messages as conversation context

- [ ] **Step 1: Before building prompt, GET /chat for last 10 messages, format as `Sender: text` lines, include in prompt with instruction to continue the thread naturally**

- [ ] **Step 2: Commit** — `"feat: threaded memory — watcher includes conversation context"`

---

## Wave 3: Intelligence (Context-Aware, Multi-Agent)

### Task 7: Context-Aware Replies (Feature 5)

**Files:**
- Create: `scripts/gather-context.sh` — collects git branch, last commit, active agents, recent file changes
- Modify: `scripts/chat-ai-watcher.sh` — inject dev context into prompt

- [ ] **Step 1: Create gather-context.sh — outputs current branch, last commit, active agents from /roster, recently changed files from git diff**

- [ ] **Step 2: Watcher calls gather-context.sh and appends output to prompt**

- [ ] **Step 3: Commit** — `"feat: context-aware replies with git/agent awareness"`

### Task 8: Multi-Agent Chat Routing (Feature 7)

**Files:**
- Modify: `scripts/chat-ai-watcher.sh` — keyword-based topic detection, route to agent persona

- [ ] **Step 1: Add keyword detection — bug/error → Debugger, review/PR → Reviewer, CSS/UI → Frontend, test → Tester, security → Security, deploy/CI → DevOps, perf/slow → PerfEng, db/query → DBA, else → Claude**

- [ ] **Step 2: Post reply with matching sender name and role, add role-specific personality to prompt**

- [ ] **Step 3: Commit** — `"feat: multi-agent routing — messages routed to relevant specialist"`

---

## Wave 4: Power Features (Slash Commands, Proactive, Notifications)

### Task 9: Slash Commands (Feature 10)

**Files:**
- Modify: `server/index.js` — detect /commands in POST /chat, handle and respond

- [ ] **Step 1: In POST /chat, if text starts with `/`, route to command handler. Supported: `/status` (agent count, client count), `/agents` (list active agents), `/clear` (clear chat DB), `/help` (list commands)**

- [ ] **Step 2: Post user's command as normal message, then post result as system message**

- [ ] **Step 3: Commit** — `"feat: slash commands — /status, /agents, /clear, /help"`

### Task 10: Proactive Messages (Feature 6)

**Files:**
- Modify: `server/index.js` — post chat messages when agents spawn/complete

- [ ] **Step 1: In processEvent agent_spawned case, post `{agent.name}: starting work: {task short}` to chat via addMessage + broadcast**

- [ ] **Step 2: In processEvent agent_completed case, post `{agent.name}: finished: {result short}` to chat**

- [ ] **Step 3: Commit** — `"feat: proactive messages — agents announce start/finish in chat"`

### Task 11: Smart Notifications (Feature 12)

**Files:**
- Create: `scripts/notify.sh` — macOS notification helper using osascript
- Modify: `server/index.js` — trigger notifications for important events

- [ ] **Step 1: Create notify.sh that sends macOS notification via osascript**

- [ ] **Step 2: Server calls notify.sh for: direct mentions containing "Claude" or "@claude", agent failures, slash command results**

- [ ] **Step 3: Notifications fire even when AI toggle is off (they're for important events only)**

- [ ] **Step 4: Commit** — `"feat: smart notifications for important events via macOS"`

---

## Wave 5: UI/UX Design Pass

### Task 12: Frontend Design Polish

**Files:**
- Modify: `src/components/SlackChat.tsx` — refined layout for all new features
- Modify: `src/styles/office.css` — polished styles, animations

This task should be handled by the **frontend-developer subagent** with full creative freedom, implementing:

- [ ] Typing indicator with smooth bouncing dots animation
- [ ] Reaction pills below messages — clickable, with pop animation
- [ ] Read receipt as tiny Claude avatar aligned right (like iMessage blue dots)
- [ ] System messages (slash command output) in distinct muted card style
- [ ] Slash command autocomplete hint when input starts with "/"
- [ ] Agent-specific message colors matching their office character
- [ ] Proactive messages with subtle slide-in entrance animation
- [ ] Smooth auto-scroll to bottom on new messages
- [ ] All animations respect the existing pixel art dark theme

- [ ] **Commit** — `"feat: UI/UX polish pass for all chat features"`

---

## Execution Order

| Wave | Tasks | Features | Dependencies |
|------|-------|----------|-------------|
| 1 | 1, 2 | Persistence, Personality | None |
| 2 | 3, 4, 5, 6 | Typing, Reactions, Seen, Memory | Wave 1 |
| 3 | 7, 8 | Context-Aware, Multi-Agent | Wave 2 |
| 4 | 9, 10, 11 | Commands, Proactive, Notifications | Wave 1 |
| 5 | 12 | UI/UX polish | All waves |

**Parallel opportunities:** Waves 3 and 4 are independent — can run simultaneously with subagents.
