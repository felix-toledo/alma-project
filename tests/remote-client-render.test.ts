import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { translatePwa } from '../src/remote-client/i18n'
import { attachOutcomeKey, attachRetryOffered } from '../src/remote-client/lib/outcome'
import { AttachButton, AttachChips, AttachNotes } from '../src/remote-client/screens/AttachBar'
import { FileLines } from '../src/remote-client/screens/FileLines'
import type { PhoneAttachmentView } from '../src/shared/attach/phone'
import type { Attachments } from '../src/remote-client/screens/useAttachments'
import type { Chip, PhoneChipReason } from '../src/shared/attach/phone-chips'
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

describe('PWA attachment lines (031 AC-8.8, AC-5.1, AC-8.9)', () => {
  const lines = (attachments: PhoneAttachmentView[] | undefined, language: 'es' | 'en' = 'en'): string =>
    renderToStaticMarkup(createElement(FileLines, { attachments, language }))

  it('AC-8.8 (031) each attachment is its name, a kind icon and its size, as plain text: no link, no picture, no title', () => {
    const out = lines([
      { name: '<script>alert(1)</script>.txt', kind: 'text', size: 999 },
      { name: '**x**.md', kind: 'text', size: 1000 },
      { name: 'https://evil.example/a.png', kind: 'image', size: 700_000 },
      { name: 'informe.pdf', kind: 'pdf', size: 0 }
    ])
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;.txt')
    expect(out).toContain('**x**.md')
    expect(out).toContain('https://evil.example/a.png')
    for (const size of ['999 B', '1000 B', '683.5 KB', '0 B']) expect(out).toContain(size)
    expect(out).not.toMatch(/<script|<a[ >]|<img| href=| src=| title=|<button/i)
    expect(out.match(/<svg/g)).toHaveLength(4)
    expect(out).not.toMatch(/\bid=/)
  })

  it('AC-8.8 (031) the kind is announced in the language of the phone', () => {
    const one: PhoneAttachmentView[] = [{ name: 'a', kind: 'image', size: 1 }]
    expect(lines(one, 'en')).toContain(translatePwa('en', 'remote.pwa.attach.kind.image'))
    expect(lines(one, 'es')).toContain(translatePwa('es', 'remote.pwa.attach.kind.image'))
    for (const kind of ['text', 'pdf', 'office'] as const) {
      expect(lines([{ name: 'a', kind, size: 1 }], 'en')).toContain(translatePwa('en', `remote.pwa.attach.kind.${kind}`))
    }
  })

  it('AC-5.3 (031) a message without attachments draws no lines', () => {
    expect(lines(undefined)).toBe('')
    expect(lines([])).toBe('')
  })
})

