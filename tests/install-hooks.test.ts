/**
 * hooks/install-hooks.sh — registers agent-tracker.sh in ~/.claude/settings.json.
 * Runs the real script with HOME pointed at a temp dir.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const INSTALLER = fileURLToPath(new URL('../hooks/install-hooks.sh', import.meta.url))
const EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop'] as const
const TRACKER_COMMAND = /^bash ".*\/hooks\/agent-tracker\.sh"$/

const homes: string[] = []
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true })
})

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'agent-office-home-'))
  homes.push(home)
  return home
}

function runInstaller(home: string) {
  return execFileSync('bash', [INSTALLER], { encoding: 'utf8', env: { ...process.env, HOME: home } })
}

const settingsPath = (home: string) => join(home, '.claude', 'settings.json')
const readSettings = (home: string) => JSON.parse(readFileSync(settingsPath(home), 'utf8'))

/** Hook groups for an event that run agent-tracker.sh */
function trackerGroups(settings: any, event: string) {
  return (settings.hooks?.[event] ?? []).filter((g: any) =>
    (g.hooks ?? []).some((h: any) => typeof h.command === 'string' && h.command.includes('agent-tracker.sh')),
  )
}

describe('install-hooks.sh', () => {
  it('creates settings.json with PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart and SubagentStop on a fresh HOME', () => {
    const home = freshHome()
    const out = runInstaller(home)

    expect(existsSync(settingsPath(home))).toBe(true)
    const settings = readSettings(home)
    expect(Object.keys(settings.hooks).sort()).toEqual([...EVENTS].sort())
    for (const event of EVENTS) {
      const groups = trackerGroups(settings, event)
      expect(groups).toHaveLength(1)
      expect(groups[0]).toEqual({ matcher: '', hooks: [{ type: 'command', command: expect.stringMatching(TRACKER_COMMAND) }] })
      expect(out).toContain(`[add]  ${event}`)
    }

    // A backup is taken before writing
    expect(readdirSync(join(home, '.claude')).some(f => f.startsWith('settings.json.backup.'))).toBe(true)
  })

  it('adds the missing events to an older install that only had PostToolUse, keeping everything else', () => {
    const home = freshHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    const old = {
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'bash /old/checkout/hooks/agent-tracker.sh' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      },
    }
    writeFileSync(settingsPath(home), JSON.stringify(old, null, 2))

    const out = runInstaller(home)
    const settings = readSettings(home)

    // Untouched: the old PostToolUse entry (recognised by script name, not path) and unrelated keys
    expect(settings.hooks.PostToolUse).toEqual(old.hooks.PostToolUse)
    expect(settings.hooks.Stop).toEqual(old.hooks.Stop)
    expect(settings.permissions).toEqual(old.permissions)
    expect(out).toContain('[skip] PostToolUse already registered')

    // Added: every other event, SubagentStart and PostToolUseFailure included
    for (const event of EVENTS.filter(e => e !== 'PostToolUse')) {
      expect(trackerGroups(settings, event)).toEqual([
        { matcher: '', hooks: [{ type: 'command', command: expect.stringMatching(TRACKER_COMMAND) }] },
      ])
      expect(out).toContain(`[add]  ${event}`)
    }
  })

  it('is a no-op on a second run', () => {
    const home = freshHome()
    runInstaller(home)
    const before = readFileSync(settingsPath(home))

    const out = runInstaller(home)
    const after = readFileSync(settingsPath(home))

    expect(after.equals(before)).toBe(true)
    for (const event of EVENTS) expect(out).toContain(`[skip] ${event} already registered`)
    expect(out).not.toContain('[add]')
  })

  it('treats an unparseable settings file as empty', () => {
    const home = freshHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsPath(home), '{ this is not json')

    runInstaller(home)
    const settings = readSettings(home)
    for (const event of EVENTS) expect(trackerGroups(settings, event)).toHaveLength(1)
  })
})
