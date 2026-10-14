'use strict'

/**
 * electron-builder `afterPack` hook: give the packaged copy of better-sqlite3
 * the binary built for Electron's Node.
 *
 * The checkout's node_modules stay built for the system Node — `npmRebuild`
 * is off in package.json — so `npm test`, `node server/index.js` and the Vite
 * dev flow keep working after a pack. The packaged server runs on the Node
 * bundled inside Electron (ELECTRON_RUN_AS_NODE, see main.cjs), whose ABI is
 * different, so only the copy inside the app bundle is swapped, using
 * better-sqlite3's own prebuild-install against the Electron version and
 * architecture being packaged. No network: the same prebuilt download
 * electron-builder's rebuild would make, into the bundle instead of the repo.
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { Arch } = require('electron-builder')

const MODULE = 'better-sqlite3'

module.exports = async function afterPack(context) {
  const { packager, appOutDir, arch } = context
  const archName = Arch[arch]
  if (archName === 'universal') {
    throw new Error(`[after-pack] ${MODULE}: a universal macOS build needs one prebuilt per architecture; build x64 and arm64 separately`)
  }

  const electronVersion = packager.info.framework.version
  const moduleDir = path.join(packager.getResourcesDir(appOutDir), 'app', 'node_modules', MODULE)
  if (!fs.existsSync(path.join(moduleDir, 'package.json'))) {
    throw new Error(`[after-pack] ${MODULE} not found at ${moduleDir} — is "asar" off and ${MODULE} a production dependency?`)
  }

  console.log(`  • after-pack  fetching ${MODULE} prebuilt for electron@${electronVersion} ${archName} into ${path.relative(process.cwd(), moduleDir)}`)

  const result = spawnSync(
    process.execPath,
    [
      require.resolve('prebuild-install/bin.js'),
      '--runtime', 'electron',
      '--target', electronVersion,
      '--arch', archName,
      '--verbose',
    ],
    { cwd: moduleDir, stdio: 'inherit' },
  )
  if (result.status !== 0) {
    throw new Error(`[after-pack] prebuild-install failed for ${MODULE} (electron@${electronVersion} ${archName}, exit ${result.status})`)
  }
}
