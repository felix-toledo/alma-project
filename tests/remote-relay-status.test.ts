import { describe, expect, it } from 'vitest'
import { RelayController, runRelayTest } from '../src/coordinator/channels/remote/relay-controller'
import type { AuditEvent } from '../src/shared/audit'
import { en } from '../src/shared/i18n/en'
import { es } from '../src/shared/i18n/es'
import { defaultRemote } from '../src/shared/remote/settings'
import { overlayRelayStatus, refusedReasonKey, relayFailureKey, type RelayState } from '../src/shared/remote/relay-status'
import { relayTab } from '../src/shared/remote/relay-view'
import type { RelayFailure, RemoteSettings, RemoteStatus } from '../src/shared/types'

const CAUSES: RelayFailure[] = ['relayUnreachable', 'relayRefused', 'relayFull', 'relayVersion', 'relayGone']
const online: RemoteStatus = { state: 'online', address: 'https://abc.relay.test', keyExpiresInDays: 40 }

describe('overlayRelayStatus (spec 027 T8)', () => {
  it('AC-7.1 a Tailscale status is left alone: no relay state returns the very same status', () => {
    expect(overlayRelayStatus(online, null)).toBe(online)
    const tailscaleDown: RemoteStatus = { state: 'error', failure: 'tailscaleDown', detail: 'x' }
    expect(overlayRelayStatus(tailscaleDown, null)).toBe(tailscaleDown)
  })

  it('AC-7.2 each relay cause shows as an error with exactly that cause, its detail kept and the address left', () => {
    for (const failure of CAUSES) {
      const shown = overlayRelayStatus(online, { state: 'error', failure, detail: 'why' })
      expect(shown, failure).toEqual({ ...online, state: 'error', relayFailure: failure, detail: 'why' })
      expect(shown.failure, failure).toBeUndefined()
    }
    expect(overlayRelayStatus(online, { state: 'error', failure: 'relayGone' }).detail).toBeUndefined()
  })

  it('AC-7.1 the relay state follows through: connecting shows as connecting, online and off change nothing', () => {
    expect(overlayRelayStatus(online, { state: 'connecting' })).toEqual({ ...online, state: 'connecting' })
    expect(overlayRelayStatus(online, { state: 'online' })).toEqual(online)
    expect(overlayRelayStatus(online, { state: 'off' })).toEqual(online)
    // Recovery: the error disappears with the cause.
    const down = overlayRelayStatus(online, { state: 'error', failure: 'relayUnreachable' })
    expect(down.state).toBe('error')
    const up = overlayRelayStatus(online, { state: 'online' })
    expect(up.state).toBe('online')
    expect(up.relayFailure).toBeUndefined()
  })

  it('AC-7.2 a handshake input never produces an error, whether the relay is online or claims an error with no listed cause', () => {
    const handshake = { state: 'online', failure: 'handshake' } as unknown as RelayState
    expect(overlayRelayStatus(online, handshake)).toEqual(online)
    expect(overlayRelayStatus(online, { state: 'error', failure: 'handshake' } as unknown as RelayState)).toEqual(online)
    expect(overlayRelayStatus(online, { state: 'error' })).toEqual(online)
    expect(overlayRelayStatus(online, { state: 'online', failure: 'relayGone' })).toEqual(online)
    expect(overlayRelayStatus(online, { state: 'connecting', failure: 'relayGone' })).toEqual({ ...online, state: 'connecting' })
  })

  it('AC-7.1 the overlay never hides the channel: off stays off, and the channel own error is not replaced', () => {
    const off: RemoteStatus = { state: 'off' }
    expect(overlayRelayStatus(off, { state: 'error', failure: 'relayGone' })).toBe(off)
    expect(overlayRelayStatus(off, { state: 'connecting' })).toBe(off)
    const listener: RemoteStatus = { state: 'error', failure: 'listener', detail: 'EADDRINUSE' }
    expect(overlayRelayStatus(listener, { state: 'online' })).toEqual(listener)
    expect(overlayRelayStatus(listener, { state: 'error', failure: 'relayFull' })).toEqual(listener)
    expect(overlayRelayStatus(listener, { state: 'connecting' })).toEqual(listener)
    const connecting: RemoteStatus = { state: 'connecting' }
    expect(overlayRelayStatus(connecting, { state: 'error', failure: 'relayRefused' })).toEqual({ state: 'error', relayFailure: 'relayRefused' })
  })

  it('AC-4.8 a renamed relay is carried to the status in every state except when nothing is selected', () => {
    expect(overlayRelayStatus(online, { state: 'online', renamed: true })).toEqual({ ...online, relayRenamed: true })
    expect(overlayRelayStatus({ state: 'off' }, { state: 'off', renamed: true })).toEqual({ state: 'off', relayRenamed: true })
    expect(overlayRelayStatus(online, { state: 'error', failure: 'relayGone', renamed: true })).toMatchObject({ state: 'error', relayFailure: 'relayGone', relayRenamed: true })
    expect(overlayRelayStatus(online, { state: 'online', renamed: false })).toEqual(online)
    expect(overlayRelayStatus(online, null)).not.toHaveProperty('relayRenamed')
  })

  it('AC-7.1 the overlay does not change its inputs', () => {
    const channel: RemoteStatus = { state: 'online', address: 'a', failure: undefined }
    const relay: RelayState = { state: 'error', failure: 'relayFull', detail: 'd' }
    const before = JSON.stringify([channel, relay])
    overlayRelayStatus(channel, relay)
    expect(JSON.stringify([channel, relay])).toBe(before)
  })
})

