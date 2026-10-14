/**
 * hooks/install-hooks.sh — registers agent-tracker.sh in ~/.claude/settings.json,
 * and repoints entries left behind by a checkout that moved.
 * Runs the real script with HOME pointed at a temp dir.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const INSTALLER = fileURLToPath(new URL('../hooks/install-hooks.sh', import.meta.url))
const TRACKER_SCRIPT = fileURLToPath(new URL('../hooks/agent-tracker.sh', import.meta.url))
const EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'SessionStart', 'SessionEnd'] as const
const TRACKER_COMMAND = /^bash ".*\/hooks\/agent-tracker\.sh"$/
/** What the installer writes for an event when nothing of ours was there */
const OUR_GROUP = { matcher: '', hooks: [{ type: 'command', command: expect.stringMatching(TRACKER_COMMAND) }] }
/** A tracker hook as a user might have written it by hand for a checkout that is gone */
const stale = (path = '/old/moved/path') => ({ type: 'command', command: `bash "${path}/hooks/agent-tracker.sh"` })

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
  it('creates settings.json with PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop, SessionStart and SessionEnd on a fresh HOME', () => {
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

    // The old PostToolUse entry is recognised by script name and repointed at this checkout (its old path is gone)
    expect(settings.hooks.PostToolUse).toEqual([OUR_GROUP])
    expect(out).toContain('[update] PostToolUse (was /old/checkout/hooks/agent-tracker.sh)')
    // Untouched: hooks that are not ours and unrelated keys
    expect(settings.hooks.Stop).toEqual(old.hooks.Stop)
    expect(settings.permissions).toEqual(old.permissions)

    // Added: every other event, SubagentStart, PostToolUseFailure, SessionStart and SessionEnd included
    for (const event of EVENTS.filter(e => e !== 'PostToolUse')) {
      expect(trackerGroups(settings, event)).toEqual([OUR_GROUP])
      expect(out).toContain(`[add]  ${event}`)
    }
  })

  it('repoints every entry that names a checkout that moved, keeps foreign hooks where they were and adds nothing twice', () => {
    const home = freshHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo foreign' }] }
    const old: any = { hooks: {} }
    for (const event of EVENTS) old.hooks[event] = [{ matcher: '', hooks: [stale()] }]
    // Two of the events also carry hooks that are not ours: a group of their own, and one sharing our group
    old.hooks.PreToolUse = [foreign, { matcher: '', hooks: [stale()] }]
    old.hooks.PostToolUse = [{ matcher: '', hooks: [{ type: 'command', command: 'echo first' }, stale()] }]
    writeFileSync(settingsPath(home), JSON.stringify(old, null, 2))

    const out = runInstaller(home)
    const settings = readSettings(home)

    expect(readFileSync(settingsPath(home), 'utf8')).not.toContain('/old/moved/path')
    for (const event of EVENTS) {
      expect(trackerGroups(settings, event)).toHaveLength(1)
      expect(out).toContain(`[update] ${event} (was /old/moved/path/hooks/agent-tracker.sh)`)
    }
    expect(settings.hooks.PreToolUse).toEqual([foreign, OUR_GROUP])
    expect(settings.hooks.PostToolUse).toEqual([
      { matcher: '', hooks: [{ type: 'command', command: 'echo first' }, { type: 'command', command: expect.stringMatching(TRACKER_COMMAND) }] },
    ])
    for (const event of EVENTS) {
      expect(out).not.toContain(`[add]  ${event}`)
      expect(out).not.toContain(`[skip] ${event}`)
    }
    expect(out).toContain('hooks: 0 added, 7 repointed at this checkout, 0 unchanged')
    expect(out).toContain('Installation complete!')

    // Repaired once, a re-run has nothing left to do
    const before = readFileSync(settingsPath(home))
    const again = runInstaller(home)
    expect(readFileSync(settingsPath(home)).equals(before)).toBe(true)
    for (const event of EVENTS) expect(again).toContain(`[skip] ${event} already registered`)
    expect(again).toContain('hooks: 0 added, 0 repointed at this checkout, 7 unchanged')
  })

  it('leaves an entry that already points at this checkout alone, however it was quoted', () => {
    const home = freshHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    const mine = { matcher: '', hooks: [{ type: 'command', command: `bash ${TRACKER_SCRIPT}` }] }
    writeFileSync(settingsPath(home), JSON.stringify({ hooks: { PreToolUse: [mine] } }))

    const out = runInstaller(home)
    expect(readSettings(home).hooks.PreToolUse).toEqual([mine])
    expect(out).toContain('[skip] PreToolUse already registered')
    expect(out).not.toContain('[update] PreToolUse')
  })

  it('drops a second office entry for the same event, so a repaired install never reports a tool call twice', () => {
    const home = freshHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsPath(home), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '', hooks: [stale('/old/a')] }, { matcher: '', hooks: [stale('/old/b')] }] },
    }))

    const out = runInstaller(home)
    expect(readSettings(home).hooks.PreToolUse).toEqual([OUR_GROUP])
    expect(out).toContain('[update] PreToolUse (was /old/a/hooks/agent-tracker.sh)')
    expect(out).toContain('[drop] PreToolUse duplicate office entry (was /old/b/hooks/agent-tracker.sh)')
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

