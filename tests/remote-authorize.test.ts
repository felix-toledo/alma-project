import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod/v4'
import { ROUTES, type RouteSpec, sessionChallengeBody } from '../src/shared/remote/api'
import { authorizeRemote, stepUpRequired } from '../src/shared/remote/authorize'
import { defaultRemote } from '../src/shared/remote/settings'
import type { RemoteSettings } from '../src/shared/types'

const bodyOf = (path: string): ZodType => {
  const body = ROUTES.find((r) => r.path === path)?.body
  if (!body) throw new Error(`no body schema for ${path}`)
  return body
}

describe('remote API contracts (spec 026 T6)', () => {
  it('AC-3.6 the route table is the closed list', () => {
    expect(ROUTES.map((r) => [r.method, r.path, r.auth, r.scope ?? null, r.audit, r.sensitive ?? false])).toEqual([
      ['GET', '/api/hello', 'none', null, 'none', false],
      ['POST', '/api/pair/request', 'pairing', null, 'change', false],
      ['GET', '/api/pair/status', 'pairing', null, 'none', false],
      ['POST', '/api/pair/passkey', 'pairing', null, 'change', false],
      ['POST', '/api/session/challenge', 'none', null, 'none', false],
      ['POST', '/api/session', 'none', null, 'none', false],
      ['GET', '/api/state', 'session', ['chat', 'approve'], 'none', false],
      ['POST', '/api/chat/send', 'session', 'chat', 'change', false],
      ['POST', '/api/chat/new', 'session', 'chat', 'change', false],
      ['POST', '/api/chat/stop', 'session', 'chat', 'change', false],
      ['GET', '/api/approvals', 'session', 'approve', 'none', false],
      ['POST', '/api/approvals/answer', 'session', 'approve', 'change', false],
      ['GET', '/api/home/things', 'session', 'home', 'none', false],
      ['POST', '/api/stepup/challenge', 'session', 'home', 'none', true],
      ['POST', '/api/home/control', 'session', 'home', 'change', false],
      ['GET', '/api/cameras', 'session', 'cameras', 'none', false],
      ['GET', '/api/cameras/still', 'session', 'cameras', 'picture', false],
      ['GET', '/api/push/key', 'session', null, 'none', false],
      ['POST', '/api/push/subscribe', 'session', null, 'none', false],
      ['DELETE', '/api/push', 'session', null, 'none', false],
      ['POST', '/api/pong', 'session', null, 'none', false],
      ['POST', '/api/forget', 'session', null, 'change', false],
      ['GET', '/api/status', 'session', null, 'none', false],
      ['POST', '/api/notes/list', 'session', 'vault', 'none', false],
      ['POST', '/api/notes/find', 'session', 'vault', 'none', false],
      ['POST', '/api/notes/read', 'session', 'vault', 'open', false],
      ['POST', '/api/notes/image', 'session', 'vault', 'open', false],
      ['POST', '/api/threads/list', 'session', 'history', 'none', false],
      ['POST', '/api/threads/read', 'session', 'history', 'open', false],
      ['POST', '/api/threads/send', 'session', 'history', 'open', false],
      ['POST', '/api/threads/stop', 'session', 'history', 'open', false]
    ])
  })

  it('AC-5.4 malformed bodies are rejected by their schemas and valid ones pass', () => {
    const chat = bodyOf('/api/chat/send')
    expect(chat.safeParse({ text: 'x'.repeat(8000) }).success).toBe(true)
    expect(chat.safeParse({ text: 'x'.repeat(8001) }).success).toBe(false)
    expect(chat.safeParse({ text: 'hi', extra: 1 }).success).toBe(false)
    expect(chat.safeParse({ text: 7 }).success).toBe(false)
    expect(chat.safeParse({}).success).toBe(false)
    const answer = bodyOf('/api/approvals/answer')
    expect(answer.safeParse({ id: 'a', decision: 'allow' }).success).toBe(true)
    expect(answer.safeParse({ id: 'a', decision: 'deny' }).success).toBe(true)
    expect(answer.safeParse({ id: 'a', decision: 'always' }).success).toBe(false)
    expect(answer.safeParse({ id: 'a', decision: 'allow', extra: 1 }).success).toBe(false)
    const coord = 'x'.repeat(43)
    const key = { kty: 'EC', crv: 'P-256', x: coord, y: coord }
    const request = bodyOf('/api/pair/request')
    expect(request.safeParse({ secret: 's'.repeat(43), phonePublicKey: key }).success).toBe(true)
    expect(request.safeParse({ secret: 's'.repeat(43), phonePublicKey: { ...key, key_ops: ['verify'], ext: true } }).success).toBe(true)
    expect(request.safeParse({ secret: 'short', phonePublicKey: key }).success).toBe(false)
    expect(request.safeParse({ secret: 's'.repeat(43), phonePublicKey: { ...key, x: 'short' } }).success).toBe(false)
    expect(request.safeParse({ secret: 's'.repeat(43), phonePublicKey: { ...key, crv: 'P-384' } }).success).toBe(false)
    expect(request.safeParse({ secret: 's'.repeat(43), phonePublicKey: key, extra: 1 }).success).toBe(false)
    const passkey = bodyOf('/api/pair/passkey')
    const attestation = { offer: 's'.repeat(43), pcNonce: 'n'.repeat(22), attestationObject: 'aGVsbG8', clientDataJSON: 'e30' }
    expect(passkey.safeParse(attestation).success).toBe(true)
    expect(passkey.safeParse({ ...attestation, pcNonce: 'short' }).success).toBe(false)
    expect(passkey.safeParse({ ...attestation, offer: 'short' }).success).toBe(false)
    expect(passkey.safeParse({ ...attestation, attestationObject: 7 }).success).toBe(false)
    expect(passkey.safeParse({ ...attestation, extra: 1 }).success).toBe(false)
  })
})

