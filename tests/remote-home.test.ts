import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { needsStepUp, StepUpFlow } from '../src/coordinator/channels/remote/stepup'
import { ToolError } from '../src/coordinator/tools/types'
import { initAudit } from '../src/shared/audit'
import { translate } from '../src/shared/i18n/messages'
import type { RemoteResponse } from '../src/shared/remote/api'
import { b64u } from '../src/shared/remote/crypto'
import { HOST, openSession, pairDevice, testChannel, type Harness } from './support/remote-harness'
import { fakeAssertion, fakeCredential } from './support/webauthn-fake'

const HOST_NAME = 'alma-test.ts.net'
const ORIGIN = `https://${HOST_NAME}`

async function withPasskey(t: Harness, counter = 5) {
  const { deviceId, privateKey } = await pairDevice(t)
  const credential = await fakeCredential()
  await t.store.setPasskey(deviceId, {
    credentialId: b64u.encode(credential.credentialId),
    publicKey: credential.publicKey,
    counter
  })
  return { deviceId, privateKey, credential }
}

async function assertionFor(
  credential: Awaited<ReturnType<typeof fakeCredential>>,
  challenge: string,
  counter: number
) {
  const made = await fakeAssertion(credential, {
    challenge: b64u.decode(challenge),
    origin: ORIGIN,
    rpId: HOST_NAME,
    counter
  })
  return {
    authenticatorData: b64u.encode(made.authenticatorData),
    clientDataJSON: b64u.encode(made.clientDataJSON),
    signature: b64u.encode(made.signature)
  }
}

