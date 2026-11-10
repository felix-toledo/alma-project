// The PC's one outbound WebSocket to the relay (spec 027 PD-2, PD-10): connects, registers, hands every phone frame
// to the host and every answer back, and reconnects by itself. It opens no listener: its only network activity is
// the WebSocket client it is given.
import { b64u, type PublicJwk } from '../../../shared/remote/crypto'
import { RELAY_CLOSE, type RelayFrame, registrationMessage, relayToPcSchema } from '../../../shared/remote/relay-frame'
import type { RelayState } from '../../../shared/remote/relay-status'
import type { RelayFailure } from '../../../shared/types'

/** The part of the runtime's WebSocket this needs. Handlers take `never` so the global WebSocket fits without a cast. */
export interface WebSocketLike {
  readonly readyState: number
  onopen: ((event: never) => void) | null
  onmessage: ((event: never) => void) | null
  onclose: ((event: never) => void) | null
  onerror: ((event: never) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}
export type WebSocketCtor = new (url: string) => WebSocketLike

export const BACKOFF = { startMs: 1_000, capMs: 60_000, jitter: 0.2, stableMs: 30_000 } as const
// The platform answers the text `ping` with `pong` without waking the room (PD-2).
export const KEEPALIVE = { pingMs: 25_000, silentMs: 70_000 } as const

/** 1 s, 2 s, 4 s, doubling to a 60 s cap, plus or minus 20 % jitter. `unit` is in [0, 1); `atCap` is for causes that wait the longest. */
export function retryDelay(attempt: number, unit: number, atCap = false): number {
  const base = atCap ? BACKOFF.capMs : Math.min(BACKOFF.capMs, BACKOFF.startMs * 2 ** Math.min(attempt, 30))
  return Math.round(base * (1 - BACKOFF.jitter + 2 * BACKOFF.jitter * unit))
}

/** `detail` is the close code, for the {reason} of the refused text; the words belong to the dictionaries. */
type Outcome = { failure: RelayFailure; detail?: string; retry: 'schedule' | 'cap' | 'never' }

function outcomeOf(code: number): Outcome {
  switch (code) {
    case RELAY_CLOSE.version:
      return { failure: 'relayVersion', retry: 'never' }
    case RELAY_CLOSE.gone:
      return { failure: 'relayGone', retry: 'never' }
    case RELAY_CLOSE.refused:
      return { failure: 'relayRefused', detail: String(code), retry: 'cap' }
    case RELAY_CLOSE.replaced:
      return { failure: 'relayRefused', detail: String(code), retry: 'cap' }
    case RELAY_CLOSE.heldByAnotherKey:
      return { failure: 'relayRefused', detail: String(code), retry: 'cap' }
    case RELAY_CLOSE.full:
      return { failure: 'relayFull', retry: 'cap' }
    default:
      return { failure: 'relayUnreachable', retry: 'schedule' }
  }
}

export interface RelayConnectionDeps {
  url: string
  routingId: string
  identity: { publicKey: PublicJwk; sign(data: Uint8Array): Promise<Uint8Array> }
  webSocket: WebSocketCtor
  schedule(fn: () => void, ms: number): () => void
  /** A number in [0, 1) for the retry jitter. */
  jitter(): number
  /** A phone frame for the host. `gone` refuses it; null sends nothing back (the relay times the request out). */
  onFrame(rid: string, frame: RelayFrame, signal: AbortSignal): Promise<RelayFrame | 'gone' | null>
  onState(state: RelayState): void
  /** Called each time the relay accepts the PC, so the sessions of the old connection are dropped (AC-3.11). */
  onConnected(): void
}

type Phase = 'open' | 'registering' | 'ready'
const none = (): void => {}

export class RelayConnection {
  private running = false
  private socket: WebSocketLike | null = null
  private failures = 0
  private reported: string | null = null
  private cancelRetry = none
  private cancelPing = none
  private cancelWatchdog = none
  private cancelStable = none
  private readonly inFlight = new Map<string, AbortController>()

  constructor(private readonly deps: RelayConnectionDeps) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.failures = 0
    this.report({ state: 'connecting' })
    this.open()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.cancelRetry()
    this.cancelRetry = none
    const socket = this.socket
    this.release()
    try {
      socket?.close(1000)
    } catch {
      // Already closed.
    }
    this.report({ state: 'off' })
  }

