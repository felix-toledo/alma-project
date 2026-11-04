// A small Home Assistant client: REST for config flows, automations and camera pictures; one WebSocket for
// registries, states, service calls and live events. Node's global WebSocket, so no dependency.

export class HaError extends Error {}

type Pending = { resolve(value: unknown): void; reject(error: Error): void }

export interface StateObject {
  entity_id: string
  state: string
  attributes: Record<string, unknown>
  last_changed?: string
  last_updated?: string
}

export interface HaEvent {
  event_type: string
  data: { entity_id?: string; old_state?: StateObject | null; new_state?: StateObject | null } & Record<string, unknown>
}

const REST_TIMEOUT_MS = 30_000
const CALL_TIMEOUT_MS = 30_000

export class HaClient {
  private socket: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private eventHandlers = new Set<(event: HaEvent) => void>()
  private closed = false
  private opening: Promise<void> | null = null

  constructor(
    readonly baseUrl: string,
    private token: string
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  setToken(token: string): void {
    this.token = token
  }

  /** Called with every subscribed event (state changes, registry updates). */
  onEvent(handler: (event: HaEvent) => void): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  /** Fires when the socket drops (the hub reconnects and reloads). */
  onClose?: () => void

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  // ---------------------------------------------------------------------------
  // REST

  async rest<T = unknown>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, options: { raw?: boolean; timeoutMs?: number } = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? REST_TIMEOUT_MS)
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let message = text
      try {
        const data = JSON.parse(text) as { message?: string; error?: string }
        message = data.message ?? data.error ?? text
      } catch {
        // plain text
      }
      throw new HaError(`Home Assistant respondió ${response.status}: ${message.slice(0, 400) || response.statusText}`)
    }
    if (options.raw) return Buffer.from(await response.arrayBuffer()) as T
    const text = await response.text()
    return (text ? JSON.parse(text) : null) as T
  }

  // ---------------------------------------------------------------------------
  // WebSocket

  /** Connects and authenticates (idempotent). */
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve()
    this.closed = false
    this.opening ??= this.open().finally(() => (this.opening = null))
    return this.opening
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${this.baseUrl.replace(/^http/, 'ws')}/api/websocket`)
      let authenticated = false
      const fail = (error: Error): void => {
        if (!authenticated) reject(error)
      }
      socket.onerror = () => fail(new HaError('No se pudo abrir la conexión con Home Assistant.'))
      socket.onclose = () => {
        fail(new HaError('Home Assistant cerró la conexión.'))
        if (this.socket === socket) this.socket = null
        for (const waiter of this.pending.values()) waiter.reject(new HaError('Se perdió la conexión con Home Assistant.'))
        this.pending.clear()
        if (authenticated && !this.closed) this.onClose?.()
      }
      socket.onmessage = (message) => {
        const data = JSON.parse(String(message.data)) as { type: string; id?: number; success?: boolean; result?: unknown; error?: { message?: string }; event?: HaEvent; message?: string }
        switch (data.type) {
          case 'auth_required':
            socket.send(JSON.stringify({ type: 'auth', access_token: this.token }))
            break
          case 'auth_ok':
            authenticated = true
            this.socket = socket
            resolve()
            break
          case 'auth_invalid':
            fail(new HaError(`Home Assistant rechazó el token: ${data.message ?? 'inválido'}`))
            socket.close()
            break
          case 'result': {
            const waiter = data.id === undefined ? undefined : this.pending.get(data.id)
            if (!waiter) break
            this.pending.delete(data.id!)
            if (data.success) waiter.resolve(data.result)
            else waiter.reject(new HaError(data.error?.message ?? 'Home Assistant devolvió un error.'))
            break
          }
          case 'event':
            for (const handler of this.eventHandlers) handler(data.event as HaEvent)
            break
        }
      }
    })
  }

  /** One WebSocket command; resolves with its result. */
  call<T = unknown>(message: Record<string, unknown>): Promise<T> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new HaError('Sin conexión con Home Assistant.'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new HaError('Home Assistant no respondió a tiempo.'))
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value as T)),
        reject: (error) => (clearTimeout(timer), reject(error))
      })
      socket.send(JSON.stringify({ id, ...message }))
    })
  }

  subscribe(eventType: string): Promise<unknown> {
    return this.call({ type: 'subscribe_events', event_type: eventType })
  }

  close(): void {
    this.closed = true
    this.socket?.close()
    this.socket = null
  }
}

/** Waits until Home Assistant answers its API (it takes a minute or two to boot). */
export async function waitForHa(url: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (signal?.aborted) throw new HaError('Cancelado.')
    try {
      const response = await fetch(`${url.replace(/\/+$/, '')}/api/onboarding`, { signal: AbortSignal.timeout(4000) })
      if (response.ok || response.status === 401 || response.status === 404) return
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new HaError('Home Assistant no arrancó a tiempo.')
}

export interface Onboarding {
  token: string
  username: string
  password: string
}

/**
 * Finishes Home Assistant's first-run wizard for a fresh install: creates Alma's own owner account, mints a
 * long-lived token for it, and closes the wizard's steps so nobody ever sees it.
 */
export async function onboard(url: string, password: string): Promise<Onboarding> {
  const base = url.replace(/\/+$/, '')
  const clientId = `${base}/`
  const post = async (path: string, body: unknown, token?: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REST_TIMEOUT_MS)
    })
    if (!response.ok) throw new HaError(`El asistente de Home Assistant falló en ${path}: ${response.status} ${(await response.text()).slice(0, 200)}`)
    return (await response.json().catch(() => ({}))) as Record<string, unknown>
  }
  const { auth_code } = await post('/api/onboarding/users', { client_id: clientId, name: 'Alma', username: 'alma', password, language: 'es' })
  const tokenResponse = await fetch(`${base}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: String(auth_code), client_id: clientId }),
    signal: AbortSignal.timeout(REST_TIMEOUT_MS)
  })
  if (!tokenResponse.ok) throw new HaError(`No se pudo obtener el token inicial: ${tokenResponse.status}`)
  const { access_token } = (await tokenResponse.json()) as { access_token: string }
  for (const step of ['core_config', 'analytics']) await post(`/api/onboarding/${step}`, {}, access_token).catch(() => undefined)
  await post('/api/onboarding/integration', { client_id: clientId, redirect_uri: `${clientId}?auth_callback=1` }, access_token).catch(() => undefined)

  const client = new HaClient(base, access_token)
  await client.connect()
  try {
    const longLived = await client.call<string>({ type: 'auth/long_lived_access_token', client_name: 'Alma', lifespan: 3650 })
    return { token: longLived, username: 'alma', password }
  } finally {
    client.close()
  }
}
