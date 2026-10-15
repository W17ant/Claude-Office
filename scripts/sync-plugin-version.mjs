#!/usr/bin/env node
/**
 * Copy package.json's version into .claude-plugin/plugin.json.
 *
 * `npm version` runs this as the "version" script, after it has bumped
 * package.json and before it commits, so one `npm version minor` moves both
 * files and the tag together (tests/plugin.test.ts fails when they differ,
 * and the release workflow names the GitHub release after package.json).
 * Only the version line is rewritten: the manifest keeps its own formatting,
 * such as the one-line keywords array. An optional directory argument points
 * it at another checkout; the tests run it against a scratch copy.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.argv[2] ? resolve(process.argv[2]) : join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const file = join(root, '.claude-plugin', 'plugin.json')
const before = readFileSync(file, 'utf8')

const after = before.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`)
if (after === before && !before.includes(`"version": "${version}"`)) {
  console.error(`sync-plugin-version: no "version" line found in ${file}`)
  process.exit(1)
}
if (after !== before) {
  writeFileSync(file, after)
}
console.log(`sync-plugin-version: .claude-plugin/plugin.json is at ${version}`)
