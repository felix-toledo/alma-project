import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { translatePwa } from '../src/remote-client/i18n'
import { NoteBody } from '../src/remote-client/screens/NoteBody'
import { StateView } from '../src/remote-client/screens/StateView'
import type { ScreenState } from '../src/remote-client/lib/screen-state'

const draw = (state: ScreenState<string>, onRetry?: () => void): string =>
  renderToStaticMarkup(createElement(StateView<string>, { state, language: 'en', empty: 'remote.pwa.folder.empty', onRetry, children: (data: string) => `content:${data}` }))
const esc = (text: string): string => text.replace(/'/g, '&#x27;')
const retryLabel = translatePwa('en', 'remote.pwa.retry')

describe('PWA state view (028 AC-6.3, AC-6.4, AC-6.6)', () => {
  it('AC-6.3 (028) every state draws its own concrete text and the content only when there is content', () => {
    expect(draw({ kind: 'content', data: 'x' })).toBe('content:x')
    expect(draw({ kind: 'empty' })).toContain(translatePwa('en', 'remote.pwa.folder.empty'))
    expect(draw({ kind: 'error', key: 'remote.pwa.note.gone', retry: false })).toContain(translatePwa('en', 'remote.pwa.note.gone'))
    expect(draw({ kind: 'scopeOff', key: 'remote.pwa.writeOff' })).toContain(translatePwa('en', 'remote.pwa.writeOff'))
    expect(draw({ kind: 'unreachable' })).toContain(esc(translatePwa('en', 'remote.pwa.pcUnreachable')))
    expect(draw({ kind: 'revoked' })).toContain(translatePwa('en', 'remote.pwa.revoked'))
  })

  it('AC-6.3 (028) loading draws nothing before the threshold and a skeleton after it', () => {
    expect(draw({ kind: 'loading', since: Date.now() })).toBe('')
    const late = draw({ kind: 'loading', since: Date.now() - 1000 })
    expect(late).toContain('pwa-skeleton')
    expect(late).toContain('aria-busy="true"')
    expect(late).toContain(translatePwa('en', 'remote.pwa.loading'))
  })

  it('AC-6.6 (028) retry is offered for the PC not answering and a retryable error, never for scope off, revoked or empty', () => {
    const retry = (): void => undefined
    expect(draw({ kind: 'unreachable' }, retry)).toContain(retryLabel)
    expect(draw({ kind: 'error', key: 'remote.pwa.error.invalid', retry: true }, retry)).toContain(retryLabel)
    expect(draw({ kind: 'error', key: 'remote.pwa.noteTooBig', retry: false }, retry)).not.toContain(retryLabel)
    expect(draw({ kind: 'scopeOff', key: 'remote.pwa.scopeOff' }, retry)).not.toContain(retryLabel)
    expect(draw({ kind: 'revoked' }, retry)).not.toContain(retryLabel)
    expect(draw({ kind: 'empty' }, retry)).not.toContain(retryLabel)
    // Nothing to run: no button to show.
    expect(draw({ kind: 'unreachable' })).not.toContain(retryLabel)
  })
})

const hostile = [
  '# Titulo',
  '<script>alert(1)</script>',
  '<img src="https://evil.example/pixel.png" onerror="alert(2)">',
  '![tracker](https://evil.example/pixel.png)',
  '![inline](data:image/png;base64,AAEC)',
  '![foto](Fotos/gato.png)',
  '[js](javascript:alert(3)) [mail](mailto:a@b.c) [web](https://example.com/x?y=1) [nota](Otra.md) [ancla](#seccion)'
].join('\n\n')

describe('PWA note rendering (028 AC-2.3, AC-2.12, AC-2.15)', () => {
  const asked: string[] = []
  const body = renderToStaticMarkup(
    createElement(NoteBody, {
      text: hostile,
      notePath: 'Docs/n.md',
      language: 'en',
      fetchImage: async (target: string) => {
        asked.push(target)
        return { ok: false as const, reason: 'network' as const }
      },
      onOpenNote: () => undefined
    })
  )

  it('AC-2.12 (028) nothing executes and no address the note names is loaded', () => {
    // Raw HTML shows as escaped text, as in the desktop reading mode: never a tag, never an attribute that loads.
    expect(body).not.toMatch(/<script/i)
    expect(body).toContain('&lt;script&gt;')
    expect(body).not.toContain('<img')
    expect(body).not.toMatch(/(src|href)="[^"]*(evil.example|data:)/)
    expect(body).toContain(translatePwa('en', 'remote.pwa.image.blocked'))
    // A vault image waits (it is asked for only when it nears the screen), it is not fetched while drawing.
    expect(asked).toEqual([])
    expect(body).toContain(translatePwa('en', 'remote.pwa.loading'))
  })

  it('AC-2.15 (028) links: a note opens inside, an external one only as a link to tap, the rest are plain text', () => {
    expect(body).toContain('<a href="https://example.com/x?y=1" target="_blank" rel="noopener noreferrer">web</a>')
    expect(body).toMatch(/<button[^>]*class="pwa-link"[^>]*>nota<\/button>/)
    expect(body).not.toContain('javascript:')
    expect(body).not.toContain('mailto:')
    expect(body).not.toMatch(/<a [^>]*>(js|mail|ancla)</)
    expect(body).toContain('<span>js</span>')
  })
})
