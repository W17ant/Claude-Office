#!/usr/bin/env node
/**
 * rotate-token.mjs — `npm run rotate-token`: retire the office token.
 *
 * The server reuses the token in $AGENT_OFFICE_HOME/auth-token across
 * restarts, so a browser that opened the office link once keeps working.
 * To change it (it was shown somewhere it should not have been, a browser
 * profile you no longer trust has it), this deletes the file; the next start
 * writes a new one. Every page that kept the old token then shows the office
 * read-only until it is given the new link (`npm run open`).
 *
 * A running server keeps the token it started with in memory, while the hook
 * and the scripts read the file — so while the office answers on its port
 * this refuses (stop it first: scripts/stop-office.sh, Ctrl+C, or quit the
 * desktop app). --force deletes the file anyway; then restart the office at
 * once, since until it is restarted every hook event is refused.
 */

import { realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import helpers from '../electron/helpers.cjs'
import { readPort } from '../server/config.js'

const { runtimeDirFromEnv } = helpers

async function serverAnswers(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

/** Delete the token file unless the office is running (or `force`); returns the exit code. */
export async function rotateToken({ env = process.env, force = false, out = process.stdout, err = process.stderr } = {}) {
  const tokenFile = join(runtimeDirFromEnv(env), 'auth-token')
  const port = readPort(env, { warn: m => err.write(`${m}\n`) })
  const running = await serverAnswers(port)
  if (running && !force) {
    err.write(`The office is running on port ${port} with the current token. Stop it first (bash scripts/stop-office.sh, Ctrl+C, or quit the desktop app), then run npm run rotate-token again.\n`)
    return 1
  }
  rmSync(tokenFile, { force: true })
  out.write(`Deleted ${tokenFile}: the next start writes a new office token.\n`)
  if (running) err.write('The office is still running with the old token: restart it now (until then the hooks are refused).\n')
  out.write('Then open the office with npm run open; pages that kept the old token show it read-only until they get the new link.\n')
  return 0
}

function isMainModule() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  rotateToken({ force: process.argv.slice(2).includes('--force') }).then(code => process.exit(code))
}
