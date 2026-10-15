/**
 * The MEMORY meter for a session without the status line (plugin install,
 * `claude -p`): server/meterEstimate.js reads the last reply's usage from the
 * session transcript, server/status.js keeps it as `source: 'transcript'`
 * until the status line reports, and src/meters.ts draws the "est." marker
 * and the "needs the status line" tooltips.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { loadOffice, postAuthed, postEvent, removeOffice, type Office } from './helpers'
import {
  DEFAULT_WINDOW, ESTIMATE_THROTTLE_MS, EXTENDED_WINDOW, MODEL_WINDOWS, WIDE_TAIL_BYTES,
  canonicalModel, contextWindow, createMeterEstimator, estimateMemory, lastUsage, modelName, readTranscriptUsage,
} from '../server/meterEstimate.js'
import { createStatusStore } from '../server/status.js'
import { TAIL_BYTES } from '../server/transcript.js'
import {
  STATUS_LINE_INSTALL, estimateMarker, estimateTip, formatMemory, isEstimated, needsStatusLineTip,
  type SessionStatus,
} from '../src/meters'

const SID = '8cf68f64-5433-40f7-a130-557fc7f67e42'
const AT = '2026-10-14T19:05:33.347Z'

/** The last reply's usage in the captured 2.1.300 session: 2 + 1592 + 42400 + 57 = 44051 */
const USAGE = { input_tokens: 2, cache_creation_input_tokens: 1592, cache_read_input_tokens: 42400, output_tokens: 57 }

/** One assistant record per content block, the whole message's usage on each (REPORT.md section 2). */
function assistant(id: string, block: object, usage: object, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'assistant', uuid: `u-${id}-${Math.random()}`, timestamp: AT, sessionId: SID, isSidechain: false,
    requestId: `req_${id}`, requestedModel: 'claude-haiku-5-5', version: '2.1.300',
    message: { model: 'claude-haiku-5-5', id, role: 'assistant', content: [block], stop_reason: 'end_turn', usage: { ...usage, service_tier: 'standard' } },
    ...extra,
  })
}

/**
 * A transcript in the shape Claude Code writes: a user turn, a tool-using
 * reply (thinking + tool_use, two records sharing message.id), its tool
 * result, the final reply (thinking + text, two records sharing message.id),
 * then the bookkeeping rows that follow every turn.
 */