describe('remote authorization (spec 026 T7)', () => {
  const routeOf = (path: string): RouteSpec => {
    const found = ROUTES.find((r) => r.path === path)
    if (!found) throw new Error(`no route ${path}`)
    return found
  }
  const device = { deviceId: 'd1' }
  const withScopes = (scopes: Partial<RemoteSettings['scopes']>): RemoteSettings => ({ ...defaultRemote(), scopes: { ...defaultRemote().scopes, ...scopes } })

  it('AC-3.2 the verdict depends only on device, settings and route, never on a transport', () => {
    expect(authorizeRemote.length).toBe(1)
    const input = { device, remote: withScopes({ chat: true }), route: routeOf('/api/chat/send') }
    expect(authorizeRemote(input)).toEqual(authorizeRemote({ ...input }))
    expect(authorizeRemote(input)).toEqual({ ok: true })
  })

  it('AC-5.1 an enabled scope runs and a disabled one is refused, for every scope and route', () => {
    const cases = [
      ['/api/chat/send', 'chat'],
      ['/api/approvals/answer', 'approve'],
      ['/api/home/control', 'home'],
      ['/api/cameras/still', 'cameras']
    ] as const
    for (const [path, scope] of cases) {
      const route = routeOf(path)
      const isStill = path === '/api/cameras/still'
      const remote = isStill ? { ...withScopes({ cameras: true }), cameras: ['camera.a'] } : withScopes({ [scope]: true })
      const cameraId = isStill ? { cameraId: 'camera.a' } : {}
      expect(authorizeRemote({ device, remote, route, ...cameraId })).toEqual({ ok: true })
      expect(authorizeRemote({ device, remote: withScopes({}), route, ...cameraId })).toEqual({ ok: false, reason: 'scope-off' })
    }
  })

  it('AC-5.1 the state route opens with either chat or approve', () => {
    const route = routeOf('/api/state')
    expect(authorizeRemote({ device, remote: withScopes({ chat: true }), route })).toEqual({ ok: true })
    expect(authorizeRemote({ device, remote: withScopes({ approve: true }), route })).toEqual({ ok: true })
    expect(authorizeRemote({ device, remote: withScopes({ chat: true, approve: true }), route })).toEqual({ ok: true })
    expect(authorizeRemote({ device, remote: withScopes({}), route })).toEqual({ ok: false, reason: 'scope-off' })
  })

  it('AC-5.1 session routes without a scope need no scope: only the device', () => {
    for (const path of ['/api/push/key', '/api/push/subscribe', '/api/push', '/api/pong', '/api/status', '/api/forget'] as const) {
      expect(authorizeRemote({ device, remote: withScopes({}), route: routeOf(path) })).toEqual({ ok: true })
    }
  })

  it('AC-5.9 with the approve scope off approvals are hidden', () => {
    const remote = withScopes({ chat: true })
    expect(authorizeRemote({ device, remote, route: routeOf('/api/approvals') })).toEqual({ ok: false, reason: 'scope-off' })
    expect(authorizeRemote({ device, remote, route: routeOf('/api/approvals/answer') })).toEqual({ ok: false, reason: 'scope-off' })
  })

  it('AC-5.12 the step-up route needs the locks-and-alarms sub-switch on', () => {
    const route = routeOf('/api/stepup/challenge')
    expect(authorizeRemote({ device, remote: { ...withScopes({ home: true }), sensitive: false }, route })).toEqual({ ok: false, reason: 'sensitive-off' })
    expect(authorizeRemote({ device, remote: { ...withScopes({ home: true }), sensitive: true }, route })).toEqual({ ok: true })
    expect(authorizeRemote({ device, remote: { ...withScopes({}), sensitive: true }, route })).toEqual({ ok: false, reason: 'scope-off' })
  })

  it('AC-5.20 only unlock, open and disarm need a step-up', () => {
    for (const action of ['unlock', 'open', 'disarm'] as const) expect(stepUpRequired(action)).toBe(true)
    for (const action of ['lock', 'close', 'arm_home', 'arm_away', 'trigger'] as const) expect(stepUpRequired(action)).toBe(false)
  })

  it('AC-5.22 only allow-listed cameras are served', () => {
    const route = routeOf('/api/cameras/still')
    const remote = { ...withScopes({ cameras: true }), cameras: ['camera.kitchen'] }
    expect(authorizeRemote({ device, remote, route, cameraId: 'camera.kitchen' })).toEqual({ ok: true })
    expect(authorizeRemote({ device, remote, route, cameraId: 'camera.yard' })).toEqual({ ok: false, reason: 'camera-not-allowed' })
    expect(authorizeRemote({ device, remote: withScopes({}), route, cameraId: 'camera.kitchen' })).toEqual({ ok: false, reason: 'scope-off' })
  })

  it('AC-5.3 a session route without a device is refused; open and pairing routes do not need one', () => {
    expect(authorizeRemote({ device: null, remote: withScopes({ chat: true }), route: routeOf('/api/chat/send') })).toEqual({ ok: false, reason: 'unknown-device' })
    expect(authorizeRemote({ device: null, remote: defaultRemote(), route: routeOf('/api/hello') })).toEqual({ ok: true })
    expect(authorizeRemote({ device: null, remote: defaultRemote(), route: routeOf('/api/pair/request') })).toEqual({ ok: true })
  })

  it('AC-6.6 no route acts on another device', () => {
    const touchesOtherDevice = (routes: readonly RouteSpec[]): string[] =>
      routes
        .filter((r) => r.auth === 'session' && r.path.includes(':'))
        .map((r) => r.path)
        .concat(
          routes
            .filter((r) => {
              const shape = (r.body as unknown as { shape?: Record<string, unknown> } | undefined)?.shape
              return r.auth === 'session' && shape !== undefined && Object.hasOwn(shape, 'deviceId')
            })
            .map((r) => r.path)
        )
    expect(touchesOtherDevice(ROUTES)).toEqual([])
    expect(ROUTES.every((r) => !r.path.includes(':'))).toBe(true)
    // Negative fixtures: a session route naming a device, or a path parameter, is flagged.
    const fakes: readonly RouteSpec[] = [
      { method: 'POST', path: '/api/fake', auth: 'session', audit: 'none', body: sessionChallengeBody },
      { method: 'GET', path: '/api/devices/:id', auth: 'session', audit: 'none' }
    ]
    expect(touchesOtherDevice(fakes)).toEqual(['/api/devices/:id', '/api/fake'])
  })
})
