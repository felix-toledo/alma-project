import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { build, loadConfigFromFile } from 'vite'

const root = join(__dirname, '..')

/**
 * Hosts a built PWA may name without breaking origin-independence (AC-3.8):
 * XML namespaces are identifiers, never fetched. Anything else (a CDN font, an
 * API host, a telemetry pixel) would pin the phone to someone's server.
 */
const ACCEPTED_HOSTS = new Set([
  'http://www.w3.org/2000/svg', // React DOM's SVG namespace constant
  'http://www.w3.org/1999/xlink', // React DOM's xlink namespace constant
  'http://www.w3.org/1998/Math/MathML', // React DOM's MathML namespace constant
  'http://www.w3.org/XML/1998/namespace', // XML namespace constant
  'https://react.dev/errors/', // React production error-code links: dead strings in thrown errors, never fetched
  // react-markdown (spec 028 T58, accepted as Q14 by the human 2026-11-08): hast-util-to-jsx-runtime puts this documentation link in an error message; same class as react.dev/errors/, never fetched
  'https://github.com/syntax-tree/hast-util-to-jsx-runtime'
])

function emittedFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) found.push(join(entry.parentPath, entry.name))
  }
  return found
}

describe('T40 PWA build (AC-3.8, BR-18)', () => {
  it('AC-3.8 the built PWA has no hard-coded host', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'alma-pwa-'))
    const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, join(root, 'vite.remote.config.ts'))
    expect(loaded).not.toBeNull()
    // Vitest runs with NODE_ENV=test, which would bundle React's development build
    // (full of react.dev doc links); the shipped PWA is a production build.
    const previousEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      await build({ ...loaded?.config, mode: 'production', logLevel: 'silent', build: { ...loaded?.config.build, outDir, emptyOutDir: true } })
    } finally {
      process.env.NODE_ENV = previousEnv
    }
    const offenders: string[] = []
    for (const file of emittedFiles(outDir)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/https?:\/\/[^\s"'`]+/g)) {
        const host = match[0].replace(/[).;,]+$/, '')
        if (![...ACCEPTED_HOSTS].some((accepted) => host === accepted || host.startsWith(`${accepted}/`))) {
          offenders.push(`${file}: ${host}`)
        }
      }
    }
    expect(offenders).toEqual([])
  }, 120_000)

  it('T51 the manifest carries no start_url, so the pair fragment survives into the installed app', () => {
    // public/ is copied verbatim into the build: the source manifest is the shipped one.
    const manifest = JSON.parse(readFileSync(join(root, 'src/remote-client/public/manifest.webmanifest'), 'utf8')) as Record<string, unknown>
    expect(manifest).not.toHaveProperty('start_url')
    expect(manifest.display).toBe('standalone')
  })
})
