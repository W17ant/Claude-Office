/**
 * hooks/install-hooks.sh — registers agent-tracker.sh in ~/.claude/settings.json,
 * repoints entries left behind by a checkout that moved, and takes it all back out with --uninstall.
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
/** Every event the installer registers: workers, sessions, and the main thread's turn (prompt, reply, needs-you, errors, compaction). */
const EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop',
  'SessionStart', 'SessionEnd',
  'UserPromptSubmit', 'Stop', 'PermissionRequest', 'Notification', 'StopFailure', 'PreCompact', 'PostCompact',
  'PostToolBatch', 'CwdChanged', 'PostModelSwitch',
] as const
/** The ones added for the main thread (F01/F02); an older install lacks exactly these. */
const TURN_EVENTS = [
  'UserPromptSubmit', 'Stop', 'PermissionRequest', 'Notification', 'StopFailure', 'PreCompact', 'PostCompact',
  'PostToolBatch', 'CwdChanged', 'PostModelSwitch',
] as const
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
  it('creates settings.json with all 17 events (workers, sessions, the main thread\'s turn) on a fresh HOME', () => {
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
    // Untouched: a Stop hook that is not ours keeps its place (ours is added after it) and unrelated keys
    expect(settings.hooks.Stop).toEqual([...old.hooks.Stop, OUR_GROUP])
    expect(settings.permissions).toEqual(old.permissions)

    // Added: every other event, SubagentStart, PostToolUseFailure, SessionStart and SessionEnd included
    for (const event of EVENTS.filter(e => e !== 'PostToolUse')) {
      expect(trackerGroups(settings, event)).toEqual([OUR_GROUP])
      expect(out).toContain(`[add]  ${event}`)
    }
  })

  it('adds the ten main-thread events to an install that predates them and leaves the seven it had alone', () => {
    const home = freshHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    const older = EVENTS.filter(e => !(TURN_EVENTS as readonly string[]).includes(e))
    const settings: any = { hooks: {} }
    for (const event of older) settings.hooks[event] = [{ matcher: '', hooks: [{ type: 'command', command: `bash "${TRACKER_SCRIPT}"` }] }]
    writeFileSync(settingsPath(home), JSON.stringify(settings, null, 2))

    const out = runInstaller(home)
    const after = readSettings(home)
    expect(Object.keys(after.hooks).sort()).toEqual([...EVENTS].sort())
    for (const event of older) {
      expect(after.hooks[event]).toEqual(settings.hooks[event])
      expect(out).toContain(`[skip] ${event} already registered`)
    }
    for (const event of TURN_EVENTS) {
      expect(after.hooks[event]).toEqual([OUR_GROUP])
      expect(out).toContain(`[add]  ${event}`)
    }
    expect(out).toContain('hooks: 10 added, 0 repointed at this checkout, 7 unchanged')
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
    expect(out).toContain(`hooks: 0 added, ${EVENTS.length} repointed at this checkout, 0 unchanged`)
    expect(out).toContain('Installation complete!')

    // Repaired once, a re-run has nothing left to do
    const before = readFileSync(settingsPath(home))
    const again = runInstaller(home)
    expect(readFileSync(settingsPath(home)).equals(before)).toBe(true)
    for (const event of EVENTS) expect(again).toContain(`[skip] ${event} already registered`)
    expect(again).toContain(`hooks: 0 added, 0 repointed at this checkout, ${EVENTS.length} unchanged`)
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
    // Stop is one of ours too now: the foreign hook stays first, ours is appended
    expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'say done' }] }, OUR_GROUP])
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

