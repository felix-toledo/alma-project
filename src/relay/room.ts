import { b64u } from '../shared/remote/crypto'
import { parseRelayFrame, pcToRelaySchema, RELAY_CLOSE, type RelayFrame, type RelayRefusal, type RelayToPc } from '../shared/remote/relay-frame'
import { REMOTE_RELAY_LIMITS, type RelayLimits } from '../shared/remote/relay-limits'
import type { RelayCounters } from './counters'
import { type AddressLimits, createAddressLimits, createRoomLimits, type RoomLimits } from './limits-state'
import { checkRegistration, claim, newChallenge } from './registration'

export const CLOSE = RELAY_CLOSE

export interface PcSocket {
  send(message: string): void
  close(code: number, reason?: string): void
  /** Called once the PC proved its key, with the hash of it, so a platform that lets the room sleep can keep it with the socket. */
  remember?(keyHash: string): void
}

export interface ForwardContext {
  address: string
  bytes: number
  signal?: AbortSignal
}

export type ForwardResult = RelayFrame | RelayRefusal | 'malformed'

export interface RoomDeps {
  routingId: string
  random(length: number): Uint8Array
  /** Runs `fn` after `ms`; returns the cancel. Defaults to the platform timer. */
  schedule?(fn: () => void, ms: number): () => void
  limits?: RelayLimits
  now?(): number
  /** Shared across the rooms of one deployment, so probing many ids from one address adds up. Defaults to a private one. */
  addresses?: AddressLimits
  /** The emergency stop: true makes every route answer full. */
  paused?(): boolean
  counters?: RelayCounters
}

// A socket that died between the platform's last event and now throws on send; the room treats that as the socket being gone.
const send = (socket: PcSocket, message: RelayToPc): boolean => {
  try {
    socket.send(JSON.stringify(message))
    return true
  } catch {
    return false
  }
}

const platformSchedule = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms)
  return () => clearTimeout(handle)
}

type Settle = (result: RelayFrame | RelayRefusal) => void

/**
 * One room per routing id. Platform-free: the adapter hands it sockets and calls its methods.
 * It never opens a frame: it routes ciphertext and keeps only what a live connection needs.
 */
export class RelayRoom {
  private pc: { socket: PcSocket; keyHash: string } | null = null
  // Sockets that have been sent a challenge and not yet proved a key.
  private readonly registering = new Map<PcSocket, { nonce: Uint8Array; stop: () => void }>()
  // Sockets whose proof is being checked. One that closes meanwhile leaves this set, and its registration then finds it gone.
  private readonly verifying = new Set<PcSocket>()
  // Requests waiting for the PC's answer, by request id. Each entry ends itself and cleans up its own timer.
  private readonly pending = new Map<string, Settle>()
  private readonly limits: RelayLimits
  private readonly schedule: (fn: () => void, ms: number) => () => void
  private readonly roomLimits: RoomLimits
  private readonly addresses: AddressLimits

  constructor(private readonly deps: RoomDeps) {
    this.limits = deps.limits ?? REMOTE_RELAY_LIMITS
    this.schedule = deps.schedule ?? platformSchedule
    const now = deps.now ?? Date.now
    this.roomLimits = createRoomLimits(this.limits, now)
    this.addresses = deps.addresses ?? createAddressLimits(this.limits, now)
  }

  get online(): boolean {
    return this.pc !== null
  }

  get inFlight(): number {
    return this.pending.size
  }

  async acceptPc(socket: PcSocket, address: string): Promise<void> {
    if (this.deps.paused?.()) return this.turnAway(socket, CLOSE.full)
    // A verdict already known is used at once, so limits kept in this room cost no extra turn; one that comes from elsewhere is waited for.
    const attempt = this.addresses.attempt(address)
    if (!(typeof attempt === 'boolean' ? attempt : await attempt)) return this.turnAway(socket, CLOSE.full)
    const nonce = newChallenge(this.deps.random)
    // A socket that connects and never answers does not hold a place: it is closed as refused after the registration time.
    const stop = this.schedule(() => {
      if (this.registering.delete(socket)) this.turnAway(socket, CLOSE.refused)
    }, this.limits.registerTimeoutMs)
    this.registering.set(socket, { nonce, stop })
    send(socket, { k: 'challenge', nonce: b64u.encode(nonce) })
  }

