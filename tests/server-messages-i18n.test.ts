/**
 * server-messages-i18n.test.ts - the server's chat lines, the /recap line and
 * the desktop permission notification speak the office's language, while
 * commands, project and tool names stay as they are.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOffice, removeOffice, type Office } from './helpers'

const de = {
  meta: { name: 'Deutsch', englishName: 'German' },
  server: {
    commands: { help: 'Befehle: {commands}', quiet: '🏢 Ruhig hier' },
    recap: { quiet: '📋 Rückblick: ruhiger Tag.' },
    notify: { title: 'Claude braucht dich', bash: 'will einen Befehl ausführen' },
  },
}

describe('server messages in the office language', () => {
  let office: Office
  let i18n: typeof import('../server/i18n.js')

  beforeAll(async () => {
    office = await loadOffice()
    // The same module instance the freshly loaded server uses
    i18n = await import('../server/i18n.js')
    const dir = mkdtempSync(join(tmpdir(), 'agent-office-locales-'))
    copyFileSync('locales/en.json', join(dir, 'en.json'))
    writeFileSync(join(dir, 'de.json'), JSON.stringify(de))
    i18n.useLocaleDir(dir)
    i18n.setLanguage('de')
  })

  afterAll(() => {
    i18n.useLocaleDir()
    removeOffice(office)
  })

  it('/help answers in German and keeps the command names', async () => {
    const res = await request(office.server.app).post('/chat').send({ sender: 'Boss', text: '/help' })
    expect(res.status).toBeLessThan(300)
    const rows = (await request(office.server.app).get('/chat')).body.messages
    const reply = rows[rows.length - 1].text
    expect(reply).toMatch(/^Befehle: /)
    expect(reply).toContain('/status')
  })

  it('/agents on a quiet office answers in German', async () => {
    await request(office.server.app).post('/chat').send({ sender: 'Boss', text: '/agents' })
    const rows = (await request(office.server.app).get('/chat')).body.messages
    expect(rows[rows.length - 1].text).toBe('🏢 Ruhig hier')
  })

  it('the recap line and the notification follow the language', async () => {
    const { recapLine } = await import('../server/recap.js')
    const ZERO = { sessions: 0, agentsSpawned: 0, agentsCompleted: 0, tasksCompleted: 0, deploys: 0, pushes: 0, buildsFailed: 0, testsFailed: 0, incidents: 0, costUsd: 0 }
    expect(recapLine({ date: '2026-11-18', ...ZERO })).toBe('📋 Rückblick: ruhiger Tag.')
    // A key the German file lacks comes out in English
    expect(recapLine({ date: '2026-11-18', ...ZERO, sessions: 1 })).toMatch(/1 session/)
    expect(recapLine({ date: '2026-11-18', ...ZERO, sessions: 1, costUsd: 1234.5 })).toContain('1.234,50')

    const { permissionNotificationText } = await import('../server/permission-notify.js')
    expect(permissionNotificationText({ project: 'alpha', toolName: 'Bash' })).toEqual({
      title: 'Claude braucht dich', message: 'alpha · Bash will einen Befehl ausführen',
    })
  })

  it('English stays exactly as before', () => {
    i18n.setLanguage(null)
    try {
      expect(i18n.t('server.commands.help', { commands: 'x' })).toMatch(/Commands/)
    } finally {
      i18n.setLanguage('de')
    }
  })
})
