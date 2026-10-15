/**
 * meterEstimate.js — the MEMORY meter for a session that sends no status line.
 *
 * The meters are fed by hooks/status-line.sh, and two common setups never run
 * it: the plugin install (a plugin may register `subagentStatusLine` but not
 * `statusLine`) and headless `claude -p`, which renders no status line at all.
 * Both still send every hook event, and every hook event names the session's
 * transcript. The last assistant message in it says how full the context
 * window is:
 *
 *   tokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens
 *
 * (captured 2.1.300: 2 + 1592 + 42400 + 57 = 44051, the same number Claude
 * Code put in that session's compact_boundary preTokens and in the
 * SessionStart{resume} hook's context_tokens). The window it is a share of
 * comes from the model, see contextWindow() below.
 *
 * Only MEMORY is estimated. PAYROLL and ELECTRICITY stay status-line only:
 * the transcript carries no cost and no rate limits, and pricing tokens from a
 * table or inventing limits would put numbers on the wall that Claude Code
 * never reported. The page says "needs the status line" for those instead.
 *
 * The status line always wins: server/status.js applies an estimate only to a
 * session the status line has never reported for, and a report stops the
 * estimate for that session for good. An estimate is numbers and a model id —
 * no text from the conversation — so it travels on the open GET /status and
 * the WS broadcast like the status-line numbers do.
 *
 * Cost of a refresh: one tail read (TAIL_BYTES, once more with
 * WIDE_TAIL_BYTES when the last reply is further back) through fs/promises,
 * at most once per ESTIMATE_THROTTLE_MS per session, never on the /event
 * request path: note() only queues the read on a microtask, and a hook burst
 * inside the throttle window collapses into one trailing read at its end (so
 * the reply a turn's last event follows is never missed).
 */

import { open } from 'fs/promises'
import { TAIL_BYTES, isTranscriptPath, usageTokens } from './transcript.js'

export const ESTIMATE_THROTTLE_MS = 5_000
export const DEFAULT_WINDOW = 200_000
export const EXTENDED_WINDOW = 1_000_000
// A last reply further back than TAIL_BYTES: the system prompt snapshot
// Claude Code attaches between turns alone is ~130 KB in a small session
export const WIDE_TAIL_BYTES = 4 * TAIL_BYTES
// Sessions tracked at once; the least recently read is dropped past this
const MAX_TRACKED = 256

/**
 * Context window per model, from Claude Code 2.1.300's own model table (the
 * `context: { window, native_1m }` entry of each model id, read from the CLI
 * bundle on 2026-10-14). The CLI's rule for the status line's
 * context_window_size is: a `[1m]` tag on the model → 1,000,000; a model whose
 * table entry is native_1m → 1,000,000; anything else → 200,000.
 * claude-haiku-5-5 is also confirmed live: the `claude -p` result's
 * modelUsage["claude-haiku-5-5"].contextWindow was 1000000 in every captured
 * run, and so was the status line's context_window_size.
 *
 * Keys are canonical ids (see canonicalModel): dated, Bedrock and Vertex
 * spellings fold onto them. A model not in the table gets DEFAULT_WINDOW and
 * the meter is marked approximate.
 */
