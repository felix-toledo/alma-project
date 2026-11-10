import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ABUSE_CONTACT,
  ABUSE_CONTACT_PLACEHOLDER,
  BUDGET_CEILING,
  BUDGET_CEILING_PLACEHOLDER,
  JURISDICTION,
  JURISDICTION_PLACEHOLDER,
  RELAY_DOMAIN,
  RELAY_DOMAIN_PLACEHOLDER,
  relayAvailable,
  releaseBlockers
} from '../src/shared/remote/relay-config'
import { REMOTE_RELAY_LIMITS } from '../src/shared/remote/relay-limits'
import { publishCheck } from '../scripts/relay-publish-check.mts'

const root = join(__dirname, '..')
const set = { ABUSE_CONTACT: 'abuse@example.test', JURISDICTION: 'Paraguay', BUDGET_CEILING: '20 USD' }
const placeholders = { ABUSE_CONTACT: ABUSE_CONTACT_PLACEHOLDER, JURISDICTION: JURISDICTION_PLACEHOLDER, BUDGET_CEILING: BUDGET_CEILING_PLACEHOLDER }
const scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts

describe('relay release gate (spec 027 AC-6.7)', () => {
  it('AC-6.7 publishing is blocked while any notice constant is a placeholder, and only publishing', () => {
    expect(releaseBlockers(set)).toEqual([])
    expect(releaseBlockers({ ...set, ABUSE_CONTACT: ABUSE_CONTACT_PLACEHOLDER })).toEqual(['ABUSE_CONTACT'])
    expect(releaseBlockers({ ...set, JURISDICTION: JURISDICTION_PLACEHOLDER })).toEqual(['JURISDICTION'])
    expect(releaseBlockers({ ...set, BUDGET_CEILING: BUDGET_CEILING_PLACEHOLDER })).toEqual(['BUDGET_CEILING'])
    expect(releaseBlockers(placeholders)).toEqual(['ABUSE_CONTACT', 'JURISDICTION', 'BUDGET_CEILING'])
  })

  it('AC-6.7 the publish check names each placeholder it is given and says nothing is left when none stands', () => {
    expect(publishCheck(placeholders)).toEqual({ ok: false, message: expect.stringContaining('replace before publishing') })
    for (const name of Object.keys(placeholders)) expect(publishCheck(placeholders).message).toContain(name)
    expect(publishCheck({ ...set, JURISDICTION: JURISDICTION_PLACEHOLDER })).toMatchObject({ ok: false, message: expect.stringContaining('JURISDICTION') })
    expect(publishCheck(set)).toMatchObject({ ok: true })
  })

  it('AC-6.7 the maintainer supplied the facts: the shipped constants are not placeholders and the publish script now exits 0', () => {
    expect({ ABUSE_CONTACT, JURISDICTION, BUDGET_CEILING, RELAY_DOMAIN }).toEqual({
      ABUSE_CONTACT: 'abuse@almaproject.app',
      JURISDICTION: 'Argentina',
      BUDGET_CEILING: 'USD 5 per month',
      RELAY_DOMAIN: 'almaproject.app'
    })
    expect(releaseBlockers({ ABUSE_CONTACT, JURISDICTION, BUDGET_CEILING })).toEqual([])
    expect(RELAY_DOMAIN).not.toBe(RELAY_DOMAIN_PLACEHOLDER)
    const output = execFileSync(process.execPath, [join(root, 'scripts', 'relay-publish-check.mts')], { encoding: 'utf8', stdio: 'pipe' })
    expect(output).toContain('are set')
    // Publishing is unblocked, and a packaged build offers the relay with the shipped constants.
    expect(relayAvailable({ domain: RELAY_DOMAIN, packaged: true })).toBe(true)
  })

  it('AC-6.7 the script is wired to its own entry and no check, test or build script calls it', () => {
    expect(scripts['relay:publish-check']).toContain('scripts/relay-publish-check.mts')
    for (const [name, command] of Object.entries(scripts)) {
      if (name !== 'relay:publish-check') expect(command, name).not.toContain('relay-publish-check')
    }
  })

  it('AC-1.14 the relay domain is a build-time constant, a host name and not its placeholder; coding is never blocked by a placeholder', () => {
    expect(RELAY_DOMAIN).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/)
    expect(RELAY_DOMAIN).not.toBe(RELAY_DOMAIN_PLACEHOLDER)
    expect(releaseBlockers({ ...set })).toEqual([])
  })

  it('BR-28 the relay limits hold the spec defaults', () => {
    expect(REMOTE_RELAY_LIMITS).toEqual({
      frameBytes: 4_194_304,
      pcConnections: 1,
      phoneConnections: 15,
      framesPerMinute: 900,
      bytesPerDay: 1_073_741_824,
      attemptsPerMinutePerAddress: 120,
      unknownIdPerMinute: 10,
      unknownIdBackoffMs: 300_000,
      anonymousHandshakesPerMinute: 10,
      requestTimeoutMs: 35_000,
      registerTimeoutMs: 10_000
    })
  })
})

