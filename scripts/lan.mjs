#!/usr/bin/env node
/**
 * lan.mjs - `npm run lan`: start the office with phone mode's watch-only LAN listener.
 *
 * The same server as `npm run server` (loopback 127.0.0.1:3334, unchanged),
 * plus a second listener on this machine's private Wi-Fi address (port 3335,
 * AGENT_OFFICE_LAN_PORT) that serves the office scene to a phone holding the
 * viewer key. The server prints the phone link and a QR code of it. See
 * docs/reference.md › Phone mode for what the phone can and cannot see.
 *
 *   --rotate  forget the viewer key first, so this start mints a new one
 *             (phones holding the old link stop getting the office)
 *
 * Equivalent to AGENT_OFFICE_LAN=1 node server/index.js, which is what to set
 * for start-office.sh or any other launcher.
 */

import { realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import helpers from '../electron/helpers.cjs'

const { runtimeDirFromEnv } = helpers

/**
 * Delete the viewer key file; the next LAN start writes a new key.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} the file removed
 */
export function rotateViewerKey(env = process.env) {
  const file = join(runtimeDirFromEnv(env), 'lan-viewer-key')
  rmSync(file, { force: true })
  return file
}

function isMainModule() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  if (process.argv.slice(2).includes('--rotate')) {
    const file = rotateViewerKey()
    console.log(`Deleted ${file}: this start mints a new viewer key (an office already running keeps the old one until it restarts).`)
  }
  process.env.AGENT_OFFICE_LAN = '1'
  // Imported after the env is set; the module binds nothing until start()
  const { start } = await import('../server/index.js')
  start()
}