describe('install-hooks.sh: shapes Claude Code would reject do not crash the merge', () => {
  it.each([
    ['an empty array', []],
    ['null', null],
    ['a string', 'nope'],
  ])('"hooks" given as %s is replaced with an object, with a warning, and the rest of the file is kept', (_label, hooks) => {
    const home = freshHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsPath(home), JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks }))

    const out = runInstaller(home)
    const settings = readSettings(home)
    expect(out).toContain('[warn] "hooks" is a JSON')
    expect(out).not.toMatch(/Traceback|AttributeError/)
    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'] })
    expect(Object.keys(settings.hooks).sort()).toEqual([...EVENTS].sort())
    for (const event of EVENTS) expect(trackerGroups(settings, event)).toEqual([OUR_GROUP])
  })

  it('wraps an event given as one object in a list, keeps entries that are not objects, and still repairs ours', () => {
    const home = freshHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo foreign' }] }
    writeFileSync(settingsPath(home), JSON.stringify({
      hooks: {
        PreToolUse: foreign,
        PostToolUse: { matcher: '', hooks: ['junk', stale()] },
        SubagentStop: ['junk', 42, { matcher: '', hooks: [stale()] }],
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      },
    }))

    const out = runInstaller(home)
    const settings = readSettings(home)
    expect(out).toContain('[warn] "hooks.PreToolUse" is a single object, wrapped in a list')
    expect(settings.hooks.PreToolUse).toEqual([foreign, OUR_GROUP])
    expect(settings.hooks.PostToolUse).toEqual([{ matcher: '', hooks: ['junk', { type: 'command', command: expect.stringMatching(TRACKER_COMMAND) }] }])
    expect(settings.hooks.SubagentStop).toEqual(['junk', 42, OUR_GROUP])
    expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'say done' }] }])
    expect(out).toContain('[update] PostToolUse (was /old/moved/path/hooks/agent-tracker.sh)')
    expect(out).toContain('[update] SubagentStop (was /old/moved/path/hooks/agent-tracker.sh)')
    for (const event of EVENTS) expect(trackerGroups(settings, event)).toHaveLength(1)
  })
})

