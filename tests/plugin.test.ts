/**
 * The Claude Code plugin packaging. The repository root is the `agent-office`
 * plugin and its own marketplace: .claude-plugin/plugin.json,
 * .claude-plugin/marketplace.json, hooks/hooks.json and commands/office.md.
 * These checks follow the documented schemas (plugins/manifest-reference,
 * plugins/marketplace-reference, hooks#matcher-patterns), tie hooks.json to
 * the tracker it points at, and run `claude plugin validate` when the CLI is
 * on PATH.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TRACKER = join(ROOT, 'hooks', 'agent-tracker.sh')
const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))

const pkg = readJson('package.json')
const plugin = readJson('.claude-plugin/plugin.json')
const marketplace = readJson('.claude-plugin/marketplace.json')
const hooksFile = readJson('hooks/hooks.json')
const hooks: Record<string, any[]> = hooksFile.hooks

/**
 * Every hook event name Claude Code 2.1.300 accepts — its own "Valid events:"
 * list, printed when a settings file names an unknown one.
 */
const VALID_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Notification', 'UserPromptSubmit',
  'UserPromptExpansion', 'SessionStart', 'SessionEnd', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact', 'PreModelSwitch', 'PostModelSwitch', 'PermissionRequest', 'PermissionDenied',
  'Setup', 'TeammateIdle', 'TaskCreated', 'TaskCompleted', 'Elicitation', 'ElicitationResult', 'ConfigChange',
  'WorktreeCreate', 'WorktreeRemove', 'InstructionsLoaded', 'CwdChanged', 'FileChanged', 'DirectoryAdded',
  'MessageDisplay',
]

/**
 * What hooks/install-hooks.sh registers — read from its EVENTS tuple, so the
 * plugin and the installer cannot drift apart without this test noticing.
 */
const INSTALLER_EVENTS = (() => {
  const source = readFileSync(join(ROOT, 'hooks', 'install-hooks.sh'), 'utf8')
  const tuple = /^EVENTS = \(([\s\S]*?)^\)/m.exec(source)
  if (!tuple) throw new Error('could not find the EVENTS tuple in hooks/install-hooks.sh')
  return Array.from(tuple[1].matchAll(/'([A-Za-z]+)'/g), (m) => m[1])
})()

const TRACKER_COMMAND = 'bash "${CLAUDE_PLUGIN_ROOT}/hooks/agent-tracker.sh"'

