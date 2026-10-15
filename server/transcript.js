/**
 * Transcript tail — the last few things an agent said and the tools it
 * called, read from its own Claude Code transcript (JSONL).
 *
 * Where the files are (observed with Claude Code 2.1.300):
 *   ~/.claude/projects/<proj>/<session_id>.jsonl                          the session
 *   ~/.claude/projects/<proj>/<session_id>/subagents/agent-<agent_id>.jsonl   each worker
 * So a worker's file follows from the session transcript (on every hook
 * event) and the Claude agent_id the hook forwards; SubagentStop also names
 * it outright (agent_transcript_path).
 *
 * Record shapes that matter here: `assistant` records carry
 * message{id, content[]}, and Claude Code writes ONE RECORD PER CONTENT BLOCK
 * — a reply with thinking + text + tool_use is three lines sharing message.id
 * — so blocks are folded back into one entry per message. Thinking blocks are
 * never read (they are empty on disk anyway and are not what the agent said).
 * Everything else in the file (user turns, tool results, attachments, system
 * rows, cost-state) is skipped.
 *
 * Only the end of the file is read: a session transcript is hundreds of KB
 * (the system prompt is attached to it several times) and GET /agents/:id is
 * polled every two seconds while a card is open. Defensive throughout: a
 * missing file, a half-written last line or junk between the lines all give
 * fewer entries, never an error.
 */

import { openSync, fstatSync, readSync, closeSync } from 'fs'
import { dirname, join, isAbsolute } from 'path'

export const TAIL_BYTES = 256 * 1024
export const DEFAULT_MAX_ENTRIES = 8
export const DEFAULT_MAX_CHARS = 200
const INPUT_MAX_CHARS = 120

/**
 * The transcript of a worker: `<dir of the session transcript>/<sessionId>/subagents/agent-<claudeAgentId>.jsonl`.
 * null when any part is missing or the ids are not plain identifiers (a hook
 * payload is data; an id with a slash in it must not pick a path).
 */
export function agentTranscriptPath(sessionTranscriptPath, sessionId, claudeAgentId) {
  if (typeof sessionTranscriptPath !== 'string' || !sessionTranscriptPath.endsWith('.jsonl')) return null
  if (!plainId(sessionId) || !plainId(claudeAgentId)) return null
  return join(dirname(sessionTranscriptPath), sessionId, 'subagents', `agent-${claudeAgentId}.jsonl`)
}

function plainId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id)
}

/**
 * A path the server is willing to open: absolute, a .jsonl file, no `..`
 * segment. The paths come from the hook (token-authenticated) but the tail
 * is served openly on loopback, so a transcript path is the only kind of
 * file this reads — and parse() only ever returns assistant text and tool
 * names, so any other JSONL yields nothing.
 */
export function isTranscriptPath(path) {
  return typeof path === 'string' && isAbsolute(path) && path.endsWith('.jsonl') && !path.split(/[\\/]/).includes('..')
}

