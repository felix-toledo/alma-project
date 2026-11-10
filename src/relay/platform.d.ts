// The few Cloudflare runtime types the adapter uses, written by hand so no platform package enters the install tree (spec 027 PD-8).
// They extend the web types the runtime shares with the browser; only what the adapter calls is declared.

interface WebSocket {
  /** The accepting side of a pair, for the classic API. The hibernation API accepts through the object's state instead. */
  accept(): void
  /** Small data that travels with the socket through a sleep of the object. */
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}

declare class WebSocketPair {
  0: WebSocket
  1: WebSocket
}

/** A request text the platform answers by itself, without waking the object. */
declare class WebSocketRequestResponsePair {
  constructor(request: string, response: string)
  readonly request: string
  readonly response: string
}

interface ResponseInit {
  webSocket?: WebSocket | null
}

interface DurableObjectId {
  toString(): string
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub
}

interface DurableObjectState {
  acceptWebSocket(socket: WebSocket): void
  getWebSockets(): WebSocket[]
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void
}

/** The static assets of the deployment: the phone app and its manifest. */
interface AssetsFetcher {
  fetch(request: Request): Promise<Response>
}

/** The bindings declared in relay/wrangler.toml. */
interface RelayEnv {
  ROOM: DurableObjectNamespace
  GATE: DurableObjectNamespace
  ASSETS: AssetsFetcher
  RELAY_PAUSED?: string
}
