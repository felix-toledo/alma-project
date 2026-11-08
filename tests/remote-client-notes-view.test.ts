import { describe, expect, it } from 'vitest'
import { findEvent, folderEvent, imageDataUrl, imageFailureKey, noteTitle, readEvent } from '../src/remote-client/lib/notes-view'
import { nextScreenState, startScreen } from '../src/remote-client/lib/screen-state'

const entry = (name: string, kind: 'file' | 'folder' = 'file') => ({ name, kind, size: 1, mtime: 2 })

describe('PWA notes screens (028 AC-2.1, AC-2.2, AC-2.10, AC-2.11, AC-2.14, AC-6.3)', () => {
  it('AC-2.1 (028) a folder becomes rows in the order the PC sent, with the full path and what each one opens', () => {
    const event = folderEvent({ ok: true, folder: 'Docs', entries: [entry('Ideas', 'folder'), entry('plan.md'), entry('foto.PNG'), entry('doc.pdf'), entry('mapa.excalidraw')] })
    expect(event).toEqual({
      type: 'content',
      data: {
        kind: 'rows',
        rows: [
          { key: 'Docs/Ideas', kind: 'folder', label: 'Ideas', path: 'Docs/Ideas' },
          { key: 'Docs/plan.md', kind: 'note', label: 'plan', path: 'Docs/plan.md' },
          { key: 'Docs/foto.PNG', kind: 'image', label: 'foto.PNG', path: 'Docs/foto.PNG' },
          { key: 'Docs/doc.pdf', kind: 'file', label: 'doc.pdf', path: 'Docs/doc.pdf' },
          { key: 'Docs/mapa.excalidraw', kind: 'file', label: 'mapa.excalidraw', path: 'Docs/mapa.excalidraw' }
        ]
      }
    })
    // The vault root has no prefix to join.
    expect(folderEvent({ ok: true, folder: '', entries: [entry('a.md')] })).toMatchObject({ data: { rows: [{ path: 'a.md' }] } })
  })

  it('AC-2.2 (028) an empty folder is empty, no vault is its own content, and a failure keeps its cause', () => {
    expect(folderEvent({ ok: true, folder: '', entries: [] })).toEqual({ type: 'empty' })
    expect(folderEvent({ ok: true, vault: 'none' })).toEqual({ type: 'content', data: { kind: 'none' } })
    expect(findEvent({ ok: true, vault: 'none' })).toEqual({ type: 'content', data: { kind: 'none' } })
    const failed = folderEvent({ ok: false, reason: 'scope-off' })
    expect(failed).toEqual({ type: 'failed', reason: 'scope-off', operation: 'notes.list' })
    expect(nextScreenState(startScreen(0), failed, 1)).toEqual({ kind: 'scopeOff', key: 'remote.pwa.scopeOff' })
    expect(nextScreenState(startScreen(0), folderEvent({ ok: false, reason: 'network' }), 1)).toEqual({ kind: 'unreachable' })
  })

  it('AC-2.10 (028) results show the note and the folder it is in; no match is empty', () => {
    expect(findEvent({ ok: true, found: [{ path: 'Docs/Ideas/plan.md', name: 'plan.md' }, { path: 'raiz.md', name: 'raiz.md' }] })).toEqual({
      type: 'content',
      data: {
        kind: 'rows',
        rows: [
          { key: 'Docs/Ideas/plan.md', kind: 'note', label: 'plan', path: 'Docs/Ideas/plan.md', sub: 'Docs/Ideas' },
          { key: 'raiz.md', kind: 'note', label: 'raiz', path: 'raiz.md' }
        ]
      }
    })
    expect(findEvent({ ok: true, found: [] })).toEqual({ type: 'empty' })
    expect(findEvent({ ok: false, reason: 'rate-limited' })).toEqual({ type: 'failed', reason: 'rate-limited', operation: 'notes.find' })
  })

  it('AC-2.3 (028) a note is shown without its frontmatter and a failure reads per operation', () => {
    expect(readEvent({ ok: true, path: 'Docs/a.md', content: '---\ntags: [x]\n---\n# Hola ![[foto.png]]', mtime: 1 })).toEqual({
      type: 'content',
      data: { path: 'Docs/a.md', text: '# Hola ![foto.png](<foto.png>)' }
    })
    const big = readEvent({ ok: false, reason: 'too-large' })
    expect(nextScreenState(startScreen(0), big, 1)).toEqual({ kind: 'error', key: 'remote.pwa.noteTooBig', retry: false })
    // A drawing or an office file: the list shows it, opening it says it cannot be viewed (AC-2.14).
    expect(nextScreenState(startScreen(0), readEvent({ ok: false, reason: 'unsupported' }), 1)).toEqual({ kind: 'error', key: 'remote.pwa.file.unsupported', retry: false })
    expect(nextScreenState(startScreen(0), readEvent({ ok: false, reason: 'gone' }), 1)).toEqual({ kind: 'error', key: 'remote.pwa.note.gone', retry: false })
  })

  it('AC-2.11 (028) an image that cannot be shown says why: too big, blocked or unresolved, rate limit, PC down', () => {
    expect(imageFailureKey('too-large')).toBe('remote.pwa.photoTooBig')
    for (const reason of ['unavailable', 'gone', 'unsupported', 'invalid'] as const) expect(imageFailureKey(reason)).toBe('remote.pwa.image.blocked')
    expect(imageFailureKey('rate-limited')).toBe('remote.pwa.rateLimited')
    expect(imageFailureKey('network')).toBe('remote.pwa.pcUnreachable')
    expect(imageFailureKey('scope-off')).toBe('remote.pwa.scopeOff')
  })

  it('AC-2.12 (028) the picture URL is a data: URL of an image and nothing else', () => {
    expect(imageDataUrl('AAEC', 'image/png')).toBe('data:image/png;base64,AAEC')
    expect(imageDataUrl('PHN2Zy8+', 'image/svg+xml')).toBe('data:image/svg+xml;base64,PHN2Zy8+')
    expect(imageDataUrl('AAEC', 'text/html')).toBeNull()
    expect(imageDataUrl('AAEC', 'image/png;charset=x,<script>')).toBeNull()
    expect(imageDataUrl('A"A', 'image/png')).toBeNull()
  })

  it('AC-6.2 (028) the title of a note is its name without the extension; a folder or file keeps its name', () => {
    expect(noteTitle('Docs/Ideas/plan.md')).toEqual({ title: 'plan', where: 'Docs/Ideas' })
    expect(noteTitle('raiz.md')).toEqual({ title: 'raiz', where: '' })
    expect(noteTitle('Docs/foto.png')).toEqual({ title: 'foto.png', where: 'Docs' })
    expect(noteTitle('Docs/Ideas', 'folder')).toEqual({ title: 'Ideas', where: 'Docs' })
    expect(noteTitle('', 'folder')).toEqual({ title: '', where: '' })
  })
})
