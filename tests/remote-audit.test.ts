import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACTIVITY_LIMIT, readRemoteActivity } from '../src/coordinator/channels/remote/activity'
import { audit, initAudit, type AuditEvent } from '../src/shared/audit'
import { b64u } from '../src/shared/remote/crypto'
import { defaultRemote } from '../src/shared/remote/settings'
import { COMPANY_AGENT, HOST, makeThread, openSession, pairDevice, testChannel, type Harness } from './support/remote-harness'
import { fakeAssertion, fakeAttestation, fakeCredential } from './support/webauthn-fake'

const HOST_NAME = 'alma-test.ts.net'
const ORIGIN = `https://${HOST_NAME}`
const OFFER = b64u.encode(new Uint8Array(32).fill(1))
const KEY = { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) }
const UNKNOWN = 'z'.repeat(43)

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function servedAudit(passkey = false): Promise<{ t: Harness; headers: Record<string, string>; deviceId: string; credential?: Awaited<ReturnType<typeof fakeCredential>> }> {
  const t = await testChannel({
    remote: {
      enabled: true,
      sensitive: true,
      cameras: ['camera.patio'],
      scopes: { chat: true, approve: true, home: true, cameras: true, vault: false, history: false }
    }
  })
  await t.state.update({ hostName: HOST_NAME })
  await t.channel.sync()
  if (!passkey) {
    const { deviceId, privateKey } = await pairDevice(t, 'audit-phone')
    const token = await openSession(t, deviceId, privateKey)
    return { t, headers: { ...HOST, authorization: `Bearer ${token}` }, deviceId }
  }
  const paired = await pairDevice(t, 'audit-phone')
  const credential = await fakeCredential()
  await t.store.setPasskey(paired.deviceId, {
    credentialId: b64u.encode(credential.credentialId),
    publicKey: credential.publicKey,
    counter: 5
  })
  const token = await openSession(t, paired.deviceId, paired.privateKey)
  return { t, headers: { ...HOST, authorization: `Bearer ${token}` }, deviceId: paired.deviceId, credential }
}

async function steppedUp(
  t: Harness,
  headers: Record<string, string>,
  credential: Awaited<ReturnType<typeof fakeCredential>>,
  thing: string,
  action: string
) {
  const issued = await t.transport.request({ method: 'POST', path: '/api/stepup/challenge', headers, body: { thing, action } })
  expect(issued.status).toBe(200)
  const made = await fakeAssertion(credential, {
    challenge: b64u.decode((issued.body as { challenge: string }).challenge),
    origin: ORIGIN,
    rpId: HOST_NAME,
    counter: 6
  })
  return {
    authenticatorData: b64u.encode(made.authenticatorData),
    clientDataJSON: b64u.encode(made.clientDataJSON),
    signature: b64u.encode(made.signature)
  }
}

function actions(records: AuditEvent[]): string[] {
  return records.map((entry) => entry.action)
}