describe('remote step-up (spec 026 T19)', () => {
  let now = 0

  async function served(remote?: NonNullable<Parameters<typeof testChannel>[0]>['remote']): Promise<Harness> {
    now = 0
    const t = await testChannel({ remote: { enabled: true, ...remote } })
    await t.state.update({ hostName: HOST_NAME })
    await t.channel.sync()
    return t
  }

  function flowOf(t: Harness): StepUpFlow {
    return new StepUpFlow({ store: t.store, state: t.state, now: () => now, random: (n) => new Uint8Array(n).fill(3) })
  }

  function setT(t: Harness, next: number): void {
    now = next
    t.setNow(next)
  }

  it('AC-5.20 unlock, open and disarm need step-up; the rest, and nothing unknown, does not slip through', () => {
    for (const action of ['unlock', 'open', 'disarm']) expect(needsStepUp(action), action).toBe(true)
    for (const action of ['lock', 'close', 'arm_home', 'arm_away', 'trigger', 'silence', 'stop', 'set-position']) {
      expect(needsStepUp(action), action).toBe(false)
    }
    expect(needsStepUp('toggle')).toBe(true)
    expect(needsStepUp('')).toBe(true)
  })

  it('AC-5.13 opening needs a valid assertion bound to this device, thing and action', async () => {
    const t = await served()
    const flow = flowOf(t)
    const { deviceId, credential } = await withPasskey(t)
    const issued = flow.issue(deviceId, 'lock.front_door', 'unlock')
    if (!('challenge' in issued)) throw new Error('issue failed')
    const verified = await flow.verify(deviceId, 'lock.front_door', 'unlock', await assertionFor(credential, issued.challenge, 6))
    expect(verified).toEqual({ ok: true })
    expect(t.store.devices().find((known) => known.id === deviceId)?.passkey?.counter).toBe(6)
  })

  it('AC-5.13 wrong thing, action, device, replay, stale challenge and counter regress are refused', async () => {
    const t = await served()
    const flow = flowOf(t)
    const { deviceId, credential } = await withPasskey(t)
    const other = await pairDevice(t, 'other')
    async function fresh(counter = 6) {
      const issued = flow.issue(deviceId, 'lock.front_door', 'unlock')
      if (!('challenge' in issued)) throw new Error('issue failed')
      return { challenge: issued.challenge, assertion: await assertionFor(credential, issued.challenge, counter) }
    }
    const thing = await fresh()
    expect(await flow.verify(deviceId, 'lock.back_door', 'unlock', thing.assertion)).toEqual({ ok: false })
    const action = await fresh()
    expect(await flow.verify(deviceId, 'lock.front_door', 'lock', action.assertion)).toEqual({ ok: false })
    const who = await fresh()
    expect(await flow.verify(other.deviceId, 'lock.front_door', 'unlock', who.assertion)).toEqual({ ok: false })
    const replay = await fresh()
    expect(await flow.verify(deviceId, 'lock.front_door', 'unlock', replay.assertion)).toEqual({ ok: true })
    expect(await flow.verify(deviceId, 'lock.front_door', 'unlock', replay.assertion)).toEqual({ ok: false })
    const regress = await fresh(5)
    expect(await flow.verify(deviceId, 'lock.front_door', 'unlock', regress.assertion)).toEqual({ ok: false })
    expect(t.store.devices().find((known) => known.id === deviceId)?.passkey?.counter).toBe(6)

    const t2 = await served()
    const flow2 = flowOf(t2)
    const second = await withPasskey(t2)
    const late = flow2.issue(second.deviceId, 'lock.front_door', 'unlock')
    if (!('challenge' in late)) throw new Error('issue failed')
    setT(t2, 61_000)
    const stale = await assertionFor(second.credential, late.challenge, 6)
    expect(await flow2.verify(second.deviceId, 'lock.front_door', 'unlock', stale)).toEqual({ ok: false })
    expect(t2.store.devices().find((known) => known.id === second.deviceId)?.passkey?.counter).toBe(5)
  })

  it('AC-5.13 the challenge lives at 60 seconds and dies right after', async () => {
    const t = await served()
    const flow = flowOf(t)
    const { deviceId, credential } = await withPasskey(t)
    const first = flow.issue(deviceId, 'lock.front_door', 'unlock')
    if (!('challenge' in first)) throw new Error('issue failed')
    setT(t, 60_000)
    expect(await flow.verify(deviceId, 'lock.front_door', 'unlock', await assertionFor(credential, first.challenge, 6))).toEqual({ ok: true })
    const second = flow.issue(deviceId, 'lock.front_door', 'unlock')
    if (!('challenge' in second)) throw new Error('issue failed')
    setT(t, 120_001)
    expect(await flow.verify(deviceId, 'lock.front_door', 'unlock', await assertionFor(credential, second.challenge, 7))).toEqual({ ok: false })
  })

  it('AC-5.14 a failed step-up runs nothing and burns the challenge', async () => {
    const t = await served()
    const flow = flowOf(t)
    const { deviceId, credential } = await withPasskey(t)
    const issued = flow.issue(deviceId, 'lock.front_door', 'unlock')
    if (!('challenge' in issued)) throw new Error('issue failed')
    const good = await assertionFor(credential, issued.challenge, 6)
    const broken = Uint8Array.from(b64u.decode(good.signature))
    broken[broken.length - 1] = broken[broken.length - 1] === 0 ? 1 : 0
    expect(await flow.verify(deviceId, 'lock.front_door', 'unlock', { ...good, signature: b64u.encode(broken) })).toEqual({ ok: false })
    expect(await flow.verify(deviceId, 'lock.front_door', 'unlock', good)).toEqual({ ok: false })
    expect(t.store.devices().find((known) => known.id === deviceId)?.passkey?.counter).toBe(5)
  })

  it('AC-5.20 through the channel, lock needs no challenge and unlock gets one', async () => {
    const t = await served({ scopes: { chat: false, approve: false, home: true, cameras: false, vault: false, history: false }, sensitive: true })
    const { deviceId, privateKey } = await pairDevice(t)
    const credential = await fakeCredential()
    await t.store.setPasskey(deviceId, { credentialId: 'c', publicKey: credential.publicKey, counter: 0 })
    const token = await openSession(t, deviceId, privateKey)
    const headers = { ...HOST, authorization: `Bearer ${token}` }
    const lock = await t.transport.request({ method: 'POST', path: '/api/stepup/challenge', headers, body: { thing: 'lock.front_door', action: 'lock' } })
    expect(lock.status).toBe(400)
    const unlock = await t.transport.request({ method: 'POST', path: '/api/stepup/challenge', headers, body: { thing: 'lock.front_door', action: 'unlock' } })
    expect(unlock.status).toBe(200)
    expect(Object.keys(unlock.body as Record<string, unknown>)).toEqual(['challenge'])
  })

  it('AC-5.21 a device without a passkey cannot open or disarm', async () => {
    const t = await served()
    const flow = flowOf(t)
    const { deviceId } = await pairDevice(t)
    expect(flow.issue(deviceId, 'lock.front_door', 'unlock')).toEqual({ error: 'no-passkey' })
    const credential = await fakeCredential()
    const made = await fakeAssertion(credential, { challenge: new Uint8Array(32).fill(3), origin: ORIGIN, rpId: HOST_NAME, counter: 1 })
    expect(
      await flow.verify(deviceId, 'lock.front_door', 'unlock', {
        authenticatorData: b64u.encode(made.authenticatorData),
        clientDataJSON: b64u.encode(made.clientDataJSON),
        signature: b64u.encode(made.signature)
      })
    ).toEqual({ ok: false })
  })
})