describe('install-hooks.sh --uninstall', () => {
  const env = (home: string) => ({ ...process.env, HOME: home, AGENT_OFFICE_HOME: join(home, '.agent-office') })
  const install = (home: string, args: string[] = []) => execFileSync('bash', [INSTALLER, ...args], { encoding: 'utf8', env: env(home) })
  const uninstall = (home: string, args: string[] = []) => execFileSync('bash', [INSTALLER, '--uninstall', ...args], { encoding: 'utf8', env: env(home) })
  /** Writes settings.json the way the installer does (two-space indent, trailing newline), so a put-back file can be compared byte for byte */
  function writeSettings(home: string, settings: unknown) {
    mkdirSync(join(home, '.claude'), { recursive: true })
    const text = JSON.stringify(settings, null, 2) + '\n'
    writeFileSync(settingsPath(home), text)
    return text
  }
  const readText = (home: string) => readFileSync(settingsPath(home), 'utf8')
  const backups = (home: string) => readdirSync(join(home, '.claude')).filter(f => f.startsWith('settings.json.backup.'))
  const prevFile = (home: string, name: string) => join(home, '.agent-office', name)
  const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo foreign' }] }
  const foreignStop = { hooks: [{ type: 'command', command: 'say done' }] }

  it('after an install on a fresh HOME, removes all 17 events and both status lines and leaves {}', () => {
    const home = freshHome()
    install(home)
    expect(readSettings(home).statusLine).toBeDefined()

    const out = uninstall(home)
    expect(readText(home)).toBe('{}\n')
    for (const event of EVENTS) expect(out).toContain(`[remove] ${event} (`)
    expect(out).toContain(`hooks: ${EVENTS.length} office entries removed`)
    expect(out).toContain('[remove] statusLine (was ')
    expect(out).toContain('[remove] subagentStatusLine (was ')
    expect(out).toContain('Uninstall complete')
    expect(out).toMatch(/backup saved: .*settings\.json\.backup\./)
  })

  it('install then uninstall gives a file with unrelated settings back byte for byte', () => {
    const home = freshHome()
    const before = writeSettings(home, { permissions: { allow: ['Bash(ls:*)'] }, model: 'opus' })
    install(home)
    expect(Object.keys(readSettings(home).hooks)).toHaveLength(EVENTS.length)

    uninstall(home)
    expect(readText(home)).toBe(before)
  })

  it('puts back a status line the install wrapped (command, padding, refreshInterval) and keeps foreign hooks where they were, byte for byte', () => {
    const home = freshHome()
    const before = writeSettings(home, {
      hooks: { PreToolUse: [foreign], Stop: [foreignStop] },
      statusLine: { type: 'command', command: '~/.claude/statusline.sh', padding: 2, refreshInterval: 5 },
      subagentStatusLine: { type: 'command', command: 'jq -c \'.tasks[] | {id, content: .label}\'' },
    })
    const installed = install(home)
    expect(installed).toContain('[wrap] statusLine')
    expect(existsSync(prevFile(home, 'statusline-prev'))).toBe(true)
    expect(existsSync(prevFile(home, 'subagent-statusline-prev'))).toBe(true)
    expect(readSettings(home).hooks.PreToolUse).toHaveLength(2)

    const out = uninstall(home)
    expect(readText(home)).toBe(before)
    expect(out).toContain('[restore] statusLine: ~/.claude/statusline.sh')
    expect(out).toContain('[restore] subagentStatusLine: jq -c \'.tasks[] | {id, content: .label}\'')
    // The saved commands are back in settings.json, so the files go
    expect(existsSync(prevFile(home, 'statusline-prev'))).toBe(false)
    expect(existsSync(prevFile(home, 'subagent-statusline-prev'))).toBe(false)
  })

  it('leaves a file with nothing of ours alone: foreign hooks, an empty event, a foreign status line; no backup, exit 0', () => {
    const home = freshHome()
    const before = writeSettings(home, {
      hooks: { PreToolUse: [foreign], Stop: [] },
      statusLine: { type: 'command', command: '~/.claude/statusline.sh', padding: 2 },
    })
    // A saved command left over from an earlier install is not ours to delete while our status line is not registered
    mkdirSync(join(home, '.agent-office'), { recursive: true })
    writeFileSync(prevFile(home, 'statusline-prev'), 'old-status\n')

    const out = uninstall(home)
    expect(readText(home)).toBe(before)
    expect(out).toMatch(/nothing to remove/i)
    expect(out).toContain('hooks: no office entries found')
    expect(out).toContain('[skip] statusLine is not the office\'s')
    expect(out).toContain('[note]')
    expect(existsSync(prevFile(home, 'statusline-prev'))).toBe(true)
    expect(backups(home)).toEqual([])
  })

  it('exits 0 with nothing to remove when there is no settings file at all, and creates none', () => {
    const home = freshHome()
    const out = uninstall(home)
    expect(out).toMatch(/nothing to remove/i)
    expect(existsSync(join(home, '.claude'))).toBe(false)
  })

  it('removes entries that point at a checkout that moved, duplicates included, and the stale status line (put back from the saved command)', () => {
    const home = freshHome()
    mkdirSync(join(home, '.agent-office'), { recursive: true })
    writeFileSync(prevFile(home, 'statusline-prev'), '~/.claude/statusline.sh\n')
    const old: any = { hooks: {} }
    for (const event of EVENTS) old.hooks[event] = [{ matcher: '', hooks: [stale()] }]
    // Foreign hooks in a group of their own and sharing a group with ours; two office entries for one event
    old.hooks.PreToolUse = [foreign, { matcher: '', hooks: [stale('/old/a')] }, { matcher: '', hooks: [stale('/old/b')] }]
    old.hooks.PostToolUse = [{ matcher: '', hooks: [{ type: 'command', command: 'echo first' }, stale()] }]
    old.statusLine = { type: 'command', command: 'bash /old/checkout/hooks/status-line.sh', padding: 2, refreshInterval: 5 }
    old.subagentStatusLine = { type: 'command', command: 'bash "/old/checkout/hooks/status-line.sh" --subagents' }
    writeSettings(home, old)

    const out = uninstall(home)
    const settings = readSettings(home)
    expect(readText(home)).not.toContain('agent-tracker.sh')
    expect(readText(home)).not.toContain('status-line.sh')
    expect(settings.hooks).toEqual({
      PreToolUse: [foreign],
      PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'echo first' }] }],
    })
    expect(settings.statusLine).toEqual({ type: 'command', command: '~/.claude/statusline.sh', padding: 2, refreshInterval: 5 })
    expect(settings).not.toHaveProperty('subagentStatusLine')
    expect(out).toContain('[remove] PreToolUse (/old/a/hooks/agent-tracker.sh)')
    expect(out).toContain('[remove] PreToolUse (/old/b/hooks/agent-tracker.sh)')
    for (const event of EVENTS.filter(e => e !== 'PreToolUse')) expect(out).toContain(`[remove] ${event} (/old/moved/path/hooks/agent-tracker.sh)`)
    expect(out).toContain(`hooks: ${EVENTS.length + 1} office entries removed`)
    expect(out).toContain('[restore] statusLine: ~/.claude/statusline.sh')
    expect(out).toContain('[remove] subagentStatusLine (was /old/checkout/hooks/status-line.sh)')
    expect(existsSync(prevFile(home, 'statusline-prev'))).toBe(false)
    expect(backups(home)).toHaveLength(1)
  })

  it('--no-status-line removes the hooks only', () => {
    const home = freshHome()
    install(home)
    const out = uninstall(home, ['--no-status-line'])
    const settings = readSettings(home)
    expect(settings).not.toHaveProperty('hooks')
    expect(settings.statusLine).toBeDefined()
    expect(settings.subagentStatusLine).toBeDefined()
    expect(out).toContain('[skip] statusLine + subagentStatusLine (--no-status-line)')
  })

  describe('shapes Claude Code would reject do not crash it', () => {
    it.each([
      ['an empty array', []],
      ['null', null],
      ['a string', 'nope'],
    ])('"hooks" given as %s holds nothing of ours and is left as it is', (_label, hooks) => {
      const home = freshHome()
      const before = writeSettings(home, { permissions: { allow: ['Bash(ls:*)'] }, hooks })
      const out = uninstall(home)
      expect(out).not.toMatch(/Traceback|AttributeError|TypeError/)
      expect(out).toContain('[skip] "hooks" is a JSON')
      expect(out).toMatch(/nothing to remove/i)
      expect(readText(home)).toBe(before)
    })

    it('an unparseable settings file is left as it is', () => {
      const home = freshHome()
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(settingsPath(home), '{ this is not json')
      const out = uninstall(home)
      expect(out).not.toMatch(/Traceback/)
      expect(out).toMatch(/nothing to remove/i)
      expect(readText(home)).toBe('{ this is not json')
    })

    it('finds ours inside an event given as one object, next to entries that are not objects, and leaves the odd shapes themselves alone', () => {
      const home = freshHome()
      writeSettings(home, {
        hooks: {
          PreToolUse: foreign, // one foreign group, not a list: left as it is
          PostToolUse: { matcher: '', hooks: ['junk', stale()] }, // ours removed, the junk entry and the object shape stay
          SubagentStop: ['junk', 42, { matcher: '', hooks: [stale()] }], // ours and its emptied group go, the junk entries stay
          SessionStart: { matcher: '', hooks: [stale()] }, // one group, ours, emptied: the event goes
          Stop: [{ hooks: 'not a list' }, { matcher: '', hooks: [stale()] }],
          SessionEnd: 'nope',
        },
        statusLine: 'not an object',
        subagentStatusLine: { type: 'command' },
      })

      const out = uninstall(home)
      expect(out).not.toMatch(/Traceback|AttributeError|TypeError/)
      expect(readSettings(home)).toEqual({
        hooks: {
          PreToolUse: foreign,
          PostToolUse: { matcher: '', hooks: ['junk'] },
          SubagentStop: ['junk', 42],
          Stop: [{ hooks: 'not a list' }],
          SessionEnd: 'nope',
        },
        statusLine: 'not an object',
        subagentStatusLine: { type: 'command' },
      })
      expect(out).toContain('hooks: 4 office entries removed')
      expect(out).toContain('[skip] statusLine is not the office\'s')
      expect(out).toContain('[skip] subagentStatusLine is not the office\'s')
    })
  })
})