describe('T26 audit mapping (AC-7.1 a 7.5, BR-6, BR-30)', () => {
  it('AC-7.1: send, new y stop se auditan como remote con deviceId', async () => {
    const { t, headers, deviceId } = await servedAudit()
    expect((await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: 'hola' } })).status).toBe(200)
    expect((await t.transport.request({ method: 'POST', path: '/api/chat/new', headers, body: {} })).status).toBe(200)
    expect((await t.transport.request({ method: 'POST', path: '/api/chat/stop', headers, body: {} })).status).toBe(200)
    expect(actions(t.records)).toEqual(['remote.chat.send', 'remote.chat.new', 'remote.chat.stop'])
    for (const entry of t.records) {
      expect(entry.actor).toBe('remote')
      expect(entry.outcome).toBe('ok')
      expect(entry.detail).toEqual({ deviceId })
    }
  })

  it('AC-7.1: answer, control, picture, step-up y forget se auditan; el step-up viaja en su control', async () => {
    const { t, headers, deviceId, credential } = await servedAudit(true)
    if (!credential) throw new Error('sin passkey en el test')
    const mine = t.approvals.askApproval({
      threadId: 'remote',
      toolUseId: 'tu1',
      toolName: 'run_command',
      input: {},
      flagged: false,
      allowAlways: true
    })
    const answer = await t.transport.request({ method: 'POST', path: '/api/approvals/answer', headers, body: { id: mine.approvalId, decision: 'allow' } })
    expect(answer.status).toBe(200)
    const control = await t.transport.request({ method: 'POST', path: '/api/home/control', headers, body: { thing: 'light.techo', action: 'on' } })
    expect(control.status).toBe(200)
    t.setAlwaysAllowTools(['camera_look'])
    const still = await t.transport.request({ method: 'GET', path: '/api/cameras/still', query: 'id=camera.patio', headers })
    expect(still.status).toBe(200)
    const assertion = await steppedUp(t, headers, credential, 'lock.puerta', 'unlock')
    const pending = t.transport.request({ method: 'POST', path: '/api/home/control', headers, body: { thing: 'lock.puerta', action: 'unlock', assertion } })
    await vi.waitFor(() => expect(t.approvals.broker.pending()).toHaveLength(1))
    const [approval] = t.approvals.broker.pending()
    await t.transport.request({ method: 'POST', path: '/api/approvals/answer', headers, body: { id: approval?.approvalId, decision: 'allow' } })
    expect((await pending).status).toBe(200)
    const forget = await t.transport.request({ method: 'POST', path: '/api/forget', headers })
    expect(forget.status).toBe(200)
    expect(actions(t.records)).toEqual([
      'remote.approvals.answer',
      'remote.home.control',
      'remote.camera.still',
      'remote.approvals.answer',
      'remote.home.control',
      'remote.device.forget'
    ])
    for (const entry of t.records) {
      expect(entry.actor).toBe('remote')
      expect(entry.detail).toEqual({ deviceId })
    }
  })

  it('AC-7.1: listas y polling no se auditan', async () => {
    const { t, headers } = await servedAudit()
    expect((await t.transport.request({ method: 'GET', path: '/api/state', headers })).status).toBe(200)
    expect((await t.transport.request({ method: 'GET', path: '/api/approvals', headers })).status).toBe(200)
    expect((await t.transport.request({ method: 'GET', path: '/api/home/things', headers })).status).toBe(200)
    expect((await t.transport.request({ method: 'GET', path: '/api/cameras', headers })).status).toBe(200)
    expect(t.records).toEqual([])
    const polling = await servedAudit()
    expect(await polling.t.channel.pairStart()).toEqual({ ok: true })
    const request = await polling.t.transport.request({ method: 'POST', path: '/api/pair/request', headers: HOST, body: { secret: OFFER, phonePublicKey: KEY } })
    expect(request.status).toBe(200)
    const pcNonce = (request.body as { pcNonce: string }).pcNonce
    const status = await polling.t.transport.request({ method: 'GET', path: '/api/pair/status', headers: HOST, query: `offer=${OFFER}&pcNonce=${pcNonce}` })
    expect(status.status).toBe(200)
    expect(actions(polling.t.records)).toEqual(['remote.pair.request'])
  })

  it('AC-7.3: el pedido pairing es remote; approve y reject son user (deviceId donde hay device)', async () => {
    const { t } = await servedAudit()
    expect(await t.channel.pairStart()).toEqual({ ok: true })
    const request = await t.transport.request({ method: 'POST', path: '/api/pair/request', headers: HOST, body: { secret: OFFER, phonePublicKey: KEY } })
    expect(request.status).toBe(200)
    expect(t.records).toEqual([{ action: 'remote.pair.request', actor: 'remote', outcome: 'ok' }])
    const approved = await t.channel.pairApprove('Pixel')
    expect(approved.ok).toBe(true)
    const deviceId = approved.ok ? approved.deviceId : ''
    expect(t.records[1]).toEqual({ action: 'remote.pair.approve', actor: 'user', target: deviceId, outcome: 'ok', detail: { deviceId } })
    expect(await t.channel.pairStart()).toEqual({ ok: true })
    expect(await t.channel.pairReject()).toEqual({ ok: true })
    expect(t.records[2]).toEqual({ action: 'remote.pair.reject', actor: 'user', outcome: 'ok' })
  })

  it('AC-7.5: fallos denegados, throttled, sin nombres; deviceId solo si se conoce', async () => {
    const { t, headers, deviceId } = await servedAudit()
    const badAuth = await t.transport.request({ method: 'GET', path: '/api/status', headers: { ...HOST, authorization: 'Bearer mala' } })
    expect(badAuth.status).toBe(401)
    t.setRemote({ scopes: { chat: false, approve: false, home: false, cameras: false, vault: false, history: false } })
    const scoped = await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: 'hola' } })
    expect(scoped.status).toBe(403)
    t.setRemote({ scopes: { chat: true, approve: true, home: true, cameras: true, vault: false, history: false } })
    const stepUp = await t.transport.request({ method: 'POST', path: '/api/home/control', headers, body: { thing: 'lock.puerta', action: 'unlock' } })
    expect(stepUp.status).toBe(403)
    expect(await t.channel.pairStart()).toEqual({ ok: true })
    const badPair = await t.transport.request({ method: 'POST', path: '/api/pair/request', headers: HOST, body: { secret: UNKNOWN, phonePublicKey: KEY } })
    expect(badPair.status).toBe(400)
    expect(t.records).toEqual([
      { action: 'remote.status', actor: 'remote', outcome: 'denied', throttle: true },
      { action: 'remote.chat.send', actor: 'remote', outcome: 'denied', detail: { deviceId }, throttle: true },
      { action: 'remote.home.control', actor: 'remote', outcome: 'denied', detail: { deviceId }, throttle: true },
      { action: 'remote.pair.request', actor: 'remote', outcome: 'denied', throttle: true }
    ])
    expect(JSON.stringify(t.records)).not.toContain('audit-phone')
  })

  it('AC-7.2: secretos, códigos, llaves, pruebas y suscripciones nunca llegan al trail', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'alma-remote-audit-'))
    dirs.push(dataDir)
    initAudit(dataDir, 'coordinator')
    const t = await testChannel({
      remote: { enabled: true, cameras: ['camera.patio'], scopes: { chat: true, approve: true, home: true, cameras: true, vault: false, history: false } },
      record: (entry) => audit(entry)
    })
    await t.state.update({ hostName: HOST_NAME })
    await t.channel.sync()
    expect(await t.channel.pairStart()).toEqual({ ok: true })
    const request = await t.transport.request({ method: 'POST', path: '/api/pair/request', headers: HOST, body: { secret: OFFER, phonePublicKey: KEY } })
    expect(request.status).toBe(200)
    const code = (t.pairings.at(-1) as { code: string }).code
    expect(code).toMatch(/^\d{6}$/)
    const approved = await t.channel.pairApprove('Pixel')
    if (!approved.ok) throw new Error('approve falló en el test')
    const credential = await fakeCredential()
    const attestation = await fakeAttestation(credential, { challenge: new Uint8Array(32).fill(1), origin: ORIGIN, rpId: HOST_NAME })
    const pcNonce = (request.body as { pcNonce: string }).pcNonce
    const passkey = await t.transport.request({
      method: 'POST',
      path: '/api/pair/passkey',
      headers: HOST,
      body: { offer: OFFER, pcNonce, attestationObject: b64u.encode(attestation.attestationObject), clientDataJSON: b64u.encode(attestation.clientDataJSON) }
    })
    expect(passkey.status).toBe(200)
    const attestationText = `${b64u.encode(attestation.attestationObject)}:${b64u.encode(attestation.clientDataJSON)}`
    const { deviceId, privateKey } = await pairDevice(t, 'audit-phone')
    const token = await openSession(t, deviceId, privateKey)
    const headers = { ...HOST, authorization: `Bearer ${token}` }
    expect((await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: 'texto-secreto-7x2' } })).status).toBe(200)
    const subscription = { endpoint: 'https://push.example.com/suscripcion-secreta-9z8', keys: { p256dh: 'p256dh-secreta', auth: 'auth-secreta' } }
    await t.transport.request({ method: 'POST', path: '/api/push/subscribe', headers, body: subscription })
    const month = new Date().toISOString().slice(0, 7)
    const file = join(dataDir, 'audit', `coordinator-${month}.jsonl`)
    const trail = readFileSync(file, 'utf8')
    expect(trail).toContain('remote.pair.request')
    for (const secret of [OFFER, code, KEY.x, KEY.y, attestationText, subscription.endpoint, 'p256dh-secreta', 'auth-secreta', 'texto-secreto-7x2', 'audit-phone']) {
      expect(trail, secret.slice(0, 24)).not.toContain(secret)
    }
  })

  it('AC-7.4: un sink que truena no rompe la operación', async () => {
    const t = await testChannel({
      remote: { enabled: true, scopes: { chat: true, approve: true, home: true, cameras: true, vault: false, history: false } },
      record: () => {
        throw new Error('sink roto')
      }
    })
    await t.channel.sync()
    const { deviceId, privateKey } = await pairDevice(t)
    const token = await openSession(t, deviceId, privateKey)
    const headers = { ...HOST, authorization: `Bearer ${token}` }
    expect((await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: 'hola' } })).status).toBe(200)
    expect((await t.transport.request({ method: 'POST', path: '/api/home/control', headers, body: { thing: 'light.techo', action: 'on' } })).status).toBe(200)
    await t.channel.revokeDevice(deviceId)
    await t.channel.sweepDevices()
    expect(t.store.devices()).toEqual([])
  })

  it('AC-7.6: el lector devuelve solo entradas remote, newest first (rotas se saltan, borrado muestra id)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'alma-remote-activity-'))
    dirs.push(dataDir)
    initAudit(dataDir, 'coordinator')
    let byte = 0
    const t = await testChannel({
      remote: { enabled: true, scopes: { chat: true, approve: false, home: false, cameras: false, vault: false, history: false } },
      record: (entry) => audit(entry),
      random: (length: number) => {
        byte = (byte % 250) + 1
        return new Uint8Array(length).fill(byte)
      }
    })
    await t.channel.sync()
    const pixel = await pairDevice(t, 'Pixel')
    const nexus = await pairDevice(t, 'Nexus')
    const pixelHeaders = { ...HOST, authorization: `Bearer ${await openSession(t, pixel.deviceId, pixel.privateKey)}` }
    const nexusHeaders = { ...HOST, authorization: `Bearer ${await openSession(t, nexus.deviceId, nexus.privateKey)}` }
    audit({ action: 'tool.run', actor: 'agent', target: 'run_command', outcome: 'ok' })
    expect((await t.transport.request({ method: 'POST', path: '/api/chat/send', headers: pixelHeaders, body: { text: 'uno' } })).status).toBe(200)
    t.chat.resolveAsk(0, 'listo')
    await t.chat.pending[0]?.promise
    const month = new Date().toISOString().slice(0, 7)
    appendFileSync(join(dataDir, 'audit', `coordinator-${month}.jsonl`), 'línea-rota{{{\n', 'utf8')
    expect((await t.transport.request({ method: 'POST', path: '/api/chat/send', headers: nexusHeaders, body: { text: 'dos' } })).status).toBe(200)
    await t.channel.revokeDevice(pixel.deviceId)
    const entries = readRemoteActivity({ dataDir, devices: t.store.devices() })
    expect(entries.map((entry) => entry.action)).toEqual(['remote.device.revoke', 'remote.chat.send', 'remote.chat.send'])
    expect(entries[0]).toMatchObject({ device: pixel.deviceId, outcome: 'ok' })
    expect(entries[1]).toMatchObject({ device: 'Nexus', outcome: 'ok' })
    expect(entries[2]).toMatchObject({ device: pixel.deviceId, outcome: 'ok' })
    expect(entries.every((entry) => typeof entry.ts === 'string')).toBe(true)
  })

  it('AC-7.6: la actividad se topa en ACTIVITY_LIMIT, las más nuevas', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'alma-remote-activity-cap-'))
    dirs.push(dataDir)
    initAudit(dataDir, 'coordinator')
    for (let i = 0; i < ACTIVITY_LIMIT + 5; i++) {
      audit({ action: `remote.op.${i}`, actor: 'remote', outcome: 'ok', detail: { deviceId: 'd1' } })
    }
    const entries = readRemoteActivity({ dataDir, devices: [{ id: 'd1', name: 'Pixel' }] })
    expect(entries).toHaveLength(ACTIVITY_LIMIT)
    expect(entries[0]?.action).toBe(`remote.op.${ACTIVITY_LIMIT + 4}`)
    expect(entries.at(-1)?.action).toBe('remote.op.5')
  })
})

