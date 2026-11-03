import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acsOf, lintSpecs, loadSpecs, openQuestions, readTests, statusOf, testRefs } from './support/specs'

const spec = (status: string, body = '', acs = '- **AC-1.1** does a thing\n- **AC-1.2** does another') =>
  `---\nstatus: ${status}\n---\n# S\n\n## 5. Acceptance criteria\n${acs}\n\n## 8. Open Questions\n${body}\n\n## Notes\nx\n`

describe('specs: pipeline consistency (docs/pipeline.md)', () => {
  it('the real specs are consistent', () => {
    const root = join(__dirname, '..')
    expect(lintSpecs(loadSpecs(root), readTests(root))).toEqual([])
  })

  it('reads status and unchecked open questions only inside their section, numbered heading or not', () => {
    expect(statusOf(spec('ready'))).toBe('ready')
    expect(statusOf('# no frontmatter')).toBeUndefined()
    expect(openQuestions(spec('draft', '- [ ] Q1 who?\n- [x] Q2 done'))).toEqual(['- [ ] Q1 who?'])
    expect(openQuestions('---\nstatus: draft\n---\n## Open Questions\n- [ ] Q')).toEqual(['- [ ] Q'])
    expect(openQuestions('## Notes\n- [ ] not a question')).toEqual([])
  })

  it('parses criteria with continuation lines and ignores mentions inside other text', () => {
    const acs = acsOf('- **AC-1.1** first\n  continues here [gap]\n- **AC-1.2** [manual] by hand\nsee AC-1.1 above\n- **AC-2.1** last')
    expect(acs.map((a) => [a.id, a.gap, a.manual])).toEqual([
      ['AC-1.1', true, false],
      ['AC-1.2', false, true],
      ['AC-2.1', false, false]
    ])
    expect(testRefs('x Test: tests/a.test.ts › "does it" and Test: tests/b.test.ts › "also"')).toEqual([
      { file: 'tests/a.test.ts', fragment: 'does it' },
      { file: 'tests/b.test.ts', fragment: 'also' }
    ])
  })

  it('flags broken pipeline states', () => {
    const tests = { 'tests/a.test.ts': 'it("AC-1.1 does a thing")' }
    const dirs = [
      { name: 'a-no-status', spec: '# nothing' },
      { name: 'b-draft-with-plan', spec: spec('draft', '- [ ] Q'), plan: 'p' },
      { name: 'c-ready-with-question', spec: spec('ready', '- [ ] Q') },
      { name: 'd-implemented-untested', spec: spec('implemented'), plan: 'p', tasks: '- [x] t' },
      { name: 'e-implemented-open-task', spec: spec('implemented', '', '- **AC-1.1** a'), plan: 'p', tasks: '- [ ] t' },
      { name: 'f-missing' },
      { name: 'g-duplicate-id', spec: spec('draft', '', '- **AC-1.1** a\n- **AC-1.1** b') },
      { name: 'h-implemented-no-plan', spec: spec('implemented', '', '- **AC-1.1** a') }
    ]
    expect(lintSpecs(dirs, tests)).toEqual([
      expect.stringContaining('a-no-status: frontmatter needs status'),
      expect.stringContaining('b-draft-with-plan: draft specs cannot have a plan'),
      expect.stringContaining('c-ready-with-question: ready but 1 open question'),
      expect.stringContaining('d-implemented-untested: AC-1.2 names no test'),
      expect.stringContaining('e-implemented-open-task: implemented but tasks.md has unchecked'),
      expect.stringContaining('f-missing: spec.md is missing'),
      expect.stringContaining('g-duplicate-id: AC-1.1 is defined twice'),
      expect.stringContaining('h-implemented-no-plan: implemented but plan.md is missing'),
      expect.stringContaining('h-implemented-no-plan: implemented but tasks.md is missing')
    ])
  })

  it('implemented: every criterion cites a real test, is tagged [gap]/[manual], or is named in a test', () => {
    const tests = { 'tests/a.test.ts': "it('does a thing')\nit('AC-3.1 named')" }
    const acs = [
      '- **AC-1.1** ok. Test: tests/a.test.ts › "does a thing"',
      '- **AC-1.2** untested logic [gap]',
      '- **AC-1.3** [manual] looks right',
      '- **AC-3.1** found by id'
    ].join('\n')
    const done = { plan: 'p', tasks: '- [x] t' }
    expect(lintSpecs([{ name: 'ok', spec: spec('implemented', '', acs), ...done }], tests)).toEqual([])

    const bad = [
      '- **AC-1.1** cites a missing file. Test: tests/nope.test.ts › "x"',
      '- **AC-1.2** cites a missing title. Test: tests/a.test.ts › "not there"',
      '- **AC-1.3** says nothing'
    ].join('\n')
    expect(lintSpecs([{ name: 'bad', spec: spec('implemented', '', bad), ...done }], tests)).toEqual([
      expect.stringContaining('AC-1.1 cites tests/nope.test.ts, which does not exist'),
      expect.stringContaining('AC-1.2 cites "not there", not found in tests/a.test.ts'),
      expect.stringContaining('AC-1.3 names no test')
    ])
    expect(lintSpecs([{ name: 'empty', spec: spec('implemented', '', ''), ...done }], tests)).toEqual([expect.stringContaining('defines no acceptance criteria')])
  })

  it('accepts a healthy pipeline', () => {
    const tests = { 'tests/a.test.ts': 'AC-1.1 AC-1.2' }
    expect(lintSpecs([{ name: 'ok', spec: spec('implemented', '- [x] closed'), plan: 'p', tasks: '- [x] t' }], tests)).toEqual([])
    expect(lintSpecs([{ name: 'wip', spec: spec('draft', '- [ ] open') }], {})).toEqual([])
    const manual = spec('implemented', '', '- **AC-1.1** named\n- **AC-1.2** [manual] by hand')
    expect(lintSpecs([{ name: 'm', spec: manual, plan: 'p', tasks: '- [x] t' }], { 'tests/a.test.ts': 'AC-1.1' })).toEqual([])
  })
})
