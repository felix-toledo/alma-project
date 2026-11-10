// Independent verification of spec 027 (tester): the 026 channel is unchanged by the relay (AC-2.x), every scope still
// starts off after enabling the relay (AC-1.x), and no tool or settings patch reaches the relay's settings (AC-1.5, AC-1.6).
//
// Mutation check: VERIFY_027_MUTATE=relay-scopes lets planRemoteChange keep the requested scopes when the relay is chosen.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { stripRemotePatch } from '../src/shared/remote/confirmations'
import { defaultRemote, sanitizeRemote } from '../src/shared/remote/settings'
import { appTools, type RunContext } from '../src/coordinator/agent'
import { builtinTools } from '../src/coordinator/tools'
import { jsonSchemaOf, type ToolDefinition } from '../src/coordinator/tools/types'
import { defaultSettings } from '../src/shared/defaults'
import type { RemoteScope, RemoteSettings } from '../src/shared/types'
import { onThePair, served } from './support/relay-served'
import { HOST, openSession, pairDevice, testChannel } from './support/remote-harness'

vi.mock('../src/shared/remote/confirmations', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/shared/remote/confirmations')>()
  if (process.env['VERIFY_027_MUTATE'] !== 'relay-scopes') return real
  return {
    ...real,
    planRemoteChange: (...args: Parameters<typeof real.planRemoteChange>) => {
      const planned = real.planRemoteChange(...args)
      return args[1].transport === 'relay' ? { ...planned, next: { ...planned.next, scopes: args[1].scopes } } : planned
    }
  }
})

const { planRemoteChange } = await import('../src/shared/remote/confirmations')

const root = join(__dirname, '..')
const SCOPES: RemoteScope[] = ['chat', 'approve', 'home', 'cameras', 'vault', 'history']
const allScopes = (value: boolean): RemoteSettings['scopes'] => Object.fromEntries(SCOPES.map((scope) => [scope, value])) as RemoteSettings['scopes']