  private open(): void {
    const socket = new this.deps.webSocket(this.deps.url)
    this.socket = socket
    let phase: Phase = 'open'
    this.armWatchdog(socket)
    socket.onmessage = (event: { data: unknown }): void => {
      if (this.socket !== socket) return
      this.armWatchdog(socket)
      if (typeof event.data !== 'string') return
      const message = parseMessage(event.data)
      if (!message) return
      if (message.k === 'challenge' && phase === 'open') {
        phase = 'registering'
        void this.register(socket, message.nonce)
      } else if (message.k === 'ready' && phase === 'registering') {
        phase = 'ready'
        this.ready(socket)
      } else if (message.k === 'f' && phase === 'ready') {
        void this.serve(socket, message.rid, message.frame)
      } else if (message.k === 'abort') {
        this.inFlight.get(message.rid)?.abort()
      }
    }
    socket.onclose = (event: { code: number }): void => this.lose(socket, event.code)
    socket.onerror = none
  }

  private async register(socket: WebSocketLike, nonce: string): Promise<void> {
    try {
      const key = this.deps.identity.publicKey
      const sig = await this.deps.identity.sign(registrationMessage(this.deps.routingId, b64u.decode(nonce)))
      if (this.socket !== socket) return
      const pub = { kty: 'EC', crv: 'P-256', x: key.x ?? '', y: key.y ?? '' }
      socket.send(JSON.stringify({ k: 'reg', pub, sig: b64u.encode(sig) }))
    } catch {
      // A challenge we cannot answer ends in the relay closing the socket.
    }
  }

  private ready(socket: WebSocketLike): void {
    this.deps.onConnected()
    this.report({ state: 'online' })
    this.cancelStable()
    this.cancelStable = this.deps.schedule(() => {
      this.failures = 0
    }, BACKOFF.stableMs)
    const ping = (): void => {
      if (this.socket !== socket) return
      try {
        socket.send('ping')
      } catch {
        // The close that follows reports it.
      }
      this.cancelPing = this.deps.schedule(ping, KEEPALIVE.pingMs)
    }
    this.cancelPing = this.deps.schedule(ping, KEEPALIVE.pingMs)
  }

  private async serve(socket: WebSocketLike, rid: string, frame: RelayFrame): Promise<void> {
    const controller = new AbortController()
    this.inFlight.set(rid, controller)
    let answer: RelayFrame | 'gone' | null
    try {
      answer = await this.deps.onFrame(rid, frame, controller.signal)
    } catch {
      answer = 'gone'
    } finally {
      this.inFlight.delete(rid)
    }
    if (this.socket !== socket || controller.signal.aborted || answer === null) return
    socket.send(JSON.stringify(answer === 'gone' ? { k: 'x', rid, refusal: 'gone' } : { k: 'r', rid, frame: answer }))
  }

  private armWatchdog(socket: WebSocketLike): void {
    this.cancelWatchdog()
    this.cancelWatchdog = this.deps.schedule(() => {
      if (this.socket !== socket) return
      // Detach first, so the close event this causes is not read as the relay's.
      this.lose(socket, 1006)
      try {
        socket.close()
      } catch {
        // Already closed.
      }
    }, KEEPALIVE.silentMs)
  }

  /** Stops the timers and cancels what the phone was waiting on. */
  private release(): void {
    this.socket = null
    this.cancelPing()
    this.cancelWatchdog()
    this.cancelStable()
    this.cancelPing = this.cancelWatchdog = this.cancelStable = none
    for (const controller of this.inFlight.values()) controller.abort()
    this.inFlight.clear()
  }

  private lose(socket: WebSocketLike, code: number): void {
    if (this.socket !== socket) return
    this.release()
    const outcome = outcomeOf(code)
    this.failures++
    this.report({ state: 'error', failure: outcome.failure, ...(outcome.detail === undefined ? {} : { detail: outcome.detail }) })
    if (outcome.retry === 'never') return
    const delay = retryDelay(this.failures - 1, this.deps.jitter(), outcome.retry === 'cap')
    this.cancelRetry = this.deps.schedule(() => {
      this.cancelRetry = none
      if (this.running) this.open()
    }, delay)
  }

  /** One transition per change: the same state, or the same cause again, is not told twice. */
  private report(state: RelayState): void {
    const key = state.state === 'error' ? `error:${state.failure}` : state.state
    if (key === this.reported) return
    this.reported = key
    this.deps.onState(state)
  }
}

function parseMessage(text: string) {
  try {
    const parsed = relayToPcSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