describe('PWA composer files (031 AC-8.2, AC-8.3, AC-8.4, AC-8.5, AC-8.8)', () => {
  const view = (over: Partial<Attachments> = {}): Attachments => ({
    chips: [],
    button: { enabled: true, reason: null },
    known: true,
    pick: () => undefined,
    remove: () => undefined,
    retry: () => undefined,
    readyIds: () => [],
    canSend: () => true,
    sent: () => undefined,
    ...over
  })
  const html = (component: unknown, props: Record<string, unknown>): string => renderToStaticMarkup(createElement(component as never, props))
  const hostile = '<script>alert(1)</script>**x**.txt'

  it('AC-8.2 (031) the attach button has a name, opens the phone\'s own chooser for several files and forces no camera', () => {
    const out = html(AttachButton, { attach: view(), language: 'en', running: false })
    expect(out).toContain(`aria-label="${translatePwa('en', 'remote.pwa.attach.button')}"`)
    expect(out).toMatch(/<input[^>]*type="file"[^>]*multiple/)
    expect(out).not.toContain('capture')
    // named picture types, not image/*: iOS then converts a HEIC photo to JPEG instead of handing over a file the phone refuses
    expect(out).toMatch(/accept="image\/jpeg,image\/png,image\/webp,image\/gif,[^"]*\.pdf/)
    expect(out).not.toContain('image/*')
    expect(out).toMatch(/<button[^>]*type="button"/)
    expect(out).not.toMatch(/<button[^>]*disabled/)
  })

  it('AC-8.4 (031) the button is disabled when the PC does not allow files, and says why only once the PC has answered', () => {
    const off = view({ button: { enabled: false, reason: 'remote.pwa.attach.off' } })
    expect(html(AttachButton, { attach: off, language: 'en', running: false })).toMatch(/<button[^>]*disabled/)
    expect(html(AttachNotes, { attach: off, language: 'en' })).toContain(translatePwa('en', 'remote.pwa.attach.off'))
    expect(html(AttachNotes, { attach: { ...off, known: false }, language: 'en' })).not.toContain(translatePwa('en', 'remote.pwa.attach.off'))
    expect(html(AttachNotes, { attach: view(), language: 'en' })).toBe('')
  })

  it('AC-8.4 (031) a run in progress disables the button too', () => {
    expect(html(AttachButton, { attach: view(), language: 'en', running: true })).toMatch(/<button[^>]*disabled/)
  })

  it('AC-4.3 (031) while a send is in flight the chips cannot be removed or retried, and while it is not they can', () => {
    const chips: Chip[] = [
      { key: 'a', name: 'a.pdf', state: 'ready', id: 'x' },
      { key: 'b', name: 'b.pdf', state: 'failed', reason: 'network' }
    ]
    const buttons = (locked: boolean) => (html(AttachChips, { attach: view({ chips }), language: 'en', locked }).match(/<button[^>]*>/g) ?? [])
    expect(buttons(true)).toHaveLength(3)
    for (const button of buttons(true)) expect(button).toMatch(/disabled/)
    for (const button of buttons(false)) expect(button).not.toMatch(/disabled/)
  })

  it('AC-8.3 (031) each chip shows its name or its state, with a remove button that names the file', () => {
    const chips: Chip[] = [
      { key: 'a', name: 'a.pdf', state: 'preparing' },
      { key: 'b', name: 'b.pdf', state: 'uploading' },
      { key: 'c', name: 'c.pdf', state: 'ready', id: 'secret-id' }
    ]
    const out = html(AttachChips, { attach: view({ chips }), language: 'en' })
    expect(out).toContain(translatePwa('en', 'remote.pwa.attach.preparing', { name: 'a.pdf' }))
    expect(out).toContain(translatePwa('en', 'remote.pwa.attach.uploading', { name: 'b.pdf' }))
    expect(out).toMatch(/<span>c\.pdf<\/span>/)
    for (const name of ['a.pdf', 'b.pdf', 'c.pdf']) expect(out).toContain(`aria-label="${translatePwa('en', 'remote.pwa.attach.remove', { name })}"`)
    expect(out).not.toContain('secret-id')
    expect(html(AttachChips, { attach: view(), language: 'en' })).toBe('')
  })

  it('AC-8.5 (031) a failed chip is explained by exactly one concrete text naming the file, and retry only where trying again can help', () => {
    const reasons: PhoneChipReason[] = ['too-large', 'file-type', 'secret-name', 'attach-off', 'notice-needed', 'unavailable', 'network', 'unreadable']
    for (const reason of reasons) {
      const chips: Chip[] = [{ key: 'k', name: 'doc.pdf', state: 'failed', reason }]
      const notes = html(AttachNotes, { attach: view({ chips }), language: 'en' })
      const text = translatePwa('en', attachOutcomeKey(reason), { name: 'doc.pdf' }).replace(/'/g, '&#x27;')
      expect(notes, reason).toContain(text)
      expect(notes.match(/class="pwa-error"/g), reason).toHaveLength(1)
      const retry = html(AttachChips, { attach: view({ chips }), language: 'en' }).includes(`aria-label="${translatePwa('en', 'remote.pwa.retry')}"`)
      expect(retry, reason).toBe(attachRetryOffered(reason))
    }
  })

  it('AC-8.8 (031) a hostile file name is plain text: escaped, no markup, no link, no title', () => {
    const chips: Chip[] = [
      { key: 'k1', name: hostile, state: 'ready', id: 'i' },
      { key: 'k2', name: hostile, state: 'failed', reason: 'file-type' }
    ]
    const out = html(AttachChips, { attach: view({ chips }), language: 'en' }) + html(AttachNotes, { attach: view({ chips }), language: 'en' })
    expect(out).not.toMatch(/<script/i)
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;**x**.txt')
    expect(out).not.toMatch(/<a[ >]|<img| title=|href=/)
  })
})
