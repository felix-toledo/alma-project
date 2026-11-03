import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const STATUSES = ['draft', 'ready', 'implemented'] as const
export type SpecStatus = (typeof STATUSES)[number]

export interface SpecDir {
  name: string
  spec?: string
  plan?: string
  tasks?: string
}

export interface Ac {
  id: string
  text: string
  manual: boolean
  gap: boolean
}

const AC_BULLET = /^\s*[-*] \*\*(AC-\d+(?:\.\d+)?)\*\*/
const TEST_REF = /Test:\s*(tests\/[\w./-]+\.test\.ts)\s*›\s*"([^"]+)"/g

export function statusOf(spec: string): string | undefined {
  return /^---\r?\n(?:[^\n]*\n)*?status:\s*(\S+)/.exec(spec)?.[1]
}

/** Lines of the `## Open Questions` section that are still unchecked. */
export function openQuestions(spec: string): string[] {
  const section = /^## (?:\d+\. )?Open Questions[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(spec)?.[1] ?? ''
  return section.split('\n').filter((line) => /^\s*- \[ \]/.test(line))
}

/** Acceptance criteria as defined by a `- **AC-n.n**` bullet; indented continuation lines belong to it. */
export function acsOf(spec: string): Ac[] {
  const lines = spec.split(/\r?\n/)
  const acs: Ac[] = []
  for (let i = 0; i < lines.length; i++) {
    const id = AC_BULLET.exec(lines[i])?.[1]
    if (!id) continue
    let text = lines[i]
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*[-*] /.test(lines[i + 1])) text += `\n${lines[++i]}`
    acs.push({ id, text, manual: /\[manual\]/i.test(text), gap: /\[gap\]/i.test(text) })
  }
  return acs
}

/** `Test: tests/x.test.ts › "title fragment"` references inside one criterion. */
export function testRefs(text: string): { file: string; fragment: string }[] {
  return [...text.matchAll(TEST_REF)].map((m) => ({ file: m[1], fragment: m[2] }))
}

/**
 * What must hold for the spec pipeline to be trustworthy (constitution I and III):
 * - every spec has a known status;
 * - a draft may have open questions, but it cannot have a plan or tasks yet;
 * - ready or implemented means no open questions;
 * - implemented means it has a plan and tasks, every task is checked, and each non-[manual] AC either names an
 *   existing test (`Test: tests/x.test.ts › "title"`, or its id appears in a test) or is tagged [gap] (testable,
 *   no test yet: a backlog that only shrinks).
 *
 * `tests` maps repo-relative path to file text.
 */
export function lintSpecs(dirs: SpecDir[], tests: Record<string, string>): string[] {
  const problems: string[] = []
  const allTests = Object.values(tests).join('\n')
  for (const dir of dirs) {
    if (!dir.spec) {
      problems.push(`${dir.name}: spec.md is missing`)
      continue
    }
    const status = statusOf(dir.spec)
    if (!status || !(STATUSES as readonly string[]).includes(status)) {
      problems.push(`${dir.name}: frontmatter needs status: ${STATUSES.join(' | ')} (got ${status ?? 'nothing'})`)
      continue
    }
    const questions = openQuestions(dir.spec)
    if (status === 'draft' && (dir.plan || dir.tasks)) problems.push(`${dir.name}: draft specs cannot have a plan or tasks (resolve the open questions first)`)
    if ((status === 'ready' || status === 'implemented') && questions.length) problems.push(`${dir.name}: ${status} but ${questions.length} open question(s) remain`)
    const acs = acsOf(dir.spec)
    const ids = acs.map((ac) => ac.id)
    for (const id of ids.filter((id, i) => ids.indexOf(id) !== i)) problems.push(`${dir.name}: ${id} is defined twice`)
    if (status === 'implemented') {
      if (!dir.plan) problems.push(`${dir.name}: implemented but plan.md is missing`)
      if (!dir.tasks) problems.push(`${dir.name}: implemented but tasks.md is missing`)
      if (/^\s*- \[ \]/m.test(dir.tasks ?? '')) problems.push(`${dir.name}: implemented but tasks.md has unchecked tasks`)
      if (!acs.length) problems.push(`${dir.name}: implemented spec defines no acceptance criteria`)
      for (const ac of acs) {
        if (ac.manual) continue
        const refs = testRefs(ac.text)
        for (const ref of refs) {
          if (!(ref.file in tests)) problems.push(`${dir.name}: ${ac.id} cites ${ref.file}, which does not exist`)
          else if (!tests[ref.file].includes(ref.fragment)) problems.push(`${dir.name}: ${ac.id} cites "${ref.fragment}", not found in ${ref.file}`)
        }
        if (!refs.length && !ac.gap && !allTests.includes(ac.id)) problems.push(`${dir.name}: ${ac.id} names no test: cite one (Test: file › "title") or tag it [gap] or [manual]`)
      }
    }
  }
  return problems
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)

export function loadSpecs(root: string): SpecDir[] {
  const base = join(root, '.specify', 'specs')
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, spec: read(join(base, entry.name, 'spec.md')), plan: read(join(base, entry.name, 'plan.md')), tasks: read(join(base, entry.name, 'tasks.md')) }))
}

export function readTests(root: string): Record<string, string> {
  const tests: Record<string, string> = {}
  for (const entry of readdirSync(join(root, 'tests'), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.test.ts')) continue
    const path = join(entry.parentPath, entry.name)
    tests[`tests/${path.slice(join(root, 'tests').length + 1).split(/[\\/]/).join('/')}`] = readFileSync(path, 'utf8')
  }
  return tests
}