function homeBody(res: RemoteResponse): { things?: unknown[]; areas?: unknown[]; state?: string; note?: string; error?: string } {
  return res.body as { things?: unknown[]; areas?: unknown[]; state?: string; note?: string; error?: string }
}

function toolEntries(dataDir: string): Record<string, unknown>[] {
  const month = new Date().toISOString().slice(0, 7)
  const file = join(dataDir, 'audit', `coordinator-${month}.jsonl`)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

describe('T23 direct house control (AC-5.10, 5.12, 5.13, 5.18, 5.20, 7.7)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function servedHome(
    sensitive = false,
    passkey = false
  ): Promise<{ t: Harness; headers: Record<string, string>; deviceId: string; credential?: Awaited<ReturnType<typeof fakeCredential>> }> {
    const t = await testChannel({
      remote: {
        enabled: true,
        sensitive,
        scopes: { chat: false, approve: true, home: true, cameras: false, vault: false, history: false }
      }
    })
    await t.state.update({ hostName: HOST_NAME })
    await t.channel.sync()
    if (!passkey) {
      const { deviceId, privateKey } = await pairDevice(t)
      const token = await openSession(t, deviceId, privateKey)
      return { t, headers: { ...HOST, authorization: `Bearer ${token}` }, deviceId }
    }
    const { deviceId, privateKey, credential } = await withPasskey(t)
    const token = await openSession(t, deviceId, privateKey)
    return { t, headers: { ...HOST, authorization: `Bearer ${token}` }, deviceId, credential }
  }

  async function control(
    t: Harness,
    headers: Record<string, string>,
    body: Record<string, unknown>
  ): Promise<RemoteResponse> {
    return t.transport.request({ method: 'POST', path: '/api/home/control', headers, body })
  }

  async function steppedUp(
    t: Harness,
    headers: Record<string, string>,
    credential: Awaited<ReturnType<typeof fakeCredential>>,
    counter: number,
    thing: string,
    action: string
  ) {
    const issued = await t.transport.request({ method: 'POST', path: '/api/stepup/challenge', headers, body: { thing, action } })
    expect(issued.status).toBe(200)
    return assertionFor(credential, (issued.body as { challenge: string }).challenge, counter)
  }

  it('AC-5.10: una luz se controla con home_control, riesgo home, sin preguntar', async () => {
    const { t, headers } = await servedHome()
    const res = await control(t, headers, { thing: 'light.techo', action: 'on' })
    expect(res.status).toBe(200)
    expect(t.home.calls).toEqual([{ entityId: 'light.techo', service: 'light/turn_on', data: {} }])
    expect(t.approvals.broker.pending()).toEqual([])
    expect(t.approvals.events.some((event) => event.type === 'approval.request')).toBe(false)
    expect(homeBody(res).state).toContain('on')
  })

  it('AC-5.10: lo cotidiano rechaza una cerradura y apunta al control seguro', async () => {
    const { t, headers } = await servedHome()
    const res = await control(t, headers, { thing: 'lock.puerta', action: 'on' })
    expect(res.status).toBe(400)
    expect(homeBody(res).note).toContain('home_secure_control')
    expect(t.home.calls).toEqual([])
  })

  it.each([
    ['lock.puerta', 'unlock'],
    ['cover.porton', 'open'],
    ['alarm.casa', 'disarm'],
    ['siren.patio', 'trigger']
  ])('AC-5.12: %s %s con el sub-switch apagado da 403 sensitive-off', async (thing, action) => {
    const { t, headers } = await servedHome(false)
    const res = await control(t, headers, { thing, action })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'sensitive-off' })
    expect(t.home.calls).toEqual([])
  })

  it('AC-5.13: abrir sin step-up válido da 403 step-up-required', async () => {
    const { t, headers } = await servedHome(true)
    const missing = await control(t, headers, { thing: 'lock.puerta', action: 'unlock' })
    expect(missing.status).toBe(403)
    expect(missing.body).toEqual({ error: 'step-up-required' })
    const bogus = await control(t, headers, { thing: 'lock.puerta', action: 'unlock', assertion: { nope: true } })
    expect(bogus.status).toBe(403)
    expect(bogus.body).toEqual({ error: 'step-up-required' })
    expect(t.home.calls).toEqual([])
  })

  it('AC-5.13/5.20: con step-up válido se pide aprobación en el teléfono (dos confirmaciones)', async () => {
    const { t, headers, credential } = await servedHome(true, true)
    if (!credential) throw new Error('sin passkey en el test')
    const assertion = await steppedUp(t, headers, credential, 6, 'lock.puerta', 'unlock')
    const pending = control(t, headers, { thing: 'lock.puerta', action: 'unlock', assertion })
    await vi.waitFor(() => expect(t.approvals.broker.pending()).toHaveLength(1))
    const [approval] = t.approvals.broker.pending()
    expect(approval?.threadId).toBe('remote')
    expect(approval?.toolName).toBe('home_secure_control')
    const answer = await t.transport.request({
      method: 'POST',
      path: '/api/approvals/answer',
      headers,
      body: { id: approval?.approvalId, decision: 'allow' }
    })
    expect(answer.status).toBe(200)
    const res = await pending
    expect(res.status).toBe(200)
    expect(t.home.calls).toEqual([{ entityId: 'lock.puerta', service: 'lock/unlock', data: {} }])
  })

  it('AC-5.20: lock no pide step-up pero sí aprobación', async () => {
    const { t, headers } = await servedHome(true)
    const pending = control(t, headers, { thing: 'lock.puerta', action: 'lock' })
    await vi.waitFor(() => expect(t.approvals.broker.pending()).toHaveLength(1))
    const [approval] = t.approvals.broker.pending()
    await t.transport.request({
      method: 'POST',
      path: '/api/approvals/answer',
      headers,
      body: { id: approval?.approvalId, decision: 'allow' }
    })
    const res = await pending
    expect(res.status).toBe(200)
    expect(t.home.calls).toEqual([{ entityId: 'lock.puerta', service: 'lock/lock', data: {} }])
  })

  it('AC-5.18: en modo bloqueado se rechaza con la nota existente', async () => {
    const { t, headers } = await servedHome()
    t.setApprovalMode('blocked')
    const res = await control(t, headers, { thing: 'light.techo', action: 'on' })
    expect(res.status).toBe(403)
    expect(homeBody(res)).toMatchObject({ error: 'denied', note: 'Bloqueado por el modo de aprobación' })
    expect(t.home.calls).toEqual([])
  })

  it('AC-7.7: un control deja dos entradas (la del tool y la remote con deviceId)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'alma-remote-home-audit-'))
    dirs.push(dataDir)
    initAudit(dataDir, 'coordinator')
    const { t, headers, deviceId } = await servedHome()
    const res = await control(t, headers, { thing: 'light.techo', action: 'on' })
    expect(res.status).toBe(200)
    const tool = toolEntries(dataDir).filter((entry) => entry['target'] === 'home_control')
    expect(tool).toHaveLength(1)
    expect(tool[0]).toMatchObject({ action: 'tool.run', actor: 'agent', outcome: 'ok' })
    expect(t.records).toEqual([
      { action: 'remote.home.control', actor: 'remote', target: 'light.techo', outcome: 'ok', detail: { deviceId } }
    ])
  })

  it('AC-5.10: casa apagada o desconectada devuelve los mensajes existentes', async () => {
    const { t, headers } = await servedHome()
    t.home.enabled = false
    const off = await control(t, headers, { thing: 'light.techo', action: 'on' })
    expect(off.status).toBe(503)
    expect(homeBody(off).note).toBe(translate('es', 'tool.home.off'))
    t.home.enabled = true
    t.home.ready = false
    t.home.engineState = 'missing'
    const down = await control(t, headers, { thing: 'light.techo', action: 'on' })
    expect(down.status).toBe(503)
    expect(homeBody(down).note).toBe(translate('es', 'tool.home.notConnected', { status: 'missing' }))
    expect(t.home.calls).toEqual([])
  })

  it('T23: /api/home/things lista con el flag sensible', async () => {
    const { t, headers } = await servedHome()
    const res = await t.transport.request({ method: 'GET', path: '/api/home/things', headers })
    expect(res.status).toBe(200)
    expect(homeBody(res).things).toEqual([
      { id: 'l1', entityId: 'light.techo', name: 'Luz techo', kind: 'light', areaId: 'cocina', state: 'off', sensitive: false },
      { id: 'k1', entityId: 'lock.puerta', name: 'Puerta', kind: 'lock', areaId: null, state: 'locked', sensitive: true },
      { id: 'g1', entityId: 'cover.porton', name: 'Portón', kind: 'cover', areaId: null, state: 'closed', sensitive: true },
      { id: 'b1', entityId: 'cover.persiana', name: 'Persiana', kind: 'cover', areaId: null, state: 'open', sensitive: false },
      { id: 'a1', entityId: 'alarm.casa', name: 'Alarma', kind: 'alarm', areaId: null, state: 'disarmed', sensitive: true },
      { id: 's1', entityId: 'siren.patio', name: 'Sirena', kind: 'alarm', areaId: null, state: 'idle', sensitive: true },
      { id: 'c1', entityId: 'camera.patio', name: 'Cámara patio', kind: 'camera', areaId: null, state: 'idle', sensitive: false },
      { id: 'c2', entityId: 'camera.techo', name: 'Cámara techo', kind: 'camera', areaId: null, state: 'idle', sensitive: false }
    ])
    expect(homeBody(res).areas).toEqual([{ id: 'cocina', name: 'Cocina' }])
  })
})

