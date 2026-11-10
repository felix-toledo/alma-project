import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../src/shared/defaults'
import { en } from '../src/shared/i18n/en'
import { es } from '../src/shared/i18n/es'
import { planRemoteChange, runConfirmations, stripRemotePatch } from '../src/shared/remote/confirmations'
import { defaultRemote, sanitizeRemote } from '../src/shared/remote/settings'
import type { RemoteSettings } from '../src/shared/types'

const plan = (before: RemoteSettings, after: RemoteSettings, dormant: string[]) => planRemoteChange(before, after, dormant, { activeVault: 'C:/Notes' })

describe('remote settings (spec 026 T2)', () => {
  it('AC-1.1 a fresh install has remote access off and every scope off', () => {
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
  })

  it('AC-3.7 settings cannot name the test transport', () => {
    expect(sanitizeRemote({ transport: 'local' }).transport).toBe('tailscale')
    expect(sanitizeRemote({ transport: 'tailscale' }).transport).toBe('tailscale')
    expect(sanitizeRemote({}).transport).toBe('tailscale')
    expect(sanitizeRemote({ transport: 7 }).transport).toBe('tailscale')
  })

  it('AC-1.1 a malformed remote section falls back to the default', () => {
    const base = defaultRemote()
    for (const value of [null, undefined, [], 'remote', 42, true]) {
      expect(sanitizeRemote(value)).toEqual(base)
    }
  })

  it('AC-1.1 wrong-typed fields fall back per field and valid ones are kept', () => {
    expect(
      sanitizeRemote({
        enabled: true,
        transport: 'local',
        scopes: { chat: true, approve: 'yes', home: 1, cameras: null },
        sensitive: 'no',
        cameras: ['camera.kitchen', 7],
        agentId: 'revisor',
        extra: 1
      })
    ).toEqual({
      enabled: true,
      transport: 'tailscale',
      scopes: { chat: true, approve: false, home: false, cameras: false, vault: false, history: false },
      sensitive: false,
      continueHistory: false,
      sendFiles: false,
      cameras: [],
      vaultExcluded: [],
      agentId: 'revisor'
    })
  })

  it('AC-1.1 missing fields fall back to the default', () => {
    expect(sanitizeRemote({ enabled: true })).toEqual({ ...defaultRemote(), enabled: true })
    expect(sanitizeRemote({ scopes: { chat: true } }).scopes).toEqual({ chat: true, approve: false, home: false, cameras: false, vault: false, history: false })
  })
})

