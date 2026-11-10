/** incidentAssets.ts - which prop each role grabs when prod goes down. */
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { INCIDENT_PROPS, incidentPropFor } from '../src/incidentAssets'

describe('incidentPropFor', () => {
  it('pairs each role with its prop', () => {
    expect(incidentPropFor('devops-engineer')).toBe(INCIDENT_PROPS.pager)
    expect(incidentPropFor('boss')).toBe(INCIDENT_PROPS.megaphone)
    expect(incidentPropFor('debugger')).toBe(INCIDENT_PROPS.extinguisher)
    expect(incidentPropFor('security-auditor')).toBe(INCIDENT_PROPS.magnifier)
    expect(incidentPropFor('test-engineer')).toBe(INCIDENT_PROPS.canary)
    expect(incidentPropFor('performance-engineer')).toBe(INCIDENT_PROPS.stopwatch)
  })

  it('roles without a prop carry nothing', () => {
    expect(incidentPropFor('frontend-developer')).toBeNull()
    expect(incidentPropFor('main')).toBeNull()
    expect(incidentPropFor('')).toBeNull()
  })

  it('every prop file exists', () => {
    for (const path of Object.values(INCIDENT_PROPS)) expect(existsSync(`public${path}`), path).toBe(true)
  })
})
