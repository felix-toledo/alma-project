import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildShellManifest, computeShellManifest, MANIFEST_FILE } from '../scripts/shell-manifest.mts'
import { readShellManifest } from '../src/shared/remote/relay-shell'

const files = {
  'index.html': '<html></html>',
  'sw.js': 'self.addEventListener("fetch", () => {})',
  'assets/app-1a2b3c.js': 'console.log(1)',
  'assets/app-4d5e6f.css': 'body{}',
  'manifest.webmanifest': '{}'
}

describe('shell manifest (spec 027 PD-13)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('AC-3.12 the root hash is 64 hex characters and the same for the same files whatever order they come in', () => {
    const forward = computeShellManifest(files, 5)
    expect(forward.rootHash).toMatch(/^[0-9a-f]{64}$/)
    const backward = computeShellManifest(Object.fromEntries(Object.entries(files).reverse()), 5)
    expect(backward.rootHash).toBe(forward.rootHash)
    expect(Object.keys(backward.files)).toEqual(Object.keys(forward.files))
    expect(Object.keys(forward.files)).toEqual([...Object.keys(files)].sort())
    expect(forward.version).toBe(5)
    // Text and the bytes of the same text are one file.
    expect(computeShellManifest({ ...files, 'index.html': new TextEncoder().encode('<html></html>') }, 5).rootHash).toBe(forward.rootHash)
  })

  it('AC-3.12 the root hash changes when one byte of one file changes, a file is added, removed or renamed', () => {
    const base = computeShellManifest(files, 5).rootHash
    const changed = new Set<string>()
    for (const name of Object.keys(files)) {
      changed.add(computeShellManifest({ ...files, [name]: `${files[name as keyof typeof files]}x` }, 5).rootHash)
      const bytes = new TextEncoder().encode(files[name as keyof typeof files])
      bytes[0] ^= 1
      changed.add(computeShellManifest({ ...files, [name]: bytes }, 5).rootHash)
    }
    changed.add(computeShellManifest({ ...files, 'extra.js': '' }, 5).rootHash)
    const { 'sw.js': _gone, ...without } = files
    changed.add(computeShellManifest(without, 5).rootHash)
    const { 'sw.js': moved, ...rest } = files
    changed.add(computeShellManifest({ ...rest, 'sw2.js': moved }, 5).rootHash)
    expect(changed.has(base)).toBe(false)
    expect(changed.size).toBe(Object.keys(files).length * 2 + 3)
    // Content moved from one file to another is not the same set of files.
    expect(computeShellManifest({ a: 'x', b: 'y' }, 1).rootHash).not.toBe(computeShellManifest({ a: 'y', b: 'x' }, 1).rootHash)
    // And a path cannot be confused with content.
    expect(computeShellManifest({ 'a\nb': '' }, 1).rootHash).not.toBe(computeShellManifest({ a: 'b' }, 1).rootHash)
  })

  it('AC-3.12 the version rides beside the hash and does not change it', () => {
    expect(computeShellManifest(files, 1).rootHash).toBe(computeShellManifest(files, 99).rootHash)
    expect(computeShellManifest(files, 99).version).toBe(99)
  })

  it('AC-3.12 the manifest of a folder reads every file in it, skips its own, and goes to disk where the PC and the phone both read it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alma-shell-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'assets'))
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
    const first = buildShellManifest(dir, 7)
    expect(first).toEqual(computeShellManifest(files, 7))
    const onDisk = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'))
    expect(onDisk).toEqual(first)
    // Running it again over a folder that now holds the manifest gives the same answer: the manifest is not one of its files.
    expect(buildShellManifest(dir, 7)).toEqual(first)
    expect(Object.keys(first.files)).not.toContain(MANIFEST_FILE)
    writeFileSync(join(dir, 'assets', 'app-1a2b3c.js'), 'console.log(2)')
    expect(buildShellManifest(dir, 7).rootHash).not.toBe(first.rootHash)
  })

  it('AC-3.12 the phone and the PC read the manifest the same way, and anything off reads as no manifest', () => {
    const manifest = computeShellManifest(files, 12)
    expect(readShellManifest(manifest)).toEqual({ version: 12, rootHash: manifest.rootHash })
    expect(readShellManifest(JSON.parse(JSON.stringify(manifest)))).toEqual({ version: 12, rootHash: manifest.rootHash })
    for (const bad of [null, undefined, 'x', 7, [], {}, { version: 1 }, { rootHash: manifest.rootHash }, { version: -1, rootHash: manifest.rootHash }, { version: 1.5, rootHash: manifest.rootHash }, { version: '1', rootHash: manifest.rootHash }, { version: 1, rootHash: 'short' }, { version: 1, rootHash: 'Z'.repeat(64) }, { version: 1, rootHash: 7 }]) {
      expect(readShellManifest(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})