describe('remote confirmations (spec 026 T3)', () => {
  const on = (): RemoteSettings => ({ ...defaultRemote(), enabled: true })

  it('AC-1.2 turning on yields one enable confirmation naming the dormant devices', () => {
    const { confirmations, next } = plan(defaultRemote(), { ...defaultRemote(), enabled: true }, ['Pixel de Ana', 'iPhone'])
    expect(confirmations).toEqual([{ kind: 'enable', dormant: ['Pixel de Ana', 'iPhone'] }])
    expect(next.enabled).toBe(true)
  })

  it('AC-1.11 the turn-on confirmation carries an empty list when no device is dormant', () => {
    const { confirmations } = plan(defaultRemote(), { ...defaultRemote(), enabled: true }, [])
    expect(confirmations).toEqual([{ kind: 'enable', dormant: [] }])
  })

  it('AC-1.2 staying on with no change asks nothing', () => {
    const before = { ...on(), scopes: { chat: true, approve: false, home: false, cameras: false, vault: false, history: false } }
    const { confirmations, next } = plan(before, { ...before }, ['Pixel'])
    expect(confirmations).toEqual([])
    expect(next).toEqual(before)
  })

  it('AC-1.11 one, five or odd dormant names ride along verbatim', () => {
    const turnedOn = { ...defaultRemote(), enabled: true }
    expect(plan(defaultRemote(), turnedOn, ['Pixel']).confirmations).toEqual([
      { kind: 'enable', dormant: ['Pixel'] }
    ])
    const five = ['a', 'b', 'c', 'd', 'e']
    expect(plan(defaultRemote(), turnedOn, five).confirmations).toEqual([{ kind: 'enable', dormant: five }])
    const odd = ['a,b', 'c\nd', ' e ']
    expect(plan(defaultRemote(), turnedOn, odd).confirmations).toEqual([{ kind: 'enable', dormant: odd }])
  })

  it('AC-1.12 every turn-on starts with all scopes and locks off and keeps the camera list', () => {
    const before = { ...defaultRemote(), cameras: ['camera.kitchen'] }
    const after: RemoteSettings = {
      ...before,
      enabled: true,
      scopes: { chat: true, approve: true, home: true, cameras: true, vault: false, history: false },
      sensitive: true,
      agentId: 'revisor'
    }
    const { confirmations, next } = plan(before, after, [])
    expect(confirmations).toEqual([{ kind: 'enable', dormant: [] }])
    expect(next).toEqual({ ...after, scopes: { chat: false, approve: false, home: false, cameras: false, vault: false, history: false }, sensitive: false })
  })

  it('AC-1.12 a turn-on that also adds a camera asks for both', () => {
    const { confirmations } = plan(defaultRemote(), { ...defaultRemote(), enabled: true, cameras: ['camera.kitchen'] }, [])
    expect(confirmations).toEqual([{ kind: 'enable', dormant: [] }, { kind: 'camera', cameraId: 'camera.kitchen' }])
  })

  it('AC-1.7 turning off asks nothing and keeps the section as sent', () => {
    const before = { ...on(), scopes: { chat: true, approve: false, home: false, cameras: false, vault: false, history: false } }
    const after = { ...before, enabled: false }
    expect(plan(before, after, [])).toEqual({ confirmations: [], next: after })
  })

  it('AC-1.9 turning a scope on asks, turning it off does not', () => {
    const before = on()
    expect(plan(before, { ...before, scopes: { ...before.scopes, chat: true } }, []).confirmations).toEqual([{ kind: 'scope', scope: 'chat' }])
    const chatOn = { ...before, scopes: { ...before.scopes, chat: true } }
    expect(plan(chatOn, before, []).confirmations).toEqual([])
  })

  it('AC-1.9 every scope asks on the way on and none on the way off', () => {
    for (const scope of ['chat', 'approve', 'home', 'cameras'] as const) {
      const before = on()
      const ask = plan(before, { ...before, scopes: { ...before.scopes, [scope]: true } }, [])
      expect(ask.confirmations).toEqual([{ kind: 'scope', scope }])
      const noisy = { ...before, scopes: { ...before.scopes, [scope]: true } }
      expect(plan(noisy, before, []).confirmations).toEqual([])
    }
  })

  it('AC-1.9 two scopes at once yield two confirmations in scope order', () => {
    const before = on()
    const after = { ...before, scopes: { chat: true, approve: false, home: true, cameras: false, vault: false, history: false } }
    expect(plan(before, after, []).confirmations).toEqual([
      { kind: 'scope', scope: 'chat' },
      { kind: 'scope', scope: 'home' }
    ])
  })

  it('AC-1.9 scope flips while remote stays off ask nothing: they cannot take effect', () => {
    const before = defaultRemote()
    const after = { ...before, scopes: { chat: true, approve: false, home: false, cameras: false, vault: false, history: false } }
    expect(plan(before, after, []).confirmations).toEqual([])
  })

  it('AC-1.10 locks and alarms ask when turned on, not when turned off', () => {
    const before = on()
    expect(plan(before, { ...before, sensitive: true }, []).confirmations).toEqual([{ kind: 'sensitive' }])
    expect(plan({ ...before, sensitive: true }, before, []).confirmations).toEqual([])
  })

  it('AC-5.22 adding a camera asks naming it; removing or reordering asks nothing', () => {
    const before = { ...on(), cameras: ['camera.kitchen', 'camera.door'] }
    const added = plan(before, { ...before, cameras: ['camera.kitchen', 'camera.door', 'camera.yard'] }, [])
    expect(added.confirmations).toEqual([{ kind: 'camera', cameraId: 'camera.yard' }])
    expect(plan(before, { ...before, cameras: ['camera.kitchen'] }, []).confirmations).toEqual([])
    expect(plan(before, { ...before, cameras: ['camera.door', 'camera.kitchen'] }, []).confirmations).toEqual([])
  })

  it('AC-5.22 camera additions ask even while remote is off: the list persists across turn-ons', () => {
    const before = defaultRemote()
    const after = { ...before, cameras: ['camera.kitchen'] }
    expect(plan(before, after, []).confirmations).toEqual([{ kind: 'camera', cameraId: 'camera.kitchen' }])
  })

  it('AC-1.4 runConfirmations stops at the first refusal and asks nothing after it', () => {
    const asked: string[] = []
    const result = runConfirmations([{ kind: 'scope', scope: 'chat' }, { kind: 'scope', scope: 'home' }, { kind: 'sensitive' }], (c) => {
      asked.push(c.kind)
      return c.kind !== 'scope' || (c.kind === 'scope' && c.scope !== 'home')
    })
    expect(result).toBe('denied')
    expect(asked).toEqual(['scope', 'scope'])
    expect(runConfirmations([{ kind: 'sensitive' }], () => true)).toBe('ok')
    expect(runConfirmations([], () => false)).toBe('ok')
  })

  it('AC-1.5 stripRemotePatch removes remote, keeps the rest and does not mutate', () => {
    const patch = { remote: defaultRemote(), language: 'es' }
    const stripped = stripRemotePatch(patch)
    expect(stripped).toEqual({ language: 'es' })
    expect('remote' in stripped).toBe(false)
    expect(patch.remote).toEqual(defaultRemote())
  })

  it('AC-1.5 a patch with only remote strips to nothing', () => {
    expect(stripRemotePatch({ remote: defaultRemote() })).toEqual({})
  })
})

