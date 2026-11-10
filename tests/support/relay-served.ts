// The 026 harness over the relay pair, with a device paired and in session (spec 027 T17, T18).
import type { RemoteSettings } from '../../src/shared/types'
import type { RelayPairTransport } from './relay-pair'
import { HOST, openSession, pairDevice, testChannel } from './remote-harness'

/** Runs `run` with the harness building the relay pair instead of the in-process transport. */
export async function onThePair<T>(run: () => Promise<T>): Promise<T> {
  const before = process.env['ALMA_TEST_TRANSPORT']
  process.env['ALMA_TEST_TRANSPORT'] = 'relay'
  try {
    return await run()
  } finally {
    if (before === undefined) delete process.env['ALMA_TEST_TRANSPORT']
    else process.env['ALMA_TEST_TRANSPORT'] = before
  }
}

export async function served(remote: Partial<RemoteSettings>) {
  const t = await testChannel({ remote: { enabled: true, ...remote } })
  await t.channel.sync()
  const { deviceId, privateKey } = await pairDevice(t)
  const token = await openSession(t, deviceId, privateKey)
  return { t, pair: t.transport as RelayPairTransport, deviceId, privateKey, token, headers: { ...HOST, authorization: `Bearer ${token}` } }
}
