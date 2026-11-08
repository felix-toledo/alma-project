import { describe, expect, it } from 'vitest'
import { en } from '../src/shared/i18n/en'
import { es } from '../src/shared/i18n/es'
import { planRemoteChange, stripRemotePatch, type RemoteConfirmation } from '../src/shared/remote/confirmations'
import { REMOTE_LIMITS, ROUTES, type Refusal, type RouteSpec } from '../src/shared/remote/api'
import { authorizeRemote } from '../src/shared/remote/authorize'
import { refusalResponse } from '../src/coordinator/channels/remote/transport'
import { statusView } from '../src/shared/remote/status'
import { defaultRemote, sanitizeRemote } from '../src/shared/remote/settings'
import type { RemoteSettings } from '../src/shared/types'

const VAULT = 'C:/Notes'
const plan = (before: RemoteSettings, after: RemoteSettings, dormant: string[] = []) => planRemoteChange(before, after, dormant, { activeVault: VAULT })
const on = (): RemoteSettings => ({ ...defaultRemote(), enabled: true })
const allOn = { chat: true, approve: true, home: true, cameras: true, vault: true, history: true }

describe('remote notes and history scopes (spec 028 phase 1)', () => {
  it('AC-1.3 (028) defaults have Notes, History and continue off and an empty list', () => {
    const remote = defaultRemote()
    expect(remote.scopes.vault).toBe(false)
    expect(remote.scopes.history).toBe(false)
    expect(remote.continueHistory).toBe(false)
    expect(remote.vaultExcluded).toEqual([])
  })

  it('AC-1.3 (028) sanitize drops invalid exclusion items one by one', () => {
    const remote = sanitizeRemote({ vaultExcluded: ['Private', 7, '', null, 'Work/Taxes', '  '] })
    expect(remote.vaultExcluded).toEqual(['Private', 'Work/Taxes'])
  })

  it('AC-1.3 (028) a non-array exclusion list resets and forces Notes off', () => {
    for (const bad of ['Private', 7, null, { a: 1 }, true]) {
      const remote = sanitizeRemote({ scopes: { vault: true, history: true }, vaultExcluded: bad })
      expect(remote.vaultExcluded).toEqual([])
      expect(remote.scopes.vault).toBe(false)
      expect(remote.scopes.history).toBe(true)
    }
  })

  it('AC-1.3 (028) old settings files load with the new scopes off', () => {
    const remote = sanitizeRemote({
      enabled: true,
      scopes: { chat: true, approve: false, home: false, cameras: true, vault: false, history: false },
      sensitive: false,
      cameras: [],
      agentId: 'general'
    })
    expect(remote.scopes).toEqual({ chat: true, approve: false, home: false, cameras: true, vault: false, history: false })
    expect(remote.continueHistory).toBe(false)
    expect(remote.vaultExcluded).toEqual([])
  })
})