describe('remote dictionary keys (spec 026 T4)', () => {
  // Every PC key of spec 6.1 except remote.pwa.* (the PWA's own dictionary, T40) and the reuse rows,
  // plus the two operational keys the coordinator renders itself (T32/T33).
  const PC_KEYS = [
    'settings.tab.remote',
    'remote.enable',
    'remote.offByDefault.hint',
    'remote.scope.chat',
    'remote.scope.approve',
    'remote.scope.home',
    'remote.scope.cameras',
    'remote.scope.sensitive',
    'remote.scope.sensitive.hint',
    'remote.scope.cameras.allow',
    'remote.cameras.none',
    'remote.wizard.tailscale.found',
    'remote.wizard.tailscale.missing',
    'remote.wizard.tailscale.disconnected',
    'remote.wizard.tailscale.download',
    'remote.wizard.serve',
    'remote.wizard.test',
    'remote.wizard.test.ok',
    'remote.wizard.fail.noInternet',
    'remote.wizard.fail.tailscaleDown',
    'remote.wizard.fail.httpsOff',
    'remote.wizard.fail.listener',
    'remote.wizard.fail.portTaken',
    'remote.wizard.port.pick',
    'remote.wizard.fail.serveBusy',
    'remote.wizard.fail.phoneSilent',
    'remote.wizard.acl.hint',
    'remote.wizard.notice.plan',
    'remote.wizard.notice.certs',
    'remote.wizard.notice.rename',
    'remote.wizard.renamed',
    'remote.wizard.renamed.revoke',
    'remote.wizard.keyExpiry',
    'remote.notice.down',
    'remote.notice.down.title',
    'remote.serve.notBuilt',
    'remote.pair.qr.hint',
    'remote.pair.code.compare',
    'remote.pair.name',
    'remote.pair.approve',
    'remote.pair.reject',
    'remote.pair.expired',
    'remote.pair.locked',
    'remote.pair.busy',
    'remote.pair.limit',
    'remote.devices.title',
    'remote.devices.none',
    'remote.devices.lastSeen',
    'remote.devices.dormant',
    'remote.devices.revoke',
    'remote.devices.revokeAll',
    'remote.devices.revoke.confirm',
    'remote.activity.title',
    'remote.activity.none',
    'tray.remote.off',
    'main.remote.enable',
    'main.remote.enableDetail',
    'main.remote.dormant',
    'main.remote.scope',
    'main.remote.sensitive',
    'main.remote.camera',
    'main.remote.pair',
    'main.remote.revokeAll',
    'main.remote.serve',
    'main.remote.download'
  ]

  it('AC-9.3 every PC key of the spec table exists in both dictionaries', () => {
    expect(PC_KEYS).toHaveLength(65)
    for (const key of PC_KEYS) {
      expect(Object.hasOwn(es, key), `es ${key}`).toBe(true)
      expect(Object.hasOwn(en, key), `en ${key}`).toBe(true)
    }
  })
})
