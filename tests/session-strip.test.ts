/** SessionStrip — a session from another AI tool carries a tag naming the tool; Claude Code sessions look as before. */

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SessionStrip from '../src/components/SessionStrip'
import { clientOf } from '../src/tools'

const render = (sessions: any[]) => renderToStaticMarkup(React.createElement(SessionStrip, { sessions, agents: [] } as any))

describe('SessionStrip tool tag', () => {
  it('tags a Codex session, and names the tool in its hover text', () => {
    const html = render([{ id: 'codex:abc', client: 'codex', project: 'demo', state: 'active' }])
    expect(html).toMatch(/class="session-pill-client"[^>]*>Codex</)
    expect(html).toContain('tool: Codex')
  })

  it('works out the tool from the id when the session has no client field', () => {
    expect(render([{ id: 'gemini:abc', project: 'demo', state: 'active' }])).toMatch(/session-pill-client[^>]*>Gemini CLI</)
  })

  it('leaves a Claude Code session without a tag', () => {
    const html = render([{ id: '5f0c3b1e-claude', project: 'demo', state: 'active' }])
    expect(html).not.toContain('session-pill-client')
    expect(html).not.toContain('tool:')
  })
})

describe('clientOf', () => {
  it('reads the tool from the session id prefix, or the explicit client', () => {
    expect(clientOf('codex:1')).toBe('codex')
    expect(clientOf('opencode:ses_1')).toBe('opencode')
    expect(clientOf('5f0c3b1e')).toBeUndefined()
    expect(clientOf('weird:1')).toBeUndefined()
    expect(clientOf('x', 'kimi')).toBe('kimi')
  })
})
