import { describe, expect, it } from 'vitest'
import type { Change } from '../src/shared/dream/apply'
import { applyChanges, foldBatch, foldedChanges, foldedLines, MAX_MEMORY_CHARS, memoryTotal, startFold } from '../src/shared/dream/apply'
import type { JournalEntry, JournalTexts } from '../src/shared/dream/journal'
import { journalSection, renderJournal } from '../src/shared/dream/journal'
import type { BatchOutput } from '../src/shared/dream/output'

const src = [{ thread: 't1', ts: 1 }]
const add = (text: string): Change => ({ kind: 'add', text, why: 'w', sources: src })
const replace = (old: string, text: string): Change => ({ kind: 'replace', old, text, why: 'w', sources: src })
const remove = (old: string): Change => ({ kind: 'remove', old, why: 'w', sources: src })
const batch = (part: Partial<BatchOutput>): BatchOutput => ({ add: [], replace: [], remove: [], speculative: [], ...part })
const line = (n: number, length: number): string => `${n}`.padEnd(length, 'x')

describe('dream: applying changes (spec 033)', () => {
  it('AC-6.5 (033) a target line changed meanwhile is skipped', () => {
    const snapshot = ['Vive en Asunción', 'Tiene un perro', 'Toma café']
    // Meanwhile the person edited one line and deleted another, and added one of their own.
    const current = ['Vive en Asunción, Paraguay', 'Toma café', 'Línea nueva de la persona']
    const changes = [replace('Vive en Asunción', 'Vive en Encarnación'), remove('Tiene un perro'), replace('Toma café', 'Toma mate'), add('Le gusta correr')]
    const result = applyChanges(current, snapshot, changes)
    expect(result.lines).toEqual(['Vive en Asunción, Paraguay', 'Toma mate', 'Línea nueva de la persona', 'Le gusta correr'])
    expect(result.skipped).toEqual([
      { change: changes[1], reason: 'changed' },
      { change: changes[0], reason: 'changed' }
    ])
    expect(result.applied).toEqual([changes[2], changes[3]])
    // Duplicate lines: each change takes one occurrence; a second removal needs a second copy.
    const dup = applyChanges(['A', 'B', 'A'], ['A', 'B', 'A'], [remove('A'), remove('A'), remove('A')])
    expect(dup.lines).toEqual(['B'])
    expect(dup.skipped.map((s) => s.reason)).toEqual(['changed'])
  })

  it('AC-6.3 (033) the 4000 limit', () => {
    expect(MAX_MEMORY_CHARS).toBe(4000)
    // The measure is the sum of the lines, as remember counts it (plan §10 G1).
    expect(memoryTotal(['abc', 'de'])).toBe(5)
    // Many changes: no count limit.
    const many = Array.from({ length: 60 }, (_, i) => add(`Recuerdo número ${i}`))
    expect(applyChanges([], [], many).applied).toHaveLength(60)
    // 3900 used: removals, then replacements, then additions in proposed order while they fit; the rest is full.
    const lines = [line(1, 1000), line(2, 1000), line(3, 1000), line(4, 900)]
    const changes = [add('a'.repeat(150)), add('b'.repeat(60)), replace(line(2, 1000), 'r'.repeat(1050)), remove(line(4, 900)), add('c'.repeat(40))]
    const result = applyChanges(lines, lines, changes)
    // After the removal (3000) the growing replacement fits (3050); then 150 fits (3200), 60 fits (3260), 40 fits.
    expect(result.skipped).toEqual([])
    expect(memoryTotal(result.lines)).toBe(3300)
    const tight = applyChanges(lines, lines, [add('a'.repeat(150)), add('b'.repeat(60)), add('c'.repeat(40))])
    expect(tight.applied).toEqual([add('b'.repeat(60)), add('c'.repeat(40))])
    expect(tight.skipped).toEqual([{ change: add('a'.repeat(150)), reason: 'full' }])
    expect(memoryTotal(tight.lines)).toBe(4000)
    // A growing replacement that does not fit is full (plan §10 G2).
    const grow = applyChanges(lines, lines, [replace(line(1, 1000), 'g'.repeat(1200))])
    expect(grow.skipped.map((s) => s.reason)).toEqual(['full'])
    expect(grow.lines).toEqual(lines)
    // A file that started at 4100 never grows, but may shrink and may refill what it freed.
    const over = [line(1, 2000), line(2, 2100)]
    expect(applyChanges(over, over, [add('nuevo recuerdo')]).skipped.map((s) => s.reason)).toEqual(['full'])
    const shrunk = applyChanges(over, over, [replace(line(2, 2100), 's'.repeat(2000)), add('n'.repeat(100)), add('m'.repeat(10))])
    expect(memoryTotal(shrunk.lines)).toBe(4100)
    expect(shrunk.skipped.map((s) => s.reason)).toEqual(['full'])
    // The person grew the file past 4000 meanwhile: their lines stay, a shrinking replacement still applies.
    const snap = [line(1, 3000)]
    const grown = [line(1, 3000), line(9, 1500)]
    const meanwhile = applyChanges(grown, snap, [replace(line(1, 3000), 'short line'), add('n'.repeat(10))])
    expect(meanwhile.lines).toEqual(['short line', line(9, 1500), 'n'.repeat(10)])
  })

  it('AC-6.2 (033) a replacement keeps the old line verbatim', () => {
    const result = applyChanges(['Vive en Asunción'], ['Vive en Asunción'], [replace('Vive en Asunción', 'Vive en Encarnación')])
    expect(result.applied).toEqual([{ kind: 'replace', old: 'Vive en Asunción', text: 'Vive en Encarnación', why: 'w', sources: src }])
    expect(result.lines).toEqual(['Vive en Encarnación'])
  })

  it('AC-6.4 (033) a removal keeps the line verbatim', () => {
    const result = applyChanges(['Tiene un perro', 'Toma café'], ['Tiene un perro', 'Toma café'], [remove('Tiene un perro')])
    expect(result.applied).toEqual([{ kind: 'remove', old: 'Tiene un perro', why: 'w', sources: src }])
    expect(result.lines).toEqual(['Toma café'])
  })

  it('AC-6.5 (033) a later batch sees what earlier batches changed', () => {
    const s2 = [{ thread: 't2', ts: 5 }]
    let fold = startFold(['Vive en Asunción', 'Tiene un perro', 'Toma café'])
    fold = foldBatch(fold, batch({ add: [{ text: 'Trabaja en X', why: 'w', sources: src }], replace: [{ old: 'Vive en Asunción', text: 'Vive en Luque', why: 'w', sources: src }] }))
    fold = foldBatch(
      fold,
      batch({
        // Changes on lines an earlier batch wrote, and one target nobody has.
        replace: [
          { old: 'Trabaja en X', text: 'Trabaja en Y', why: 'w2', sources: s2 },
          { old: 'Vive en Luque', text: 'Vive en Encarnación', why: 'w2', sources: s2 },
          { old: 'No existe', text: 'Algo', why: 'w2', sources: s2 }
        ],
        remove: [{ old: 'Tiene un perro', why: 'w2', sources: s2 }]
      })
    )
    expect(foldedLines(fold)).toEqual(['Vive en Encarnación', 'Toma café', 'Trabaja en Y'])
    // Every change targets a line of the snapshot or adds one, so applying against the file works.
    expect(foldedChanges(fold)).toEqual([
      { kind: 'remove', old: 'Tiene un perro', why: 'w2', sources: s2 },
      { kind: 'replace', old: 'Vive en Asunción', text: 'Vive en Encarnación', why: 'w2', sources: [...src, ...s2] },
      { kind: 'add', text: 'Trabaja en Y', why: 'w2', sources: [...src, ...s2] }
    ])
    expect(fold.skipped).toEqual([{ change: { kind: 'replace', old: 'No existe', text: 'Algo', why: 'w2', sources: s2 }, reason: 'not-found' }])
    // A line added then removed in the same dream never reaches the file.
    const gone = foldBatch(foldBatch(startFold([]), batch({ add: [{ text: 'Efímero', why: 'w', sources: src }] })), batch({ remove: [{ old: 'Efímero', why: 'w', sources: src }] }))
    expect(foldedChanges(gone)).toEqual([])
    // A replaced line later removed is a removal of the original line.
    const replacedThenRemoved = foldBatch(
      foldBatch(startFold(['Original']), batch({ replace: [{ old: 'Original', text: 'Nuevo', why: 'w', sources: src }] })),
      batch({ remove: [{ old: 'Nuevo', why: 'w2', sources: s2 }] })
    )
    expect(foldedChanges(replacedThenRemoved)).toEqual([{ kind: 'remove', old: 'Original', why: 'w2', sources: [...src, ...s2] }])
    expect(applyChanges(['Original'], ['Original'], foldedChanges(replacedThenRemoved)).lines).toEqual([])
  })
})