describe('remote confirmations for Notes, History and continue (spec 028 T4)', () => {
  it('AC-1.2 (028) several at once ask once each in the fixed order', () => {
    const before = { ...on(), cameras: ['camera.a'], vaultExcluded: ['Private', 'Work/Taxes'] }
    const after = { ...before, scopes: allOn, sensitive: true, continueHistory: true, cameras: ['camera.a', 'camera.b'], vaultExcluded: ['Work/Taxes'] }
    const expected: RemoteConfirmation[] = [
      { kind: 'scope', scope: 'chat' },
      { kind: 'scope', scope: 'approve' },
      { kind: 'scope', scope: 'home' },
      { kind: 'scope', scope: 'cameras' },
      { kind: 'scope', scope: 'vault', vaultFolder: VAULT },
      { kind: 'scope', scope: 'history' },
      { kind: 'sensitive' },
      { kind: 'continue' },
      { kind: 'camera', cameraId: 'camera.b' },
      { kind: 'unexclude', folder: 'Private' }
    ]
    expect(plan(before, after).confirmations).toEqual(expected)
  })

  it('AC-1.2 (028) turning one off asks nothing', () => {
    const before = { ...on(), scopes: allOn, sensitive: true, continueHistory: true }
    for (const after of [
      { ...before, scopes: { ...allOn, vault: false } },
      { ...before, scopes: { ...allOn, history: false } },
      { ...before, continueHistory: false }
    ]) {
      expect(plan(before, after).confirmations).toEqual([])
    }
  })

  it('AC-1.2 (028) the vault folder rides only on the Notes scope and continue needs History on', () => {
    const history = plan(on(), { ...on(), scopes: { ...on().scopes, history: true } }).confirmations
    expect(history).toEqual([{ kind: 'scope', scope: 'history' }])
    const noHistory = plan(on(), { ...on(), continueHistory: true })
    expect(noHistory.confirmations).toEqual([])
    expect(noHistory.next.continueHistory).toBe(false)
  })

  it('AC-1.3 (028) every turn-on resets scopes, sensitive and continue and keeps cameras and exclusions', () => {
    const before = { ...defaultRemote(), cameras: ['camera.a'], vaultExcluded: ['Private'] }
    const after = { ...before, enabled: true, scopes: allOn, sensitive: true, continueHistory: true }
    const { confirmations, next } = plan(before, after, ['Pixel'])
    expect(confirmations).toEqual([{ kind: 'enable', dormant: ['Pixel'] }])
    expect(next).toEqual({ ...after, scopes: defaultRemote().scopes, sensitive: false, continueHistory: false })
    expect(next.cameras).toEqual(['camera.a'])
    expect(next.vaultExcluded).toEqual(['Private'])
  })

  it('AC-1.3 (028) turning History off also turns the continue sub-switch off (plan Q3)', () => {
    const before = { ...on(), scopes: { ...on().scopes, history: true }, continueHistory: true }
    const { confirmations, next } = plan(before, { ...before, scopes: { ...before.scopes, history: false } })
    expect(confirmations).toEqual([])
    expect(next.continueHistory).toBe(false)
  })

  it('AC-1.8 (028) excluding a folder asks nothing', () => {
    const before = { ...on(), vaultExcluded: ['Private'] }
    expect(plan(before, { ...before, vaultExcluded: ['Private', 'Work'] }).confirmations).toEqual([])
    expect(plan(defaultRemote(), { ...defaultRemote(), vaultExcluded: ['Work'] }).confirmations).toEqual([])
  })

  it('AC-1.10 (028) removing an exclusion asks, also while remote is off', () => {
    const before = { ...defaultRemote(), vaultExcluded: ['Private', 'Work'] }
    const after = { ...before, vaultExcluded: ['Work'] }
    expect(plan(before, after).confirmations).toEqual([{ kind: 'unexclude', folder: 'Private' }])
    expect(plan({ ...before, enabled: true }, { ...after, enabled: true }).confirmations).toEqual([{ kind: 'unexclude', folder: 'Private' }])
    expect(plan(before, { ...before, vaultExcluded: ['private', 'Work'] }).confirmations).toEqual([])
  })

  it('AC-1.10 (028) a re-spelling of an exclusion (case, slash, backslash) is the same entry and asks nothing', () => {
    const before = { ...defaultRemote(), vaultExcluded: ['Work/Taxes', 'Private'] }
    expect(plan(before, { ...before, vaultExcluded: ['work\\taxes\\', 'Private/'] }).confirmations).toEqual([])
    expect(plan(before, { ...before, vaultExcluded: ['work\\taxes\\'] }).confirmations).toEqual([{ kind: 'unexclude', folder: 'Private' }])
  })
})

describe('the coordinator cannot reach the new keys (spec 028 T5)', () => {
  it('AC-1.4 (028) stripRemotePatch removes a patch carrying any new key and does not mutate', () => {
    for (const remote of [
      { scopes: { vault: true } },
      { scopes: { history: true } },
      { continueHistory: true },
      { vaultExcluded: [] },
      { ...defaultRemote(), vaultExcluded: ['Private'], continueHistory: true }
    ]) {
      const patch = { remote, language: 'es' }
      const copy = structuredClone(patch)
      expect(stripRemotePatch(patch)).toEqual({ language: 'es' })
      expect(patch).toEqual(copy)
    }
    expect(stripRemotePatch({ remote: { vaultExcluded: ['Private'] } })).toEqual({})
  })
})

