/**
 * index.js - the registry of other AI tools the office can show (POST /hook/:tool).
 *
 * Each entry is a translator module: { id, label, translate(payload, event) }.
 * Adding a tool = one file here, one fixture folder in tests/fixtures/tools/,
 * one test in tests/tool-translators.test.ts.
 */

import antigravity from './antigravity.js'
import codex from './codex.js'
import gemini from './gemini.js'
import kimi from './kimi.js'
import opencode from './opencode.js'

/** Tool id -> translator module. */
export const TOOLS = Object.freeze({
  [codex.id]: codex,
  [gemini.id]: gemini,
  [antigravity.id]: antigravity,
  [kimi.id]: kimi,
  [opencode.id]: opencode,
})

/**
 * Translate one raw hook payload from a tool.
 * @param {string} tool  the tool id from the route
 * @param {unknown} payload  the raw payload
 * @param {string} [event]  the hook event name, when the relay passed one
 * @returns {object[] | null} office events ([] when not understood), or null for an unknown tool
 */
export function translateFor(tool, payload, event) {
  if (!Object.hasOwn(TOOLS, tool)) return null
  return TOOLS[tool].translate(payload, typeof event === 'string' ? event : undefined)
}
