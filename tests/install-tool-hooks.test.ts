/** scripts/install-tool-hooks.mjs — connects other AI tools to the office by editing their own config, and takes it back out exactly. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { install, status, targetFile, TOOL_IDS, uninstall } from '../scripts/install-tool-hooks.mjs'

const HOOKS_DIR = '/opt/office/hooks'
let home: string
const opts = () => ({ home, hooksDir: HOOKS_DIR })
const write = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
const read = (file: string) => readFileSync(file, 'utf8')
// The folder whose presence says the tool is installed
const TOOL_DIRS: Record<string, string> = { codex: '.codex', gemini: '.gemini', antigravity: '.gemini/antigravity-cli', kimi: '.kimi-code', opencode: '.config/opencode' }

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tool-hooks-')) })
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('every tool', () => {
  it('knows the five tools', () => {
    expect([...TOOL_IDS].sort()).toEqual(['antigravity', 'codex', 'gemini', 'kimi', 'opencode'])
  })

  for (const tool of ['codex', 'gemini', 'antigravity', 'kimi', 'opencode']) {
    describe(tool, () => {
      beforeEach(() => mkdirSync(join(home, TOOL_DIRS[tool]), { recursive: true }))

      it('says not-installed without the tool, then not-connected, then connected', () => {
        rmSync(join(home, TOOL_DIRS[tool]), { recursive: true, force: true })
        if (tool === 'antigravity') rmSync(join(home, '.gemini'), { recursive: true, force: true })
        expect(status(tool, { home })).toBe('not-installed')
        mkdirSync(join(home, TOOL_DIRS[tool]), { recursive: true })
        expect(status(tool, { home })).toBe('not-connected')
        install(tool, opts())
        expect(status(tool, { home })).toBe('connected')
      })

      it('creates a missing config file, and uninstall removes it again', () => {
        const file = targetFile(tool, home)
        expect(existsSync(file)).toBe(false)
        install(tool, opts())
        expect(existsSync(file)).toBe(true)
        uninstall(tool, { home })
        expect(existsSync(file)).toBe(false)
      })

      it('is idempotent', () => {
        install(tool, opts())
        const once = read(targetFile(tool, home))
        install(tool, opts())
        expect(read(targetFile(tool, home))).toBe(once)
      })

      it('refuses to write through a symlink', () => {
        const real = join(home, 'elsewhere.txt')
        writeFileSync(real, tool === 'kimi' ? '' : '{}')
        mkdirSync(dirname(targetFile(tool, home)), { recursive: true })
        symlinkSync(real, targetFile(tool, home))
        expect(() => install(tool, opts())).toThrow(/symlink/i)
        expect(read(real)).toBe(tool === 'kimi' ? '' : '{}')
      })
    })
  }
})

describe('JSON configs keep what is not ours', () => {
  const cases: [string, string, (cfg: any) => void][] = [
    ['codex', '{\n    "hooks": {\n        "Stop": [{ "hooks": [{ "type": "command", "command": "my-own-hook" }] }]\n    },\n    "other": 1\n}\n', cfg => {
      expect(cfg.other).toBe(1)
      expect(JSON.stringify(cfg.hooks.Stop)).toContain('my-own-hook')
    }],
    ['gemini', '{ "theme": "dark", "hooks": { "BeforeTool": [{ "matcher": "x", "hooks": [{ "type": "command", "command": "mine" }] }] } }', cfg => {
      expect(cfg.theme).toBe('dark')
      expect(JSON.stringify(cfg.hooks.BeforeTool)).toContain('"mine"')
    }],
    ['antigravity', '{ "someone-else": { "Stop": [{ "type": "command", "command": "theirs" }] } }', cfg => {
      expect(cfg['someone-else'].Stop[0].command).toBe('theirs')
    }],
  ]

  for (const [tool, original, check] of cases) {
    it(`${tool}: install keeps other entries, backs up once, and uninstall restores the file byte for byte`, () => {
      const file = targetFile(tool, home)
      write(file, original)
      install(tool, opts())
      const cfg = JSON.parse(read(file))
      check(cfg)
      expect(read(file)).toContain('office-relay.py')
      expect(read(`${file}.claude-office.bak`)).toBe(original)
      install(tool, opts())
      expect(read(`${file}.claude-office.bak`)).toBe(original)
      uninstall(tool, { home })
      expect(read(file)).toBe(original)
    })

    it(`${tool}: uninstall keeps a hook the user added after install`, () => {
      const file = targetFile(tool, home)
      write(file, original)
      install(tool, opts())
      const cfg = JSON.parse(read(file))
      cfg['added-later'] = { note: 'mine' }
      writeFileSync(file, JSON.stringify(cfg))
      uninstall(tool, { home })
      const after = JSON.parse(read(file))
      expect(after['added-later']).toEqual({ note: 'mine' })
      expect(read(file)).not.toContain('office-relay.py')
      check(after)
    })
  }

  it('codex: tells the person to approve the hook with /hooks', () => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    expect(install('codex', opts()).notes.join('\n')).toMatch(/\/hooks/)
  })

  it('every tool but Codex is labelled experimental, with the issue link', () => {
    for (const tool of ['gemini', 'antigravity', 'kimi', 'opencode']) {
      mkdirSync(join(home, TOOL_DIRS[tool]), { recursive: true })
      expect(install(tool, opts()).notes.join('\n'), tool).toContain('experimental — tell us if it works')
    }
  })

  it('points each command at the relay with the tool id', () => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    install('codex', opts())
    expect(read(targetFile('codex', home))).toContain(`python3 -I \\"${HOOKS_DIR}/office-relay.py\\" codex`)
  })

  it('passes Antigravity the event name, since its payload has none', () => {
    mkdirSync(join(home, '.gemini/antigravity-cli'), { recursive: true })
    install('antigravity', opts())
    expect(read(targetFile('antigravity', home))).toContain('antigravity PreToolUse')
  })
})

describe('kimi config.toml', () => {
  beforeEach(() => mkdirSync(join(home, '.kimi-code'), { recursive: true }))

  it('adds a marked block of [[hooks]] tables, and uninstall restores the file byte for byte', () => {
    const file = targetFile('kimi', home)
    const original = 'model = "kimi-k2"\n\n[ui]\ntheme = "dark"'
    writeFileSync(file, original)
    install('kimi', opts())
    const text = read(file)
    expect(text).toContain('# >>> claude-office')
    expect(text).toContain('# <<< claude-office')
    expect(text).toMatch(/\[\[hooks\]\]\nevent = "PreToolUse"\ncommand = ".*office-relay\.py.* kimi"\ntimeout = 2\n/)
    uninstall('kimi', { home })
    expect(read(file)).toBe(original)
  })

  it('keeps [[hooks]] the user wrote', () => {
    const file = targetFile('kimi', home)
    writeFileSync(file, '[[hooks]]\nevent = "Stop"\ncommand = "mine"\n')
    install('kimi', opts())
    uninstall('kimi', { home })
    expect(read(file)).toBe('[[hooks]]\nevent = "Stop"\ncommand = "mine"\n')
  })

  it('refuses a file that lists hooks inline, and says what to add by hand', () => {
    const file = targetFile('kimi', home)
    const inline = 'hooks = [ { event = "Stop", command = "mine" } ]\n'
    writeFileSync(file, inline)
    const { changed, notes } = install('kimi', opts())
    expect(changed).toEqual([])
    expect(notes.join('\n')).toContain('[[hooks]]')
    expect(read(file)).toBe(inline)
  })

  it('uses the older ~/.kimi when that is the one that exists', () => {
    rmSync(join(home, '.kimi-code'), { recursive: true })
    mkdirSync(join(home, '.kimi'), { recursive: true })
    expect(targetFile('kimi', home)).toBe(join(home, '.kimi', 'config.toml'))
  })
})

describe('opencode plugin', () => {
  it('copies the plugin and removes only our own file', () => {
    mkdirSync(join(home, '.config/opencode'), { recursive: true })
    const hooksDir = join(home, 'hooks')
    write(join(hooksDir, 'opencode-plugin.js'), '/** opencode-plugin.js - Claude Office\'s OpenCode plugin */\nexport const ClaudeOffice = 1\n')
    install('opencode', { home, hooksDir })
    expect(read(targetFile('opencode', home))).toContain("Claude Office's OpenCode plugin")
    writeFileSync(targetFile('opencode', home), 'someone else wrote this')
    uninstall('opencode', { home })
    expect(read(targetFile('opencode', home))).toBe('someone else wrote this')
  })
})