describe('verify 027 (7) every scope still starts off after enabling the relay', () => {
  const befores: RemoteSettings[] = []
  for (const enabled of [false, true])
    for (const transport of ['tailscale', 'relay'] as const)
      for (const scopes of [allScopes(false), allScopes(true)]) befores.push({ ...defaultRemote(), enabled, transport, scopes, sensitive: scopes.chat, continueHistory: scopes.chat })
  const afters: RemoteSettings[] = []
  for (const enabled of [false, true])
    for (const transport of ['tailscale', 'relay'] as const)
      for (const scopes of [allScopes(false), allScopes(true), { ...allScopes(false), home: true }]) afters.push({ ...defaultRemote(), enabled, transport, scopes, sensitive: true, continueHistory: true, cameras: ['camera.patio'] })
  const plan = (before: RemoteSettings, after: RemoteSettings) => planRemoteChange(before, after, ['Old phone'], { activeVault: 'C:/Notes' })

  it('AC-1.9 every turn-on, from every previous state and with any requested scopes, saves every scope and sub-switch off', () => {
    let turnOns = 0
    for (const before of befores) {
      for (const after of afters) {
        if (before.enabled || !after.enabled) continue
        turnOns++
        const { next, confirmations } = plan(before, after)
        const label = `${before.transport}->${after.transport} scopes=${JSON.stringify(after.scopes)}`
        expect(next.scopes, label).toEqual(allScopes(false))
        expect(next.sensitive, label).toBe(false)
        expect(next.continueHistory, label).toBe(false)
        expect(confirmations[0], label).toMatchObject({ kind: 'enable' })
        expect(confirmations.some((confirmation) => confirmation.kind === 'scope'), label).toBe(false)
        // The relay is named in the enable dialog exactly while it is the choice.
        expect(Boolean((confirmations[0] as { relay?: true }).relay), label).toBe(after.transport === 'relay')
      }
    }
    expect(turnOns).toBeGreaterThan(10)
  })

  it('AC-1.9 AC-1.13 off and on again with the relay selected: the relay is kept, asks nothing new, and no scope persists', () => {
    const running: RemoteSettings = { ...defaultRemote(), enabled: true, transport: 'relay', scopes: { ...allScopes(false), chat: true, home: true } }
    const off = plan(running, { ...running, enabled: false })
    expect(off.confirmations).toEqual([])
    expect(off.next.transport).toBe('relay')
    const on = plan(off.next, { ...off.next, enabled: true })
    expect(on.confirmations).toEqual([{ kind: 'enable', dormant: ['Old phone'], relay: true }])
    expect(on.next.transport).toBe('relay')
    expect(on.next.scopes).toEqual(allScopes(false))
  })

  it('AC-1.2 AC-1.9 selecting the relay while remote runs changes no scope, asks only for the relay, and selecting Tailscale asks nothing', () => {
    const running: RemoteSettings = { ...defaultRemote(), enabled: true, scopes: { ...allScopes(false), chat: true } }
    const toRelay = plan(running, { ...running, transport: 'relay' })
    expect(toRelay.confirmations).toEqual([{ kind: 'relay' }])
    expect(toRelay.next.scopes).toEqual(running.scopes)
    expect(plan(toRelay.next, { ...toRelay.next, transport: 'tailscale' }).confirmations).toEqual([])
    // Selecting the relay together with a wider scope still asks for the scope.
    const both = plan(running, { ...running, transport: 'relay', scopes: { ...running.scopes, cameras: true } })
    expect(both.confirmations.map((confirmation) => confirmation.kind)).toEqual(['relay', 'scope'])
  })

  it('AC-1.1 AC-1.12 a settings file that says nothing, or nonsense, about the transport is Tailscale with remote off and every scope off', () => {
    for (const stored of [undefined, null, {}, [], 'relay', { transport: 'relay ' }, { transport: 'RELAY' }, { transport: 1 }, { transport: { id: 'relay' } }, { transport: ['relay'] }]) {
      const settings = sanitizeRemote(stored)
      expect(settings.transport, JSON.stringify(stored)).toBe('tailscale')
      expect(settings.enabled, JSON.stringify(stored)).toBe(false)
      expect(settings.scopes, JSON.stringify(stored)).toEqual(allScopes(false))
    }
    expect(defaultRemote().transport).toBe('tailscale')
    expect(defaultRemote().enabled).toBe(false)
  })

  it('AC-1.14 no relay address, domain or credential survives in the settings, whatever a file or a patch says', () => {
    const hostile = { enabled: true, transport: 'relay', relayDomain: 'evil.example', relayUrl: 'wss://evil.example', relay: { domain: 'evil.example', routingId: 'abcd', secret: 'SECRET-RELAY' }, routingId: 'abcd', domain: 'evil.example' }
    const cleaned = JSON.stringify(sanitizeRemote(hostile))
    for (const needle of ['evil', 'abcd', 'SECRET-RELAY', 'routingId', 'relayDomain']) expect(cleaned, needle).not.toContain(needle)
  })
})

