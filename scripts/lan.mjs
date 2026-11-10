#!/usr/bin/env node
/**
 * lan.mjs - `npm run lan`: start the office with phone mode's LAN listener (watch-only, or `--full` over HTTPS).
 *
 * The same server as `npm run server` (loopback 127.0.0.1:3334, unchanged),
 * plus a second listener on this machine's private Wi-Fi address (port 3335,
 * AGENT_OFFICE_LAN_PORT). Without a flag that listener is watch-only over
 * plain HTTP: it serves the office scene to a phone holding the viewer key.
 * The server prints the phone link and a QR code of it. See
 * docs/reference.md › Phone mode for what the phone can and cannot see.
 *
 *   --full    serve the full office instead (chat, permission cards that can
 *             be answered, meters, settings, inspector), over HTTPS only,
 *             with a certificate made on this machine and its own phone
 *             secret. The server also prints the certificate's SHA-256
 *             fingerprint: compare it with what the phone shows on its
 *             one-time certificate warning. Never the default.
 *   --rotate  forget the viewer key and the phone secret first, so this
 *             start mints new ones (phones holding an old link stop getting
 *             the office)
 *
 * Equivalent to AGENT_OFFICE_LAN=1 node server/index.js (or
 * AGENT_OFFICE_LAN=full for --full), which is what to set for start-office.sh
 * or any other launcher.
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

/**
 * Delete the phone secret file; the next full-mode start writes a new
 * secret, and a phone holding the old link is refused (401) from then on.
 * The certificate is left alone: it holds no secret a phone was given, and a
 * new one would only make every phone warn again.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} the file removed
 */
export function rotatePhoneSecret(env = process.env) {
  const file = join(runtimeDirFromEnv(env), 'lan-phone-secret')
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
  const args = process.argv.slice(2)
  if (args.includes('--rotate')) {
    // Why both, whichever mode starts: one flag that means "every phone link
    // I ever handed out is dead" is harder to get wrong than two
    const files = [rotateViewerKey(), rotatePhoneSecret()]
    console.log(`Deleted ${files.join(' and ')}: this start mints what it needs anew (an office already running keeps the old ones until it restarts).`)
  }
  // Why set outright rather than read: full mode is asked for on this command
  // line or not at all, so a stray AGENT_OFFICE_LAN=full in the shell cannot
  // turn plain `npm run lan` into it
  process.env.AGENT_OFFICE_LAN = args.includes('--full') ? 'full' : '1'
  // Imported after the env is set; the module binds nothing until start()
  const { start } = await import('../server/index.js')
  start()
}