  async onPcMessage(socket: PcSocket, raw: string): Promise<void> {
    if (this.pc?.socket === socket) return this.onRegisteredMessage(raw)
    const waiting = this.registering.get(socket)
    if (!waiting) return
    let message: ReturnType<typeof pcToRelaySchema.safeParse>
    try {
      message = pcToRelaySchema.safeParse(JSON.parse(raw))
    } catch {
      return this.refuse(socket)
    }
    if (!message.success || message.data.k !== 'reg') return this.refuse(socket)
    // The challenge is single use; a second message while it is being checked finds no entry and is ignored.
    this.registering.delete(socket)
    waiting.stop()
    this.verifying.add(socket)
    const proof = await checkRegistration(this.deps.routingId, waiting.nonce, message.data.pub, message.data.sig)
    if (!this.verifying.delete(socket)) return
    if (!proof.ok) return this.turnAway(socket, CLOSE.refused)
    // Decided after the await in one synchronous block, so two racing registrations cannot both win.
    const decision = claim(this.pc?.keyHash ?? null, proof.keyHash)
    if (decision === 'refuse') return this.turnAway(socket, CLOSE.heldByAnotherKey)
    if (decision === 'replace') {
      this.pc?.socket.close(CLOSE.replaced)
      this.settleAll('offline')
    }
    this.pc = { socket, keyHash: proof.keyHash }
    socket.remember?.(proof.keyHash)
    send(socket, { k: 'ready' })
    this.deps.counters?.registered()
  }

  /**
   * After a sleep: the platform kept the PC's socket and the hash of its key, and the room takes it back. A second one is closed as replaced.
   * A socket that kept no key never finished registering and is turned away.
   */
  restorePc(socket: PcSocket, keyHash: string | null): void {
    if (keyHash === null) {
      this.turnAway(socket, CLOSE.refused)
      return
    }
    if (this.pc) {
      socket.close(CLOSE.replaced)
      return
    }
    this.pc = { socket, keyHash }
  }

  onPcClose(socket: PcSocket): void {
    this.registering.get(socket)?.stop()
    this.registering.delete(socket)
    this.verifying.delete(socket)
    if (this.pc?.socket !== socket) return
    this.pc = null
    this.settleAll('offline')
  }

  /** Routes one phone frame to the PC and returns the PC's answer. A phone that goes away rejects with the signal's reason. */
  async forward(raw: unknown, from: ForwardContext): Promise<ForwardResult> {
    if (this.deps.paused?.()) return this.refusal('full')
    const attempt = this.addresses.attempt(from.address)
    if (!(typeof attempt === 'boolean' ? attempt : await attempt) || from.bytes > this.limits.frameBytes) return this.refusal('full')
    const parsed = parseRelayFrame(raw)
    if (!parsed.ok) return this.refusal(parsed.reason)
    const pc = this.pc
    // An id with no live PC is the same whether it never existed or is only asleep; probing for them is what is throttled.
    if (!pc) {
      const miss = this.addresses.miss(from.address)
      return this.refusal((typeof miss === 'boolean' ? miss : await miss) ? 'offline' : 'full')
    }
    if (!this.roomLimits.admit({ bytes: from.bytes, handshake: parsed.frame.t === 'hs1', inFlight: this.pending.size })) return this.refusal('full')
    if (from.signal?.aborted) throw from.signal.reason
    const rid = b64u.encode(this.deps.random(12))
    return new Promise<RelayFrame | RelayRefusal>((resolve, reject) => {
      let cancelTimer = (): void => {}
      // Whichever of answer, timeout, abort or PC loss comes first ends the request; the others find nothing.
      const end = (run: () => void): void => {
        if (!this.pending.delete(rid)) return
        cancelTimer()
        from.signal?.removeEventListener('abort', onAbort)
        run()
      }
      cancelTimer = this.schedule(
        () =>
          end(() => {
            send(pc.socket, { k: 'abort', rid })
            resolve(this.refusal('timeout'))
          }),
        this.limits.requestTimeoutMs
      )
      const onAbort = (): void =>
        end(() => {
          send(pc.socket, { k: 'abort', rid })
          reject(from.signal?.reason)
        })
      from.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(rid, (result) => end(() => resolve(result)))
      if (!send(pc.socket, { k: 'f', rid, frame: parsed.frame })) {
        // The PC's socket is dead: it is gone, and this request is told so.
        this.onPcClose(pc.socket)
        end(() => resolve(this.refusal('offline')))
        return
      }
      this.deps.counters?.forwarded()
    })
  }

  private onRegisteredMessage(raw: string): void {
    let message: ReturnType<typeof pcToRelaySchema.safeParse>
    try {
      message = pcToRelaySchema.safeParse(JSON.parse(raw))
    } catch {
      return
    }
    if (!message.success) return
    if (message.data.k === 'x') {
      const waiting = this.pending.get(message.data.rid)
      if (waiting) waiting(this.refusal(message.data.refusal))
      return
    }
    if (message.data.k !== 'r') return
    this.roomLimits.answered(raw.length)
    const waiting = this.pending.get(message.data.rid)
    if (!waiting) return
    this.deps.counters?.forwarded()
    waiting(message.data.frame)
  }

  private settleAll(result: RelayRefusal): void {
    for (const settle of [...this.pending.values()]) settle(result)
  }

  private refuse(socket: PcSocket): void {
    this.registering.get(socket)?.stop()
    this.registering.delete(socket)
    this.turnAway(socket, CLOSE.refused)
  }

  private turnAway(socket: PcSocket, code: number): void {
    this.deps.counters?.refused('registration')
    socket.close(code)
  }

  private refusal<R extends RelayRefusal | 'malformed'>(reason: R): R {
    this.deps.counters?.refused(reason)
    return reason
  }
}
