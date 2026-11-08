import { b64u, signEs256, type PublicJwk } from './crypto'

/** The push services a subscription may point at (PD-15): nothing else is ever called. */
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com']
const PUSH_SUFFIXES = ['.push.apple.com', '.notify.windows.com']

function pushHostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (PUSH_HOSTS.includes(host)) return true
  return PUSH_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

/**
 * Whether a push subscription endpoint may be stored (AC-11.1, SSRF): https only,
 * no credentials, not a private host, and one of the known push services. The
 * private-host check is injected (the coordinator's own).
 */
export function allowedPushEndpoint(endpoint: string, isPrivate: (hostname: string) => boolean): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  if (isPrivate(url.hostname)) return false
  return pushHostAllowed(url.hostname)
}

/** The VAPID public key in uncompressed point form (b64u): the PushManager key and the JWT `k`. */
export function vapidPublicKey(publicKey: PublicJwk): string {
  if (!publicKey.x || !publicKey.y) throw new Error('vapid key without coordinates')
  const point = new Uint8Array(65)
  point[0] = 4
  point.set(b64u.decode(publicKey.x), 1)
  point.set(b64u.decode(publicKey.y), 33)
  return b64u.encode(point)
}

const encoder = new TextEncoder()

/**
 * The VAPID authorization for one push (PD-15): an ES256 JWT over this endpoint's
 * origin, valid 12 hours. The push itself carries an empty body (AC-11.1).
 */
export async function buildVapid(deps: {
  endpoint: string
  subject: string
  publicKey: PublicJwk
  privateKey: PublicJwk
  now: number
}): Promise<{ authorization: string }> {
  const header = b64u.encode(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const payload = b64u.encode(
    encoder.encode(JSON.stringify({ aud: new URL(deps.endpoint).origin, exp: Math.floor(deps.now / 1000) + 12 * 3600, sub: deps.subject }))
  )
  const signature = b64u.encode(await signEs256(deps.privateKey, encoder.encode(`${header}.${payload}`)))
  return { authorization: `vapid t=${header}.${payload}.${signature}, k=${vapidPublicKey(deps.publicKey)}` }
}
