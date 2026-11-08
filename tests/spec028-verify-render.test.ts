import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { classifyLink, imageTarget, prepareNote } from '../src/remote-client/lib/markdown'
import { NoteBody } from '../src/remote-client/screens/NoteBody'

// Adversarial verification of spec 028 notes rendering. Its own file because it renders TSX (tsconfig.remote.json), which tsconfig.node.json cannot compile.

describe('AC-2.12 / AC-2.15 (028 verify) a note is data, not code', () => {
  const language = 'en' as const
  const render = (text: string): string => renderToStaticMarkup(createElement(NoteBody, { text: prepareNote(text), notePath: 'Docs/n.md', language, fetchImage: async () => ({ ok: false as const, reason: 'unavailable' as const }), onOpenNote: () => undefined }))

  it('AC-2.12 (028 verify) raw HTML, scripts, remote and data images, javascript links in every spelling: nothing executable or remote reaches the markup', () => {
    const html = render(
      [
        '<script>alert(1)</script>',
        '<img src="http://evil.test/pixel.png" onerror="alert(1)">',
        '<iframe src="http://evil.test"></iframe>',
        '<a href="javascript:alert(1)">raw</a>',
        '[a](javascript:alert(1))',
        '[b](JaVaScRiPt:alert(1))',
        '[c](java&#x73;cript:alert(1))',
        '[d](&#106;avascript:alert(1))',
        '[e](<javascript:alert(1)>)',
        '[f][1]',
        '[1]: javascript:alert(1)',
        '<javascript:alert(1)>',
        '[g](data:text/html;base64,PHNjcmlwdD4=)',
        '[h](vbscript:x)',
        '![i](http://evil.test/a.png)',
        '![j](//evil.test/b.png)',
        '![k](data:image/svg+xml;base64,PHN2Zz4=)',
        '![[http://evil.test/c.png]]',
        '![[//evil.test/d.png]]',
        '![l]( https://evil.test/e.png)',
        '[ok](https://example.com/page)',
        '[wiki]([[Otra]])',
        '[[Plain wiki]]'
      ].join('\n\n')
    )
    // Text that merely shows the attack (escaped) is fine; what must not exist is an element or attribute that acts.
    expect(html).not.toMatch(/<(script|iframe|img|object|embed|style|link)\b/i)
    expect(html).not.toMatch(/<[^>]*\son\w+\s*=/i)
    expect(html).not.toMatch(/\s(src|href|srcset|action|formaction)="(?!https:\/\/example\.com\/page")/i)
    expect(html).not.toMatch(/(src|href)="[^"]*evil/i)
    // The one external link is a plain anchor that opens on tap, in a new context, without the opener.
    expect(html).toContain('href="https://example.com/page"')
    expect(html).toMatch(/rel="noopener noreferrer"/)
    expect(html).toContain('[[Plain wiki]]')
  })

  it('AC-2.15 (028 verify) a relative note link becomes a button, never an anchor, and a link that climbs out of the vault is inert text', () => {
    const html = render('[ok](Otra.md) [up](../../../secret.md) [abs](/etc/passwd.md) [win](C:\\x.md)')
    expect(html).toContain('<button')
    expect(html).not.toMatch(/href="(?!https?:)/)
    expect(html.match(/<button/g)).toHaveLength(1)
  })

  it('AC-2.12 (028 verify) every spelling of an address the phone could be tricked into asking about is blocked before any request', () => {
    for (const src of ['http://x/a.png', 'HTTPS://x/a.png', 'data:image/png;base64,AA', 'blob:x', 'file:///c:/a.png', 'C:\\a.png', 'c:a.png', '//x/a.png', '\\\\x\\a.png', 'ftp://x', 'x:y', '', undefined]) {
      expect(imageTarget(src as string | undefined), String(src)).toEqual({ kind: 'blocked' })
    }
    expect(imageTarget('Notas/foto%20uno.png')).toEqual({ kind: 'vault', target: 'Notas/foto uno.png' })
    expect(imageTarget('%E0%A4%A')).toEqual({ kind: 'blocked' })
    expect(classifyLink('%E0%A4%A.md', 'n.md')).toEqual({ kind: 'blocked' })
  })
})
