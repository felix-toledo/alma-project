import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PwaKey } from '../src/remote-client/i18n'
import { en as pwaEn } from '../src/remote-client/i18n/en'
import { es as pwaEs } from '../src/remote-client/i18n/es'
import { AttachButton, AttachChips, AttachNotes } from '../src/remote-client/screens/AttachBar'
import { FileLines } from '../src/remote-client/screens/FileLines'
import type { Attachments } from '../src/remote-client/screens/useAttachments'
import type { Chip, ChipState, PhoneChipReason } from '../src/shared/attach/phone-chips'

// The markup tests of the verification live apart from verify-031-pwa.test.ts: they compile with the DOM project (tsconfig.remote.json).

describe('031 verify: the markup is plain text only (AC-5.1, AC-8.8, BR-19)', () => {
  const HOSTILE = '<img src=x onerror=alert(1)>"\'><a href="javascript:alert(1)">pwn</a> javascript:alert(1)'
  const attach = (chips: Chip[], over: Partial<Attachments> = {}): Attachments => ({
    chips,
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
  // only real tags count: a hostile name that survives as escaped text is exactly what is wanted
  const noMarkup = (html: string) => {
    const tags = html.match(/<[a-zA-Z][^>]*>/g) ?? []
    const names = new Set(tags.map((tag) => /^<([a-zA-Z0-9]+)/.exec(tag)?.[1]))
    expect([...names].filter((name) => !['div', 'ul', 'li', 'span', 'p', 'button', 'input', 'svg', 'rect', 'circle', 'path'].includes(name ?? ''))).toEqual([])
    // attribute values are dropped first: an escaped name inside aria-label="..." is text, not an attribute
    for (const tag of tags) expect(tag.replace(/="[^"]*"/g, '=""')).not.toMatch(/\s(href|src|title|srcset|style|on\w+)=/i)
  }

  it('AC-8.8 (031 verify) a message\'s attachments show name, kind and size as text: no image, link or title, whatever the name says', () => {
    const html = renderToStaticMarkup(createElement(FileLines, { language: 'en', attachments: [{ name: HOSTILE, kind: 'image', size: 2048 }, { name: 'doc.pdf', kind: 'pdf', size: 5 }, { name: 'o.docx', kind: 'office', size: 1_500_000 }, { name: 't.txt', kind: 'text', size: 0 }] }))
    noMarkup(html)
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('2.0 KB')
    expect(html).toContain('5 B')
    expect(html).toContain('1.4 MB')
    for (const kind of ['Picture', 'PDF', 'Document', 'Text']) expect(html).toContain(kind)
    expect(html).not.toMatch(/ID-MARKER|\/api\//)
  })

  it('AC-8.8 (031 verify) no attachments, an empty list or none at all draws nothing', () => {
    for (const attachments of [undefined, []]) expect(renderToStaticMarkup(createElement(FileLines, { language: 'es', attachments }))).toBe('')
  })

  it('AC-8.8 (031 verify) kind labels exist in Spanish too', () => {
    const html = renderToStaticMarkup(createElement(FileLines, { language: 'es', attachments: [{ name: 'a', kind: 'image', size: 1 }, { name: 'b', kind: 'office', size: 1 }] }))
    expect(html).toContain('Imagen')
    expect(html).toContain('Documento')
  })

  it('AC-8.3 (031 verify) chips draw their state texts and name with a remove button labelled with the name, all escaped', () => {
    const chips: Chip[] = [
      { key: '1', name: HOSTILE, state: 'preparing' },
      { key: '2', name: 'b.png', state: 'uploading' },
      { key: '3', name: 'c.txt', state: 'ready', id: 'SECRET-ID' },
      { key: '4', name: 'd.txt', state: 'failed', reason: 'network' }
    ]
    const html = renderToStaticMarkup(createElement(AttachChips, { attach: attach(chips), language: 'en' }))
    noMarkup(html)
    expect(html).toContain('Preparing')
    expect(html).toContain('Uploading')
    expect(html).toContain('data-state="ready"')
    expect(html).not.toContain('SECRET-ID')
    expect((html.match(/aria-label="Remove/g) ?? []).length).toBe(4)
    expect(html).not.toContain(HOSTILE)
  })

  it('AC-8.5 (031 verify) only a failed chip with a retryable reason has a retry button', () => {
    const draw = (reason: PhoneChipReason | undefined, state: ChipState = 'failed') =>
      renderToStaticMarkup(createElement(AttachChips, { attach: attach([{ key: 'k', name: 'n.txt', state, reason }]), language: 'en' }))
    expect(draw('network')).toContain('aria-label="Retry"')
    expect(draw('unreadable')).toContain('aria-label="Retry"')
    for (const reason of ['file-type', 'too-large', 'secret-name', 'attach-off', 'notice-needed', 'unavailable'] as const) expect(draw(reason)).not.toContain('Retry')
    expect(draw(undefined)).not.toContain('Retry')
    expect(draw('network', 'uploading')).not.toContain('Retry')
    expect(renderToStaticMarkup(createElement(AttachChips, { attach: attach([]), language: 'en' }))).toBe('')
  })

  it('AC-8.5 (031 verify) every failed chip shows exactly one concrete line naming the file; a healthy chip shows none', () => {
    const chips: Chip[] = [
      { key: '1', name: 'one.png', state: 'failed', reason: 'file-type' },
      { key: '2', name: HOSTILE, state: 'failed', reason: 'secret-name' },
      { key: '3', name: 'ok.txt', state: 'ready', id: 'x' },
      { key: '4', name: 'up.txt', state: 'uploading' }
    ]
    const html = renderToStaticMarkup(createElement(AttachNotes, { attach: attach(chips), language: 'en' }))
    noMarkup(html)
    expect((html.match(/pwa-error/g) ?? []).length).toBe(2)
    expect(html).toContain('one.png')
    expect(html).not.toContain('ok.txt')
    expect(html).not.toContain('up.txt')
  })

  it('AC-8.4 (031 verify) the switch-off reason is shown only once the PC has answered, and not when the button is enabled', () => {
    const off = { enabled: false, reason: 'remote.pwa.attach.off' as PwaKey }
    expect(renderToStaticMarkup(createElement(AttachNotes, { attach: attach([], { button: off, known: true }), language: 'en' }))).toContain('Sending files is turned off on the PC.')
    expect(renderToStaticMarkup(createElement(AttachNotes, { attach: attach([], { button: off, known: false }), language: 'en' }))).not.toContain('turned off')
    expect(renderToStaticMarkup(createElement(AttachNotes, { attach: attach([]), language: 'en' }))).toBe('')
  })

  it('AC-8.2 (031 verify) the attach button is labelled, disabled when files are off or a run is going, and opens a chooser that takes several files without forcing the camera', () => {
    const draw = (enabled: boolean, running: boolean) => renderToStaticMarkup(createElement(AttachButton, { attach: attach([], { button: { enabled, reason: null } }), language: 'es', running }))
    const on = draw(true, false)
    expect(on).toContain('aria-label="Adjuntar"')
    expect(on).toMatch(/<button[^>]*type="button"/)
    expect(on).not.toMatch(/<button[^>]*disabled/)
    expect(on).toMatch(/<input[^>]*type="file"/)
    expect(on).toContain('multiple')
    expect(on).not.toMatch(/capture/)
    expect(on).not.toContain('image/*')
    expect(on).toContain('image/jpeg')
    expect(draw(false, false)).toMatch(/<button[^>]*disabled/)
    expect(draw(true, true)).toMatch(/<button[^>]*disabled/)
  })

  it('AC-8.2 (031 verify) the chooser lists the 030 types and offers nothing the PC would refuse by extension, SVG and HTML included', () => {
    const html = renderToStaticMarkup(createElement(AttachButton, { attach: attach([]), language: 'en', running: false }))
    const accept = /accept="([^"]*)"/.exec(html)?.[1] ?? ''
    const list = accept.split(',')
    for (const type of ['.png', '.pdf', '.docx', '.txt', '.xlsx', '.pptx']) expect(list).toContain(type)
    for (const type of ['.svg', '.html', '.exe', '.zip', 'image/svg+xml', 'text/html', '*/*', 'image/*']) expect(list).not.toContain(type)
  })

  it('AC-8.9 (031 verify) the phone shows no text of its own: the attach-bar strings are all dictionary entries in both languages', () => {
    for (const key of Object.keys(pwaEs).filter((k) => k.startsWith('remote.pwa.attach.') || k === 'remote.pwa.can.attach')) {
      expect({ key, es: key in pwaEs, en: key in pwaEn }).toEqual({ key, es: true, en: true })
    }
  })
})
