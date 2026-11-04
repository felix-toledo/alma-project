// Spec 025 AC-7.6: code comments in `src/` and `tests/` are English (test titles and Spanish assertions stay).
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSources } from './support/arch'
import { checkCommentsBaseline, COMMENTS_BASELINE, countSpanishComments, spanishComments } from './support/comments-language'

const root = resolve(__dirname, '..')

describe('AC-7.6 comments', () => {
  it('AC-7.6 comments in src and tests that read as Spanish are exactly the recorded ones (lower the baseline, never raise it)', () => {
    const files = { ...readSources(root, 'src'), ...readSources(root, 'tests') }
    expect(checkCommentsBaseline(countSpanishComments(files), COMMENTS_BASELINE)).toEqual([])
  })

  it('AC-7.6 comments sees Spanish in line and block comments and leaves strings, code spans and quoted UI text alone', () => {
    const source = [
      '// Esto no se usa más',
      'const a = "Esto no se usa más" // an English comment',
      '/** La función devuelve el valor. */',
      "const b = 'x' /* `configuración` and «Guardar cambios» stay */",
      '/* The value for the user. */',
      '// Says "¡Sí, dale!" to confirm',
      'const url = "https://example.com/ñandú"'
    ].join('\n')
    expect(spanishComments(source)).toEqual([
      { line: 1, text: 'Esto no se usa más' },
      { line: 3, text: '* La función devuelve el valor.' }
    ])
  })

  it('AC-7.6 comments fails above the baseline and below it, and covers only src and tests', () => {
    expect(checkCommentsBaseline({ 'src/a.ts': 2 }, { 'src/a.ts': 1 })).toEqual([expect.stringContaining('baseline 1: write the comment in English')])
    expect(checkCommentsBaseline({ 'src/a.ts': 1 }, { 'src/a.ts': 2 })).toEqual([expect.stringContaining('lower the baseline to 1')])
    expect(checkCommentsBaseline({}, { 'src/gone.ts': 2 })).toEqual([expect.stringContaining('lower the baseline to 0')])
    const spanish = '// Esto no se usa más'
    expect(countSpanishComments({ 'src/a.ts': spanish, 'scripts/b.ts': spanish, 'tests/c.tsx': spanish, 'docs/d.md': spanish })).toEqual({ 'src/a.ts': 1, 'tests/c.tsx': 1 })
  })
})
