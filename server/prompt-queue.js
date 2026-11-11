/**
 * prompt-queue.js - Prompts typed in the office chat for one Claude Code session, waiting for that session's next Stop hook.
 *
 * The flow (docs/reference.md › Prompts from the chat):
 *
 *   1. On the office page on this Mac, `@agent-office fix the failing test`
 *      in the chat. POST /chat (server/index.js) resolves the mention to one
 *      live session (resolveMention below), checks the caller may queue (the
 *      UI token or the office token, never the phone, a proxied page or a
 *      read-only one) and adds the text here.
 *   2. While a session has anything queued, an empty marker file
 *      `<runtime dir>/prompt-queue/<session id>` exists. The hook checks for
 *      it on Stop (a stat, so a session with nothing queued pays nothing): when
 *      it is there, the hook POSTs its session_turn_end in the foreground with
 *      `claim: true` and a fresh nonce instead of in the background.
 *   3. The server claims the oldest prompt (claim below: removed from the
 *      queue as it is handed out, so it is delivered once) and answers with
 *      its text and proof = HMAC(token, "office-prompt\n" nonce \n id \n text).
 *      The hook checks the proof, then prints `{"decision": "block",
 *      "reason": ...}`, and Claude Code carries on with the prompt as its
 *      next instruction instead of stopping.
 *
 * In memory, by design. A queued prompt is an instruction to run code in a
 * session; one that outlived a server restart could fire hours later into a
 * conversation that has moved on. So the queue dies with the process, a
 * prompt expires after PROMPT_TTL_MS undelivered, a session's prompts go when
 * the session ends, and the markers are cleared on start and on stop
 * (clearMarkers), so a stale marker can only ever cost one foreground POST
 * that comes back empty.
 *
 * The limitation: a session sitting idle at its prompt runs no hook, so its
 * queued prompt waits until its next turn ends (someone types in that
 * terminal). Nothing in Claude Code's hook contract starts a turn from the
 * outside with a user prompt.
 */

import { mkdirSync, writeFileSync, unlinkSync, readdirSync, chmodSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'

// Why 5: each delivery is one Stop-hook continuation, and Claude Code ends a
// turn anyway after 8 continuations in a row (docs: hooks › Stop). A full
// queue drains inside that cap, so the office never runs into it, and five
// unrun instructions is already more than anyone tracks by eye.
export const MAX_QUEUED_PER_SESSION = 5
// Why 2000: the chat line clamp (POST /chat) and the hook's own text clamp
export const MAX_PROMPT_LEN = 2000
// Why an hour: long enough to cover a long turn; past that the prompt was
// most likely written for a state of the session that no longer holds
export const PROMPT_TTL_MS = 60 * 60_000
/** The marker directory's name inside the runtime dir. */
export const MARKER_DIR_NAME = 'prompt-queue'
// A session id becomes a file name: only the shape Claude Code uses (a UUID),
// never a path separator or a dot. The hook checks the same pattern.
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/

/**
 * A per-session queue of chat prompts, with the marker files the hook checks.
 * @param {{ dir: string, now?: () => number, ttlMs?: number, maxPerSession?: number,
 *           onExpire?: (sessionId: string, item: object) => void }} opts
 *   dir: the marker directory (created 0700 on first use); onExpire: told about
 *   every prompt that expired undelivered
 * @returns {{ add: Function, claim: Function, list: Function, drop: Function, prune: Function, clearMarkers: Function }}
 */
export function createPromptQueue({ dir, now = Date.now, ttlMs = PROMPT_TTL_MS, maxPerSession = MAX_QUEUED_PER_SESSION, onExpire = () => {} }) {
  /** @type {Map<string, Array<{ id: string, text: string, from: string, queuedAt: number }>>} */
  const queues = new Map()
  const markerOf = sessionId => join(dir, sessionId)

  function syncMarker(sessionId) {
    try {
      if (queues.get(sessionId)?.length) {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        try { chmodSync(dir, 0o700) } catch {}
        // Why empty: the hook only asks whether it exists; the text stays in memory
        writeFileSync(markerOf(sessionId), '', { mode: 0o600 })
      } else {
        unlinkSync(markerOf(sessionId))
      }
    } catch {
      // ENOENT on an unlink is the normal case; a failed write means the hook
      // never claims, and the prompt expires like any other
    }
  }

  /** Drop expired prompts (all sessions, or one); returns how many went. */
  function prune(only = null) {
    const t = now()
    let gone = 0
    for (const [sessionId, items] of queues) {
      if (only && sessionId !== only) continue
      const keep = items.filter(item => t - item.queuedAt < ttlMs)
      if (keep.length === items.length) continue
      for (const item of items) if (!keep.includes(item)) { gone++; onExpire(sessionId, item) }
      if (keep.length) queues.set(sessionId, keep)
      else queues.delete(sessionId)
      syncMarker(sessionId)
    }
    return gone
  }

  return {
    /**
     * Queue `text` for a session.
     * @returns {{ ok: true, item: object, position: number } | { ok: false, reason: 'bad-session' | 'empty' | 'too-long' | 'full' }}
     */
    add(sessionId, { text, from = 'office' }) {
      if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return { ok: false, reason: 'bad-session' }
      if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty' }
      if (text.length > MAX_PROMPT_LEN) return { ok: false, reason: 'too-long' }
      prune(sessionId)
      const items = queues.get(sessionId) ?? []
      if (items.length >= maxPerSession) return { ok: false, reason: 'full' }
      const item = { id: randomBytes(8).toString('hex'), text: wellFormed(text), from: String(from).slice(0, 80), queuedAt: now() }
      items.push(item)
      queues.set(sessionId, items)
      syncMarker(sessionId)
      return { ok: true, item, position: items.length }
    },

    /** Take the oldest live prompt for a session (removed as it is handed out), or null. */
    claim(sessionId) {
      prune(sessionId)
      const items = queues.get(sessionId)
      if (!items?.length) return null
      const item = items.shift()
      if (!items.length) queues.delete(sessionId)
      syncMarker(sessionId)
      return item
    },

    /** The prompts waiting for a session, oldest first (copies). */
    list(sessionId) {
      prune(sessionId)
      return (queues.get(sessionId) ?? []).map(item => ({ ...item }))
    },

    /** Forget every prompt of a session (it ended); returns how many went. */
    drop(sessionId) {
      const n = queues.get(sessionId)?.length ?? 0
      queues.delete(sessionId)
      syncMarker(sessionId)
      return n
    },

    prune: () => prune(),

    /**
     * Remove every marker file, the ones another run left behind included:
     * the queue lives in memory, so a marker without this process behind it
     * means nothing. Called on start and on stop.
     */
    clearMarkers() {
      let names = []
      try { names = readdirSync(dir) } catch { return }
      for (const name of names) {
        if (!SESSION_ID_PATTERN.test(name)) continue
        try { unlinkSync(join(dir, name)) } catch {}
      }
    },
  }
}

/**
 * Lone UTF-16 surrogates replaced by U+FFFD. The proof is an HMAC over the
 * text's UTF-8 bytes: Node encodes a lone surrogate as U+FFFD, Python cannot
 * encode it at all, so the two sides would never agree on such a text.
 * @param {string} text
 * @returns {string}
 */
export function wellFormed(text) {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
}

// ---------------------------------------------------------------------------
// @-mentions: which session a chat line names
// ---------------------------------------------------------------------------

/** A name as a mention spells it: trimmed, lower case, whitespace as '-'. */
export function mentionSlug(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '-')
}