const NOTE_TEXT = 'texto-de-nota-secreto-4h'
const TITLE = 'titulo-secreto-5x'
const MESSAGE = 'mensaje-secreto-3k'
const SENT = 'envio-secreto-8q'
const QUERY = 'consulta-secreta-2w'

/** Notes and Conversations on, with one note, one image, an excluded folder and one conversation to open. */
async function servedOpens(options: { cont?: boolean; record?: (entry: AuditEvent) => void } = {}): Promise<Harness> {
  const scopes = { ...defaultRemote().scopes, chat: true, vault: true, history: true }
  const t = await testChannel({
    remote: { ...defaultRemote(), enabled: true, scopes, continueHistory: options.cont ?? true, vaultExcluded: ['Privado'] },
    record: options.record
  })
  await t.channel.sync()
  t.vault.put('Diario/hoy.md', NOTE_TEXT)
  t.vault.put('Diario/foto.png', new Uint8Array([1, 2, 3]))
  t.vault.put('Privado/a.md', 'otro-secreto')
  t.chat.threads.push({ ...makeThread('t1'), title: TITLE, messages: [{ role: 'user', content: [{ type: 'text', text: MESSAGE }], ts: 1 }] })
  t.chat.threads.push(makeThread('c1', COMPANY_AGENT))
  return t
}