describe('relay controller and test (spec 027 T21)', () => {
  const CAUSES: RelayFailure[] = ['relayUnreachable', 'relayRefused', 'relayFull', 'relayVersion', 'relayGone']

  function setup() {
    const records: AuditEvent[] = []
    const changes: Array<RelayState | null> = []
    let notices = 0
    const controller = new RelayController({
      record: (entry) => records.push(entry),
      notify: () => void notices++,
      onChange: (state) => changes.push(state)
    })
    return { controller, records, changes, notices: () => notices }
  }

  it('AC-7.1 relay status changes are emitted and readable, once each, and nothing happens while Tailscale is selected', () => {
    const t = setup()
    expect(t.controller.current()).toBeNull()
    t.controller.report({ state: 'error', failure: 'relayGone' })
    expect(t.controller.current()).toBeNull()
    expect(t.changes).toEqual([])
    expect(t.records).toEqual([])
    expect(t.notices()).toBe(0)
    t.controller.select(true)
    expect(t.controller.current()).toEqual({ state: 'off' })
    t.controller.report({ state: 'connecting' })
    t.controller.report({ state: 'connecting' })
    t.controller.report({ state: 'online' })
    expect(t.controller.current()).toEqual({ state: 'online' })
    expect(t.changes).toEqual([{ state: 'off' }, { state: 'connecting' }, { state: 'online' }])
    t.controller.select(false)
    expect(t.controller.current()).toBeNull()
    expect(t.changes.at(-1)).toBeNull()
    // Choosing Tailscale twice says nothing the second time.
    t.controller.select(false)
    expect(t.changes.filter((change) => change === null)).toHaveLength(1)
  })

  it.each(CAUSES)('AC-7.2 the cause %s is shown as itself, with one notice and one audit entry', (failure) => {
    const t = setup()
    t.controller.select(true)
    t.controller.report({ state: 'connecting' })
    t.controller.report({ state: 'error', failure, detail: '4003' })
    expect(t.controller.current()).toEqual({ state: 'error', failure, detail: '4003' })
    expect(overlayRelayStatus({ state: 'online', address: 'https://x.relay.test' }, t.controller.current())).toMatchObject({ state: 'error', relayFailure: failure })
    expect(t.notices()).toBe(1)
    expect(t.records).toEqual([{ action: 'remote.relay.down', actor: 'remote', outcome: 'error' }])
    expect(relayFailureKey(failure)).toBe(`remote.relay.fail.${failure.slice('relay'.length).toLowerCase()}`)
  })

  it('AC-7.2 each cause has its own text in both languages', () => {
    const keys = CAUSES.map(relayFailureKey)
    expect(new Set(keys).size).toBe(CAUSES.length)
    for (const key of keys) {
      expect(typeof en[key], key).toBe('string')
      expect(typeof es[key], key).toBe('string')
      expect(String(en[key]).length).toBeGreaterThan(10)
    }
    expect(typeof en['remote.notice.relayDown']).toBe('string')
    expect(typeof es['remote.notice.relayDown']).toBe('string')
  })

  it('AC-7.2 one notice and one audit entry per outage over 50 retries, and recovery is one more entry', () => {
    const t = setup()
    t.controller.select(true)
    t.controller.report({ state: 'connecting' })
    for (let i = 0; i < 50; i++) {
      t.controller.report({ state: 'error', failure: 'relayUnreachable' })
      t.controller.report({ state: 'connecting' })
    }
    t.controller.report({ state: 'error', failure: 'relayFull' })
    expect(t.notices()).toBe(1)
    expect(t.records.map((entry) => entry.action)).toEqual(['remote.relay.down'])
    t.controller.report({ state: 'online' })
    expect(t.records.map((entry) => [entry.action, entry.outcome])).toEqual([
      ['remote.relay.down', 'error'],
      ['remote.relay.up', 'ok']
    ])
    t.controller.report({ state: 'online' })
    expect(t.records).toHaveLength(2)
    // A second outage is a new one.
    t.controller.report({ state: 'error', failure: 'relayUnreachable' })
    expect(t.notices()).toBe(2)
    expect(t.records.map((entry) => entry.action)).toEqual(['remote.relay.down', 'remote.relay.up', 'remote.relay.down'])
  })

  it('AC-7.2 an outage that ends because the relay is stopped or deselected records no recovery', () => {
    for (const end of [(c: RelayController) => c.report({ state: 'off' }), (c: RelayController) => c.select(false)]) {
      const t = setup()
      t.controller.select(true)
      t.controller.report({ state: 'error', failure: 'relayUnreachable' })
      end(t.controller)
      expect(t.records.map((entry) => entry.action)).toEqual(['remote.relay.down'])
      t.controller.select(true)
      t.controller.report({ state: 'error', failure: 'relayUnreachable' })
      expect(t.notices()).toBe(2)
    }
  })

  it('AC-7.2 a failed phone handshake is audited and throttled and does not mark the relay down', () => {
    const t = setup()
    t.controller.select(true)
    t.controller.report({ state: 'online' })
    const changes = t.changes.length
    for (let i = 0; i < 3; i++) t.controller.handshakeFailed()
    expect(t.records).toEqual(Array(3).fill({ action: 'remote.relay.handshake', actor: 'remote', outcome: 'denied', throttle: true }))
    expect(JSON.stringify(t.records)).not.toMatch(/deviceId|detail|target/)
    expect(t.controller.current()).toEqual({ state: 'online' })
    expect(t.changes).toHaveLength(changes)
    expect(t.notices()).toBe(0)
    // Nor does it end or start an outage.
    t.controller.report({ state: 'error', failure: 'relayUnreachable' })
    t.controller.handshakeFailed()
    t.controller.report({ state: 'online' })
    expect(t.records.map((entry) => entry.action).filter((action) => action !== 'remote.relay.handshake')).toEqual(['remote.relay.down', 'remote.relay.up'])
    // With Tailscale selected there is no relay to report on.
    t.controller.select(false)
    const before = t.records.length
    t.controller.handshakeFailed()
    expect(t.records).toHaveLength(before)
  })

  it('AC-8.7 a relay that has ended maps to gone and points to Tailscale, in both languages', () => {
    const t = setup()
    t.controller.select(true)
    t.controller.report({ state: 'error', failure: 'relayGone' })
    expect(overlayRelayStatus({ state: 'online' }, t.controller.current())).toMatchObject({ state: 'error', relayFailure: 'relayGone' })
    expect(relayFailureKey('relayGone')).toBe('remote.relay.fail.gone')
    expect(en['remote.relay.fail.gone']).toMatch(/Tailscale/)
    expect(es['remote.relay.fail.gone']).toMatch(/Tailscale/)
    // Choosing Tailscale leaves the relay behind, untouched and silent.
    t.controller.select(false)
    expect(t.controller.current()).toBeNull()
  })

  it('AC-4.8 a changed relay domain is carried in the state and kept across reports', () => {
    const t = setup()
    t.controller.select(true)
    t.controller.setRenamed(true)
    expect(t.controller.current()).toEqual({ state: 'off', renamed: true })
    t.controller.report({ state: 'online' })
    expect(t.controller.current()).toEqual({ state: 'online', renamed: true })
    t.controller.setRenamed(true)
    expect(t.changes).toHaveLength(3)
    t.controller.setRenamed(false)
    expect(t.controller.current()).toEqual({ state: 'online' })
  })

  it('AC-7.2 a refusal says why in words: the close code maps to a dictionary key, and anything else to a generic one', () => {
    const keys = ['4001', '4002', '4003', undefined, 'whatever'].map(refusedReasonKey)
    expect(keys[0]).not.toBe(keys[1])
    expect(keys[1]).not.toBe(keys[2])
    expect(keys[3]).toBe(keys[4])
    expect(new Set(keys).size).toBe(4)
    for (const key of keys) {
      expect(typeof en[key], key).toBe('string')
      expect(typeof es[key], key).toBe('string')
    }
  })

  it('AC-7.3 the relay connection check runs its steps in order, one cause each', async () => {
    const run = async (answers: { internet?: boolean | 'throws'; connect?: RelayState | 'throws'; phone?: 'none' | 'answered' | 'silent' | 'throws' }) => {
      const calls: string[] = []
      const result = await runRelayTest({
        internet: async () => {
          calls.push('internet')
          if (answers.internet === 'throws') throw new Error('offline')
          return answers.internet ?? true
        },
        connect: async () => {
          calls.push('connect')
          if (answers.connect === 'throws') throw new Error('refused')
          return answers.connect ?? { state: 'online' }
        },
        phone: async () => {
          calls.push('phone')
          if (answers.phone === 'throws') throw new Error('silent')
          return answers.phone ?? 'answered'
        }
      })
      return { result, calls }
    }
    expect(await run({})).toEqual({ result: { ok: true }, calls: ['internet', 'connect', 'phone'] })
    expect(await run({ phone: 'none' })).toEqual({ result: { ok: true }, calls: ['internet', 'connect', 'phone'] })
    expect(await run({ internet: false })).toEqual({ result: { ok: false, cause: 'noInternet' }, calls: ['internet'] })
    expect(await run({ internet: 'throws' })).toEqual({ result: { ok: false, cause: 'noInternet' }, calls: ['internet'] })
    for (const failure of CAUSES) {
      expect(await run({ connect: { state: 'error', failure } })).toEqual({ result: { ok: false, cause: failure }, calls: ['internet', 'connect'] })
    }
    for (const unsettled of [{ state: 'connecting' }, { state: 'off' }, { state: 'error' }] as const) {
      expect((await run({ connect: unsettled })).result).toEqual({ ok: false, cause: 'relayUnreachable' })
    }
    expect((await run({ connect: 'throws' })).result).toEqual({ ok: false, cause: 'relayUnreachable' })
    expect(await run({ phone: 'silent' })).toEqual({ result: { ok: false, cause: 'phoneSilent' }, calls: ['internet', 'connect', 'phone'] })
    expect((await run({ phone: 'throws' })).result).toEqual({ ok: false, cause: 'phoneSilent' })
  })
})