export const MODEL_WINDOWS = Object.freeze({
  // native 1M context
  'claude-haiku-5-5':      { window: EXTENDED_WINDOW, name: 'Haiku 5.5' },
  'claude-sonnet-5':       { window: EXTENDED_WINDOW, name: 'Sonnet 5' },
  'claude-sonnet-5-5':     { window: EXTENDED_WINDOW, name: 'Sonnet 5.5' },
  'claude-opus-4-7':       { window: EXTENDED_WINDOW, name: 'Opus 4.7' },
  'claude-opus-4-8':       { window: EXTENDED_WINDOW, name: 'Opus 4.8' },
  'claude-opus-5':         { window: EXTENDED_WINDOW, name: 'Opus 5' },
  'claude-opus-5-5':       { window: EXTENDED_WINDOW, name: 'Opus 5.5' },
  'claude-fable-5':        { window: EXTENDED_WINDOW, name: 'Fable 5' },
  'claude-fable-5-1':      { window: EXTENDED_WINDOW, name: 'Fable 5.1' },
  'claude-mythos-5':       { window: EXTENDED_WINDOW, name: 'Mythos 5' },
  'claude-mythos-5-1':     { window: EXTENDED_WINDOW, name: 'Mythos 5.1' },
  'claude-mythos-preview': { window: EXTENDED_WINDOW, name: 'Mythos Preview' },
  // 200k, unless the session runs the [1m] variant
  'claude-3-5-haiku':      { window: DEFAULT_WINDOW, name: 'Haiku 3.5' },
  'claude-haiku-4-5':      { window: DEFAULT_WINDOW, name: 'Haiku 4.5' },
  'claude-3-5-sonnet':     { window: DEFAULT_WINDOW, name: 'Sonnet 3.5' },
  'claude-3-7-sonnet':     { window: DEFAULT_WINDOW, name: 'Sonnet 3.7' },
  'claude-sonnet-4':       { window: DEFAULT_WINDOW, name: 'Sonnet 4' },
  'claude-sonnet-4-0':     { window: DEFAULT_WINDOW, name: 'Sonnet 4' },
  'claude-sonnet-4-5':     { window: DEFAULT_WINDOW, name: 'Sonnet 4.5' },
  'claude-sonnet-4-6':     { window: DEFAULT_WINDOW, name: 'Sonnet 4.6' },
  'claude-opus-4':         { window: DEFAULT_WINDOW, name: 'Opus 4' },
  'claude-opus-4-0':       { window: DEFAULT_WINDOW, name: 'Opus 4' },
  'claude-opus-4-1':       { window: DEFAULT_WINDOW, name: 'Opus 4.1' },
  'claude-opus-4-5':       { window: DEFAULT_WINDOW, name: 'Opus 4.5' },
  'claude-opus-4-6':       { window: DEFAULT_WINDOW, name: 'Opus 4.6' },
})

const ONE_M_TAG = /\[1m\]/i
const MAX_MODEL_LEN = 80

/**
 * The table key for a model id: lower case, no [1m] tag, no provider prefix
 * (us.anthropic.…, anthropic.…), no Vertex @date, no Bedrock -v1:0, no
 * -YYYYMMDD or -latest suffix. '' for anything that is not a string.
 */
export function canonicalModel(id) {
  if (typeof id !== 'string') return ''
  let m = id.trim().toLowerCase().replace(/\[1m\]/g, '')
  const at = m.indexOf('claude-')
  if (at > 0) m = m.slice(at)
  return m.replace(/@.*$/, '').replace(/-v\d+(:\d+)?$/, '').replace(/-(\d{8}|latest)$/, '')
}

/**
 * The context window for the model ids a transcript record names
 * (`requestedModel` keeps a [1m] tag, `message.model` is the API id), and how
 * it was decided:
 *   basis '1m-tag'   a [1m] tag on either id                → 1,000,000
 *   basis 'model'    the model is in MODEL_WINDOWS          → its window
 *   basis 'unknown'  neither                                → 200,000, approximate
 *   basis 'overflow' more tokens than the window above holds → 1,000,000, approximate
 *                    (the session must run the 1M variant without saying so)
 */
export function contextWindow(models, tokens = 0) {
  const ids = (Array.isArray(models) ? models : [models]).filter(id => typeof id === 'string' && id)
  let result
  if (ids.some(id => ONE_M_TAG.test(id))) {
    result = { size: EXTENDED_WINDOW, basis: '1m-tag', approximate: false }
  } else {
    const known = ids.map(id => MODEL_WINDOWS[canonicalModel(id)]).find(Boolean)
    result = known
      ? { size: known.window, basis: 'model', approximate: false }
      : { size: DEFAULT_WINDOW, basis: 'unknown', approximate: true }
  }
  if (typeof tokens === 'number' && tokens > result.size && result.size < EXTENDED_WINDOW) {
    return { size: EXTENDED_WINDOW, basis: 'overflow', approximate: true }
  }
  return result
}

/** Display name for a model id ('Haiku 5.5'), or undefined when the table does not know it. */
export function modelName(id) {
  return MODEL_WINDOWS[canonicalModel(id)]?.name
}