function fixtureTranscript(finalUsage: object = USAGE): string {
  const first = { input_tokens: 2, cache_creation_input_tokens: 14539, cache_read_input_tokens: 27861, output_tokens: 358 }
  return [
    JSON.stringify({ type: 'user', timestamp: AT, sessionId: SID, message: { role: 'user', content: 'Read package.json and summarise it in one line' } }),
    JSON.stringify({ type: 'attachment', sessionId: SID, attachment: { type: 'model', identity: { modelId: 'claude-haiku-5-5' } } }),
    assistant('msg_011Cg2ekY78FXwvtNnbAKYmF', { type: 'thinking', thinking: '', signature: 'x' }, first),
    assistant('msg_011Cg2ekY78FXwvtNnbAKYmF', { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x/package.json' } }, first),
    JSON.stringify({ type: 'user', timestamp: AT, sessionId: SID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"name":"agent-office"}' }] } }),
    assistant('msg_011Cg2en3KZ9WKEUJ42CX4sU', { type: 'thinking', thinking: '', signature: 'y' }, finalUsage),
    assistant('msg_011Cg2en3KZ9WKEUJ42CX4sU', { type: 'text', text: 'agent-office: a pixel-art office for Claude Code sessions.' }, finalUsage),
    JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', hookCount: 1, sessionId: SID }),
    JSON.stringify({ type: 'cost-state', sessionId: SID, totalCostUSD: 0.014, modelUsage: { 'claude-haiku-5-5': { inputTokens: 4 } } }),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'Read package.json', sessionId: SID }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Summarise package.json', sessionId: SID }),
  ].join('\n') + '\n'
}

describe('lastUsage: the context reading at the end of a transcript', () => {
  it('takes the last main-thread reply (blocks share message.id and usage) as the four counts summed', () => {
    expect(lastUsage(fixtureTranscript())).toEqual({
      tokens: 44051, input: 43994, output: 57, model: 'claude-haiku-5-5', requestedModel: 'claude-haiku-5-5',
    })
  })

  it('skips sidechain and <synthetic> records, junk and half-written lines', () => {
    const text = fixtureTranscript() + [
      assistant('msg_side', { type: 'text', text: 'worker' }, { input_tokens: 9, output_tokens: 9 }, { isSidechain: true }),
      JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', id: 'msg_err', content: [{ type: 'text', text: 'API Error' }], usage: { input_tokens: 0, output_tokens: 0 } } }),
      'not json at all',
      '{"type":"assistant","message":{"usage":{"input_tok',
    ].join('\n')
    expect(lastUsage(text)?.tokens).toBe(44051)
  })

  it('a compact_boundary after the last reply means the window was just emptied', () => {
    const text = fixtureTranscript() + JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 44051 } }) + '\n'
    expect(lastUsage(text)).toEqual({ compacted: true })
    // ...and the next reply refills it
    const after = text + assistant('msg_next', { type: 'text', text: 'ok' }, { input_tokens: 3, cache_read_input_tokens: 9000, output_tokens: 20 }) + '\n'
    expect(lastUsage(after)).toMatchObject({ tokens: 9023, input: 9003, output: 20 })
  })

  it('null when there is no reply with a usage yet', () => {
    expect(lastUsage('')).toBeNull()
    expect(lastUsage(null as unknown as string)).toBeNull()
    expect(lastUsage(JSON.stringify({ type: 'user', message: { content: 'hi' } }))).toBeNull()
    expect(lastUsage(JSON.stringify({ type: 'assistant', message: { id: 'm', content: [] } }))).toBeNull()
  })
})

