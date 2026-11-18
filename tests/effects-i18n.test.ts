/**
 * effects-i18n.test.ts - the prop over an agent (water glass, pizza, cake,
 * fire, party) is chosen from what the agent is doing, never from the words
 * on its status line, so it is the same in every language.
 */
import { describe, expect, it } from 'vitest'
import { getEffect, eventEffectKind } from '../src/agentManager'
import { moveAgentsForEvent, returnAgentsFromEvent } from '../src/officeReducer'

describe('effects do not depend on the language', () => {
  it('a water break shows the water glass whatever its status line says', () => {
    expect(getEffect('coffee-break', 0, 'Wasserpause', 'a1', '', 'debugger', false, 'water')).toBe('/sprites/effects/glass-water.png')
    expect(getEffect('coffee-break', 0, 'Kaffeepause', 'a1', '', 'debugger', false, undefined)).toBe('/sprites/effects/need-coffee.png')
  })

  it('an event walk shows its prop from the event, not its translated name', () => {
    expect(getEffect('walking-to-desk', 0, 'Feuerübung!', 'a1', '', 'debugger', false, 'fire')).toBe('/sprites/effects/fire.png')
    expect(getEffect('walking-to-desk', 0, '誕生日', 'a1', '', 'debugger', false, 'cake')).toBe('/sprites/effects/cake.png')
  })

  it('English text still works without a kind (the ?sim script)', () => {
    expect(getEffect('walking-to-desk', 0, 'Pizza in the lobby!', 'a1', '', 'debugger', false)).toBe('/sprites/effects/pizza.png')
  })

  it('maps event ids to props', () => {
    expect(eventEffectKind('fire-drill')).toBe('fire')
    expect(eventEffectKind('pizza')).toBe('pizza')
    expect(eventEffectKind('birthday')).toBe('cake')
    expect(eventEffectKind('deploy-success')).toBe('party')
    expect(eventEffectKind('friday')).toBe('party')
    expect(eventEffectKind('standup')).toBeUndefined()
  })

  it('an event walk carries the kind, and the walk back drops it', () => {
    const env = { live: false, random: () => 0.5, computePath: (_from: any, to: any) => [to] } as any
    const agent = { id: 'a1', name: 'Dev', role: 'debugger', state: 'working', position: { x: 10, y: 10 }, deskPosition: { x: 10, y: 10 } } as any
    const { agents, movedIds } = moveAgentsForEvent([agent], { x: 50, y: 50 }, 'Feuerübung!', env, 'fire')
    expect(agents[0].effectKind).toBe('fire')
    const back = returnAgentsFromEvent(agents, movedIds, env)
    expect(back[0].effectKind).toBeUndefined()
  })
})
