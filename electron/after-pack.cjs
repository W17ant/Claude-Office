'use strict'

/**
 * electron-builder `afterPack` hook: check and trim the packaged copy of
 * better-sqlite3.
 *
 * better-sqlite3 13 is a Node-API addon: one prebuilt per platform and
 * architecture ships inside the npm package (`prebuilds/<target>.node`), and
 * the same file loads on the system Node (tests, `node server/index.js`, the
 * Vite dev flow) and on the Node bundled inside Electron (ELECTRON_RUN_AS_NODE,
 * see main.cjs). So nothing is downloaded or swapped at pack time — the hook
 * only makes sure the bundle holds the binary for what is being packaged,
 * and nothing that would be loaded in its place:
 *
 *   1. `build/` goes: better-sqlite3 loads a locally compiled
 *      `build/{Debug,Release}/better_sqlite3.node` before any prebuilt, and a
 *      binary compiled on the build machine is not what this hook vouches for.
 *   2. `prebuilds/<platform>-<arch>.node` must exist (and its musl twin on
 *      Linux is kept, since the loader picks by the libc it finds at run time).
 *   3. Every other platform's prebuilt is removed — about 14 MB per bundle.
 */

const fs = require('fs')
const path = require('path')
const { Arch } = require('electron-builder')

const MODULE = 'better-sqlite3'

/**
 * The prebuilt file names better-sqlite3's loader (lib/binding.js) may pick
 * for a platform and architecture.
 * @param {string} platform  'darwin' | 'win32' | 'linux'
 * @param {string} arch      'x64' | 'arm64'
 * @returns {string[]} the first is required, the rest kept when present
 */
function prebuildNames(platform, arch) {
  // Why the musl twin on Linux: the loader reads /proc/self/maps at run time
  // to choose between them, and the bundle cannot know which libc it lands on.
  if (platform === 'linux') return [`linux-${arch}.node`, `linuxmusl-${arch}.node`]
  return [`${platform}-${arch}.node`]
}

module.exports = async function afterPack(context) {
  const { packager, appOutDir, arch, electronPlatformName } = context
  const archName = Arch[arch]
  if (archName === 'universal') {
    // Why refuse: pruning leaves one architecture's binary per bundle, and a
    // universal merge needs the arm64 and x64 bundles to agree file for file.
    throw new Error(`[after-pack] ${MODULE}: a universal macOS build is not supported; build x64 and arm64 separately`)
  }

  const moduleDir = path.join(packager.getResourcesDir(appOutDir), 'app', 'node_modules', MODULE)
  if (!fs.existsSync(path.join(moduleDir, 'package.json'))) {
    throw new Error(`[after-pack] ${MODULE} not found at ${moduleDir} — is "asar" off and ${MODULE} a production dependency?`)
  }

  fs.rmSync(path.join(moduleDir, 'build'), { recursive: true, force: true })

  const prebuildDir = path.join(moduleDir, 'prebuilds')
  const [required, ...optional] = prebuildNames(electronPlatformName, archName)
  if (!fs.existsSync(path.join(prebuildDir, required))) {
    throw new Error(`[after-pack] ${MODULE} has no prebuilt ${required} at ${prebuildDir}`)
  }

  const keep = new Set([required, ...optional])
  const removed = []
  for (const name of fs.readdirSync(prebuildDir)) {
    if (keep.has(name)) continue
    fs.rmSync(path.join(prebuildDir, name), { recursive: true, force: true })
    removed.push(name)
  }
  console.log(`  • after-pack  ${MODULE}: kept prebuilds/${[...keep].filter((n) => fs.existsSync(path.join(prebuildDir, n))).join(', ')}; removed ${removed.length} other platform(s)`)
}

module.exports.prebuildNames = prebuildNames
