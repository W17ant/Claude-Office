/**
 * config.ts — shared configuration constants
 *
 * Reads boss settings from office.config.json in the project root.
 * Users can customise their boss name, sprite, and colour there.
 */

// Load user config (office.config.json) — bundled by Vite
let userConfig: { boss?: { name?: string; sprite?: string; color?: string; emoji?: string } } = {}
try {
  // Vite handles JSON imports at build time
  userConfig = await import('../office.config.json')
} catch {
  // Fallback defaults if file missing
}

const bossName   = userConfig.boss?.name   ?? 'Boss'
const bossSprite = userConfig.boss?.sprite ?? 'Me-1'
const bossColor  = userConfig.boss?.color  ?? '#ff4444'
const bossEmoji  = userConfig.boss?.emoji  ?? '👑'

// The boss — always in the office
export const BOSS_CHAR = bossSprite
export const BOSS_ROLE = 'boss'
export const BOSS_NAME = bossName
export const BOSS_COLOR = bossColor
export const BOSS_EMOJI = bossEmoji

// Map agent roles to character sprite base names (in /sprites/characters/)
export const ROLE_TO_CHAR: Record<string, string> = {
  'boss':                  bossSprite,
  'assistant':             'Claude-1',
  'debugger':              'dev-1',
  'code-reviewer':         'employee-1',
  'frontend-developer':    'Frontend-dev-1',
  'fullstack-developer':   'dev-2',
  'test-engineer':         'employee-2',
  'security-auditor':      'security-audit-1',
  'devops-engineer':       'employee-3',
  'architect-reviewer':    'employee-1',
  'performance-engineer':  'employee-2',
  'database-architect':    'employee-3',
  'typescript-pro':        'employee-1',
  'ai-engineer':           'dev-2',
  'prompt-engineer':       'dev-2',
  'general-purpose':       'employee-3',
  'Explore':               'explore-1',
  // MCPs
  'github':                'employee-3',
  'supabase':              'Frontend-dev-1',
  'playwright':            'employee-2',
  'chrome':                'employee-1',
  'memory':                'dev-2',
  'seo':                   'Frontend-dev-1',
  'gmail':                 'dev-1',
  'ios-simulator':         'security-audit-1',
}
