/** hooks/office-relay.py — forwards another AI tool's hook payload to POST /hook/<tool>, signed, loopback only, never in the tool's way. */

import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:http'
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listen, loadOffice, removeOffice, type Office } from './helpers'

const RELAY = fileURLToPath(new URL('../hooks/office-relay.py', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures/tools/', import.meta.url))
const fixtureText = (tool: string, name: string) => readFileSync(join(FIXTURES, tool, `${name}.json`), 'utf8')
const withSession = (tool: string, name: string, sid: string) => JSON.stringify({ ...JSON.parse(fixtureText(tool, name)), session_id: sid })

interface Run { code: number | null, stdout: string, ms: number }

/** Run the relay with a payload on stdin and the given env; resolves when it exits. */
function relay(args: string[], stdin: string, env: Record<string, string>): Promise<Run> {
  return new Promise(resolve => {
    const t0 = Date.now()
    const child = spawn('python3', ['-I', RELAY, ...args], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } })
    let stdout = ''
    child.stdout.on('data', d => { stdout += d })
    child.on('close', code => resolve({ code, stdout, ms: Date.now() - t0 }))
    child.stdin.end(stdin)
  })
}

/** A port with nothing listening on it (bound, then closed). */
async function deadPort(): Promise<number> {
  const s = createServer()
  const port = await listen(s)
  await new Promise(r => s.close(r))
  return port
}

describe('office-relay.py', () => {
  let office: Office
  let port: number
  let env: Record<string, string>

  beforeAll(async () => {
    office = await loadOffice()
    port = await listen(office.server.httpServer)
    // Why: the server writes its token file in start(), after listen; a test office never calls start()
    writeFileSync(join(office.dir, 'auth-token'), office.server.AUTH_TOKEN)
    env = { AGENT_OFFICE_HOME: office.dir, AGENT_OFFICE_PORT: String(port) }
  })
  afterAll(async () => {
    await new Promise(r => office.server.httpServer.close(r))
    removeOffice(office)
  })

  it('forwards a Codex SessionStart into an office session', async () => {
    const r = await relay(['codex'], withSession('codex', 'session-start', 'relay-1'), env)
    expect(r.code).toBe(0)
    expect(office.server.sessions.get('codex:relay-1')?.client).toBe('codex')
  })

  it('passes the event name for a tool whose payload has none (Antigravity)', async () => {
    const payload = JSON.stringify({ ...JSON.parse(fixtureText('antigravity', 'session-start')), conversationId: 'relay-agy' })
    const r = await relay(['antigravity', 'SessionStart'], payload, env)
    expect(r.code).toBe(0)
    expect(office.server.sessions.get('antigravity:relay-agy')).toBeTruthy()
  })

  it('exits 0 at once when nothing is listening', async () => {
    const r = await relay(['codex'], fixtureText('codex', 'session-start'), { ...env, AGENT_OFFICE_PORT: String(await deadPort()) })
    expect(r.code).toBe(0)
    expect(r.ms).toBeLessThan(1500)
  })

  it('gives up on a server that never answers, and still exits 0', async () => {
    const hung: TcpServer = createTcpServer(() => { /* accept, never answer */ })
    const hungPort = await new Promise<number>(res => hung.listen(0, '127.0.0.1', () => res((hung.address() as any).port)))
    try {
      const r = await relay(['codex'], fixtureText('codex', 'session-start'), { ...env, AGENT_OFFICE_PORT: String(hungPort) })
      expect(r.code).toBe(0)
      expect(r.ms).toBeLessThan(2500)
    } finally {
      hung.close()
    }
  })

  it('ignores a full event URL: it posts to 127.0.0.1:<port> only', async () => {
    let hits = 0
    const other: Server = createServer((_req, res) => { hits++; res.end('{}') })
    const otherPort = await listen(other)
    try {
      const r = await relay(['codex'], withSession('codex', 'session-start', 'relay-url'), { ...env, AGENT_OFFICE_EVENT_URL: `http://127.0.0.1:${otherPort}/event` })
      expect(r.code).toBe(0)
      expect(hits).toBe(0)
      expect(office.server.sessions.get('codex:relay-url')).toBeTruthy()
    } finally {
      other.close()
    }
  })

  it('posts nothing inside an office run (AGENT_OFFICE_RUN=1)', async () => {
    const r = await relay(['codex'], withSession('codex', 'session-start', 'relay-run'), { ...env, AGENT_OFFICE_RUN: '1' })
    expect(r.code).toBe(0)
    expect(office.server.sessions.get('codex:relay-run')).toBeUndefined()
  })

  it('exits 0 and posts nothing for an unknown tool, empty stdin or non-JSON', async () => {
    const before = office.server.sessions.size
    for (const [args, stdin] of [[['nope'], fixtureText('codex', 'session-start')], [['codex'], ''], [['codex'], 'not json'], [[], '{}']] as [string[], string][]) {
      const r = await relay(args, stdin, env)
      expect(r.code, args.join(' ')).toBe(0)
      expect(r.stdout, args.join(' ')).toBe('')
    }
    expect(office.server.sessions.size).toBe(before)
  })

  it('saves each raw payload to AGENT_OFFICE_CAPTURE_DIR when set (recording fixtures), and still forwards it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-capture-'))
    try {
      const payload = withSession('codex', 'session-start', 'relay-capture')
      await relay(['codex'], payload, { ...env, AGENT_OFFICE_CAPTURE_DIR: dir })
      const files = readdirSync(dir)
      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/^codex-SessionStart-\d+\.json$/)
      expect(readFileSync(join(dir, files[0]), 'utf8')).toBe(payload)
      expect(office.server.sessions.get('codex:relay-capture')).toBeTruthy()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers the tools that read stdout, and stays silent for the rest', async () => {
    const down = { ...env, AGENT_OFFICE_PORT: String(await deadPort()) }
    // Gemini parses stdout as JSON; Antigravity's tool and stop hooks expect a reply — never a decision
    expect((await relay(['gemini'], fixtureText('gemini', 'before-tool'), down)).stdout).toBe('{}')
    expect((await relay(['antigravity', 'PreToolUse'], fixtureText('antigravity', 'pre-tool'), down)).stdout).toBe('{}')
    expect((await relay(['antigravity', 'Stop'], fixtureText('antigravity', 'stop'), down)).stdout).toBe('{}')
    // Kimi appends stdout to the model's context; Codex needs nothing
    expect((await relay(['kimi'], fixtureText('kimi', 'pre-tool'), down)).stdout).toBe('')
    expect((await relay(['codex'], fixtureText('codex', 'pre-tool-bash'), down)).stdout).toBe('')
  })
})
