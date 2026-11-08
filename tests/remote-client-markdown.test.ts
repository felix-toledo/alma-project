import { describe, expect, it } from 'vitest'
import { classifyLink, imageTarget, prepareNote, stripFrontmatter, wikiEmbeds } from '../src/remote-client/lib/markdown'

describe('PWA note reading (028 AC-2.3, AC-2.12, AC-2.15)', () => {
  it('AC-2.3 (028) frontmatter hidden and [[wiki]] stays plain text', () => {
    expect(stripFrontmatter('---\ntitle: x\ntags: [a]\n---\n# Hola\ncuerpo')).toBe('# Hola\ncuerpo')
    expect(stripFrontmatter('---\r\ntitle: x\r\n---\r\n# Hola\r\n')).toBe('# Hola\r\n')
    // Frontmatter only: nothing left to show, not a crash.
    expect(stripFrontmatter('---\ntitle: x\n---\n')).toBe('')
    expect(stripFrontmatter('---\ntitle: x\n---')).toBe('')
    // Only a block at the very top is frontmatter: a rule in the body, an unclosed block and leading text stay.
    expect(stripFrontmatter('# T\n\n---\nuno\n---\nfin')).toBe('# T\n\n---\nuno\n---\nfin')
    expect(stripFrontmatter('---\nsin cierre\n# T')).toBe('---\nsin cierre\n# T')
    expect(stripFrontmatter('\n---\na: b\n---\ncuerpo')).toBe('\n---\na: b\n---\ncuerpo')
    // A byte order mark in front of a note is not shown as a character.
    expect(prepareNote('\uFEFF---\na: b\n---\ncuerpo')).toBe('cuerpo')
    // A wiki link is text, not a link; only an embed of a picture is rewritten.
    expect(wikiEmbeds('ver [[Otra nota]] y [[a|alias]]')).toBe('ver [[Otra nota]] y [[a|alias]]')
    expect(wikiEmbeds('![[foto.png]]')).toBe('![foto.png](<foto.png>)')
    expect(wikiEmbeds('![[mi foto.png|300]] y ![[a.png#x]]')).toBe('![mi foto.png](<mi foto.png>) y ![a.png](<a.png>)')
    expect(wikiEmbeds('![[ foto.png ]]')).toBe('![ foto.png ](<foto.png>)')
  })

  it('AC-2.15 (028) relative note links resolve against the note', () => {
    expect(classifyLink('Otra.md', 'Docs/n.md')).toEqual({ kind: 'note', path: 'Docs/Otra.md' })
    expect(classifyLink('../x.md#seccion', 'Docs/n.md')).toEqual({ kind: 'note', path: 'x.md' })
    expect(classifyLink('sub/Y%20z.md', 'Docs/n.md')).toEqual({ kind: 'note', path: 'Docs/sub/Y z.md' })
    expect(classifyLink('%C3%91andu.MD', 'n.md')).toEqual({ kind: 'note', path: 'Ñandu.MD' })
    expect(classifyLink('./a.md?x=1', 'Docs/n.md')).toEqual({ kind: 'note', path: 'Docs/a.md' })
  })

  it('AC-2.15 (028) external links only as external, everything else blocked', () => {
    expect(classifyLink('https://example.com/a?b=1#c', 'n.md')).toEqual({ kind: 'external', url: 'https://example.com/a?b=1#c' })
    expect(classifyLink('http://example.com', 'n.md')).toEqual({ kind: 'external', url: 'http://example.com/' })
    expect(classifyLink('HTTPS://Example.com', 'n.md')).toEqual({ kind: 'external', url: 'https://example.com/' })
    const blocked = [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'mailto:a@b.co',
      'tel:123',
      'data:text/html,<script>1</script>',
      'file:///c:/x.md',
      'vbscript:x',
      'alma-vault://file/x.md',
      'C:\\x.md',
      '//evil.example/x.md',
      '/etc/x.md',
      '\\\\server\\share\\x.md',
      '../../x.md',
      '#seccion',
      '',
      '   ',
      'doc.pdf',
      'Carpeta',
      'bad%.md',
      'ftp://example.com/a'
    ]
    for (const href of blocked) expect(classifyLink(href, 'Docs/n.md'), JSON.stringify(href)).toEqual({ kind: 'blocked' })
  })

  it('AC-2.12 (028) a remote image source is never produced', () => {
    expect(imageTarget('foto.png')).toEqual({ kind: 'vault', target: 'foto.png' })
    expect(imageTarget('sub/a%20b.png')).toEqual({ kind: 'vault', target: 'sub/a b.png' })
    expect(imageTarget('../img/Ñ.PNG')).toEqual({ kind: 'vault', target: '../img/Ñ.PNG' })
    const blocked = [
      'https://evil.example/x.png',
      'HTTP://evil.example/x.png',
      'http://169.254.169.254/latest',
      '//evil.example/x.png',
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
      'file:///c:/x.png',
      'alma-vault://file/x.png',
      'blob:https://x/y',
      'ftp://x/y.png',
      'bad%.png',
      '',
      undefined
    ]
    for (const src of blocked) expect(imageTarget(src), String(src)).toEqual({ kind: 'blocked' })
  })
})
