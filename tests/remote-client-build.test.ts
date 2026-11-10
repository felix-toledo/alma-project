import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build, loadConfigFromFile } from 'vite'
import { buildShellManifest } from '../scripts/shell-manifest.mts'
import { ABUSE_CONTACT, RELAY_DOMAIN } from '../src/shared/remote/relay-config'
import { readShellManifest } from '../src/shared/remote/relay-shell'
import { importsOf, readSources } from './support/arch'

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
  'https://github.com/syntax-tree/hast-util-to-jsx-runtime',
  // zod (spec 027 T28): the relay client validates its frames with the schemas the PC and the relay share. zod carries the
  // JSON Schema vocabulary identifiers and an IPv6 template; they name a dialect and a pattern, and are never fetched.
  'https://json-schema.org/draft/2020-12/schema',
  'http://json-schema.org/draft-07/schema#',
  'http://json-schema.org/draft-04/schema#',
  'http://[${e}]'
])

function emittedFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) found.push(join(entry.parentPath, entry.name))
  }
  return found
}

/** The hosts a bundle names that are not on the accepted list. */
function strayHosts(files: Record<string, string>): string[] {
  const offenders: string[] = []
  for (const [file, text] of Object.entries(files)) {
    for (const match of text.matchAll(/https?:\/\/[^\s"'`]+/g)) {
      const host = match[0].replace(/[).;,]+$/, '')
      if (![...ACCEPTED_HOSTS].some((accepted) => host === accepted || host.startsWith(`${accepted}/`))) offenders.push(`${file}: ${host}`)
    }
  }
  return offenders
}

const usesWebSocket = (text: string): boolean => /\bWebSocket\b/.test(text)

describe('T40 PWA build (AC-3.8, BR-18)', () => {
  let outDir = ''
  const built: Record<string, string> = {}

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'alma-pwa-'))
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
    for (const file of emittedFiles(outDir)) built[file] = readFileSync(file, 'utf8')
  }, 120_000)

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true })
  })

  it('AC-3.8 the built PWA has no hard-coded host', () => {
    expect(strayHosts(built)).toEqual([])
    // This is the build that contains the relay client: the check above covers it.
    expect(Object.entries(built).some(([file, text]) => file.endsWith('.js') && text.includes('/relay/v1/frame'))).toBe(true)
  })

  it('AC-8.6 the scan sees a host that is not accepted, and one that is', () => {
    expect(strayHosts({ 'a.js': 'fetch("https://relay.example.com/x")' })).toEqual(['a.js: https://relay.example.com/x'])
    expect(strayHosts({ 'a.js': 'x = "https://react.dev/errors/"' })).toEqual([])
    expect(strayHosts({ 'a.js': 'x = "wss://relay.example.com"' })).toEqual([])
  })

  it('AC-5.10 the built PWA uses no WebSocket', () => {
    const offenders = Object.entries(built).filter(([, text]) => usesWebSocket(text)).map(([file]) => file)
    expect(offenders).toEqual([])
    // Negative fixture: the scan fails on a bundle that adds one.
    expect(usesWebSocket('const s = new WebSocket("wss://x")')).toBe(true)
    expect(usesWebSocket('socket.send(1)')).toBe(false)
  })

  it('AC-8.6 the built PWA names no relay address: no relay domain, no relay constant, no address of the relay in a request', () => {
    for (const [file, text] of Object.entries(built)) {
      if (!file.endsWith('.js')) continue
      expect(text, file).not.toMatch(/RELAY_DOMAIN|ABUSE_CONTACT|JURISDICTION|BUDGET_CEILING/)
      // The real values are not written into the phone app either: it takes its address from where it was loaded.
      expect(text, file).not.toContain(RELAY_DOMAIN)
      expect(text, file).not.toContain(ABUSE_CONTACT)
      // The only relay path is the relative one the request travels on; never a scheme and host.
      for (const match of text.matchAll(/["'`]([^"'`\s]*\/relay\/v1\/[^"'`\s]*)["'`]/g)) expect(match[1], file).toMatch(/^\/relay\/v1\/(frame|info)$/)
    }
  })

  it('AC-3.8 (027) the phone code and the shared relay modules import no package the PWA did not already have', () => {
    const phoneFiles = {
      ...readSources(root, 'src/remote-client'),
      ...Object.fromEntries(Object.entries(readSources(root, 'src/shared/remote')).filter(([file]) => /\/(relay-(frame|crypto|e2e|shell|wire|limits)|crypto)\.ts$/.test(file)))
    }
    const bare = new Set<string>()
    for (const [file, source] of Object.entries(phoneFiles)) {
      for (const specifier of importsOf(source)) {
        if (specifier.startsWith('.') || specifier.startsWith('src/')) continue
        bare.add(specifier)
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(/^node:/)
      }
    }
    // Pinned: a new entry here is a new dependency of the phone and needs a decision, not a test edit.
    const allowed = ['@fontsource-variable/outfit', 'lucide-react', 'react', 'react-dom/client', 'react-markdown', 'remark-breaks', 'remark-gfm', 'zod/v4']
    expect([...bare].filter((name) => !allowed.includes(name))).toEqual([])
    expect(bare.has('zod/v4')).toBe(true)
    // And each one is a dependency the project already declares.
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies?: Record<string, string> }
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    for (const name of bare) expect(declared, name).toContain(name.startsWith('zod') ? 'zod' : name.startsWith('react-dom') ? 'react-dom' : name)
  })

  it('AC-3.8 (027) the relay modules use only the named primitives: ECDH, ECDSA, HKDF built on HMAC, AES-GCM and SHA-256', () => {
    const names = (source: string): string[] => [...source.matchAll(/\bname:\s*'([A-Za-z0-9-]+)'/g)].map((match) => match[1])
    const files = Object.entries(readSources(root, 'src/shared/remote')).filter(([file]) => /relay-(frame|crypto|e2e|shell|wire)\.ts$|\/crypto\.ts$/.test(file))
    expect(files.length).toBeGreaterThanOrEqual(6)
    const allowed = new Set(['ECDH', 'ECDSA', 'AES-GCM', 'HMAC'])
    for (const [file, source] of files) {
      for (const name of names(source)) expect(allowed.has(name), `${file} uses ${name}`).toBe(true)
      for (const hash of source.matchAll(/hash:\s*'([A-Za-z0-9-]+)'/g)) expect(hash[1], file).toBe('SHA-256')
      expect(source, file).not.toMatch(/\bMath\.random\b|\bMD5\b|\bSHA-1\b|\bRC4\b|node:crypto|createCipher/i)
    }
    // Negative fixture: a weaker primitive is caught by the same reading.
    expect(names("crypto.subtle.encrypt({ name: 'AES-CBC' }, key, data)")).toEqual(['AES-CBC'])
    expect(allowed.has('AES-CBC')).toBe(false)
  })

  it('AC-3.12 the PWA build writes the shell manifest the PC announces and the phone shows', () => {
    const script = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts['build:remote']
    expect(script).toMatch(/vite build --config vite\.remote\.config\.ts && node scripts\/shell-manifest\.mts out\/remote$/)
    const manifest = buildShellManifest(outDir, 3)
    expect(Object.keys(manifest.files)).toEqual(expect.arrayContaining(['index.html', 'sw.js', 'manifest.webmanifest']))
    expect(readShellManifest(JSON.parse(readFileSync(join(outDir, 'shell-manifest.json'), 'utf8')))).toEqual({ version: 3, rootHash: manifest.rootHash })
    // The service worker is part of what the hash covers: it is what an operator would have to replace.
    expect(Object.keys(manifest.files).some((file) => file === 'sw.js')).toBe(true)
  })

  it('T51 the manifest carries no start_url, so the pair fragment survives into the installed app', () => {
    // public/ is copied verbatim into the build: the source manifest is the shipped one.
    const manifest = JSON.parse(readFileSync(join(root, 'src/remote-client/public/manifest.webmanifest'), 'utf8')) as Record<string, unknown>
    expect(manifest).not.toHaveProperty('start_url')
    expect(manifest.display).toBe('standalone')
  })
})