describe('audit of the notes and conversations routes (spec 028)', () => {
  it('AC-5.1 (028) opens, image fetches, sends and stops are audited; listings, find and the thread list are not', async () => {
    const t = await servedOpens()
    const { deviceId } = await t.phone()
    await t.call('/api/notes/list', { folder: 'Diario' })
    await t.call('/api/notes/find', { query: 'hoy' })
    await t.call('/api/threads/list', { offset: 0 })
    await t.call('/api/threads/read', { id: 't1', since: 1, wait: false })
    expect(t.records).toEqual([])
    expect((await t.call('/api/notes/read', { path: 'Diario/hoy.md' })).status).toBe(200)
    expect((await t.call('/api/notes/image', { target: 'foto.png', from: 'Diario/hoy.md' })).status).toBe(200)
    expect((await t.call('/api/threads/read', { id: 't1' })).status).toBe(200)
    expect((await t.call('/api/threads/send', { id: 't1', text: SENT })).status).toBe(200)
    expect((await t.call('/api/threads/stop', { id: 't1' })).status).toBe(200)
    const open = (action: string, target: string) => ({ action, actor: 'remote', target, outcome: 'ok', detail: { deviceId } })
    expect(t.records).toEqual([
      open('remote.notes.read', 'Diario/hoy.md'),
      open('remote.notes.image', 'Diario/foto.png'),
      open('remote.threads.read', 't1'),
      open('remote.threads.send', 't1'),
      open('remote.threads.stop', 't1')
    ])
  })

  it('AC-5.1 (028) a refused open is audited with outcome error, an unresolved image names no path', async () => {
    const t = await servedOpens()
    const { deviceId } = await t.phone()
    expect((await t.call('/api/notes/read', { path: 'Privado/a.md' })).status).toBe(404)
    expect((await t.call('/api/notes/image', { target: 'nada.png', from: 'Diario/hoy.md' })).status).toBe(404)
    expect((await t.call('/api/threads/read', { id: 'c1' })).status).toBe(404)
    expect(t.records).toEqual([
      { action: 'remote.notes.read', actor: 'remote', target: 'Privado/a.md', outcome: 'error', detail: { deviceId } },
      { action: 'remote.notes.image', actor: 'remote', outcome: 'error', detail: { deviceId } },
      { action: 'remote.threads.read', actor: 'remote', target: 'c1', outcome: 'error', detail: { deviceId } }
    ])
  })

  it('AC-5.2 (028) known strings (note text, title, message, query) never reach the trail', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'alma-remote-audit-028-'))
    dirs.push(dataDir)
    initAudit(dataDir, 'coordinator')
    const t = await servedOpens({ record: (entry) => audit(entry) })
    await t.call('/api/notes/find', { query: QUERY })
    await t.call('/api/notes/read', { path: 'Diario/hoy.md' })
    await t.call('/api/notes/image', { target: 'foto.png', from: 'Diario/hoy.md' })
    await t.call('/api/threads/list', { offset: 0 })
    await t.call('/api/threads/read', { id: 't1' })
    await t.call('/api/threads/send', { id: 't1', text: SENT })
    await t.call('/api/threads/stop', { id: 't1' })
    const month = new Date().toISOString().slice(0, 7)
    const trail = readFileSync(join(dataDir, 'audit', `coordinator-${month}.jsonl`), 'utf8')
    expect(trail).toContain('remote.notes.read')
    expect(trail).toContain('remote.threads.stop')
    for (const secret of [NOTE_TEXT, TITLE, MESSAGE, SENT, QUERY]) expect(trail, secret).not.toContain(secret)
  })

  it('AC-5.3 (028) scope refusals are denied and throttled, with no path, title or text', async () => {
    const t = await servedOpens({ cont: false })
    const { deviceId } = await t.phone()
    expect((await t.call('/api/threads/send', { id: 't1', text: SENT })).status).toBe(403)
    t.setRemote({ scopes: { ...defaultRemote().scopes, chat: true } })
    expect((await t.call('/api/notes/read', { path: 'Diario/hoy.md' })).status).toBe(403)
    expect((await t.call('/api/threads/read', { id: 't1' })).status).toBe(403)
    const stranger = await t.transport.request({ method: 'POST', path: '/api/notes/read', headers: { ...HOST, authorization: 'Bearer mala' }, body: { path: 'Diario/hoy.md' } })
    expect(stranger.status).toBe(401)
    expect(t.records).toEqual([
      { action: 'remote.threads.send', actor: 'remote', outcome: 'denied', detail: { deviceId }, throttle: true },
      { action: 'remote.notes.read', actor: 'remote', outcome: 'denied', detail: { deviceId }, throttle: true },
      { action: 'remote.threads.read', actor: 'remote', outcome: 'denied', detail: { deviceId }, throttle: true },
      { action: 'remote.notes.read', actor: 'remote', outcome: 'denied', throttle: true }
    ])
  })

  it('AC-5.4 (028) a throwing record does not break the operation', async () => {
    const t = await servedOpens({
      record: () => {
        throw new Error('sink roto')
      }
    })
    expect((await t.call('/api/notes/read', { path: 'Diario/hoy.md' })).status).toBe(200)
    expect((await t.call('/api/notes/image', { target: 'foto.png', from: 'Diario/hoy.md' })).status).toBe(200)
    expect((await t.call('/api/threads/read', { id: 't1' })).status).toBe(200)
    expect((await t.call('/api/threads/send', { id: 't1', text: SENT })).status).toBe(200)
    expect((await t.call('/api/threads/stop', { id: 't1' })).status).toBe(200)
  })

  it('AC-5.5 (028) the activity list includes the new actions', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'alma-remote-activity-028-'))
    dirs.push(dataDir)
    initAudit(dataDir, 'coordinator')
    const t = await servedOpens({ record: (entry) => audit(entry) })
    const { deviceId } = await t.phone()
    await t.call('/api/notes/read', { path: 'Diario/hoy.md' })
    await t.call('/api/threads/send', { id: 't1', text: SENT })
    await t.call('/api/notes/read', { path: 'Privado/a.md' })
    const entries = readRemoteActivity({ dataDir, devices: [{ id: deviceId, name: 'Pixel' }] })
    expect(entries.map((entry) => [entry.action, entry.outcome, entry.device])).toEqual([
      ['remote.notes.read', 'error', 'Pixel'],
      ['remote.threads.send', 'ok', 'Pixel'],
      ['remote.notes.read', 'ok', 'Pixel']
    ])
  })
})