describe('the relay build (spec 027 T31)', () => {
  const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8')
  const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  const wrangler = read('relay', 'wrangler.toml')
  // Comments are not configuration.
  const config = wrangler.replace(/^\s*#.*$/gm, '')

  it('AC-5.11 the relay build excludes src/relay from the installer: the app build never mentions the relay, and the relay build writes nothing', () => {
    expect(scripts.build).not.toMatch(/relay/i)
    expect(scripts['build:remote']).not.toMatch(/relay/i)
    expect(read('electron.vite.config.ts')).not.toMatch(/relay/i)
    expect(read('vite.remote.config.ts')).not.toMatch(/relay/i)
    expect(scripts['build:relay']).toBe('tsc --noEmit -p tsconfig.relay.json')
    const tsconfig = JSON.parse(read('tsconfig.relay.json')) as { compilerOptions: { noEmit: boolean; types: string[] }; include: string[] }
    expect(tsconfig.compilerOptions.noEmit).toBe(true)
    expect(tsconfig.include).toEqual(['src/relay/**/*'])
    // The relay types are checked with the rest, and the platform's own types stay out of the other zones' checks.
    expect(scripts.typecheck).toContain('build:relay')
    for (const other of ['tsconfig.node.json', 'tsconfig.web.json', 'tsconfig.remote.json']) {
      expect((JSON.parse(read(other)) as { include: string[] }).include.join(' '), other).not.toContain('src/relay')
    }
  })

  it('AC-6.7 nothing deploys from a script, and the platform tool and its types are not in the install tree', () => {
    for (const [name, command] of Object.entries(scripts)) expect(command, name).not.toMatch(/wrangler|deploy|cloudflare/i)
    const installed = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    expect(installed.filter((name) => /wrangler|cloudflare|miniflare/i.test(name))).toEqual([])
  })

  it('AC-6.1 the platform file declares the two objects once and as the SQLite-backed kind, with no storage binding and no secret', () => {
    expect(config).toMatch(/new_sqlite_classes\s*=\s*\["RoomObject",\s*"AddressGate"\]/)
    expect(config).not.toMatch(/\bnew_classes\b/)
    expect(config).toMatch(/class_name\s*=\s*"RoomObject"/)
    expect(config).toMatch(/class_name\s*=\s*"AddressGate"/)
    expect(config).not.toMatch(/\[\[(kv_namespaces|r2_buckets|d1_databases|queues|analytics_engine_datasets)\]\]/)
    expect(config).not.toMatch(/\b(secret|token|api_key|password)\b/i)
    const worker = read('src', 'relay', 'cloudflare', 'worker.ts')
    expect(worker).toMatch(/export \{ RoomObject \}/)
    expect(worker).toMatch(/export \{ AddressGate \}/)
    expect(config).toMatch(/main\s*=\s*"\.\.\/src\/relay\/cloudflare\/worker\.ts"/)
  })

  it('AC-5.10 the platform file stops at the relay domain: no public address of its own, the Worker first, the emergency stop off, the shell from the build', () => {
    expect(config).toMatch(/workers_dev\s*=\s*false/)
    expect(config).toMatch(/preview_urls\s*=\s*false/)
    expect(config).toMatch(/run_worker_first\s*=\s*true/)
    expect(config).toMatch(/RELAY_PAUSED\s*=\s*"0"/)
    expect(config).toMatch(/directory\s*=\s*"\.\.\/out\/remote"/)
    // The route and the zone are the relay domain the app is built with, so the two cannot drift.
    expect(config).not.toContain(RELAY_DOMAIN_PLACEHOLDER)
    expect(config).toContain(`pattern = "*.${RELAY_DOMAIN}/*"`)
    expect(config).toContain(`zone_name = "${RELAY_DOMAIN}"`)
  })

  it('AC-6.2 the adapter wires and decides nothing: it reaches the room, the routing, the limits and the body reader only through their functions, and has no storage of its own', () => {
    const files = ['worker.ts', 'room-object.ts', 'gate-object.ts'].map((name) => read('src', 'relay', 'cloudflare', name))
    for (const source of files) {
      expect(source).not.toMatch(/\b(?:setAlarm|getAlarm|transaction|sql|storage)\b/i)
      expect(source).not.toMatch(/\bswitch\b/)
      expect(source).not.toMatch(/\b(?:Math\.random|Date\.now\(\)\s*[-+<>])/)
    }
    expect(files[0]).toContain('planFor')
    expect(files[1]).toContain('new RelayRoom')
    expect(files[2]).toContain('answerGate')
  })
})