/**
 * The name the chat's @-autocomplete offers for a session: Claude Code's own
 * session name (`claude-office-75`, or what /rename set) when the registry
 * has one, else the session title, the project, or the start of the id.
 * @param {{ id: string, registry?: { name?: string }, title?: string, project?: string }} session
 * @returns {string}
 */
export function mentionName(session) {
  return mentionSlug(session.registry?.name || session.title || session.project || String(session.id ?? '').slice(0, 8))
}

// Why 120: past any session name; the rest of the line is the prompt
const MENTION_RE = /^@([^\s@]{1,120}?)[:,]?\s+(\S[\s\S]*)$/

/**
 * A chat line that starts with an @-mention: `{ name, body }` (name as a
 * slug, body trimmed), else null. `@agent-office: fix it` works too.
 * @param {string} text
 * @returns {{ name: string, body: string } | null}
 */
export function parseMention(text) {
  if (typeof text !== 'string') return null
  const m = MENTION_RE.exec(text.trim())
  if (!m) return null
  const body = m[2].trim()
  return body ? { name: mentionSlug(m[1]), body } : null
}

// Why 6: a shorter id prefix is too easy to hit by accident
const MIN_ID_PREFIX = 6

/**
 * The live session a mention names. Tried in order, the first tier that
 * matches anything wins: Claude Code's session name or the session title,
 * then the project, then a prefix of the session id (6+ characters). One
 * match is the session; more than one in a tier is ambiguous (the caller
 * lists them); none in any tier is not a session mention at all (the line is
 * an ordinary chat line, `@claude` for the chat bot included).
 * @param {Iterable<object>} sessions the server's session records
 * @param {string} name a slug from parseMention
 * @returns {{ session: object } | { ambiguous: object[] } | null}
 */
export function resolveMention(sessions, name) {
  const live = Array.from(sessions).filter(s => s && s.state !== 'ended')
  const tiers = [
    s => mentionSlug(s.registry?.name) === name || mentionSlug(s.title) === name,
    s => mentionSlug(s.project) === name,
    s => name.length >= MIN_ID_PREFIX && String(s.id ?? '').toLowerCase().startsWith(name),
  ]
  for (const test of tiers) {
    const hits = live.filter(test)
    if (hits.length === 1) return { session: hits[0] }
    if (hits.length > 1) return { ambiguous: hits }
  }
  return null
}