describe('authorization of the Notes and History routes (spec 028 T6)', () => {
  const device = { deviceId: 'd1' }
  const notes: RouteSpec = { method: 'POST', path: '/api/notes/read', auth: 'session', scope: 'vault', audit: 'change' }
  const list: RouteSpec = { method: 'POST', path: '/api/threads/list', auth: 'session', scope: 'history', audit: 'none' }
  const send: RouteSpec = { method: 'POST', path: '/api/threads/send', auth: 'session', scope: 'history', audit: 'change', continue: true }
  const withScopes = (scopes: Partial<RemoteSettings['scopes']>, rest: Partial<RemoteSettings> = {}): RemoteSettings => ({
    ...defaultRemote(),
    ...rest,
    scopes: { ...defaultRemote().scopes, ...scopes }
  })

  it('AC-7.2 (028) same verdict whatever carries it', () => {
    expect(authorizeRemote.length).toBe(1)
    const input = { device, remote: withScopes({ vault: true }), route: notes }
    expect(authorizeRemote(input)).toEqual(authorizeRemote({ ...input }))
    expect(authorizeRemote(input)).toEqual({ ok: true })
    const sendOn = withScopes({ history: true }, { continueHistory: true })
    expect(authorizeRemote({ device, remote: sendOn, route: send })).toEqual({ ok: true })
  })

  it('AC-1.1 (028) verdicts: Notes off, History off, continue off', () => {
    expect(authorizeRemote({ device, remote: withScopes({ history: true }), route: notes })).toEqual({ ok: false, reason: 'scope-off' })
    expect(authorizeRemote({ device, remote: withScopes({ vault: true }), route: list })).toEqual({ ok: false, reason: 'scope-off' })
    // History on, sub-switch off: list works, send is write-off.
    const readOnly = withScopes({ history: true })
    expect(authorizeRemote({ device, remote: readOnly, route: list })).toEqual({ ok: true })
    expect(authorizeRemote({ device, remote: readOnly, route: send })).toEqual({ ok: false, reason: 'write-off' })
    // The scope is checked before the sub-switch.
    expect(authorizeRemote({ device, remote: withScopes({}, { continueHistory: true }), route: send })).toEqual({ ok: false, reason: 'scope-off' })
  })

  it('AC-1.7 (028) unknown device is unknown-device on every new route', () => {
    for (const route of [notes, list, send]) {
      expect(authorizeRemote({ device: null, remote: withScopes({ vault: true, history: true }, { continueHistory: true }), route })).toEqual({
        ok: false,
        reason: 'unknown-device'
      })
    }
  })

  it('AC-7.2 (028) the new refusals have fixed statuses and byte-identical bodies', () => {
    const expected: [Refusal, number][] = [
      ['write-off', 403],
      ['unavailable', 404],
      ['gone', 404],
      ['unsupported', 415],
      ['run-active', 409]
    ]
    for (const [reason, status] of expected) {
      const response = refusalResponse(reason)
      expect(response.status).toBe(status)
      expect(response.body).toEqual({ error: reason })
      expect(JSON.stringify(refusalResponse(reason))).toBe(JSON.stringify(response))
    }
  })
})

