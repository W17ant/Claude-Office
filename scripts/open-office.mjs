#!/usr/bin/env node
/**
 * open-office.mjs — `npm run open`: open the office with its token.
 *
 * The office page shows prompts, replies and command lines, and may answer
 * permission dialogs, only once it presents the office token — the contents
 * of the 0600 auth-token file only this user can read (README › Security).
 * It learns the token from the link
 *
 *   http://127.0.0.1:<AGENT_OFFICE_PORT>/#token=<token>
 *
 * which this script prints and opens. The browser keeps the token (per
 * browser profile) and drops it from the address bar, and the server keeps
 * the same token across restarts, so this is needed once per browser.
 *
 * The browser is not handed the link itself: an opener's command line, and
 * that of a browser it starts, is readable by every local user (`ps`,
 * /proc/<pid>/cmdline) while it runs. It gets a redirect page written to the
 * runtime dir (mode 0600, in the 0700 dir), whose path is no secret — the
 * way Jupyter opens a notebook. A browser that cannot read that folder
 * (Snap-confined browsers cannot read hidden folders in the home dir) shows
 * an error page; then paste the printed link instead.
 *
 * Reads AGENT_OFFICE_PORT (default 3334), AGENT_OFFICE_UI_PORT (default
 * 3333) and AGENT_OFFICE_HOME (default ~/.agent-office).
 *
 *   --dev    the Vite dev server's page (http://localhost:<UI port>/), the
 *            one start-office.sh runs; also used when the server says its
 *            UI is not built
 *   --print  print the link, open nothing
 *
 * Exit 0 when the link was printed (opened, or not when no opener works —
 * the link is there to paste), 1 when there is no token or no server.
 */

import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import helpers from '../electron/helpers.cjs'
import { readPort, readUiPort } from '../server/config.js'

const { runtimeDirFromEnv, readOfficeToken, officeLink, writeRedirectPage, officeProofMatches, healthChallenge } = helpers

export const REDIRECT_FILE_NAME = 'open-office.html'

/** The opener for this platform: [command, args] that open `target` in the default app. */
export function openerFor(platform, target) {
  if (platform === 'darwin') return ['open', [target]]
  if (platform === 'win32') return ['explorer.exe', [target]]
  return ['xdg-open', [target]]
}

/** GET /health within `timeoutMs`: its JSON, or null when the server does not answer. */
/**
 * GET /health with a fresh challenge. Returns null when nothing answers,
 * else the health record with `proven`: whether the answer carries the
 * proof only a holder of `token` can make (server/index.js officeProof).
 */
async function health(port, token, timeoutMs = 1500) {
  const challenge = healthChallenge()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health?challenge=${challenge}`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const body = await res.json()
    return { ...body, proven: officeProofMatches(token, challenge, body?.proof) }
  } catch {
    return null
  }
}


/**
 * Run the opener and wait a moment for its verdict: a quick non-zero exit
 * (or no such program) is a failure; still running after `graceMs` (an
 * xdg-open that waits on the browser it started) counts as opened.
 */
function runOpener(command, args, env, graceMs = 3000) {
  return new Promise(resolve => {
    let settled = false
    const done = ok => { if (!settled) { settled = true; resolve(ok) } }
    let child
    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true, env })
    } catch {
      done(false)
      return
    }
    child.once('error', () => done(false))
    child.once('exit', code => done(code === 0))
    setTimeout(() => { child.unref(); done(true) }, graceMs).unref()
  })
}

/**
 * Print (and unless `print`, open) the office link. `out` / `err` are the
 * streams to write to; returns the exit code.
 */
export async function openOffice({ env = process.env, platform = process.platform, dev = false, print = false, out = process.stdout, err = process.stderr } = {}) {
  const runtimeDir = runtimeDirFromEnv(env)
  const tokenFile = join(runtimeDir, 'auth-token')
  const port = readPort(env, { warn: m => err.write(`${m}\n`) })
  const uiPort = readUiPort(env, { warn: m => err.write(`${m}\n`) })

  const token = readOfficeToken(tokenFile)
  if (!token) {
    err.write(`No office token in ${tokenFile}: the server writes it when it starts.\n`)
    err.write('Start the office first (npm run server, bash scripts/start-office.sh or the desktop app), then run npm run open again.\n')
    return 1
  }

  const status = await health(port, token)
  // Something answers on the port but cannot prove it holds the token: a
  // process that took the port while the office was down. Never hand it the
  // link (the page would give it the token from the fragment)
  if (status && !status.proven) {
    err.write(`Something is answering on port ${port}, but it is not this office: it could not prove it holds your token, so the link was not opened or printed. Stop whatever holds the port, start the office, and run npm run open again.\n`)
    return 1
  }
  // The server's own page needs a built UI; without one the Vite dev server serves it
  const useVite = dev || (status && status.uiAvailable === false)
  const base = useVite ? `http://127.0.0.1:${uiPort}` : `http://127.0.0.1:${port}`
  const link = officeLink(base, token)
  out.write(`Agent Office: ${link}\n`)
  if (!status) {
    err.write(`The office server is not answering on port ${port}. Start it (npm run server or bash scripts/start-office.sh); the link works once it is up — the token stays the same across restarts.\n`)
    return 1
  }
  if (print) return 0

  let target
  try {
    target = pathToFileURL(writeRedirectPage(join(runtimeDir, REDIRECT_FILE_NAME), link)).href
  } catch (e) {
    err.write(`Could not write the redirect page (${e.message}): open the link above yourself.\n`)
    return 0
  }
  const [command, args] = openerFor(platform, target)
  if (await runOpener(command, args, env)) {
    out.write(`Opened it in your browser (via ${fileURLToPath(target)}).\n`)
  } else {
    err.write('Could not open a browser automatically: open the link above yourself.\n')
  }
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
  const argv = process.argv.slice(2)
  openOffice({ dev: argv.includes('--dev'), print: argv.includes('--print') }).then(code => process.exit(code))
}