function modelId(val) {
  return typeof val === 'string' && val ? val.slice(0, MAX_MODEL_LEN) : undefined
}

const ASSISTANT = /"type"\s*:\s*"assistant"/
const COMPACT = /"subtype"\s*:\s*"compact_boundary"/

/**
 * What the end of a transcript says about the context window, reading from
 * the last line back:
 *   { tokens, input, output, model?, requestedModel? }  the last main-thread
 *       assistant record with a usage (input = input + both cache counts)
 *   { compacted: true }  a compact_boundary came after it: the window was just
 *       emptied and the next reply, which will say how full it is, is not in yet
 *   null  neither in this text
 * Claude Code writes one record per content block with the whole message's
 * usage on each, so the last record is the last message. Sidechain records
 * and `<synthetic>` ones (an API error or an interrupt, all-zero usage) are
 * skipped. Only lines that can be one of the two records are parsed. Pure.
 */
export function lastUsage(text) {
  const lines = String(text ?? '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const assistant = ASSISTANT.test(line)
    if (!assistant && !COMPACT.test(line)) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (!record || typeof record !== 'object' || record.isSidechain === true) continue
    if (record.type === 'system' && record.subtype === 'compact_boundary') return { compacted: true }
    if (record.type !== 'assistant') continue
    const message = record.message
    if (!message || typeof message !== 'object' || message.model === '<synthetic>') continue
    const tokens = usageTokens(message.usage)
    if (tokens === null) continue
    const count = key => {
      const n = message.usage[key]
      return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0
    }
    const reading = {
      tokens,
      input: count('input_tokens') + count('cache_creation_input_tokens') + count('cache_read_input_tokens'),
      output: count('output_tokens'),
    }
    const model = modelId(message.model)
    const requested = modelId(record.requestedModel)
    if (model) reading.model = model
    if (requested) reading.requestedModel = requested
    return reading
  }
  return null
}

/**
 * The reading at the end of a transcript file (see lastUsage), or null when
 * the path is not a transcript, the file cannot be read or its tail holds no
 * usage. Reads TAIL_BYTES; when that finds nothing and the file is bigger,
 * WIDE_TAIL_BYTES once. Never throws.
 */