describe('.claude-plugin/plugin.json', () => {
  it('names the plugin agent-office with a kebab-case name Claude Code accepts', () => {
    expect(plugin.name).toBe('agent-office')
    // No spaces, @, :, path separators (manifest reference, `name`)
    expect(plugin.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it('does not take a name reserved for, or that reads as, one of Anthropic’s own plugins', () => {
    const name = plugin.name.toLowerCase()
    // `claude plugin validate` errors on these ...
    expect(name).not.toMatch(/^(claude|anthropic|anthropics|cc-plugin)[-_. ]/)
    expect(['claude', 'anthropic', 'anthropics', 'claude-code', 'claude-mods']).not.toContain(name)
    // ... and warns (a --strict failure in CI) when claude/anthropic is a word anywhere in the name
    expect(name).not.toMatch(/(^|[-_. ])(claude|anthropic|anthropics|official)([-_. ]|$)/)
  })

  it('carries the metadata the validator warns about when missing, with the version from package.json', () => {
    expect(plugin.version).toBe(pkg.version)
    expect(typeof plugin.description).toBe('string')
    expect(plugin.description.length).toBeGreaterThan(20)
    expect(plugin.author).toMatchObject({ name: 'W17ant' })
    expect(plugin.license).toBe('MIT')
    // homepage must parse as a URL or the plugin fails to load
    expect(() => new URL(plugin.homepage)).not.toThrow()
    expect(plugin.homepage).toBe('https://github.com/W17ant/Claude-Office')
    expect(plugin.repository).toBe('https://github.com/W17ant/Claude-Office')
  })

  it('declares no component paths, so the standard layout (hooks/hooks.json, commands/) is what loads', () => {
    for (const key of ['commands', 'agents', 'skills', 'hooks', 'mcpServers', 'lspServers', 'settings', 'outputStyles']) {
      expect(plugin, `plugin.json should not set "${key}"`).not.toHaveProperty(key)
    }
  })

  it('ships nothing at the repository root that Claude Code would load as an extra component', () => {
    // The repo root IS the plugin root: any of these would silently become
    // part of every session the plugin is enabled in (standard layout table).
    for (const extra of ['settings.json', '.mcp.json', '.lsp.json', 'SKILL.md', 'CLAUDE.md', 'agents', 'skills', 'bin', 'output-styles', 'workflows', 'themes', 'monitors']) {
      expect(existsSync(join(ROOT, extra)), `${extra} at the plugin root`).toBe(false)
    }
  })
})

describe('.claude-plugin/marketplace.json', () => {
  it('has the required name, owner.name and plugins[]', () => {
    expect(typeof marketplace.name).toBe('string')
    expect(marketplace.owner).toMatchObject({ name: 'W17ant' })
    expect(Array.isArray(marketplace.plugins)).toBe(true)
    expect(marketplace.plugins).toHaveLength(1)
    // the validator warns when the description is missing
    expect(typeof marketplace.description).toBe('string')
  })

  it('uses a marketplace name Claude Code can install from and that is not reserved', () => {
    // letters, digits, ".", "_" and "-", starting with a letter or digit, no ".."
    expect(marketplace.name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
    expect(marketplace.name).not.toContain('..')
    expect(marketplace.name).not.toMatch(/^claudeai-/)
    expect(marketplace.name).not.toMatch(/claude|anthropic/i)
    const reserved = ['inline', 'builtin', 'skills-dir', 'synced', 'claude-plugin-test', 'npm', 'pip', 'uv', 'cargo', 'github', 'gh',
      'constructor', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'toString', 'valueOf',
      'agent-skills', 'life-sciences', 'healthcare', 'knowledge-work-plugins', 'first-party-plugins', 'financial-services-plugins']
    expect(reserved).not.toContain(marketplace.name.toLowerCase())
  })

  it('lists the plugin under the manifest name with the repository root as its source', () => {
    const [entry] = marketplace.plugins
    // Entry name and manifest name must agree, or `claude plugin install
    // agent-office@<marketplace>` reports the plugin as not found
    expect(entry.name).toBe(plugin.name)
    // A relative source must start with "./" ("." alone also means the root);
    // "./" is the marketplace root, i.e. this repository
    expect(['./', '.']).toContain(entry.source)
    expect(typeof entry.description).toBe('string')
    // plugin.json's version wins and the validator warns when both set one
    expect(entry).not.toHaveProperty('version')
    // Component fields on the entry would override or conflict with plugin.json
    for (const key of ['commands', 'agents', 'skills', 'hooks', 'outputStyles', 'themes']) {
      expect(entry, `entry should not set "${key}"`).not.toHaveProperty(key)
    }
  })
})

describe('hooks/hooks.json', () => {
  it('wraps the event map in a top-level "hooks" key (a bare event map fails to load)', () => {
    expect(hooksFile).toHaveProperty('hooks')
    expect(typeof hooksFile.hooks).toBe('object')
    expect(typeof hooksFile.description).toBe('string')
  })

  it('names only events this Claude Code version accepts', () => {
    for (const event of Object.keys(hooks)) {
      expect(VALID_EVENTS, `unknown hook event "${event}"`).toContain(event)
    }
  })

  it('registers exactly the 19 events the installer registers (workers, sessions, the main thread’s turn, the task list)', () => {
    expect(INSTALLER_EVENTS).toHaveLength(19)
    expect(Object.keys(hooks).sort()).toEqual([...INSTALLER_EVENTS].sort())
  })

  it('runs agent-tracker.sh through ${CLAUDE_PLUGIN_ROOT}, double-quoted, once per event', () => {
    for (const [event, groups] of Object.entries(hooks)) {
      expect(Array.isArray(groups), `hooks.${event} must be a list of matcher groups`).toBe(true)
      expect(groups, `hooks.${event} should hold one group`).toHaveLength(1)
      const [group] = groups
      expect(Array.isArray(group.hooks)).toBe(true)
      expect(group.hooks).toHaveLength(1)
      // Shell form: the validator warns when the placeholder is not quoted
      expect(group.hooks[0]).toEqual({ type: 'command', command: TRACKER_COMMAND })
    }
  })

  it('points every command at a file that exists and is executable under the repository root', () => {
    for (const groups of Object.values(hooks)) {
      for (const group of groups) {
        for (const h of group.hooks) {
          const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"'\s]+)/.exec(h.command)
          expect(m, `${h.command} does not reference \${CLAUDE_PLUGIN_ROOT}`).not.toBeNull()
          const path = join(ROOT, m![1])
          expect(existsSync(path), `${m![1]} missing`).toBe(true)
          expect(() => accessSync(path, constants.X_OK), `${m![1]} not executable`).not.toThrow()
          // No ".." — a path that escapes the plugin root does not load
          expect(m![1]).not.toContain('..')
        }
      }
    }
  })

  it('narrows nothing: every event fires on every occurrence, like the installer’s matcher ""', () => {
    // PreToolUse is activity for every tool, a main-thread PostToolUse of any
    // tool lowers a permission hand (session_tool_done), and the rest either
    // have no matcher support (UserPromptSubmit, Stop, PostToolBatch, CwdChanged)
    // or are wanted whole
    for (const [event, groups] of Object.entries(hooks)) {
      expect(groups[0].matcher, `${event} should not be narrowed`).toBeUndefined()
    }
  })
})

describe('hooks/hooks.json × agent-tracker.sh', () => {
  // A payload per registered event, in the shape Claude Code 2.1.300 sends
  // (see tests/hook-script.test.ts for the verbatim captures). Run through
  // the real script, not just its Python, with no office server to talk to.
  const base = { session_id: 'plugin-test', transcript_path: '/tmp/t.jsonl', cwd: '/tmp/project' }
  const tool = { tool_name: 'Bash', tool_input: { command: 'true' }, tool_use_id: 'toolu_plugin' }
  const PAYLOADS: Record<string, object> = {
    PreToolUse: { ...tool },
    PostToolUse: { ...tool, tool_response: { stdout: '', stderr: '', interrupted: false }, duration_ms: 3 },
    PostToolUseFailure: { ...tool, error: 'Exit code 1\nboom', is_interrupt: false, duration_ms: 3 },
    SubagentStart: { agent_id: 'a1b2c3d4e5f6a7b8c', agent_type: 'general-purpose' },
    SubagentStop: { agent_id: 'a1b2c3d4e5f6a7b8c', agent_type: 'general-purpose', last_assistant_message: 'done', stop_hook_active: false },
    SessionStart: { source: 'startup' },
    SessionEnd: { reason: 'other' },
    UserPromptSubmit: { prompt: 'hello', prompt_id: 'p1' },
    Stop: { stop_hook_active: false, last_assistant_message: 'DONE', background_tasks: [], session_crons: [] },
    PermissionRequest: { tool_name: 'Write', tool_input: { file_path: '/tmp/x' }, permission_suggestions: [] },
    Notification: { message: 'Claude needs your permission', notification_type: 'permission_prompt' },
    StopFailure: { error: 'rate_limit' },
    PreCompact: { trigger: 'manual', custom_instructions: null },
    PostCompact: { trigger: 'manual', compact_summary: 'summary' },
    PostToolBatch: { tool_calls: [{ ...tool, tool_response: '' }] },
    CwdChanged: { old_cwd: '/tmp/project', new_cwd: '/tmp' },
    PostModelSwitch: { from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', context_tokens: 1 },
    TaskCreated: { task_id: '1', task_subject: 'Fix the parser', task_description: 'The parser drops trailing commas' },
    TaskCompleted: { task_id: '1', task_subject: 'Fix the parser' },
  }

  // An AGENT_OFFICE_HOME with no auth-token, so the script never finds a server to call
  const emptyHome = mkdtempSync(join(tmpdir(), 'agent-office-plugin-'))
  afterAll(() => rmSync(emptyHome, { recursive: true, force: true }))

  function runTracker(payload: object) {
    const r = spawnSync('bash', [TRACKER], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, AGENT_OFFICE_HOME: emptyHome },
      timeout: 10_000,
    })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  }

  it('has a payload fixture for every registered event', () => {
    expect(Object.keys(PAYLOADS).sort()).toEqual(Object.keys(hooks).sort())
  })

  it.each(Object.keys(hooks))('%s: the tracker exits 0 and is either silent or well-formed', (event) => {
    const { status, stdout, stderr } = runTracker({ hook_event_name: event, ...base, ...PAYLOADS[event] })
    expect(status, `stderr: ${stderr}`).toBe(0)
    expect(stderr).toBe('')
    // The script prints nothing itself (the event goes to curl, which is
    // backgrounded and silenced); any output would be a Python traceback
    expect(stdout).toBe('')
  })

  it('is silent for an event it will never handle, which is what makes registering events ahead of time safe', () => {
    const { status, stdout, stderr } = runTracker({ hook_event_name: 'BogusEvent', ...base, some: 'field' })
    expect(status).toBe(0)
    expect(stdout + stderr).toBe('')
  })
})

describe('commands/office.md', () => {
  const source = readFileSync(join(ROOT, 'commands', 'office.md'), 'utf8')

  it('has frontmatter with a description, so /agent-office:office is listed', () => {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(source)
    expect(m).not.toBeNull()
    expect(m![1]).toMatch(/^description: .+/m)
  })

  it('checks the health endpoint and tells the user how to start the server', () => {
    expect(source).toContain('http://127.0.0.1:3334/health')
    expect(source).toContain('npm run build && npm run server')
    expect(source).toContain('${CLAUDE_PLUGIN_ROOT}')
  })
})

// `claude plugin validate` is the authoritative check; run it when the CLI is
// installed (CI installs it), otherwise skip with a note rather than fail.
const claudeVersion = (() => {
  try {
    return execFileSync('claude', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }).trim()
  } catch {
    return null
  }
})()

describe('claude plugin validate', () => {
  it.skipIf(!claudeVersion)(`passes in --strict mode on the repository root (${claudeVersion ?? 'skipped: claude not on PATH; install Claude Code to run this check'})`, () => {
    let out: string
    try {
      out = execFileSync('claude', ['plugin', 'validate', ROOT, '--strict', '--json'], {
        encoding: 'utf8',
        env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
        timeout: 60_000,
      })
    } catch (err: any) {
      throw new Error(`claude plugin validate failed (exit ${err.status}):\n${err.stdout}\n${err.stderr}`)
    }
    const report = JSON.parse(out)
    expect(report.success, JSON.stringify(report, null, 2)).toBe(true)
    expect(report.strict).toBe(true)
    // The marketplace is what a root with both manifests validates as; the
    // plugin's manifest and files are checked through its relative source
    expect(report.manifest.type).toBe('marketplace')
    expect(report.manifest.errors).toEqual([])
    expect(report.manifest.warnings).toEqual([])
  }, 70_000)

  it.skipIf(!claudeVersion)('passes on the plugin manifest by itself', () => {
    const out = execFileSync('claude', ['plugin', 'validate', join(ROOT, '.claude-plugin', 'plugin.json'), '--strict', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
      timeout: 60_000,
    })
    const report = JSON.parse(out)
    expect(report.success, JSON.stringify(report, null, 2)).toBe(true)
    expect(report.manifest.errors).toEqual([])
    expect(report.manifest.warnings).toEqual([])
  }, 70_000)
})
