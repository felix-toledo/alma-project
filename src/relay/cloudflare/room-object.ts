import { answerFor, toResponse } from '../answer'
import { parseAttachment } from '../attachment'
import { declaredBytes, readFrameBody } from '../body'
import { createCounters, logCounters } from '../counters'
import { remoteAddressLimits } from '../gate'
import { REMOTE_RELAY_LIMITS } from '../../shared/remote/relay-limits'
import { CLOSE, type PcSocket, RelayRoom } from '../room'
import { isPaused, requestLine, routeOf } from '../route'

const random = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length))

/**
 * The Durable Object of one routing id: the platform's sockets and requests on one side, the `RelayRoom` on the other.
 * It decides nothing. The PC's socket is accepted with the hibernation API and what it must keep (the id and the hash of
 * its key) rides on the socket itself, so the object can sleep and the room finds its PC again when it wakes.
 */
export class RoomObject {
  private room: RelayRoom | null = null
  private id = ''
  private readonly counters = createCounters()
  private readonly sockets = new WeakMap<WebSocket, PcSocket>()

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: RelayEnv
  ) {
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    for (const socket of state.getWebSockets()) {
      const kept = parseAttachment(socket.deserializeAttachment())
      if (kept) this.roomFor(kept.id).restorePc(this.socketOf(socket), kept.keyHash)
      else socket.close(CLOSE.refused)
    }
  }

  async fetch(request: Request): Promise<Response> {
    const route = routeOf(requestLine(request))
    const address = request.headers.get('cf-connecting-ip') ?? 'unknown'
    if (route.kind === 'pc') {
      const pair = new WebSocketPair()
      this.state.acceptWebSocket(pair[1])
      pair[1].serializeAttachment({ id: route.id, keyHash: null })
      await this.roomFor(route.id).acceptPc(this.socketOf(pair[1]), address)
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    if (route.kind !== 'frame') return toResponse(answerFor('not-found'))
    const { raw, bytes } = await readFrameBody(request.body, REMOTE_RELAY_LIMITS.frameBytes, declaredBytes(request.headers.get('content-length')))
    try {
      return toResponse(answerFor(await this.roomFor(route.id).forward(raw, { address, bytes, signal: request.signal })))
    } catch {
      // The phone went away while it waited: nobody is left to answer.
      return new Response(null, { status: 499 })
    }
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === 'string') await this.room?.onPcMessage(this.socketOf(socket), message)
  }

  webSocketClose(socket: WebSocket): void {
    this.room?.onPcClose(this.socketOf(socket))
    try {
      socket.close()
    } catch {
      // Already closed by the other side.
    }
    logCounters(this.counters)
  }

  webSocketError(socket: WebSocket): void {
    this.webSocketClose(socket)
  }

  private roomFor(id: string): RelayRoom {
    this.id = id
    this.room ??= new RelayRoom({
      routingId: id,
      random,
      counters: this.counters,
      paused: () => isPaused(this.env.RELAY_PAUSED),
      addresses: remoteAddressLimits(async (op, address) => {
        const gate = this.env.GATE.get(this.env.GATE.idFromName('addresses'))
        const response = await gate.fetch(new Request('https://gate.invalid/', { method: 'POST', body: JSON.stringify({ op, address }) }))
        return (await response.json()) === true
      })
    })
    return this.room
  }

  private socketOf(socket: WebSocket): PcSocket {
    let wrapped = this.sockets.get(socket)
    if (!wrapped) {
      wrapped = {
        send: (message) => socket.send(message),
        close: (code, reason) => socket.close(code, reason),
        remember: (keyHash) => socket.serializeAttachment({ id: this.id, keyHash })
      }
      this.sockets.set(socket, wrapped)
    }
    return wrapped
  }
}
