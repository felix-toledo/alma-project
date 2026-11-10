// The third RemoteTransport (spec 027 PD-1): the PC connects outward to the relay, opens each sealed phone request
// itself and hands it to the unchanged channel handler. It starts no listener and talks to no host but the relay.
import type { RemoteHandler } from '../../../shared/remote/api'
import type { PublicJwk } from '../../../shared/remote/crypto'
import type { RelayState } from '../../../shared/remote/relay-status'
import { RelayConnection, type WebSocketCtor } from './relay-connection'
import { RelayHost } from './relay-host'
import type { RemoteTransport } from './transport'

export interface RelayTransportDeps {
  routingId: string
  relayDomain: string
  identity: { publicKey: PublicJwk; sign(data: Uint8Array): Promise<Uint8Array> }
  /** Null for an unknown, revoked or idle-expired device. */
  deviceKey(deviceId: string): PublicJwk | null
  webSocket: WebSocketCtor
  random(length: number): Uint8Array
  now(): number
  schedule(fn: () => void, ms: number): () => void
  /** A number in [0, 1) for the retry jitter. */
  jitter(): number
  /** Every change of the relay connection, one per outage: the composition root overlays it on the channel status. */
  onState(state: RelayState): void
  shell?(): { version: number; rootHash: string } | null
  onHandshakeFailed?(): void
}

export class RelayTransport implements RemoteTransport {
  readonly id = 'relay' as const
  private host: RelayHost | null = null
  private connection: RelayConnection | null = null

  constructor(private readonly deps: RelayTransportDeps) {}

  /** Returns the relay-form address at once and connects in the background: an unreachable relay is a state to retry, not a failed start. */
  async start(handler: RemoteHandler): Promise<{ address: string }> {
    await this.stop()
    const { routingId, relayDomain } = this.deps
    const address = `https://${routingId}.${relayDomain}`
    const host = new RelayHost({
      address,
      handler,
      identity: this.deps.identity,
      deviceKey: this.deps.deviceKey,
      random: this.deps.random,
      now: this.deps.now,
      shell: this.deps.shell,
      onHandshakeFailed: this.deps.onHandshakeFailed
    })
    this.host = host
    this.connection = new RelayConnection({
      url: `wss://${routingId}.${relayDomain}/relay/v1/pc`,
      routingId,
      identity: this.deps.identity,
      webSocket: this.deps.webSocket,
      schedule: this.deps.schedule,
      jitter: this.deps.jitter,
      onFrame: (_rid, frame, signal) => host.handle(frame, signal),
      onState: this.deps.onState,
      // A new connection always means new keys: the sessions of the old one are dropped.
      onConnected: () => host.closeAll()
    })
    this.connection.start()
    return { address }
  }

  async stop(): Promise<void> {
    this.connection?.stop()
    this.host?.closeAll()
    this.connection = null
    this.host = null
  }

  closeDevice(deviceId: string): void {
    this.host?.closeDevice(deviceId)
  }

  track(token: string, deviceId: string): void {
    this.host?.track(token, deviceId)
  }
}
