/**
 * server/transcript.js — the inspector card's transcript tail: where a
 * worker's own transcript is, and what the last few assistant records of a
 * JSONL transcript say. The fixtures follow the record shapes Claude Code
 * 2.1.300 writes: one `assistant` record per content block, the blocks of a
 * reply sharing message.id; `user` rows for prompts and tool results;
 * `attachment` rows (the system prompt among them) that make the file big.
 */

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  agentTranscriptPath, isTranscriptPath, parseTranscript, scanTranscript, readTranscript, readTail, tailTranscript,
  summariseInput, clampLine, usageTokens, TAIL_BYTES,
} from '../server/transcript.js'

const dir = mkdtempSync(join(tmpdir(), 'agent-office-transcript-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const AT = '2026-10-14T19:05:35.842Z'
let n = 0

/** One assistant record (one content block), as Claude Code writes them. */
function assistant(id: string, block: object, timestamp = AT): string {
  return JSON.stringify({
    type: 'assistant', uuid: `u-${++n}`, parentUuid: `u-${n - 1}`, timestamp, sessionId: 's1', isSidechain: true, agentId: 'ac5ff55b850b4fecf',
    requestId: `req_${n}`, requestedModel: 'claude-haiku-5-5',
    message: { model: 'claude-haiku-5-5', id, role: 'assistant', content: [block], stop_reason: 'tool_use', usage: { input_tokens: 2, output_tokens: 10 } },
  })
}
const thinking = (id: string) => assistant(id, { type: 'thinking', thinking: '', signature: 'x' })
const text = (id: string, t: string, timestamp?: string) => assistant(id, { type: 'text', text: t }, timestamp)
const toolUse = (id: string, name: string, input: object) => assistant(id, { type: 'tool_use', id: `toolu_${++n}`, name, input, caller: { type: 'direct' } })
const user = (content: unknown) => JSON.stringify({ type: 'user', uuid: `u-${++n}`, timestamp: AT, message: { role: 'user', content } })
const attachment = (type: string, size = 0) => JSON.stringify({ type: 'attachment', uuid: `u-${++n}`, timestamp: AT, attachment: { type, text: 'x'.repeat(size) } })

/** The worker transcript of REPORT.md section 2: prompt, attachments, thinking + Bash (one message), its result, the reply. */
const WORKER = [
  user('Run ls /etc | wc -l with Bash and report it.'),
  attachment('environment'),
  attachment('prompt_snapshot', 500),
  thinking('msg_A'),
  toolUse('msg_A', 'Bash', { command: 'ls /etc | wc -l', description: 'Count /etc entries' }),
  user([{ tool_use_id: 'toolu_1', type: 'tool_result', content: '154' }]),
  attachment('total_tokens_reminder'),
  text('msg_B', '`ls /etc | wc -l` returned **154**, so `/etc` has 154 entries.', '2026-10-14T19:05:37.515Z'),
].join('\n') + '\n'

describe('agentTranscriptPath', () => {
  it('derives a worker file from the session transcript, the session id and the Claude agent id', () => {
    expect(agentTranscriptPath('/root/.claude/projects/-home-me-proj/8cf68f64-5433.jsonl', '8cf68f64-5433', 'ac5ff55b850b4fecf'))
      .toBe('/root/.claude/projects/-home-me-proj/8cf68f64-5433/subagents/agent-ac5ff55b850b4fecf.jsonl')
  })

  it('is null when a part is missing, the session file is not a .jsonl, or an id is not a plain identifier', () => {
    expect(agentTranscriptPath(undefined, 's', 'a')).toBeNull()
    expect(agentTranscriptPath('/t/s.jsonl', undefined, 'a')).toBeNull()
    expect(agentTranscriptPath('/t/s.jsonl', 's', undefined)).toBeNull()
    expect(agentTranscriptPath('/t/s.txt', 's', 'a')).toBeNull()
    expect(agentTranscriptPath('/t/s.jsonl', '../etc', 'a')).toBeNull()
    expect(agentTranscriptPath('/t/s.jsonl', 's', 'a/b')).toBeNull()
  })
})

describe('isTranscriptPath', () => {
  it('accepts only an absolute .jsonl path without a .. segment', () => {
    expect(isTranscriptPath('/root/.claude/projects/p/s.jsonl')).toBe(true)
    expect(isTranscriptPath('relative/s.jsonl')).toBe(false)
    expect(isTranscriptPath('/root/../etc/passwd.jsonl')).toBe(false)
    expect(isTranscriptPath('/etc/passwd')).toBe(false)
    expect(isTranscriptPath(undefined)).toBe(false)
  })
})

describe('parseTranscript', () => {
  it('folds the blocks of one message into one entry and keeps only what the agent said and called', () => {
    const entries = parseTranscript(WORKER)
    expect(entries).toEqual([
      { at: Date.parse(AT), kind: 'tool', tool: 'Bash', tools: ['Bash'], input: 'ls /etc | wc -l' },
      { at: Date.parse('2026-10-14T19:05:37.515Z'), kind: 'said', text: '`ls /etc | wc -l` returned **154**, so `/etc` has 154 entries.' },
    ])
  })

  it('three records sharing message.id (thinking + two tool_use) are one entry naming both tools', () => {
    const entries = parseTranscript([
      thinking('msg_X'),
      toolUse('msg_X', 'Read', { file_path: '/repo/a.ts' }),
      toolUse('msg_X', 'Grep', { pattern: 'TODO' }),
    ].join('\n'))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'tool', tool: 'Read', tools: ['Read', 'Grep'], input: '/repo/a.ts' })
  })

  it('a message that speaks and calls a tool is one tool entry carrying the text', () => {
    const entries = parseTranscript([text('msg_Y', 'Let me check the file.'), toolUse('msg_Y', 'Read', { file_path: '/repo/b.ts' })].join('\n'))
    expect(entries).toEqual([{ at: Date.parse(AT), kind: 'tool', tool: 'Read', tools: ['Read'], input: '/repo/b.ts', text: 'Let me check the file.' }])
  })

  it('clamps text to maxChars with an ellipsis and keeps the last maxEntries only', () => {
    const lines = Array.from({ length: 12 }, (_, i) => text(`msg_${i}`, `reply number ${i} ` + 'word '.repeat(100)))
    const entries = parseTranscript(lines.join('\n'), { maxEntries: 3, maxChars: 40 })
    expect(entries.map(e => e.text!.slice(0, 16))).toEqual(['reply number 9 w', 'reply number 10 ', 'reply number 11 '])
    for (const e of entries) {
      expect(e.text).toHaveLength(40)
      expect(e.text!.endsWith('…')).toBe(true)
      expect(e.text!.startsWith('reply number')).toBe(true)
    }
  })

  it('skips malformed lines, non-assistant rows and assistant rows without a content array; never throws', () => {
    const entries = parseTranscript([
      'not json at all',
      '{"type":"assistant"}',
      '{"type":"assistant","message":{"id":"m","content":"a string"}}',
      '[1,2,3]',
      'null',
      '{"type":"system","subtype":"stop_hook_summary"}',
      '{"type":"cost-state","totalCostUSD":0.01}',
      text('msg_ok', 'still here'),
      '{"type":"assistant","message":{"id":"m2","content":[null, 42, {"type":"text"}, {"type":"tool_use"}]}}',
      '{"truncated last line',
    ].join('\n'))
    expect(entries).toEqual([{ at: Date.parse(AT), kind: 'said', text: 'still here' }])
    expect(parseTranscript('')).toEqual([])
    expect(parseTranscript(undefined as unknown as string)).toEqual([])
  })

  it('a record without a parsable timestamp gets at: null', () => {
    const line = JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'hi' }] } })
    expect(parseTranscript(line)).toEqual([{ at: null, kind: 'said', text: 'hi' }])
  })
})

