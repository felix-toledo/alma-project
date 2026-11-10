import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The phone keeps no file, chip or attachment list (031 BR-19, AC-7.4) and draws a name only as text (AC-8.8): a scan of the
// source files that handle files, with a negative fixture so the scan is known to see what it looks for.
const FILES = [
  'lib/attach.ts',
  'lib/attach-flow.ts',
  'lib/canvas.ts',
  'lib/shrink.ts',
  'screens/useAttachments.ts',
  'screens/AttachBar.tsx',
  'screens/FileLines.tsx'
]
const STORAGE = /\b(localStorage|sessionStorage|indexedDB|caches|openDatabase|FileSystemHandle|showSaveFilePicker|navigator\.storage|document\.cookie)\b/
const MARKUP = /dangerouslySetInnerHTML|\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|\bhref=|\btitle=|URL\.createObjectURL|<img\b/

describe('the phone code that handles files (031 AC-7.4, AC-8.8)', () => {
  const sources = Object.fromEntries(FILES.map((file) => [file, readFileSync(join(__dirname, '..', 'src/remote-client', file), 'utf8')]))

  it('AC-7.4 (031) no file, chip or list is written to any storage API', () => {
    for (const [file, text] of Object.entries(sources)) expect(text, file).not.toMatch(STORAGE)
    // Negative fixture: the scan sees each one.
    for (const api of ['localStorage.setItem', 'indexedDB.open', 'caches.open', 'sessionStorage', 'document.cookie']) expect(api).toMatch(STORAGE)
  })

  it('AC-8.8 (031) a file name is never put into markup, a link, a title or an object URL', () => {
    for (const [file, text] of Object.entries(sources)) expect(text, file).not.toMatch(MARKUP)
    for (const code of ['<div dangerouslySetInnerHTML={x} />', '<a href={name}>', '<span title={name}>', 'URL.createObjectURL(file)', 'el.innerHTML = name']) expect(code).toMatch(MARKUP)
  })
})