const TEXTS: JournalTexts = {
  title: (date) => `Sueño del ${date}`,
  added: 'Recuerdos nuevos',
  replaced: 'Recuerdos corregidos',
  removed: 'Recuerdos borrados',
  skipped: 'Cambios no aplicados',
  speculative: 'Corazonadas',
  skipReason: { changed: 'la línea cambió', 'not-found': 'no estaba', full: 'no entraba' },
  capped: (unread) => `Me detuve en el tope: ${unread} conversaciones sin leer`,
  footer: (provider, model, costUsd) => `${provider} · ${model} · USD ${costUsd.toFixed(4)}`,
  source: (thread, ts) => `${thread} · ${ts}`
}
const s2 = [{ thread: 't2', ts: 42 }]
const ENTRY: JournalEntry = {
  date: '2026-06-10',
  applied: [add('Le gusta correr'), { kind: 'replace', old: 'Vive en Asunción', text: 'Vive en Encarnación', why: 'Se mudó', sources: s2 }, remove('Tiene un perro')],
  skipped: [{ change: replace('Toma café', 'Toma mate'), reason: 'changed' }, { change: add('No entra'), reason: 'full' }],
  speculative: [{ text: 'Quizás\ncambie de trabajo', sources: s2 }],
  provider: 'meta',
  model: 'm-small',
  costUsd: 0.0123
}