describe('usage: tokens and model from the last assistant message', () => {
  // A 2.1.300 foreground Explore agent: its PostToolUse(Agent) said totalTokens 20676,
  // and its final message's usage was this
  const captured = { input_tokens: 2, cache_creation_input_tokens: 1497, cache_read_input_tokens: 19054, output_tokens: 123, output_tokens_details: { thinking_tokens: 101 }, service_tier: 'standard' }

  it('usageTokens is the four counts summed — the number Claude Code reports as totalTokens', () => {
    expect(usageTokens(captured)).toBe(20676)
    expect(usageTokens({ input_tokens: 5 })).toBe(5)
    expect(usageTokens({ input_tokens: -1, output_tokens: 'x' })).toBeNull()
    expect(usageTokens(null)).toBeNull()
    expect(usageTokens('usage')).toBeNull()
  })

  it('scanTranscript keeps the last record with a usage and its model; none -> null', () => {
    const rec = (id: string, usage: object | undefined, model = 'claude-haiku-5-5') =>
      JSON.stringify({ type: 'assistant', timestamp: AT, message: { id, model, content: [{ type: 'text', text: id }], ...(usage ? { usage } : {}) } })
    const { entries, usage } = scanTranscript([
      rec('m1', { input_tokens: 1, output_tokens: 1 }, 'claude-sonnet-4-5'),
      rec('m2', captured),
      rec('m3', undefined),  // a record without usage does not reset it
    ].join('\n'))
    expect(entries.map(e => e.text)).toEqual(['m1', 'm2', 'm3'])
    expect(usage).toEqual({ tokens: 20676, model: 'claude-haiku-5-5' })
    expect(scanTranscript(WORKER).usage).toEqual({ tokens: 12, model: 'claude-haiku-5-5' })
    expect(scanTranscript('{"type":"user"}').usage).toBeNull()
  })

  it('readTranscript reads the file once for both; a missing file gives no entries and no usage', () => {
    const path = join(dir, 'usage.jsonl')
    writeFileSync(path, WORKER)
    expect(readTranscript(path).usage).toEqual({ tokens: 12, model: 'claude-haiku-5-5' })
    expect(readTranscript(join(dir, 'none.jsonl'))).toEqual({ entries: [], usage: null })
  })
})