describe('the Notes and History routes (spec 028 T7)', () => {
  const NEW = ROUTES.filter((route) => route.path.startsWith('/api/notes/') || route.path.startsWith('/api/threads/'))
  const valid: Record<string, Record<string, unknown>> = {
    '/api/notes/list': { folder: 'Work' },
    '/api/notes/find': { query: 'plan' },
    '/api/notes/read': { path: 'Work/plan.md' },
    '/api/notes/image': { target: 'img.png', from: 'Work/plan.md' },
    '/api/threads/list': { offset: 0 },
    '/api/threads/read': { id: 't1' },
    '/api/threads/send': { id: 't1', text: 'hi' },
    '/api/threads/stop': { id: 't1' }
  }

  it('AC-7.1 (028) route snapshot declares scope, audit class and a strict schema', () => {
    expect(NEW.map((r) => [r.method, r.path, r.auth, r.scope, r.audit, r.continue ?? false])).toEqual([
      ['POST', '/api/notes/list', 'session', 'vault', 'none', false],
      ['POST', '/api/notes/find', 'session', 'vault', 'none', false],
      ['POST', '/api/notes/read', 'session', 'vault', 'open', false],
      ['POST', '/api/notes/image', 'session', 'vault', 'open', false],
      ['POST', '/api/threads/list', 'session', 'history', 'none', false],
      ['POST', '/api/threads/read', 'session', 'history', 'open', false],
      ['POST', '/api/threads/send', 'session', 'history', 'open', true],
      ['POST', '/api/threads/stop', 'session', 'history', 'open', false]
    ])
    for (const route of NEW) {
      expect(route.body, route.path).toBeDefined()
      expect(route.body?.safeParse(valid[route.path]).success, route.path).toBe(true)
    }
  })

  it('AC-2.7 (028) no write, rename, delete or search route exists', () => {
    expect(NEW.filter((r) => r.path.startsWith('/api/notes/')).map((r) => r.path)).toEqual(['/api/notes/list', '/api/notes/find', '/api/notes/read', '/api/notes/image'])
    expect(ROUTES.filter((r) => /write|save|create|rename|move|delete|trash|search|upload|edit/i.test(r.path))).toEqual([])
    expect(NEW.filter((r) => r.method !== 'POST')).toEqual([])
  })

  it('AC-3.7 (028) no verb besides read, send and stop', () => {
    expect(NEW.filter((r) => r.path.startsWith('/api/threads/')).map((r) => r.path)).toEqual(['/api/threads/list', '/api/threads/read', '/api/threads/send', '/api/threads/stop'])
    expect(ROUTES.filter((r) => /thread/i.test(r.path) && /new|delete|rename|title|retry|regenerate/i.test(r.path))).toEqual([])
  })

  it('AC-2.8 (028) schemas reject missing, non-string, over-long and extra-key bodies', () => {
    const long = (n: number) => 'x'.repeat(n)
    for (const route of NEW) {
      const body = route.body
      const base = valid[route.path]
      expect(body?.safeParse({ ...base, extra: 1 }).success, `${route.path} extra`).toBe(false)
      expect(body?.safeParse(undefined).success, `${route.path} none`).toBe(false)
      for (const key of Object.keys(base)) {
        const { [key]: _gone, ...rest } = base
        expect(body?.safeParse(rest).success, `${route.path} missing ${key}`).toBe(false)
        expect(body?.safeParse({ ...base, [key]: typeof base[key] === 'string' ? 7 : 'x' }).success, `${route.path} wrong type ${key}`).toBe(false)
      }
    }
    const parse = (path: string, value: unknown) => NEW.find((r) => r.path === path)?.body?.safeParse(value).success
    expect(parse('/api/notes/list', { folder: '' })).toBe(true)
    expect(parse('/api/notes/list', { folder: long(1024) })).toBe(true)
    expect(parse('/api/notes/list', { folder: long(1025) })).toBe(false)
    expect(parse('/api/notes/find', { query: long(200) })).toBe(true)
    expect(parse('/api/notes/find', { query: long(201) })).toBe(false)
    expect(parse('/api/notes/image', { target: 'a', from: long(1025) })).toBe(false)
    expect(parse('/api/threads/send', { id: 't1', text: long(REMOTE_LIMITS.chatChars) })).toBe(true)
    expect(parse('/api/threads/send', { id: 't1', text: long(REMOTE_LIMITS.chatChars + 1) })).toBe(false)
    expect(parse('/api/threads/read', { id: '' })).toBe(false)
    expect(parse('/api/threads/read', { id: long(65) })).toBe(false)
    expect(parse('/api/threads/read', { id: 't1', before: 3, since: 2, wait: true })).toBe(true)
    expect(parse('/api/threads/read', { id: 't1', before: -1 })).toBe(false)
    expect(parse('/api/threads/read', { id: 't1', wait: 'yes' })).toBe(false)
    expect(parse('/api/threads/list', { offset: -1 })).toBe(false)
    expect(parse('/api/threads/list', { offset: 1.5 })).toBe(false)
  })
})

describe('the status the phone reads (spec 028 T8)', () => {
  it('AC-6.11 (028) status returns exactly these keys', () => {
    const remote: RemoteSettings = {
      ...defaultRemote(),
      enabled: true,
      scopes: allOn,
      sensitive: true,
      continueHistory: true,
      cameras: ['camera.secret-garage'],
      vaultExcluded: ['Private/Taxes'],
      agentId: 'secret-agent'
    }
    const view = statusView(remote)
    expect(Object.keys(view).sort()).toEqual(['continue', 'scopes', 'sensitive'])
    expect(Object.keys(view.scopes).sort()).toEqual(['approve', 'cameras', 'chat', 'history', 'home', 'vault'])
    expect(view).toEqual({ scopes: allOn, sensitive: true, continue: true })
    const text = JSON.stringify(view)
    for (const secret of ['camera.secret-garage', 'Private', 'secret-agent', 'tailscale']) expect(text).not.toContain(secret)
  })

  it('AC-6.11 (028) the sub-switch counts only while History is on', () => {
    const remote = { ...defaultRemote(), continueHistory: true }
    expect(statusView(remote).continue).toBe(false)
    expect(statusView({ ...remote, scopes: { ...remote.scopes, history: true } }).continue).toBe(true)
  })
})

describe('PC dictionary keys of spec 028 (T10)', () => {
  const KEYS = [
    'remote.scope.vault',
    'remote.scope.history',
    'remote.scope.history.continue',
    'remote.scope.history.continue.hint',
    'main.remote.continue',
    'main.remote.unexclude',
    'main.remote.scope.vaultDetail',
    'remote.vault.exclude',
    'remote.vault.exclude.none',
    'remote.vault.exclude.stale'
  ]

  it('AC-1.2 (028) every PC key of the spec exists in both dictionaries', () => {
    for (const key of KEYS) {
      expect(Object.hasOwn(es, key), `es ${key}`).toBe(true)
      expect(Object.hasOwn(en, key), `en ${key}`).toBe(true)
    }
  })
})