describe('verify 027 (8) no agent tool or settings patch reaches the relay settings', () => {
  it('AC-1.5 a coordinator patch never carries remote, whatever its shape, and is not mutated', () => {
    const patches = [
      { remote: { transport: 'relay', enabled: true } },
      { remote: undefined, language: 'es' },
      { remote: null },
      { remote: { transport: 'relay', routingId: 'x', relayDomain: 'evil.example' }, routines: [] },
      JSON.parse('{"remote":{"transport":"relay"},"__proto__":{"remote":{"transport":"relay"}}}')
    ]
    for (const patch of patches) {
      const before = JSON.stringify(patch)
      const stripped = stripRemotePatch(patch) as Record<string, unknown>
      expect('remote' in stripped).toBe(false)
      expect(Object.hasOwn(stripped, 'remote')).toBe(false)
      expect(JSON.stringify(patch)).toBe(before)
      // Whatever else it carries, merging it over the settings leaves the remote section where it was.
      expect({ ...{ remote: 'UNCHANGED' }, ...stripped }.remote).toBe('UNCHANGED')
    }
  })

  it('AC-1.6 BR-6 nothing under the coordinator except the remote channel and the composition root touches the relay modules, its credentials or the transport choice', () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.tsx?$/.test(name)) files.push(path)
      }
    }
    walk(join(root, 'src', 'coordinator'))
    const outside = files.filter((file) => {
      const rel = relative(root, file).replaceAll('\\', '/')
      return !rel.startsWith('src/coordinator/channels/remote/') && rel !== 'src/coordinator/index.ts'
    })
    expect(outside.length).toBeGreaterThan(30)
    const offenders = outside.filter((file) => /relay-(store|controller|transport|host|connection|privacy)|shared\/remote\/relay-|remote\.transport|routingId|relayDomain/.test(readFileSync(file, 'utf8')))
    expect(offenders.map((file) => relative(root, file))).toEqual([])
    // The scan can see a violation.
    expect(/relay-(store|controller)/.test("import { RelayStore } from '../channels/remote/relay-store'")).toBe(true)
  })

  it('AC-1.6 no agent tool, in any agent definition, mentions the relay or remote access in its name, description or schema', async () => {
    const base = defaultSettings()
    const settings = { ...base, email: { ...base.email, address: 'a@example.com', imapHost: 'i.example.com', smtpHost: 's.example.com' }, providers: { ...base.providers, email: { apiKey: 'k' } }, home: { ...base.home, enabled: true } }
    const seat = (channel: string, depth: number, extra: object) => ({ getSettings: () => settings, thread: { channel }, depth, knowledge: {}, whatsapp: {}, home: {}, ...extra }) as unknown as RunContext
    const allTools: ToolDefinition[] = [...builtinTools, ...appTools(seat('voice', 0, {})), ...appTools(seat('company', 1, { company: {}, knowledge: null, whatsapp: null }))]
    expect(allTools.length).toBeGreaterThan(30)
    const words = /relay|routing[-_ ]?id|remote[-_ ]?(access|settings|transport)|tailscale|pairing|safeStorage/i
    for (const tool of allTools) expect(`${tool.name} ${tool.description} ${JSON.stringify(jsonSchemaOf(tool.schema))}`, tool.name).not.toMatch(words)
  })
})