describe('summariseInput / clampLine', () => {
  it('summarises the common tools by their one telling field', () => {
    expect(summariseInput('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(summariseInput('Bash', { command: 'ls -la', description: 'list' })).toBe('ls -la')
    expect(summariseInput('Grep', { pattern: 'TODO', path: '/x' })).toBe('TODO')
    expect(summariseInput('Agent', { description: 'Count etc', prompt: 'long prompt' })).toBe('Count etc')
    expect(summariseInput('WebFetch', { url: 'https://example.com' })).toBe('https://example.com')
    expect(summariseInput('Whatever', { flag: true, name: 'thing' })).toBe('thing')
    expect(summariseInput('Whatever', { count: 3 })).toBe('{"count":3}')
    expect(summariseInput('Whatever', {})).toBe('')
    expect(summariseInput('Whatever', null)).toBe('')
  })

  it('clampLine collapses whitespace and ends a cut line with an ellipsis', () => {
    expect(clampLine('  a\n\n b\tc  ', 100)).toBe('a b c')
    expect(clampLine('abcdefghij', 5)).toBe('abcd…')
    expect(clampLine(undefined, 5)).toBe('')
  })
})

describe('tailTranscript (the file reader)', () => {
  it('reads a worker transcript', () => {
    const path = join(dir, 'worker.jsonl')
    writeFileSync(path, WORKER)
    expect(tailTranscript(path).map(e => e.kind)).toEqual(['tool', 'said'])
  })

  it('a missing file, a directory, a relative path or a non-.jsonl path give []', () => {
    expect(tailTranscript(join(dir, 'nope.jsonl'))).toEqual([])
    expect(tailTranscript(dir)).toEqual([])
    expect(tailTranscript('worker.jsonl')).toEqual([])
    expect(tailTranscript(join(dir, 'worker.txt'))).toEqual([])
    expect(readTail(join(dir, 'nope.jsonl'))).toBeNull()
  })

  it('reads only the last 256 KB of a 300 KB file: an early reply is gone, the final ones are there', () => {
    const path = join(dir, 'big.jsonl')
    const lines = [text('msg_early', 'EARLY reply, before the padding')]
    while (lines.join('\n').length < 300 * 1024) lines.push(attachment('prompt_snapshot', 8 * 1024))
    lines.push(toolUse('msg_late1', 'Bash', { command: 'ls /etc | wc -l' }))
    lines.push(text('msg_late2', 'LATE reply, at the very end'))
    writeFileSync(path, lines.join('\n') + '\n')
    expect(statSync(path).size).toBeGreaterThan(300 * 1024)

    const tail = readTail(path)!
    expect(tail.length).toBeLessThanOrEqual(TAIL_BYTES)
    expect(tail.startsWith('{')).toBe(true)  // the partial first line was dropped

    const entries = tailTranscript(path)
    expect(entries.map(e => e.kind)).toEqual(['tool', 'said'])
    expect(entries[1].text).toBe('LATE reply, at the very end')
    expect(entries.some(e => e.text?.includes('EARLY'))).toBe(false)
  })

  it('a read that starts mid-line drops that partial line and parses the rest', () => {
    const path = join(dir, 'mid.jsonl')
    const first = text('msg_1', 'first')
    const second = text('msg_2', 'second')
    writeFileSync(path, `${first}\n${second}\n`)
    // A window that begins inside the first line
    const entries = tailTranscript(path, { maxBytes: second.length + 1 + 10 })
    expect(entries).toEqual([{ at: Date.parse(AT), kind: 'said', text: 'second' }])
  })

  it('honours maxEntries and maxChars', () => {
    const path = join(dir, 'levels.jsonl')
    writeFileSync(path, [text('m1', 'a'.repeat(500)), text('m2', 'b'.repeat(500)), text('m3', 'c'.repeat(500))].join('\n'))
    const summary = tailTranscript(path, { maxEntries: 2, maxChars: 200 })
    expect(summary).toHaveLength(2)
    expect(summary[0].text).toHaveLength(200)
    expect(summary[0].text!.startsWith('bbb')).toBe(true)
    expect(tailTranscript(path, { maxChars: 2000 })[0].text).toHaveLength(500)
  })

  it('a real-shaped file with a trailing half-written line still yields the complete records', () => {
    const path = join(dir, 'partial.jsonl')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(path, WORKER + '{"type":"assistant","message":{"id":"msg_C","content":[{"type":"text","te')
    expect(tailTranscript(path).map(e => e.kind)).toEqual(['tool', 'said'])
  })
})
