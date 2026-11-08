import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { b64u, fingerprint } from '../src/shared/remote/crypto'
import { generateDeviceKey, signWithDeviceKey } from '../src/remote-client/lib/keys'
import { checkHello, deriveCode, parsePairFragment, pollPairStatus, requestPair } from '../src/remote-client/lib/pairing'
import { openSession as phoneOpenSession, type FetchLike } from '../src/remote-client/lib/session'
import { HOST, testChannel, type Harness } from './support/remote-harness'

// The phone's own pairing functions against the real RemoteChannel: the wire contract, end to end.
// The unit tests cover each side with a fake of the other; this is the only test that joins them.

const HOST_NAME = 'alma-test.ts.net'
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function phoneFetch(t: Harness): FetchLike {
  return async (url, init) => {
    const [path, query = ''] = url.split('?')
    const body = init?.body ? JSON.parse(init.body) : undefined
    const response = await t.transport.request({ method: init?.method ?? 'GET', path, query, headers: { ...HOST, ...(init?.headers ?? {}) }, body })
    return { ok: response.status >= 200 && response.status < 300, status: response.status, json: async () => response.body }
  }
}

async function servedPc(): Promise<{ t: Harness; fragment: string }> {
  const t = await testChannel({ remote: { enabled: true }, random: (n) => new Uint8Array(n).fill(1) })
  dirs.push(t.dir)
  await t.state.update({ hostName: HOST_NAME })
  await t.channel.sync()
  expect(await t.channel.pairStart()).toEqual({ ok: true })
  const secret = b64u.encode(new Uint8Array(32).fill(1))
  return { t, fragment: `#p=${secret}&f=${await fingerprint(t.state.state.pcKey.public)}` }
}

describe('spec 026 pairing, phone against PC (AC-4.2, 4.12)', () => {
  it('scan, verify the PC, same digits on both screens, approval, then a session', async () => {
    const { t, fragment } = await servedPc()
    const fetch = phoneFetch(t)
    const parsed = parsePairFragment(fragment)
    if (!parsed) throw new Error('the QR fragment must parse')

    expect(await checkHello({ fetch, expectedFingerprint: parsed.fingerprint })).toEqual({ ok: true })
    const device = await generateDeviceKey()
    const requested = await requestPair({ fetch, secret: parsed.secret, phonePublicKey: device.publicJwk })
    if (!requested.ok) throw new Error(`pair request refused: ${requested.reason}`)

    const phoneCode = await deriveCode({ secret: parsed.secret, phoneKey: device.publicJwk, pcNonce: requested.pcNonce })
    expect((t.pairings.at(-1) as { code: string }).code).toBe(phoneCode)

    const fp = await fingerprint(device.publicJwk)
    expect(await pollPairStatus({ fetch, offer: parsed.secret, pcNonce: requested.pcNonce, fp })).toMatchObject({ ok: true, status: 'pending' })

    const approved = await t.channel.pairApprove('Pixel')
    if (!approved.ok) throw new Error(`approve failed: ${approved.reason}`)
    const status = await pollPairStatus({ fetch, offer: parsed.secret, pcNonce: requested.pcNonce, fp })
    expect(status).toMatchObject({ ok: true, status: 'approved', deviceId: approved.deviceId })

    const session = await phoneOpenSession({ fetch, deviceId: approved.deviceId, sign: (bytes) => signWithDeviceKey(device.privateKey, bytes), now: () => 0 })
    expect(session.ok).toBe(true)
  })

  it('a hello that is checked and then abandoned does not spend the QR (the code stays good for the next try)', async () => {
    const { t, fragment } = await servedPc()
    const fetch = phoneFetch(t)
    const parsed = parsePairFragment(fragment)
    if (!parsed) throw new Error('the QR fragment must parse')
    expect(await checkHello({ fetch, expectedFingerprint: parsed.fingerprint })).toEqual({ ok: true })
    expect(await checkHello({ fetch, expectedFingerprint: parsed.fingerprint })).toEqual({ ok: true })
    const device = await generateDeviceKey()
    expect((await requestPair({ fetch, secret: parsed.secret, phonePublicKey: device.publicJwk })).ok).toBe(true)
  })

  it('a different secret is a refused request, never a different PC', async () => {
    const { t } = await servedPc()
    const device = await generateDeviceKey()
    const spent = await requestPair({ fetch: phoneFetch(t), secret: 'z'.repeat(43), phonePublicKey: device.publicJwk })
    expect(spent).toEqual({ ok: false, reason: 'invalid' })
  })
})