export async function readTranscriptUsage(path) {
  if (!isTranscriptPath(path)) return null
  let handle = null
  try {
    handle = await open(path, 'r')
    const { size } = await handle.stat()
    for (const maxBytes of [TAIL_BYTES, WIDE_TAIL_BYTES]) {
      const start = Math.max(0, size - maxBytes)
      const length = size - start
      if (length <= 0) return null
      const buf = Buffer.alloc(length)
      let read = 0
      while (read < length) {
        const { bytesRead } = await handle.read(buf, read, length - read, start + read)
        if (bytesRead <= 0) break
        read += bytesRead
      }
      let text = buf.subarray(0, read).toString('utf8')
      // Started mid-file: the first line is a fragment
      if (start > 0) {
        const nl = text.indexOf('\n')
        text = nl === -1 ? '' : text.slice(nl + 1)
      }
      const reading = lastUsage(text)
      if (reading || start === 0) return reading
    }
    return null
  } catch {
    return null
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

/**
 * The MEMORY numbers for a reading, in the status record's shape:
 *   { context: { used, size, input, output }, model?, modelId?,
 *     estimate: { tokens, basis, approximate, compacted? } }
 * `used` is a percentage with one decimal. A compacted reading keeps the
 * model and window of `previous` (the session's last estimate) with nothing
 * in use known; with no previous estimate there is nothing to show (null).
 */
export function estimateMemory(reading, previous = null) {
  if (!reading || typeof reading !== 'object') return null
  if (reading.compacted) {
    if (!previous) return null
    return {
      context: { used: null, size: previous.context.size, input: 0, output: 0 },
      model: previous.model,
      modelId: previous.modelId,
      estimate: { tokens: null, basis: previous.estimate.basis, approximate: previous.estimate.approximate, compacted: true },
    }
  }
  if (typeof reading.tokens !== 'number' || !Number.isFinite(reading.tokens) || reading.tokens < 0) return null
  const window = contextWindow([reading.requestedModel, reading.model], reading.tokens)
  const id = reading.model ?? (reading.requestedModel ? canonicalModel(reading.requestedModel) : undefined)
  return {
    context: {
      used: Math.min(100, Math.round((reading.tokens / window.size) * 1000) / 10),
      size: window.size,
      input: reading.input ?? 0,
      output: reading.output ?? 0,
    },
    model: modelName(id) ?? id,
    modelId: id,
    estimate: { tokens: reading.tokens, basis: window.basis, approximate: window.approximate },
  }
}

/**
 * The scheduler: note(sessionId, transcriptPath) on every hook event, and a
 * session that the status line does not report for gets its transcript read
 * — at most once per `throttleMs`, the last event of a burst answered by one
 * trailing read — and the reading handed to `apply(sessionId, reading)`.
 * `skip(sessionId)` says the status line reports for it (nothing is read);
 * `read` and the clock are injectable for tests. Timers are unref'd.
 */
export function createMeterEstimator({
  apply,
  skip = () => false,
  read = readTranscriptUsage,
  throttleMs = ESTIMATE_THROTTLE_MS,
  now = () => Date.now(),
  maxTracked = MAX_TRACKED,
} = {}) {
  if (typeof apply !== 'function') throw new TypeError('createMeterEstimator needs apply')
  /** @type {Map<string, { path: string|null, lastReadAt: number, timer: any, reading: boolean, again: boolean }>} */
  const tracked = new Map()

  function forget(sessionId) {
    const entry = tracked.get(sessionId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    tracked.delete(sessionId)
  }

  function start(sessionId, entry) {
    entry.timer = null
    entry.reading = true
    entry.lastReadAt = now()
    // Off the caller's stack: POST /event has answered before the file is touched
    queueMicrotask(() => { finish(sessionId, entry) })
  }

  async function finish(sessionId, entry) {
    let reading = null
    try {
      if (!skip(sessionId)) reading = await read(entry.path)
    } catch {
      reading = null
    } finally {
      entry.reading = false
    }
    if (tracked.get(sessionId) !== entry) return
    // The status line may have reported while the file was read: it wins
    if (skip(sessionId)) return forget(sessionId)
    if (reading) {
      try { apply(sessionId, reading) } catch (err) { console.warn(`[status] memory estimate for ${sessionId} failed: ${err?.message ?? err}`) }
    }
    if (entry.again) {
      entry.again = false
      schedule(sessionId, entry)
    }
  }

  function schedule(sessionId, entry) {
    if (entry.timer) return
    // A hook during the read: one more read once the throttle allows
    if (entry.reading) { entry.again = true; return }
    const wait = entry.lastReadAt + throttleMs - now()
    if (wait <= 0) return start(sessionId, entry)
    entry.timer = setTimeout(() => start(sessionId, entry), wait)
    entry.timer.unref?.()
  }

  function note(sessionId, transcriptPath) {
    if (typeof sessionId !== 'string' || !sessionId) return
    if (skip(sessionId)) return forget(sessionId)
    let entry = tracked.get(sessionId)
    if (!entry) {
      if (!isTranscriptPath(transcriptPath)) return
      if (tracked.size >= maxTracked) {
        // Drop the session read longest ago that is not mid-read
        let oldest = null
        for (const [id, e] of tracked) if (!e.reading && (!oldest || e.lastReadAt < oldest[1].lastReadAt)) oldest = [id, e]
        if (oldest) forget(oldest[0])
      }
      entry = { path: null, lastReadAt: -Infinity, timer: null, reading: false, again: false }
      tracked.set(sessionId, entry)
    }
    if (isTranscriptPath(transcriptPath)) entry.path = transcriptPath
    if (entry.path) schedule(sessionId, entry)
  }

  /** Forget sessions not read since `before` (the stale sweep). */
  function prune(before) {
    for (const [id, e] of tracked) if (!e.reading && !e.timer && e.lastReadAt < before) forget(id)
  }

  return { note, forget, prune, has: id => tracked.has(id), get size() { return tracked.size } }
}
