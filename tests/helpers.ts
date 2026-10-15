/**
 * Shared helpers for the server tests.
 *
 * server/index.js keeps its state at module level (activeAgents, the chat.db
 * connection, the loop budget, ...). `loadOffice()` re-evaluates the module
 * with AGENT_OFFICE_HOME pointed at a fresh temp dir, so every call is a
 * brand-new office that never touches the real ~/.agent-office. Importing
 * the module does not bind port 3334 or write the auth token — only
 * `start()` does — so tests drive the Express app through supertest and
 * call `httpServer.listen(0)` themselves when they need a live socket.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { vi } from 'vitest'

export type OfficeServer = typeof import('../server/index.js')

export interface Office {
  /** Runtime dir this instance writes to (its AGENT_OFFICE_HOME). */
  dir: string
  server: OfficeServer
}

export interface LoadOptions {
  /** Reuse an existing runtime dir (simulates a server restart). */
  dir?: string
  /** Extra env vars that server/index.js reads at import time. */
  env?: Record<string, string>
}

/** Import a fresh copy of server/index.js against a temp runtime dir. */
export async function loadOffice(opts: LoadOptions = {}): Promise<Office> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'agent-office-test-'))
  process.env.AGENT_OFFICE_HOME = dir
  // The registry roster (server/sessions.js) reads Claude Code's own
  // ~/.claude/sessions when started; a test office reads a (normally absent)
  // directory under its runtime dir instead, so the sessions of whoever runs
  // the suite never turn up in it. A test that wants a registry passes its own.
  const extra = Object.entries({ AGENT_OFFICE_REGISTRY_DIR: join(dir, 'registry'), ...(opts.env ?? {}) })
  for (const [key, value] of extra) process.env[key] = value
  try {
    vi.resetModules()
    const server = await import('../server/index.js')
    return { dir, server }
  } finally {
    for (const [key] of extra) delete process.env[key]
  }
}

/** Remove a temp runtime dir created by loadOffice. */
export function removeOffice(office: Office | undefined) {
  if (!office) return
  try { rmSync(office.dir, { recursive: true, force: true }) } catch {}
}

/**
 * POST a JSON body to a token-protected route (/event, /chat/reply, /a2a,
 * /chat/inbox/read, ...) with the server's own bearer token, or a bad one.
 */
export function postAuthed(server: OfficeServer, path: string, body: unknown, token: string = server.AUTH_TOKEN) {
  return request(server.app)
    .post(path)
    .set('Authorization', `Bearer ${token}`)
    .send(body as object)
}

/** POST /event with the server's own bearer token (or a bad one). */
export function postEvent(server: OfficeServer, body: unknown, token: string = server.AUTH_TOKEN) {
  return postAuthed(server, '/event', body, token)
}

/**
 * The WebSocket subprotocols the office page offers when it has the office
 * token (src/officeToken.ts): `new WebSocket(url, officeProtocols(server))`
 * is a trusted connection — prompt / reply text and the UI token included.
 * A client that offers none is read-only (server/index.js, "The WebSocket").
 */
export function officeProtocols(server: OfficeServer, token: string = server.AUTH_TOKEN): string[] {
  return [server.WS_PROTOCOL, `${server.WS_TOKEN_PROTOCOL_PREFIX}${token}`]
}

/** Bind an http.Server to an ephemeral localhost port and return the port. */
export function listen(httpServer: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject)
      resolve((httpServer.address() as AddressInfo).port)
    })
  })
}

/** Spawn an office agent directly through processEvent (no HTTP). */
export function spawnAgent(server: OfficeServer, agent: Record<string, unknown>) {
  return server.processEvent({ type: 'agent_spawned', agent })
}
