import type { Refusal, RemoteHandler, RemoteResponse } from '../../../shared/remote/api'
import type { RemoteFailure } from '../../../shared/types'

/**
 * A transport only moves bytes and carries no authority (BR-1): it starts something that feeds
 * requests to the handler, stops it, and cuts one device's connections on revocation.
 */
export interface RemoteTransport {
  readonly id: 'tailscale' | 'test'
  /** The public address the phone reaches (a `*.ts.net` URL, or the fixed test host). */
  start(handler: RemoteHandler): Promise<{ address: string }>
  /** Stops the listener and cuts every open connection. Safe to call after a failed start. */
  stop(): Promise<void>
  /** Connections of one device, so revocation can cut them at once. */
  closeDevice(deviceId: string): void
  /** The channel reports token ownership after resolving a session, so closeDevice can cut that device's sockets. */
  track(token: string, deviceId: string): void
}

const REFUSAL_STATUS: Record<Refusal, number> = {
  'unknown-device': 401,
  'scope-off': 403,
  'sensitive-off': 403,
  'step-up-required': 403,
  'camera-not-allowed': 403,
  'rate-limited': 429,
  invalid: 400,
  'too-large': 413,
  'unknown-route': 404,
  'already-answered': 409,
  locked: 429,
  expired: 410,
  busy: 409,
  limit: 403,
  'write-off': 403,
  unavailable: 404,
  gone: 404,
  unsupported: 415,
  'run-active': 409
}

/**
 * The one refusal constructor (AC-5.3): the channel and every transport refuse with byte-identical
 * bodies, so no refusal leaks which check failed or which transport carried it.
 */
export function refusalResponse(reason: Refusal): RemoteResponse {
  return { status: REFUSAL_STATUS[reason], headers: { 'cache-control': 'no-store' }, body: { error: reason } }
}

/** The 200 answer every flow builds: the body as given, never cached. */
export function okResponse(body: unknown): RemoteResponse {
  return { status: 200, headers: { 'cache-control': 'no-store' }, body }
}

/** A transport that cannot start rejects with this, carrying the concrete cause (AC-3.5). */
export class TransportStartError extends Error {
  constructor(
    readonly failure: RemoteFailure,
    detail?: string
  ) {
    super(detail ?? failure)
    this.name = 'TransportStartError'
  }
}
