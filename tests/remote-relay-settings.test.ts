import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayStore } from '../src/coordinator/channels/remote/relay-store'
import type { SealBox } from '../src/coordinator/channels/remote/store'
import { effectiveRelayDomain, newRoutingId, RELAY_DOMAIN, RELAY_DOMAIN_PLACEHOLDER, relayAvailable } from '../src/shared/remote/relay-config'
import { defaultSettings } from '../src/shared/defaults'
import { planRemoteChange, runConfirmations, stripRemotePatch } from '../src/shared/remote/confirmations'
import { defaultRemote, sanitizeRemote } from '../src/shared/remote/settings'
import type { RemoteSettings } from '../src/shared/types'

const plan = (before: RemoteSettings, after: RemoteSettings, dormant: string[] = []) => planRemoteChange(before, after, dormant, { activeVault: 'C:/Notes' })
const on = (patch: Partial<RemoteSettings> = {}): RemoteSettings => ({ ...defaultRemote(), enabled: true, ...patch })
const kinds = (list: ReturnType<typeof plan>): string[] => list.confirmations.map((confirmation) => confirmation.kind)

describe('relay settings (spec 027 T20)', () => {
  it('AC-1.1 a fresh install is Tailscale, whatever the saved settings say or fail to say', () => {
    expect(defaultSettings().remote.transport).toBe('tailscale')
    expect(defaultRemote().transport).toBe('tailscale')
    for (const saved of [undefined, null, {}, { enabled: true }, { transport: undefined }, { transport: null }, { transport: 'RELAY' }, { transport: 'Relay ' }, { transport: 'both' }, { transport: 7 }, { transport: ['relay'] }, { transport: 'local' }]) {
      expect(sanitizeRemote(saved).transport, JSON.stringify(saved)).toBe('tailscale')
    }
  })

  it('AC-1.12 the shipped default is relay off, and only an exact saved choice turns it on', () => {
    expect(defaultSettings().remote).toEqual({
      enabled: false,
      transport: 'tailscale',
      scopes: { chat: false, approve: false, home: false, cameras: false, vault: false, history: false },
      sensitive: false,
      continueHistory: false,
      sendFiles: false,
      cameras: [],
      vaultExcluded: [],
      agentId: 'general'
    })
    expect(sanitizeRemote({ transport: 'relay' }).transport).toBe('relay')
    expect(sanitizeRemote({ transport: 'tailscale' }).transport).toBe('tailscale')
  })

  it('AC-1.8 a restart keeps the saved choice and asks nothing, whichever transport it is', () => {
    for (const transport of ['tailscale', 'relay'] as const) {
      const saved = sanitizeRemote({ ...on({ transport }), scopes: { ...defaultRemote().scopes, chat: true } })
      expect(saved.transport).toBe(transport)
      expect(plan(saved, sanitizeRemote(JSON.parse(JSON.stringify(saved)))).confirmations).toEqual([])
    }
  })

  it('AC-1.2 selecting the relay yields one relay confirmation, selecting Tailscale none', () => {
    const tailscale = on()
    const relay = on({ transport: 'relay' })
    expect(plan(tailscale, relay).confirmations).toEqual([{ kind: 'relay' }])
    expect(plan(relay, tailscale).confirmations).toEqual([])
    expect(plan(relay, relay).confirmations).toEqual([])
    expect(plan(tailscale, tailscale).confirmations).toEqual([])
    // The choice itself is what is kept.
    expect(plan(tailscale, relay).next.transport).toBe('relay')
    expect(plan(relay, tailscale).next.transport).toBe('tailscale')
  })

  it('AC-1.2 selecting the relay asks even while remote access is off, and nothing is asked twice', () => {
    const off = defaultRemote()
    expect(plan(off, { ...off, transport: 'relay' }).confirmations).toEqual([{ kind: 'relay' }])
    expect(plan({ ...off, transport: 'relay' }, off).confirmations).toEqual([])
    expect(kinds(plan(off, { ...off, transport: 'relay' }))).toHaveLength(1)
  })

  it('AC-1.2 the relay is asked after the enable dialog and before the scopes', () => {
    const before = defaultRemote()
    const turnOn = plan(before, on({ transport: 'relay', scopes: { ...defaultRemote().scopes, chat: true } }), ['Pixel'])
    expect(turnOn.confirmations).toEqual([{ kind: 'enable', dormant: ['Pixel'], relay: true }, { kind: 'relay' }])
    const running = on({ cameras: ['camera.a'] })
    const widen = plan(running, { ...running, transport: 'relay', scopes: { ...running.scopes, home: true }, sensitive: true, cameras: ['camera.a', 'camera.b'] })
    expect(kinds(widen)).toEqual(['relay', 'scope', 'sensitive', 'camera'])
  })

  it('AC-1.4 a cancelled relay confirmation asks nothing after it, so nothing is saved', () => {
    const before = on({ cameras: ['camera.a'] })
    const after = { ...before, transport: 'relay' as const, scopes: { ...before.scopes, chat: true }, cameras: ['camera.a', 'camera.b'] }
    const asked: string[] = []
    const result = runConfirmations(plan(before, after).confirmations, (confirmation) => {
      asked.push(confirmation.kind)
      return confirmation.kind !== 'relay'
    })
    expect(result).toBe('denied')
    expect(asked).toEqual(['relay'])
    // The settings the caller still holds are untouched.
    expect(before.transport).toBe('tailscale')
    expect(runConfirmations(plan(before, after).confirmations, () => true)).toBe('ok')
  })

  it('AC-1.5 stripRemotePatch removes the relay keys with the rest of remote', () => {
    const patch = { language: 'es', remote: { ...on({ transport: 'relay' }) } }
    expect(stripRemotePatch(patch)).toEqual({ language: 'es' })
    expect(stripRemotePatch({ remote: { transport: 'relay' } })).toEqual({})
    expect(JSON.stringify(stripRemotePatch(patch))).not.toContain('relay')
    // The patch it was given is not changed.
    expect(patch.remote.transport).toBe('relay')
  })

  it('AC-1.9 every turn-on with the relay selected starts with every scope and sub-switch off', () => {
    const everything = { ...defaultRemote().scopes, chat: true, approve: true, home: true, cameras: true, vault: true, history: true }
    for (const transport of ['relay', 'tailscale'] as const) {
      const off = { ...defaultRemote(), transport }
      const turnedOn = plan(off, { ...off, enabled: true, scopes: everything, sensitive: true, continueHistory: true })
      expect(turnedOn.next.scopes).toEqual(defaultRemote().scopes)
      expect(turnedOn.next.sensitive).toBe(false)
      expect(turnedOn.next.continueHistory).toBe(false)
      expect(turnedOn.next.transport).toBe(transport)
    }
    // Selecting the relay while remote is already on changes no scope either.
    const running = on({ scopes: { ...defaultRemote().scopes, chat: true } })
    expect(plan(running, { ...running, transport: 'relay' }).next.scopes).toEqual(running.scopes)
  })

  it('AC-1.13 the relay choice survives turn-ons, needs no new relay confirmation, and the enable dialog names it', () => {
    const off = { ...defaultRemote(), transport: 'relay' as const }
    const first = plan(off, { ...off, enabled: true }, ['Pixel'])
    expect(first.confirmations).toEqual([{ kind: 'enable', dormant: ['Pixel'], relay: true }])
    expect(first.next.transport).toBe('relay')
    const again = plan({ ...first.next, enabled: false }, { ...first.next, enabled: true })
    expect(again.confirmations).toEqual([{ kind: 'enable', dormant: [], relay: true }])
    expect(plan(first.next, { ...first.next, enabled: false }).confirmations).toEqual([])
    // With Tailscale selected the enable dialog is the 026 one, unchanged.
    expect(plan(defaultRemote(), { ...defaultRemote(), enabled: true }, ['Pixel']).confirmations).toEqual([{ kind: 'enable', dormant: ['Pixel'] }])
  })

  it('AC-1.14 the relay address is not a setting: no key for it survives, and the stored keys are the known ones', () => {
    const saved = sanitizeRemote({ ...on({ transport: 'relay' }), relayDomain: 'evil.example', relayAddress: 'https://evil.example', relayUrl: 'wss://evil.example', routingId: 'abc', domain: 'evil.example' })
    expect(Object.keys(saved).sort()).toEqual(Object.keys(defaultRemote()).sort())
    expect(JSON.stringify(saved)).not.toContain('evil')
    expect(JSON.stringify(Object.keys(defaultRemote()))).not.toMatch(/relay|domain|address|url|routing/i)
  })
})