describe('verify 027 (4) the channel is unchanged by the relay', () => {
  const SECURITY_LAYER = [
    'src/coordinator/channels/remote/channel.ts',
    'src/coordinator/channels/remote/session.ts',
    'src/coordinator/channels/remote/limits.ts',
    'src/coordinator/channels/remote/pairing-flow.ts',
    'src/coordinator/channels/remote/devices-admin.ts',
    'src/coordinator/channels/remote/stepup.ts',
    'src/coordinator/channels/remote/audit.ts',
    'src/coordinator/channels/remote/store.ts',
    'src/coordinator/channels/remote/approvals.ts',
    'src/coordinator/channels/remote/chat.ts',
    'src/coordinator/channels/remote/home.ts',
    'src/coordinator/channels/remote/cameras.ts',
    'src/coordinator/channels/remote/notes.ts',
    'src/coordinator/channels/remote/threads.ts',
    'src/coordinator/channels/remote/push.ts',
    'src/coordinator/channels/remote/tailscale-transport.ts',
    'src/coordinator/channels/remote/tailscale.ts',
    'src/shared/remote/api.ts',
    'src/shared/remote/authorize.ts',
    'src/shared/remote/limits.ts',
    'src/shared/remote/pairing.ts',
    'src/shared/remote/crypto.ts',
    'src/shared/remote/wire.ts',
    'src/shared/remote/webauthn.ts'
  ]
  const git = (...args: string[]): string | null => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return null
    }
  }
  // Compared with the last commit, which holds the finished 026 channel. Once spec 027 is committed this has nothing left to
  // compare and the in-source scan below carries the claim.
  const haveGit = git('rev-parse', '--verify', 'HEAD') !== null

  // Other specs may legitimately edit these files (for example 029 adds a field to an approval card), so the claim here is
  // only that nothing in the diff against the last commit is about the relay. The byte-exact pin is the protected-files
  // manifest (tests/support/remote-protected.json), which whoever edits the security layer must update on purpose.
  it.skipIf(!haveGit)('AC-2.2 AC-2.3 no edit to the security layer, the closed route table or the Tailscale transport since the last commit is about the relay', () => {
    const diff = git('diff', '-U0', 'HEAD', '--', ...SECURITY_LAYER) ?? ''
    const edits = diff.split('\n').filter((line) => /^[+-][^+-]/.test(line))
    expect(edits.filter((line) => /relay|routing[-_ ]?id|shell[-_ ]?manifest/i.test(line))).toEqual([])
  })

  it.skipIf(!haveGit)('AC-2.3 the only edit to the transport interface is the new member of the id union', () => {
    const diff = git('diff', '-U0', 'HEAD', '--', 'src/coordinator/channels/remote/transport.ts') ?? ''
    // Other specs may edit this file too (spec 030 adds refusal codes), so only the edits that concern the transport id or the
    // relay are pinned: the id union gains 'relay' and nothing else about the relay appears.
    const edits = diff.split('\n').filter((line) => /^[+-][^+-]/.test(line))
    const aboutTheId = edits.filter((line) => /readonly id:|relay/i.test(line))
    expect(aboutTheId.filter((line) => line.startsWith('-')).map((line) => line.slice(1).trim())).toEqual(["readonly id: 'tailscale' | 'test'"])
    expect(aboutTheId.filter((line) => line.startsWith('+')).map((line) => line.slice(1).trim())).toEqual(["readonly id: 'tailscale' | 'test' | 'relay'"])
  })

  it('AC-2.3 BR-1 the security layer never names the relay and never branches on a transport id', () => {
    for (const path of SECURITY_LAYER.filter((file) => !/tailscale/.test(file))) {
      const source = readFileSync(join(root, path), 'utf8')
      expect(source, path).not.toMatch(/relay/i)
      expect(source, path).not.toMatch(/transport\.id|\.id\s*===?\s*['"](tailscale|test|relay)['"]|id\s*===?\s*['"]relay['"]/)
    }
  })

  const BATTERY: Array<{ name: string; make: (token: string) => { method: string; path: string; query?: string; headers: Record<string, string>; body?: unknown } }> = [
    { name: 'no credential', make: () => ({ method: 'GET', path: '/api/status', headers: { ...HOST } }) },
    { name: 'a malformed bearer', make: () => ({ method: 'GET', path: '/api/status', headers: { ...HOST, authorization: 'Bearer not-a-token' } }) },
    { name: 'a bearer with no value', make: () => ({ method: 'GET', path: '/api/status', headers: { ...HOST, authorization: 'Bearer ' } }) },
    { name: 'an unknown route', make: (token) => ({ method: 'GET', path: '/api/nope', headers: { ...HOST, authorization: `Bearer ${token}` } }) },
    { name: 'a wrong method on a known route', make: (token) => ({ method: 'DELETE', path: '/api/status', headers: { ...HOST, authorization: `Bearer ${token}` } }) },
    { name: 'a path-traversal route', make: (token) => ({ method: 'GET', path: '/api/../../etc/passwd', headers: { ...HOST, authorization: `Bearer ${token}` } }) },
    { name: 'an encoded traversal route', make: (token) => ({ method: 'GET', path: '/api/%2e%2e/status', headers: { ...HOST, authorization: `Bearer ${token}` } }) },
    { name: 'a message past 8000 characters', make: (token) => ({ method: 'POST', path: '/api/chat/send', headers: { ...HOST, authorization: `Bearer ${token}` }, body: { text: 'x'.repeat(8001) } }) },
    { name: 'a body past 1 MB', make: (token) => ({ method: 'POST', path: '/api/chat/send', headers: { ...HOST, authorization: `Bearer ${token}` }, body: { text: 'x'.repeat(1_100_000) } }) },
    { name: 'a body that is not the schema', make: (token) => ({ method: 'POST', path: '/api/chat/send', headers: { ...HOST, authorization: `Bearer ${token}` }, body: { nope: 1 } }) },
    { name: 'a scope that is off', make: (token) => ({ method: 'POST', path: '/api/home/control', headers: { ...HOST, authorization: `Bearer ${token}` }, body: { thing: 'light.techo', action: 'on' } }) },
    { name: 'a forged session proof', make: () => ({ method: 'POST', path: '/api/session', headers: { ...HOST }, body: { deviceId: 'nobody', signature: 'AAAA' } }) },
    { name: 'a pairing guess', make: () => ({ method: 'POST', path: '/api/pair/request', headers: { ...HOST }, body: { secret: 'A'.repeat(43), phonePublicKey: { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'A'.repeat(43) } } }) },
    { name: 'a plain status read', make: (token) => ({ method: 'GET', path: '/api/status', headers: { ...HOST, authorization: `Bearer ${token}` } }) }
  ]
  const ONLY_CHAT = { ...allScopes(false), chat: true }

  async function runBattery(label: 'local' | 'relay'): Promise<Array<{ name: string; status: number; body: unknown; headers: unknown }>> {
    const run = async () => {
      const t = await testChannel({ remote: { enabled: true, scopes: ONLY_CHAT } })
      await t.channel.sync()
      const { deviceId, privateKey } = await pairDevice(t)
      const token = await openSession(t, deviceId, privateKey)
      const out = []
      for (const entry of BATTERY) {
        const response = await t.transport.request(entry.make(token))
        out.push({ name: entry.name, status: response.status, body: response.body, headers: response.headers })
      }
      return out
    }
    return label === 'relay' ? onThePair(run) : run()
  }

  it('AC-2.4 AC-2.5 AC-5.6 the same hostile and ordinary requests get the same status, body and headers over the relay as in-process', async () => {
    delete process.env['ALMA_TEST_TRANSPORT']
    const local = await runBattery('local')
    const relay = await runBattery('relay')
    expect(relay.map((entry) => entry.name)).toEqual(local.map((entry) => entry.name))
    for (let i = 0; i < local.length; i++) expect(relay[i], local[i]?.name).toEqual(local[i])
    // The battery is not vacuous: it contains refusals of several kinds and a success.
    const statuses = new Set(local.map((entry) => entry.status))
    expect(statuses.has(200)).toBe(true)
    expect([...statuses].filter((status) => status >= 400).length).toBeGreaterThanOrEqual(3)
  })

  it('AC-2.5 BR-8 an anonymous end-to-end session, a stranger flooding bad credentials and a request with a spoofed Host or Origin gain nothing and do not lock the real phone out', async () => {
    await onThePair(async () => {
      const { t, pair, headers } = await served({ scopes: ONLY_CHAT })
      const stranger = { method: 'GET', path: '/api/status', headers: { host: 'evil.example', origin: 'https://evil.example', authorization: 'Bearer stolen-guess', 'x-forwarded-for': '1.2.3.4', cookie: 'a=b' } }
      const refusals = new Set<number>()
      for (let i = 0; i < 50; i++) refusals.add((await t.transport.request(stranger)).status)
      expect([...refusals].every((status) => status === 401 || status === 403 || status === 429)).toBe(true)
      expect(refusals.has(200)).toBe(false)
      const real = await t.transport.request({ method: 'GET', path: '/api/status', headers })
      expect(real.status).toBe(200)
      expect(pair.handlerCalls).toBeGreaterThan(50)
    })
  })
})
