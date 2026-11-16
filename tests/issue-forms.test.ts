/** Issue forms — the bug and feature forms ask how the office is run, which AI tool, and route open-ended ideas to Discussions. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// Why js-yaml: already in the tree (electron-builder), and a regex over YAML would pass on comments
import yaml from 'js-yaml'

const DIR = fileURLToPath(new URL('../.github/ISSUE_TEMPLATE/', import.meta.url))
const load = (name: string) => yaml.load(readFileSync(join(DIR, name), 'utf8')) as any
const item = (form: any, id: string) => form.body.find((b: any) => b.id === id)

// Why these four, in this order: every way the README tells people to run the office
const HOW_RUN = ['npx @w17ant/agent-office', 'Desktop app', 'From a checkout (npm run …)', 'Claude Code plugin']

describe.each([
  ['bug_report.yml', 'bug'],
  ['feature_request.yml', 'enhancement'],
])('%s', (file, label) => {
  const form = load(file)

  it('is a form with a name, description, its label and a body', () => {
    expect(form.name).toBeTruthy()
    expect(form.description).toBeTruthy()
    expect(form.labels).toContain(label)
    expect(Array.isArray(form.body)).toBe(true)
  })

  it('asks how the office is run, with exactly the four documented ways', () => {
    const how = item(form, 'how-run')
    expect(how.type).toBe('dropdown')
    expect(how.attributes.options).toEqual(HOW_RUN)
  })

  it('asks which AI tool, Claude Code and Other included', () => {
    const tool = item(form, 'ai-tool')
    expect(tool.type).toBe('dropdown')
    expect(tool.attributes.options).toEqual(expect.arrayContaining(['Claude Code', 'Other']))
  })
})

describe('feature_request.yml', () => {
  it('lets the person say they want to build it', () => {
    const boxes = load('feature_request.yml').body.filter((b: any) => b.type === 'checkboxes')
    const labels = boxes.flatMap((b: any) => b.attributes.options.map((o: any) => o.label))
    expect(labels).toContain("I'd like to build this")
  })
})

describe('config.yml', () => {
  const config = load('config.yml')

  it('turns blank issues off, so every issue goes through a form', () => {
    expect(config.blank_issues_enabled).toBe(false)
  })

  it('sends ideas and questions to Discussions', () => {
    const urls = config.contact_links.map((l: any) => l.url)
    expect(urls).toEqual(expect.arrayContaining([
      expect.stringMatching(/\/discussions\/categories\/ideas$/),
      expect.stringMatching(/\/discussions\/categories\/q-a$/),
    ]))
  })
})