/** One line for a card: whitespace collapsed, clamped with an ellipsis. */
export function clampLine(text, max) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, Math.max(0, max - 1))}…` : line
}

/** What a tool call was about, in a few words: the file, the command, the pattern. */
export function summariseInput(name, input) {
  if (!input || typeof input !== 'object') return ''
  const str = v => (typeof v === 'string' ? v : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
  switch (name) {
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return str(input.file_path || input.notebook_path)
    case 'Bash':
      return str(input.command || input.description)
    case 'Grep': case 'Glob':
      return str(input.pattern)
    case 'Agent': case 'Task':
      return str(input.description || input.prompt)
    case 'WebFetch': case 'WebSearch':
      return str(input.url || input.query)
    case 'Skill':
      return str(input.skill)
    default: {
      const first = Object.values(input).find(v => typeof v === 'string' && v.trim())
      return first ?? (Object.keys(input).length ? JSON.stringify(input) : '')
    }
  }
}

function parseTimestamp(record) {
  const t = record.timestamp
  if (typeof t === 'number') return t
  if (typeof t === 'string') {
    const ms = Date.parse(t)
    if (!Number.isNaN(ms)) return ms
  }
  return null
}

/**
 * What one assistant record's usage adds up to. Claude Code's own
 * `totalTokens` on an Agent result is this sum for the agent's final message
 * (captured 2.1.300: 2 + 1497 + 19054 + 123 = 20676 = totalTokens), so the
 * last record of a worker's transcript gives a background agent the same
 * number its SubagentStop never carries. null when there is no usage.
 */
export function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return null
  const keys = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']
  let sum = 0
  let seen = false
  for (const key of keys) {
    const n = usage[key]
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) { sum += n; seen = true }
  }
  return seen ? sum : null
}

/**
 * JSONL text -> { entries, usage }: the last `maxEntries` entries, oldest first,
 *   { at, kind: 'said', text }
 *   { at, kind: 'tool', tool, tools, input, text? }   text when the same message also spoke
 * and the usage of the last assistant record that has one, { tokens, model }
 * (see usageTokens), or null. Blocks of one message (same message.id) fold
 * into one entry; a message with any tool_use is a 'tool' entry. `text` is
 * clamped to maxChars, the input summary to 120. Pure: tests feed it strings.
 */
export function scanTranscript(text, { maxEntries = DEFAULT_MAX_ENTRIES, maxChars = DEFAULT_MAX_CHARS } = {}) {
  const byMessage = new Map()
  const order = []
  let usage = null
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (!record || typeof record !== 'object' || record.type !== 'assistant') continue
    const message = record.message
    if (!message || typeof message !== 'object') continue
    const tokens = usageTokens(message.usage)
    if (tokens !== null) usage = { tokens, ...(typeof message.model === 'string' && message.model ? { model: message.model.slice(0, 80) } : {}) }
    if (!Array.isArray(message.content)) continue
    const key = typeof message.id === 'string' && message.id ? message.id : (record.uuid ?? `line-${order.length}`)
    let entry = byMessage.get(key)
    if (!entry) {
      entry = { at: parseTimestamp(record), texts: [], tools: [], inputs: [] }
      byMessage.set(key, entry)
      order.push(entry)
    }
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) entry.texts.push(block.text)
      else if (block.type === 'tool_use' && typeof block.name === 'string') {
        entry.tools.push(block.name)
        entry.inputs.push(summariseInput(block.name, block.input))
      }
    }
  }
  const entries = []
  for (const e of order) {
    if (e.tools.length) {
      const entry = { at: e.at, kind: 'tool', tool: e.tools[0], tools: e.tools, input: clampLine(e.inputs[0], INPUT_MAX_CHARS) }
      if (e.texts.length) entry.text = clampLine(e.texts.join(' '), maxChars)
      entries.push(entry)
    } else if (e.texts.length) {
      entries.push({ at: e.at, kind: 'said', text: clampLine(e.texts.join(' '), maxChars) })
    }
  }
  return { entries: entries.slice(-maxEntries), usage }
}

/** The entries alone (see scanTranscript). */
export function parseTranscript(text, opts = {}) {
  return scanTranscript(text, opts).entries
}

/**
 * The last `maxBytes` of a file as text, or null when it cannot be read.
 * When the read starts mid-file the first (partial) line is dropped.
 */
export function readTail(path, maxBytes = TAIL_BYTES) {
  if (!isTranscriptPath(path)) return null
  let fd = null
  try {
    fd = openSync(path, 'r')
    const { size } = fstatSync(fd)
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    if (length <= 0) return ''
    const buf = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read)
      if (n <= 0) break
      read += n
    }
    let text = buf.subarray(0, read).toString('utf8')
    if (start > 0) {
      const nl = text.indexOf('\n')
      text = nl === -1 ? '' : text.slice(nl + 1)
    }
    return text
  } catch {
    return null
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch {} }
  }
}

/** The end of a transcript file scanned once: { entries, usage } (see scanTranscript); empty on any error. */
export function readTranscript(path, { maxEntries = DEFAULT_MAX_ENTRIES, maxChars = DEFAULT_MAX_CHARS, maxBytes = TAIL_BYTES } = {}) {
  const text = readTail(path, maxBytes)
  if (text === null) return { entries: [], usage: null }
  try {
    return scanTranscript(text, { maxEntries, maxChars })
  } catch {
    return { entries: [], usage: null }
  }
}

/** The last entries of a transcript file (see parseTranscript); [] on any error. */
export function tailTranscript(path, opts = {}) {
  return readTranscript(path, opts).entries
}