describe('install-hooks.sh: status line (payroll / electricity / memory)', () => {
  const STATUS_COMMAND = /^bash ".*\/hooks\/status-line\.sh"$/
  const SUBAGENT_COMMAND = /^bash ".*\/hooks\/status-line\.sh" --subagents$/

  function runWith(home: string, args: string[] = []) {
    return execFileSync('bash', [INSTALLER, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, AGENT_OFFICE_HOME: join(home, '.agent-office') },
    })
  }

  it('registers statusLine (padding 0) and subagentStatusLine next to the hooks on a fresh HOME', () => {
    const home = freshHome()
    const out = runWith(home)
    const settings = readSettings(home)
    expect(settings.statusLine).toEqual({ type: 'command', command: expect.stringMatching(STATUS_COMMAND), padding: 0 })
    expect(settings.subagentStatusLine).toEqual({ type: 'command', command: expect.stringMatching(SUBAGENT_COMMAND) })
    expect(out).toContain('[add]  statusLine')
    expect(out).toContain('[add]  subagentStatusLine')
    for (const event of EVENTS) expect(trackerGroups(settings, event)).toHaveLength(1)
    // Nothing was wrapped, so no previous command is saved
    expect(existsSync(join(home, '.agent-office', 'statusline-prev'))).toBe(false)
  })

  it('wraps a status line that was already there: saves its command for chaining, keeps its padding/refreshInterval, says so', () => {
    const home = freshHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsPath(home), JSON.stringify({
      statusLine: { type: 'command', command: '~/.claude/statusline.sh', padding: 2, refreshInterval: 5 },
      subagentStatusLine: { type: 'command', command: 'jq -c \'.tasks[] | {id, content: .label}\'' },
    }, null, 2))

    const out = runWith(home)
    const settings = readSettings(home)
    expect(settings.statusLine).toEqual({ type: 'command', command: expect.stringMatching(STATUS_COMMAND), padding: 2, refreshInterval: 5 })
    expect(settings.subagentStatusLine).toEqual({ type: 'command', command: expect.stringMatching(SUBAGENT_COMMAND) })
    expect(readFileSync(join(home, '.agent-office', 'statusline-prev'), 'utf8')).toBe('~/.claude/statusline.sh\n')
    expect(readFileSync(join(home, '.agent-office', 'subagent-statusline-prev'), 'utf8')).toBe('jq -c \'.tasks[] | {id, content: .label}\'\n')
    expect(out).toContain('[wrap] statusLine')
    expect(out).toContain('~/.claude/statusline.sh')
    expect(out).toContain('[wrap] subagentStatusLine')
  })

  it('repoints the office status line from a checkout that moved, keeping its options and chained command, and leaves it alone on a second run', () => {
    const home = freshHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, '.agent-office'), { recursive: true })
    // An earlier install wrapped the user's own status line; its command is what status-line.sh chains
    writeFileSync(join(home, '.agent-office', 'statusline-prev'), '~/.claude/statusline.sh\n')
    writeFileSync(settingsPath(home), JSON.stringify({
      statusLine: { type: 'command', command: 'bash /old/checkout/hooks/status-line.sh', padding: 2, refreshInterval: 5 },
      subagentStatusLine: { type: 'command', command: 'bash "/old/checkout/hooks/status-line.sh" --subagents' },
    }))

    const first = runWith(home)
    const settings = readSettings(home)
    expect(settings.statusLine).toEqual({ type: 'command', command: expect.stringMatching(STATUS_COMMAND), padding: 2, refreshInterval: 5 })
    expect(settings.subagentStatusLine).toEqual({ type: 'command', command: expect.stringMatching(SUBAGENT_COMMAND) })
    expect(first).toContain('[update] statusLine (was /old/checkout/hooks/status-line.sh)')
    expect(first).toContain('[update] subagentStatusLine (was /old/checkout/hooks/status-line.sh)')
    expect(first).not.toContain('[wrap]')
    // The chained command is still the user's own, not the stale office command
    expect(readFileSync(join(home, '.agent-office', 'statusline-prev'), 'utf8')).toBe('~/.claude/statusline.sh\n')
    expect(existsSync(join(home, '.agent-office', 'subagent-statusline-prev'))).toBe(false)

    const before = readFileSync(settingsPath(home))
    const second = runWith(home)
    expect(readFileSync(settingsPath(home)).equals(before)).toBe(true)
    expect(second).toContain('[skip] statusLine already registered')
    expect(second).toContain('[skip] subagentStatusLine already registered')
  })

  it('recognises the office status line by path, not by spelling: an unquoted command for this checkout is left alone', () => {
    const home = freshHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    const statusScript = INSTALLER.replace(/install-hooks\.sh$/, 'status-line.sh')
    writeFileSync(settingsPath(home), JSON.stringify({ statusLine: { type: 'command', command: `bash ${statusScript}`, padding: 0 } }))

    const out = runWith(home)
    expect(readSettings(home).statusLine).toEqual({ type: 'command', command: `bash ${statusScript}`, padding: 0 })
    expect(out).toContain('[skip] statusLine already registered')
  })

  it('--no-status-line registers the hooks only', () => {
    const home = freshHome()
    const out = runWith(home, ['--no-status-line'])
    const settings = readSettings(home)
    expect(settings).not.toHaveProperty('statusLine')
    expect(settings).not.toHaveProperty('subagentStatusLine')
    for (const event of EVENTS) expect(trackerGroups(settings, event)).toHaveLength(1)
    expect(out).toContain('[skip]')
    expect(out).toContain('--no-status-line')
  })
})