describe('relay store and address (spec 027 T22)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const folder = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'alma-relay-store-'))
    dirs.push(dir)
    return dir
  }
  // Not readable without the box: the file must hold the sealed text, never the id.
  const box: SealBox & { opened: number } = {
    opened: 0,
    seal: async (plain) => `sealed:${[...plain].reverse().join('')}`,
    open: async (sealed) => {
      box.opened++
      if (!sealed.startsWith('sealed:')) throw new Error('not sealed')
      return [...sealed.slice('sealed:'.length)].reverse().join('')
    }
  }
  const open = (dir: string, domain = 'relay.example') => RelayStore.load({ dir, sealBox: box, random: (length) => crypto.getRandomValues(new Uint8Array(length)), domain: () => domain })
  const fileOf = (dir: string): string => join(dir, 'relay-sealed')

  it('AC-1.14 the routing id is 128 random bits as lower-case base32 without padding, safe as a host name', () => {
    const id = newRoutingId((length) => new Uint8Array(length).fill(255))
    expect(id).toMatch(/^[a-z2-7]{26}$/)
    expect(id).toBe(`${'7'.repeat(25)}4`)
    expect(newRoutingId((length) => new Uint8Array(length))).toBe('a'.repeat(26))
    const seen = new Set(Array.from({ length: 50 }, () => newRoutingId((length) => crypto.getRandomValues(new Uint8Array(length)))))
    expect(seen.size).toBe(50)
    for (const value of seen) {
      expect(value).toMatch(/^[a-z2-7]{26}$/)
      expect(value.length).toBeLessThanOrEqual(63)
    }
    // It asks for exactly 16 bytes.
    let asked = 0
    newRoutingId((length) => {
      asked = length
      return new Uint8Array(length)
    })
    expect(asked).toBe(16)
  })

  it('AC-4.8 the id is created once, on first selection, and reused across restarts', async () => {
    const dir = folder()
    const first = await open(dir)
    expect(first.routingId()).toBeNull()
    expect(existsSync(fileOf(dir))).toBe(false)
    const id = await first.ensureRoutingId()
    expect(id).toMatch(/^[a-z2-7]{26}$/)
    expect(await first.ensureRoutingId()).toBe(id)
    expect(first.routingId()).toBe(id)
    const again = await open(dir)
    expect(again.routingId()).toBe(id)
    expect(await again.ensureRoutingId()).toBe(id)
    // Another PC (another folder) has another id.
    expect(await (await open(folder())).ensureRoutingId()).not.toBe(id)
  })

  it('AC-3.6 the file holds the sealed text and never the id or the domain in clear', async () => {
    const dir = folder()
    const store = await open(dir)
    const id = await store.ensureRoutingId()
    await store.recordPairing()
    const text = readFileSync(fileOf(dir), 'utf8')
    expect(text.startsWith('sealed:')).toBe(true)
    expect(text).not.toContain(id)
    expect(text).not.toContain('relay.example')
    expect(JSON.parse(await box.open(text))).toMatchObject({ routingId: id, pairedDomain: 'relay.example' })
  })

  it('AC-4.8 a changed relay domain marks renamed, and it latches until the relay phones are revoked', async () => {
    const dir = folder()
    const before = await open(dir, 'relay.example')
    await before.ensureRoutingId()
    expect(before.renamed()).toBe(false)
    expect(before.pairedDomain()).toBeNull()
    await before.recordPairing()
    expect(before.pairedDomain()).toBe('relay.example')
    expect(before.renamed()).toBe(false)
    expect((await open(dir, 'relay.example')).renamed()).toBe(false)
    const moved = await open(dir, 'relay.other.example')
    expect(moved.renamed()).toBe(true)
    // It stays after another restart, and even if the domain were to come back, until someone acts on it.
    expect((await open(dir, 'relay.other.example')).renamed()).toBe(true)
    expect((await open(dir, 'relay.example')).renamed()).toBe(true)
    await moved.acknowledgeRename()
    expect(moved.renamed()).toBe(false)
    expect(moved.pairedDomain()).toBeNull()
    const after = await open(dir, 'relay.other.example')
    expect(after.renamed()).toBe(false)
    expect(after.routingId()).toBe(moved.routingId())
    // Phones that pair again under the new domain are the new baseline.
    await after.recordPairing()
    expect((await open(dir, 'relay.other.example')).pairedDomain()).toBe('relay.other.example')
  })

  it('AC-4.8 with nothing paired there is nothing to rename', async () => {
    const dir = folder()
    await (await open(dir, 'a.example')).ensureRoutingId()
    expect((await open(dir, 'b.example')).renamed()).toBe(false)
  })

  it('AC-1.14 the override is honored only in an unpackaged app, and only if it is a host name', () => {
    const build = 'relay.example'
    expect(effectiveRelayDomain({ build, override: 'relay.test.local', packaged: false })).toBe('relay.test.local')
    expect(effectiveRelayDomain({ build, override: 'relay.test.local', packaged: true })).toBe(build)
    expect(effectiveRelayDomain({ build, packaged: false })).toBe(build)
    expect(effectiveRelayDomain({ build, packaged: true })).toBe(build)
    for (const bad of ['', ' ', 'https://evil.example', 'evil.example/path', 'evil.example:8080', 'evil example', '-bad.example', 'a..b', 'evil.example.', '.evil.example', 'a'.repeat(260), 'ev\nil.example']) {
      expect(effectiveRelayDomain({ build, override: bad, packaged: false }), JSON.stringify(bad)).toBe(build)
    }
    expect(effectiveRelayDomain({ build, override: 'Relay.Test.Local', packaged: false })).toBe('relay.test.local')
  })

  it('AC-6.7 a packaged app whose domain is still the placeholder does not offer the relay; a development run always does', () => {
    const set = { ABUSE_CONTACT: 'a@b.test', JURISDICTION: 'PY', BUDGET_CEILING: '1 USD' }
    expect(relayAvailable({ domain: RELAY_DOMAIN_PLACEHOLDER, packaged: true, constants: set })).toBe(false)
    expect(relayAvailable({ domain: 'relay.example', packaged: true, constants: set })).toBe(true)
    expect(relayAvailable({ domain: RELAY_DOMAIN_PLACEHOLDER, packaged: false, constants: set })).toBe(true)
    expect(relayAvailable({ domain: '', packaged: true, constants: set })).toBe(false)
  })

  it('AC-6.7 with the facts the maintainer supplied, a packaged build offers the relay', () => {
    expect(relayAvailable({ domain: RELAY_DOMAIN, packaged: true })).toBe(true)
  })

  it('AC-6.7 a packaged app with a real domain still offers no relay while the abuse contact, jurisdiction or budget ceiling are placeholders', () => {
    const set = { ABUSE_CONTACT: 'abuse@example.test', JURISDICTION: 'Paraguay', BUDGET_CEILING: '20 USD' }
    expect(relayAvailable({ domain: 'relay.example', packaged: true, constants: set })).toBe(true)
    for (const name of Object.keys(set) as Array<keyof typeof set>) {
      expect(relayAvailable({ domain: 'relay.example', packaged: true, constants: { ...set, [name]: `${name}_PLACEHOLDER` } }), name).toBe(false)
    }
    const placeholders = { ABUSE_CONTACT: 'ABUSE_CONTACT_PLACEHOLDER', JURISDICTION: 'JURISDICTION_PLACEHOLDER', BUDGET_CEILING: 'BUDGET_CEILING_PLACEHOLDER' }
    expect(relayAvailable({ domain: 'relay.example', packaged: true, constants: placeholders })).toBe(false)
    // A development run is never held back by them.
    expect(relayAvailable({ domain: 'relay.example', packaged: false, constants: { ...set, ABUSE_CONTACT: 'ABUSE_CONTACT_PLACEHOLDER' } })).toBe(true)
  })

  it('AC-4.8 a damaged file resets safely: no throw, no id, and a new one is made and kept', async () => {
    const damaged: Array<[string, (dir: string) => void]> = [
      ['garbage', (dir) => writeFileSync(fileOf(dir), 'not sealed at all')],
      ['empty', (dir) => writeFileSync(fileOf(dir), '')],
      ['sealed garbage', (dir) => writeFileSync(fileOf(dir), 'sealed:}}} not json')],
      ['sealed wrong shape', (dir) => writeFileSync(fileOf(dir), `sealed:${[...JSON.stringify({ routingId: 7 })].reverse().join('')}`)],
      ['sealed bad id', (dir) => writeFileSync(fileOf(dir), `sealed:${[...JSON.stringify({ routingId: 'UPPER_case-Id', pairedDomain: null })].reverse().join('')}`)],
      ['sealed bad domain', (dir) => writeFileSync(fileOf(dir), `sealed:${[...JSON.stringify({ routingId: 'a'.repeat(26), pairedDomain: 5 })].reverse().join('')}`)],
      ['a folder in the way', (dir) => mkdirSync(fileOf(dir))]
    ]
    for (const [name, damage] of damaged) {
      const dir = folder()
      damage(dir)
      const store = await open(dir)
      expect(store.routingId(), name).toBeNull()
      expect(store.pairedDomain(), name).toBeNull()
      expect(store.renamed(), name).toBe(false)
      if (name === 'a folder in the way') continue
      const id = await store.ensureRoutingId()
      expect(id, name).toMatch(/^[a-z2-7]{26}$/)
      expect((await open(dir)).routingId(), name).toBe(id)
    }
    // A box that throws on open is the same as a damaged file.
    const dir = folder()
    writeFileSync(fileOf(dir), 'sealed:whatever')
    const throwing = await RelayStore.load({ dir, sealBox: { seal: box.seal, open: async () => { throw new Error('keychain locked') } }, random: () => new Uint8Array(16), domain: () => 'x.example' })
    expect(throwing.routingId()).toBeNull()
  })

  it('AC-8.2 erase deletes the file and forgets the id, and is safe to repeat or run with nothing there', async () => {
    const dir = folder()
    const store = await open(dir)
    const id = await store.ensureRoutingId()
    await store.recordPairing()
    expect(existsSync(fileOf(dir))).toBe(true)
    await store.erase()
    expect(existsSync(fileOf(dir))).toBe(false)
    expect(store.routingId()).toBeNull()
    expect(store.pairedDomain()).toBeNull()
    expect(store.renamed()).toBe(false)
    await store.erase()
    await (await open(folder())).erase()
    expect(await store.ensureRoutingId()).not.toBe(id)
  })

  it('AC-3.6 the store says nothing on the console, damaged or not', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = folder()
    writeFileSync(fileOf(dir), 'garbage')
    await (await open(dir)).ensureRoutingId()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