describe('the context window table', () => {
  it('200k models, 1M models, the [1m] tag', () => {
    expect(contextWindow('claude-sonnet-4-6')).toEqual({ size: DEFAULT_WINDOW, basis: 'model', approximate: false })
    expect(contextWindow('claude-opus-4-5')).toEqual({ size: 200_000, basis: 'model', approximate: false })
    expect(contextWindow('claude-haiku-4-5')).toEqual({ size: 200_000, basis: 'model', approximate: false })
    expect(contextWindow('claude-haiku-5-5')).toEqual({ size: EXTENDED_WINDOW, basis: 'model', approximate: false })
    expect(contextWindow('claude-opus-5-5')).toEqual({ size: 1_000_000, basis: 'model', approximate: false })
    expect(contextWindow('claude-sonnet-5')).toEqual({ size: 1_000_000, basis: 'model', approximate: false })
    // requestedModel keeps the tag the API id drops
    expect(contextWindow(['claude-sonnet-4-6[1m]', 'claude-sonnet-4-6'])).toEqual({ size: 1_000_000, basis: '1m-tag', approximate: false })
    expect(contextWindow('opus[1m]')).toEqual({ size: 1_000_000, basis: '1m-tag', approximate: false })
  })

  it('an unknown model falls back to 200k, marked approximate', () => {
    expect(contextWindow('claude-sonnet-9-9')).toEqual({ size: 200_000, basis: 'unknown', approximate: true })
    expect(contextWindow(undefined)).toEqual({ size: 200_000, basis: 'unknown', approximate: true })
    expect(contextWindow([])).toEqual({ size: 200_000, basis: 'unknown', approximate: true })
  })

  it('more tokens than 200k can only mean the 1M variant (approximate)', () => {
    expect(contextWindow('claude-sonnet-4-6', 250_000)).toEqual({ size: 1_000_000, basis: 'overflow', approximate: true })
    expect(contextWindow('mystery-model', 250_000)).toEqual({ size: 1_000_000, basis: 'overflow', approximate: true })
    expect(contextWindow('claude-haiku-5-5', 250_000)).toEqual({ size: 1_000_000, basis: 'model', approximate: false })
  })

  it('dated, Bedrock and Vertex spellings fold onto the table key', () => {
    expect(canonicalModel('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5')
    expect(canonicalModel('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('claude-sonnet-4-5')
    expect(canonicalModel('claude-opus-4-1@20250805')).toBe('claude-opus-4-1')
    expect(canonicalModel('Claude-Sonnet-4-6[1M]')).toBe('claude-sonnet-4-6')
    expect(canonicalModel('claude-3-7-sonnet-latest')).toBe('claude-3-7-sonnet')
    expect(canonicalModel(42)).toBe('')
    expect(contextWindow('us.anthropic.claude-opus-4-8-v1:0').size).toBe(1_000_000)
    expect(modelName('claude-haiku-5-5')).toBe('Haiku 5.5')
    expect(modelName('nope')).toBeUndefined()
  })

  it('every entry is 200k or 1M', () => {
    for (const [id, entry] of Object.entries(MODEL_WINDOWS)) {
      expect([200_000, 1_000_000], id).toContain(entry.window)
      expect(entry.name, id).toBeTruthy()
    }
  })
})

describe('estimateMemory', () => {
  it('percent with one decimal, the window, the model name and how it was decided', () => {
    expect(estimateMemory({ tokens: 44051, input: 43994, output: 57, model: 'claude-haiku-5-5', requestedModel: 'claude-haiku-5-5' })).toEqual({
      context: { used: 4.4, size: 1_000_000, input: 43994, output: 57 },
      model: 'Haiku 5.5',
      modelId: 'claude-haiku-5-5',
      estimate: { tokens: 44051, basis: 'model', approximate: false },
    })
    expect(estimateMemory({ tokens: 150_000, input: 149_000, output: 1000, model: 'claude-sonnet-4-6' })?.context.used).toBe(75)
    expect(estimateMemory({ tokens: 50_000, input: 50_000, output: 0, model: 'some-new-model' })).toMatchObject({
      context: { used: 25, size: 200_000 }, model: 'some-new-model', estimate: { basis: 'unknown', approximate: true },
    })
  })

  it('a compaction keeps the previous model and window with nothing known in use; none before it -> nothing', () => {
    const prev = estimateMemory({ tokens: 44051, input: 43994, output: 57, model: 'claude-haiku-5-5' })
    expect(estimateMemory({ compacted: true }, prev)).toEqual({
      context: { used: null, size: 1_000_000, input: 0, output: 0 },
      model: 'Haiku 5.5',
      modelId: 'claude-haiku-5-5',
      estimate: { tokens: null, basis: 'model', approximate: false, compacted: true },
    })
    expect(estimateMemory({ compacted: true })).toBeNull()
    expect(estimateMemory(null)).toBeNull()
    expect(estimateMemory({ tokens: -1 })).toBeNull()
  })
})

describe('readTranscriptUsage: the file, defensively', () => {
  let dir: string
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'meter-estimate-')) })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('reads the reading from the end of a transcript file', async () => {
    const path = join(dir, `${SID}.jsonl`)
    writeFileSync(path, fixtureTranscript())
    expect(await readTranscriptUsage(path)).toMatchObject({ tokens: 44051, model: 'claude-haiku-5-5' })
  })

  it('a missing, unreadable or non-transcript path gives null, never an error', async () => {
    expect(await readTranscriptUsage(join(dir, 'none.jsonl'))).toBeNull()
    expect(await readTranscriptUsage('relative/path.jsonl')).toBeNull()
    expect(await readTranscriptUsage(join(dir, '..', 'x.jsonl'))).toBeNull()
    expect(await readTranscriptUsage(join(dir, 'notes.txt'))).toBeNull()
    expect(await readTranscriptUsage(undefined as unknown as string)).toBeNull()
    // A directory named like a transcript cannot be read as one
    mkdirSync(join(dir, 'dir.jsonl'))
    expect(await readTranscriptUsage(join(dir, 'dir.jsonl'))).toBeNull()
    const empty = join(dir, 'empty.jsonl')
    writeFileSync(empty, '')
    expect(await readTranscriptUsage(empty)).toBeNull()
  })

  it('looks further back once when the last reply is behind more than TAIL_BYTES of other rows', async () => {
    const path = join(dir, 'long.jsonl')
    // A system-prompt snapshot after the reply, bigger than the first tail
    const snapshot = JSON.stringify({ type: 'attachment', attachment: { type: 'prompt_snapshot', text: 'x'.repeat(TAIL_BYTES + 10_000) } })
    writeFileSync(path, fixtureTranscript() + snapshot + '\n')
    expect(await readTranscriptUsage(path)).toMatchObject({ tokens: 44051 })
    // ...but no further than WIDE_TAIL_BYTES
    const far = JSON.stringify({ type: 'attachment', attachment: { type: 'prompt_snapshot', text: 'x'.repeat(WIDE_TAIL_BYTES) } })
    writeFileSync(path, fixtureTranscript() + far + '\n')
    expect(await readTranscriptUsage(path)).toBeNull()
  })
})

