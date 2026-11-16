/**
 * opencode-plugin.js - Claude Office's OpenCode plugin: shows OpenCode sessions in the office.
 *
 * Installed as ~/.config/opencode/plugins/claude-office.js by
 * `agent-office install-hooks --tool opencode`. OpenCode has no command
 * hooks, only in-process plugins, so instead of running the relay per event
 * this posts each bus event ({ type, properties } plus the session's
 * `directory`) straight to the office: POST http://127.0.0.1:<port>/hook/opencode,
 * signed with the office token (~/.agent-office/auth-token) exactly like
 * hooks/office-relay.py. The server translates it (server/tools/opencode.js).
 *
 * Never in OpenCode's way: every send is fire-and-forget with a short
 * timeout, and every error is swallowed. Loopback only; nothing is sent
 * inside the office's own runs (AGENT_OFFICE_RUN=1) or without a token.
 */

import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PATH = '/hook/opencode'
// Why 1500 ms: long enough for a busy local server, short enough that a hung one costs nothing noticeable
const TIMEOUT_MS = 1500
// Why only these: enough for the status line ("running: npm test"); file contents and patches stay in OpenCode
const ARG_KEYS = ['command', 'filePath', 'path', 'pattern', 'description']
// Why a list: OpenCode's bus also carries message.part.updated on every
// streamed token; only the events server/tools/opencode.js reads are sent
const FORWARD = new Set(['session.created', 'session.deleted', 'session.idle', 'session.error', 'session.compacted', 'message.updated', 'permission.asked', 'permission.updated'])

/**
 * The request signature the office checks (server/index.js requestSignature).
 * @returns {string} hex HMAC-SHA256(token, `${method}\n${path}\n${ts}\n${body}`)
 */
export function signRequest(token, path, ts, body) {
  return createHmac('sha256', token).update(`POST\n${path}\n${ts}\n${body}`).digest('hex')
}

function readToken() {
  try {
    const home = process.env.AGENT_OFFICE_HOME || join(homedir(), '.agent-office')
    return readFileSync(join(home, 'auth-token'), 'utf8').trim()
  } catch {
    return ''
  }
}

function smallArgs(args) {
  if (!args || typeof args !== 'object') return undefined
  const out = {}
  for (const k of ARG_KEYS) if (typeof args[k] === 'string') out[k] = args[k].slice(0, 200)
  return out
}

async function send(payload) {
  try {
    if (process.env.AGENT_OFFICE_RUN === '1') return
    const token = readToken()
    if (!token) return
    const port = /^\d{1,5}$/.test(process.env.AGENT_OFFICE_PORT ?? '') ? process.env.AGENT_OFFICE_PORT : '3334'
    const body = JSON.stringify(payload)
    const ts = String(Date.now())
    await fetch(`http://127.0.0.1:${port}${PATH}`, {
      method: 'POST',
      body,
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Office-Timestamp': ts, 'X-Office-Signature': signRequest(token, PATH, ts, body) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    // The office is down or slow: OpenCode carries on
  }
}

/**
 * The plugin: OpenCode calls it once per session with { directory, ... }.
 * Why `void send`: OpenCode awaits each hook, so the post must not hold it up.
 */
export const ClaudeOffice = async ({ directory } = {}) => ({
  event: async ({ event } = {}) => {
    if (!event || !FORWARD.has(event.type)) return
    void send({ type: event.type, properties: event.properties, directory })
  },
  'tool.execute.before': async (input = {}, output = {}) => {
    void send({ type: 'tool.execute.before', properties: { tool: input.tool, sessionID: input.sessionID, callID: input.callID, args: smallArgs(output.args) }, directory })
  },
  'tool.execute.after': async (input = {}) => {
    void send({ type: 'tool.execute.after', properties: { tool: input.tool, sessionID: input.sessionID, callID: input.callID }, directory })
  },
})