function stillBody(res: RemoteResponse): { cameras?: unknown[]; photo?: string; mediaType?: string; note?: string; error?: string } {
  return res.body as { cameras?: unknown[]; photo?: string; mediaType?: string; note?: string; error?: string }
}

describe('T24 cameras (AC-5.11, 5.19, 5.22, 5.23, 7.1, BR-26)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function servedCameras(cameras: string[] = ['camera.patio']): Promise<{ t: Harness; headers: Record<string, string>; deviceId: string }> {
    const t = await testChannel({
      remote: {
        enabled: true,
        cameras,
        scopes: { chat: false, approve: true, home: false, cameras: true, vault: false, history: false }
      }
    })
    await t.channel.sync()
    const { deviceId, privateKey } = await pairDevice(t)
    const token = await openSession(t, deviceId, privateKey)
    return { t, headers: { ...HOST, authorization: `Bearer ${token}` }, deviceId }
  }

  async function answerFirst(t: Harness, headers: Record<string, string>): Promise<void> {
    await vi.waitFor(() => expect(t.approvals.broker.pending()).toHaveLength(1))
    const [approval] = t.approvals.broker.pending()
    expect(approval?.threadId).toBe('remote')
    expect(approval?.toolName).toBe('camera_look')
    const answer = await t.transport.request({
      method: 'POST',
      path: '/api/approvals/answer',
      headers,
      body: { id: approval?.approvalId, decision: 'allow' }
    })
    expect(answer.status).toBe(200)
  }

  it('AC-5.22: solo las cámaras de la lista se ven y se piden', async () => {
    const { t, headers } = await servedCameras(['camera.patio'])
    const list = await t.transport.request({ method: 'GET', path: '/api/cameras', headers })
    expect(list.status).toBe(200)
    expect(stillBody(list).cameras).toEqual([{ id: 'c1', entityId: 'camera.patio', name: 'Cámara patio', state: 'idle' }])
    const other = await t.transport.request({ method: 'GET', path: '/api/cameras/still', query: 'id=camera.techo', headers })
    expect(other.status).toBe(403)
    expect(other.body).toEqual({ error: 'camera-not-allowed' })
    expect(t.home.snapshotCalls).toEqual([])
  })

  it('AC-5.22: lista vacía → nada; id de no-cámara → inválido', async () => {
    const empty = await servedCameras([])
    const list = await empty.t.transport.request({ method: 'GET', path: '/api/cameras', headers: empty.headers })
    expect(stillBody(list).cameras).toEqual([])
    const listed = await servedCameras(['light.techo'])
    const res = await listed.t.transport.request({ method: 'GET', path: '/api/cameras/still', query: 'id=light.techo', headers: listed.headers })
    expect(res.status).toBe(400)
    expect(stillBody(res).note).toBeTruthy()
    expect(listed.t.home.snapshotCalls).toEqual([])
  })

  it('AC-5.23: 2 MB pasan, 2 MB + 1 se rehúsan y nada se envía', async () => {
    const { t, headers } = await servedCameras()
    t.setAlwaysAllowTools(['camera_look'])
    t.home.snapshotBytes = Buffer.alloc(2 * 1024 * 1024, 7)
    const ok = await t.transport.request({ method: 'GET', path: '/api/cameras/still', query: 'id=camera.patio', headers })
    expect(ok.status).toBe(200)
    expect(stillBody(ok).photo).toBe(t.home.snapshotBytes.toString('base64'))
    t.home.snapshotBytes = Buffer.alloc(2 * 1024 * 1024 + 1, 7)
    const big = await t.transport.request({ method: 'GET', path: '/api/cameras/still', query: 'id=camera.patio', headers })
    expect(big.status).toBe(413)
    expect(big.body).toEqual({ error: 'too-large' })
    // An oversize picture is refused, not audited (BR-30: only the four failure classes are).
    expect(t.records.filter((entry) => entry.action === 'remote.camera.still')).toHaveLength(1)
  })

  it('AC-5.11: nada se guarda (saveStill truena si se toca) y los bytes vienen del snapshot', async () => {
    // The row suggests spying on node:fs writes, which vitest refuses under ESM
    // ("Module namespace is not configurable"); the throwing saveStill plus the empty
    // inbox prove the same more directly: the picture is seen in transit only.
    const { t, headers } = await servedCameras()
    t.setAlwaysAllowTools(['camera_look'])
    t.home.snapshotBytes = Buffer.from('bytes-directos-camara')
    const res = await t.transport.request({ method: 'GET', path: '/api/cameras/still', query: 'id=camera.patio', headers })
    expect(res.status).toBe(200)
    expect(stillBody(res)).toEqual({ photo: Buffer.from('bytes-directos-camara').toString('base64'), mediaType: 'image/jpeg' })
    expect(t.home.snapshotCalls).toEqual(['camera.patio'])
    expect(readdirSync(t.home.inbox)).toEqual([])
  })

  it('AC-5.11: una cámara que falla devuelve la causa existente, nunca un blanco', async () => {
    const { t, headers } = await servedCameras()
    t.setAlwaysAllowTools(['camera_look'])
    t.home.snapshotError = new ToolError('tool.ha.cameraFailed', { error: 'boom' })
    const res = await t.transport.request({ method: 'GET', path: '/api/cameras/still', query: 'id=camera.patio', headers })
    expect(res.status).toBe(500)
    expect(stillBody(res)).toMatchObject({ error: 'failed' })
    expect(stillBody(res).note).toContain('boom')
  })

  it('AC-5.19: en needs-approval la tarjeta aparece en el teléfono', async () => {
    const { t, headers } = await servedCameras()
    const pending = t.transport.request({ method: 'GET', path: '/api/cameras/still', query: 'id=camera.patio', headers })
    await answerFirst(t, headers)
    const res = await pending
    expect(res.status).toBe(200)
    expect(stillBody(res).mediaType).toBe('image/jpeg')
  })

  it('AC-5.19: con regla Siempre corre sin preguntar; bloqueado se rehúsa', async () => {
    const { t, headers } = await servedCameras()
    t.setAlwaysAllowTools(['camera_look'])
    const ok = await t.transport.request({ method: 'GET', path: '/api/cameras/still', query: 'id=camera.patio', headers })
    expect(ok.status).toBe(200)
    expect(t.approvals.events.some((event) => event.type === 'approval.request')).toBe(false)
    t.setApprovalMode('blocked')
    const denied = await t.transport.request({ method: 'GET', path: '/api/cameras/still', query: 'id=camera.patio', headers })
    expect(denied.status).toBe(403)
    expect(stillBody(denied)).toMatchObject({ error: 'denied', note: 'Bloqueado por el modo de aprobación' })
  })

  it('AC-7.1: una foto deja la entrada del tool y la remote', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'alma-remote-camera-audit-'))
    dirs.push(dataDir)
    initAudit(dataDir, 'coordinator')
    const { t, headers, deviceId } = await servedCameras()
    t.setAlwaysAllowTools(['camera_look'])
    const res = await t.transport.request({ method: 'GET', path: '/api/cameras/still', query: 'id=camera.patio', headers })
    expect(res.status).toBe(200)
    const tool = toolEntries(dataDir).filter((entry) => entry['target'] === 'camera_look')
    expect(tool).toHaveLength(1)
    expect(tool[0]).toMatchObject({ action: 'tool.run', actor: 'agent', outcome: 'ok' })
    expect(t.records).toEqual([
      { action: 'remote.camera.still', actor: 'remote', target: 'camera.patio', outcome: 'ok', detail: { deviceId } }
    ])
  })
})