describe('the relay in the tab (spec 027 T30)', () => {
  const remote = (patch: Partial<RemoteSettings> = {}): RemoteSettings => ({ ...defaultRemote(), ...patch })
  const relayOn = remote({ enabled: true, transport: 'relay' })

  it('AC-7.4 with Tailscale selected the tab is the 026 one: Tailscale steps, no relay controls, and the note about the other connection', () => {
    expect(relayTab(remote({ enabled: true }), { state: 'online' })).toEqual({
      offered: true,
      viaRelay: false,
      tailscaleSteps: true,
      failure: null,
      renamed: false,
      canTest: false,
      canPair: false,
      devicesNote: true
    })
    expect(relayTab(remote(), { state: 'off' }).tailscaleSteps).toBe(true)
  })

  it('AC-7.4 with the relay selected the Tailscale steps go away, and the relay can be tested and paired only when it is on and online', () => {
    expect(relayTab(relayOn, { state: 'online' })).toMatchObject({ viaRelay: true, tailscaleSteps: false, canTest: true, canPair: true })
    expect(relayTab(relayOn, { state: 'connecting' })).toMatchObject({ canTest: true, canPair: false })
    expect(relayTab(relayOn, { state: 'error', relayFailure: 'relayFull' })).toMatchObject({ canTest: true, canPair: false, failure: 'relayFull' })
    // Selected but remote access off: the choice is shown, nothing runs.
    expect(relayTab(remote({ transport: 'relay' }), { state: 'off' })).toMatchObject({ viaRelay: true, canTest: false, canPair: false, failure: null })
  })

  it('AC-7.2 only a relay cause is shown as the relay cause, never a Tailscale one and never while the relay is not selected', () => {
    for (const failure of ['relayUnreachable', 'relayRefused', 'relayFull', 'relayVersion', 'relayGone'] as const) {
      expect(relayTab(relayOn, { state: 'error', relayFailure: failure }).failure).toBe(failure)
    }
    expect(relayTab(relayOn, { state: 'error', failure: 'tailscaleDown' }).failure).toBeNull()
    expect(relayTab(relayOn, { state: 'online', relayFailure: 'relayFull' }).failure).toBeNull()
    expect(relayTab(remote({ enabled: true }), { state: 'error', relayFailure: 'relayFull' }).failure).toBeNull()
  })

  it('AC-4.8 the renamed banner shows only for the relay, when the status says so', () => {
    expect(relayTab(relayOn, { state: 'online', relayRenamed: true }).renamed).toBe(true)
    expect(relayTab(relayOn, { state: 'online' }).renamed).toBe(false)
    expect(relayTab(remote({ enabled: true }), { state: 'online', relayRenamed: true }).renamed).toBe(false)
  })

  it('AC-6.7 a build that offers no relay shows none of it, whatever the setting says', () => {
    const hidden = relayTab(relayOn, { state: 'online', relayHidden: true, relayRenamed: true, relayFailure: 'relayGone' })
    expect(hidden).toEqual({ offered: false, viaRelay: false, tailscaleSteps: true, failure: null, renamed: false, canTest: false, canPair: false, devicesNote: false })
  })
})