describe('createMeterEstimator: throttled, trailing, and quiet once the status line reports', () => {
  afterEach(() => { vi.useRealTimers() })
  const PATH = '/home/me/.claude/projects/-home-me-proj/s1.jsonl'
  const reading = { tokens: 1000, input: 990, output: 10, model: 'claude-haiku-5-5' }

  it('reads at most once per throttle window per session; a burst ends in one trailing read', async () => {
    vi.useFakeTimers()
    const read = vi.fn(async () => reading)
    const apply = vi.fn()
    const est = createMeterEstimator({ read, apply })

    est.note('s1', PATH)
    // Never on the caller's stack: the read starts on a microtask
    expect(read).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(PATH)
    expect(apply).toHaveBeenCalledWith('s1', reading)

    // Ten events in the next second: no read until the window is over, then one
    for (let i = 0; i < 10; i++) {
      est.note('s1', PATH)
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(ESTIMATE_THROTTLE_MS - 1000 - 1)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenCalledTimes(2)

    // Quiet after that: no event, no read
    await vi.advanceTimersByTimeAsync(ESTIMATE_THROTTLE_MS * 3)
    expect(read).toHaveBeenCalledTimes(2)

    // Sessions are throttled separately
    est.note('s2', PATH.replace('s1', 's2'))
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('an event during a read gets one more read once the window allows', async () => {
    vi.useFakeTimers()
    let release: (v: unknown) => void = () => {}
    const read = vi.fn(() => new Promise(res => { release = res }))
    const apply = vi.fn()
    const est = createMeterEstimator({ read, apply })
    est.note('s1', PATH)
    await vi.advanceTimersByTimeAsync(0)
    est.note('s1', PATH)
    est.note('s1', PATH)
    release(reading)
    await vi.advanceTimersByTimeAsync(0)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(ESTIMATE_THROTTLE_MS)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('a session the status line reports for is never read, and a report during a read drops the reading', async () => {
    vi.useFakeTimers()
    const reported = new Set<string>()
    let release: (v: unknown) => void = () => {}
    const read = vi.fn(() => new Promise(res => { release = res }))
    const apply = vi.fn()
    const est = createMeterEstimator({ read, apply, skip: id => reported.has(id) })

    est.note('s1', PATH)
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)
    reported.add('s1')
    release(reading)
    await vi.advanceTimersByTimeAsync(0)
    expect(apply).not.toHaveBeenCalled()
    expect(est.has('s1')).toBe(false)

    est.note('s1', PATH)
    await vi.advanceTimersByTimeAsync(ESTIMATE_THROTTLE_MS * 2)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('needs a transcript path; a bad one is ignored; a failing read is just no reading', async () => {
    vi.useFakeTimers()
    const read = vi.fn(async () => { throw new Error('EIO') })
    const apply = vi.fn()
    const est = createMeterEstimator({ read, apply })
    est.note('s1', undefined)
    est.note('s1', 'relative.jsonl')
    est.note('', PATH)
    await vi.advanceTimersByTimeAsync(0)
    expect(read).not.toHaveBeenCalled()
    expect(est.size).toBe(0)
    est.note('s1', PATH)
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)
    expect(apply).not.toHaveBeenCalled()
    // A later event without a path still refreshes the one it knows
    await vi.advanceTimersByTimeAsync(ESTIMATE_THROTTLE_MS)
    est.note('s1', undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenLastCalledWith(PATH)
  })

  it('prune forgets sessions not read since a cut-off', async () => {
    vi.useFakeTimers()
    const est = createMeterEstimator({ read: async () => null, apply: () => {} })
    est.note('s1', PATH)
    await vi.advanceTimersByTimeAsync(0)
    est.prune(Date.now() - 1000)
    expect(est.has('s1')).toBe(true)
    est.prune(Date.now() + 1)
    expect(est.has('s1')).toBe(false)
  })
})

describe('the status store: the status line wins over an estimate', () => {
  const reading = { tokens: 44051, input: 43994, output: 57, model: 'claude-haiku-5-5', requestedModel: 'claude-haiku-5-5' }
  const statusLine = {
    type: 'session_status', sessionId: SID, project: 'Claude-Office', model: 'Haiku 5.5', modelId: 'claude-haiku-5-5',
    cost: 0.0141, durationMs: 23245, apiDurationMs: 19074, linesAdded: 0, linesRemoved: 0,
    context: { used: 5, size: 1_000_000, input: 50_000, output: 300 }, exceeds200k: false,
  }

  it('an estimate creates a MEMORY-only record marked transcript; the same reading again is not news', () => {
    const s = createStatusStore()
    const ev = s.applyEstimate(SID, reading)
    expect(ev).toMatchObject({
      type: 'session_status', sessionId: SID,
      session: {
        source: 'transcript', model: 'Haiku 5.5', modelId: 'claude-haiku-5-5', cost: 0,
        context: { used: 4.4, size: 1_000_000, input: 43994, output: 57 },
        estimate: { tokens: 44051, basis: 'model', approximate: false },
        burn: { dollarsPerMin: 0, tokensPerMin: 0 },
      },
    })
    expect(ev.session.rateLimits).toBeUndefined()
    expect(s.applyEstimate(SID, reading)).toBeNull()
    expect(s.applyEstimate(SID, { ...reading, tokens: 50_000 })?.session.context.used).toBe(5)
    expect(s.summary().totals).toEqual({ costToday: 0, tokensPerMin: 0, dollarsPerMin: 0 })
    expect(s.applyEstimate(SID, null)).toBeNull()
  })

  it('a status-line report takes over and later estimates change nothing', () => {
    const s = createStatusStore()
    s.applyEstimate(SID, reading)
    s.ingest(statusLine)
    expect(s.reportsStatusLine(SID)).toBe(true)
    const rec = s.get(SID)
    expect(rec.source).toBe('statusline')
    expect(rec).not.toHaveProperty('estimate')
    expect(rec.context).toEqual({ used: 5, size: 1_000_000, input: 50_000, output: 300 })

    expect(s.applyEstimate(SID, { ...reading, tokens: 900_000 })).toBeNull()
    expect(s.get(SID).context.used).toBe(5)
    expect(s.get(SID).source).toBe('statusline')
  })

  it('a subagent-status-line stub (the plugin can register that one) still gets its MEMORY estimated', () => {
    const s = createStatusStore()
    s.ingest({ type: 'agent_status', sessionId: SID, agents: [{ id: 'a1', tokens: 10 }] })
    expect(s.reportsStatusLine(SID)).toBe(false)
    const ev = s.applyEstimate(SID, reading)
    expect(ev.session).toMatchObject({ source: 'transcript', context: { used: 4.4 }, agents: [{ id: 'a1', tokens: 10 }] })
  })

  it('a compaction blanks the reading but keeps the window', () => {
    const s = createStatusStore()
    s.applyEstimate(SID, reading)
    const ev = s.applyEstimate(SID, { compacted: true })
    expect(ev.session.context).toEqual({ used: null, size: 1_000_000, input: 0, output: 0 })
    expect(ev.session.estimate).toMatchObject({ compacted: true, tokens: null })
    // Nothing before it: nothing to show
    expect(createStatusStore().applyEstimate('other', { compacted: true })).toBeNull()
  })
})

describe('POST /event -> estimated MEMORY on GET /status', () => {
  let office: Office
  let transcript: string
  const base = { sessionId: SID, project: 'Claude-Office', cwd: '/home/me/Claude-Office' }
  const summary = async () => (await request(office.server.app).get('/status')).body

  beforeAll(async () => {
    office = await loadOffice()
    mkdirSync(join(office.dir, 'projects'), { recursive: true })
    transcript = join(office.dir, 'projects', `${SID}.jsonl`)
    writeFileSync(transcript, fixtureTranscript())
  })
  afterAll(() => removeOffice(office))

  it('a hooked session with no status line gets MEMORY from its transcript, flagged on the wire', async () => {
    const res = await postEvent(office.server, { type: 'session_started', ...base, source: 'startup', transcriptPath: transcript })
    expect(res.status).toBe(200)
    await vi.waitFor(async () => expect((await summary()).sessions).toHaveLength(1))
    const [session] = (await summary()).sessions
    expect(session).toMatchObject({
      sessionId: SID, project: 'Claude-Office', source: 'transcript', model: 'Haiku 5.5', modelId: 'claude-haiku-5-5',
      context: { used: 4.4, size: 1_000_000, input: 43994, output: 57 },
      estimate: { tokens: 44051, basis: 'model', approximate: false },
      cost: 0,
    })
    // Numbers and a model id only: nothing the conversation said
    expect(JSON.stringify(session)).not.toContain('pixel-art')
    expect(JSON.stringify(session)).not.toContain('package.json')
  })

  it('a real status-line report wins at once, and later hook events do not bring the estimate back', async () => {
    const res = await postAuthed(office.server, '/status', {
      type: 'session_status', sessionId: SID, project: 'Claude-Office', model: 'Haiku 5.5', modelId: 'claude-haiku-5-5',
      cost: 0.02, durationMs: 1000, context: { used: 6, size: 1_000_000, input: 60_000, output: 400 },
    })
    expect(res.status).toBe(200)
    expect((await summary()).sessions[0]).toMatchObject({ source: 'statusline', cost: 0.02, context: { used: 6 } })
    expect((await summary()).sessions[0]).not.toHaveProperty('estimate')

    appendFileSync(transcript, assistant('msg_more', { type: 'text', text: 'more' }, { input_tokens: 1, cache_read_input_tokens: 300_000, output_tokens: 1 }) + '\n')
    await postEvent(office.server, { type: 'agent_working', ...base, status: 'using Read', tool: 'Read', transcriptPath: transcript })
    await new Promise(r => setTimeout(r, 50))
    expect((await summary()).sessions[0]).toMatchObject({ source: 'statusline', cost: 0.02, context: { used: 6, size: 1_000_000 } })
    expect(office.server.app.locals.status.estimator.has(SID)).toBe(false)
  })

  it('a missing or unreadable transcript gives no meter and no error', async () => {
    const missing = { ...base, sessionId: 'sess-no-file', transcriptPath: join(office.dir, 'projects', 'gone.jsonl') }
    expect((await postEvent(office.server, { type: 'session_started', ...missing, source: 'startup' })).status).toBe(200)
    const dirPath = join(office.dir, 'projects', 'a-dir.jsonl')
    mkdirSync(dirPath)
    expect((await postEvent(office.server, { type: 'session_started', ...base, sessionId: 'sess-dir', source: 'startup', transcriptPath: dirPath })).status).toBe(200)
    expect((await postEvent(office.server, { type: 'session_started', ...base, sessionId: 'sess-bad', source: 'startup', transcriptPath: '../../etc/passwd.jsonl' })).status).toBe(200)
    await new Promise(r => setTimeout(r, 50))
    const ids = (await summary()).sessions.map((s: { sessionId: string }) => s.sessionId)
    expect(ids).toEqual([SID])
  })
})

describe('the page: est. marker and the needs-the-status-line tooltips', () => {
  function session(overrides: Partial<SessionStatus> = {}): SessionStatus {
    return {
      sessionId: SID, project: 'Claude-Office', model: 'Haiku 5.5', modelId: 'claude-haiku-5-5',
      cost: 0, durationMs: 0, linesAdded: 0, linesRemoved: 0,
      context: { used: 4.4, size: 1_000_000, input: 43994, output: 57 },
      burn: { dollarsPerMin: 0, tokensPerMin: 0 },
      source: 'transcript', estimate: { tokens: 44051, basis: 'model', approximate: false },
      ...overrides,
    }
  }

  it('the marker and the reading', () => {
    expect(isEstimated(session())).toBe(true)
    expect(estimateMarker(session())).toBe('est.')
    expect(formatMemory(session())).toBe('4%')
    expect(formatMemory(session({ context: { used: 37.5, size: 200_000, input: 75_000, output: 0 }, estimate: { tokens: 75_000, basis: 'unknown', approximate: true } }))).toBe('≈38%')
    expect(formatMemory(session({ context: { used: null, size: 1_000_000, input: 0, output: 0 }, estimate: { tokens: null, basis: 'model', approximate: false, compacted: true } }))).toBe('–')
    // Status-line numbers get no marker, and an older record without `source` is not an estimate
    expect(estimateMarker(session({ source: 'statusline', estimate: undefined }))).toBe('')
    expect(estimateMarker(session({ source: undefined, estimate: undefined }))).toBe('')
    expect(formatMemory(session({ source: 'statusline', estimate: undefined, context: { used: 37.5, size: 200_000, input: 0, output: 0 } }))).toBe('38%')
  })

  it('the MEMORY tooltip says it comes from the transcript because no status line is registered', () => {
    const tip = estimateTip(session())
    expect(tip[0]).toBe('MEMORY — Claude-Office: 4% of the context window (44,051 / 1,000,000 tokens) · est.')
    expect(tip[1]).toContain('estimated from the session transcript')
    expect(tip[1]).toContain('no status line is registered')
    expect(tip[2]).toContain("1,000,000 tokens for claude-haiku-5-5 (Claude Code's model table)")
    expect(tip[3]).toBe(`payroll and electricity need the status line: ${STATUS_LINE_INSTALL}`)

    const unknown = estimateTip(session({ modelId: 'claude-next', context: { used: 10, size: 200_000, input: 20_000, output: 0 }, estimate: { tokens: 20_000, basis: 'unknown', approximate: true } }))
    expect(unknown[0]).toContain('≈10%')
    expect(unknown[2]).toContain('200,000 tokens assumed')
    expect(unknown[2]).toContain('approximate')
    expect(estimateTip(session({ estimate: { tokens: 44051, basis: '1m-tag', approximate: false } }))[2]).toContain('[1m]')
    expect(estimateTip(session({ estimate: { tokens: 300_000, basis: 'overflow', approximate: true } }))[2]).toContain('1M variant')
    expect(estimateTip(session({ context: { used: null, size: 1_000_000, input: 0, output: 0 }, estimate: { tokens: null, basis: 'model', approximate: false, compacted: true } }))[1]).toContain('compacted')
  })

  it('PAYROLL and ELECTRICITY name the status line and the install command', () => {
    expect(STATUS_LINE_INSTALL).toBe('npm run install-hooks')
    const payroll = needsStatusLineTip('PAYROLL', [session()])
    expect(payroll[0]).toBe('PAYROLL needs the status line — Claude Code reports cost only to its statusLine command')
    expect(payroll).toContain('register it with: npm run install-hooks (from the Claude-Office checkout)')
    expect(payroll).toContain('Claude-Office: needs the status line')
    const electricity = needsStatusLineTip('ELECTRICITY', [session(), session({ sessionId: 'b', project: 'other' })])
    expect(electricity[0]).toContain('tokens per minute')
    expect(electricity[1]).toContain('these 2 sessions')
  })
})