describe('dream: the journal (spec 033)', () => {
  it('AC-5.1 (033) the journal lists every change with its sources', () => {
    const text = journalSection(ENTRY, TEXTS)
    const sectionOf = (heading: string): string => text.slice(text.indexOf(heading)).split('\n### ')[0]
    expect(text).toContain('## Sueño del 2026-06-10')
    expect(sectionOf('Recuerdos nuevos')).toContain('- Le gusta correr')
    // The old line verbatim next to the new one, so the person can undo it by hand.
    expect(sectionOf('Recuerdos corregidos')).toContain('Vive en Asunción → Vive en Encarnación — Se mudó · t2 · 42')
    expect(sectionOf('Recuerdos borrados')).toContain('- Tiene un perro')
    expect(sectionOf('Cambios no aplicados')).toContain('Toma café → Toma mate')
    expect(sectionOf('Cambios no aplicados')).toContain('la línea cambió')
    expect(sectionOf('Cambios no aplicados')).toContain('No entra')
    expect(sectionOf('Cambios no aplicados')).toContain('no entraba')
    expect(sectionOf('Corazonadas')).toContain('- Quizás cambie de trabajo · t2 · 42')
    // Every item cites its sources.
    const items = text.split('\n').filter((l) => l.startsWith('- '))
    expect(items).toHaveLength(6)
    for (const item of items) expect(item).toMatch(/t\d · \d+$/)
    // An empty list leaves its heading out.
    expect(journalSection({ ...ENTRY, skipped: [], speculative: [] }, TEXTS)).not.toContain('Corazonadas')
  })

  it('AC-5.6 (033) frontmatter and footer', () => {
    const es = renderJournal(ENTRY, TEXTS, { origen: 'ia', tipo: 'sueño' })
    expect(es.startsWith('---\norigen: ia\ntipo: sueño\n---\n')).toBe(true)
    const en = renderJournal(ENTRY, TEXTS, { origin: 'ai', type: 'dream' })
    expect(en.startsWith('---\norigin: ai\ntype: dream\n---\n')).toBe(true)
    expect(es).toContain('meta · m-small · USD 0.0123')
    expect(es.trimEnd().endsWith('_meta · m-small · USD 0.0123_')).toBe(true)
    // A section to append has no frontmatter.
    expect(journalSection(ENTRY, TEXTS).startsWith('---')).toBe(false)
    expect(journalSection(ENTRY, TEXTS)).toContain('meta · m-small · USD 0.0123')
  })

  it('AC-4.3 (033) a capped journal says so and counts the unread conversations', () => {
    expect(journalSection({ ...ENTRY, capped: { unread: 3 } }, TEXTS)).toContain('Me detuve en el tope: 3 conversaciones sin leer')
    expect(journalSection(ENTRY, TEXTS)).not.toContain('tope')
  })

  it('AC-5.2 (033) the speculative section is in the journal only', () => {
    // The journal shows the hunches; applyChanges has no input for them, so they cannot reach the memory lines.
    expect(journalSection(ENTRY, TEXTS)).toContain('Corazonadas')
    expect(applyChanges([], [], ENTRY.applied).lines.join('\n')).not.toContain('cambie de trabajo')
  })
})
