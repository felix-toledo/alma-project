import type { RemoteHandler, RemoteRequest, RemoteResponse } from '../../src/shared/remote/api'
import { exceedsRequestBytes } from '../../src/coordinator/channels/remote/limits'
import { refusalResponse, type RemoteTransport } from '../../src/coordinator/channels/remote/transport'

/**
 * In-process RemoteTransport for tests: requests run the handler directly, with chosen headers and
 * remote address. Lives under tests/ so a shipped build cannot select it (AC-3.7).
 */
export class LocalTestTransport implements RemoteTransport {
  readonly id = 'test' as const
  handler: RemoteHandler | null = null
  startedCount = 0
  stopped = false
  startError: unknown = null
  readonly openDevices = new Set<string>()
  readonly closedDevices: string[] = []

  async start(handler: RemoteHandler): Promise<{ address: string }> {
    if (this.startError) throw this.startError
    this.handler = handler
    this.startedCount++
    return { address: 'https://test.invalid' }
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const id of [...this.openDevices]) this.closeDevice(id)
    this.handler = null
  }

  closeDevice(deviceId: string): void {
    this.closedDevices.push(deviceId)
    this.openDevices.delete(deviceId)
  }

  readonly tracked = new Map<string, string>()

  track(token: string, deviceId: string): void {
    this.tracked.set(token, deviceId)
  }

  /** Pretend a device holds a connection (a long-poll). */
  holdConnection(deviceId: string): void {
    this.openDevices.add(deviceId)
  }

  /** Run one request through the handler, like the real transport would. Header names are lowercased. */
  async request(input: {
    method: string
    path: string
    query?: string
    headers?: Record<string, string>
    body?: unknown
    remoteAddress?: string
    /** The phone going away: aborts the handler signal like a closed connection does. */
    signal?: AbortSignal
  }): Promise<RemoteResponse> {
    if (!this.handler) throw new Error('transport not started')
    // Real transports measure raw bytes before parsing; the JSON length approximates it here.
    const wireLength = input.body === undefined ? 0 : (JSON.stringify(input.body) ?? '').length
    if (exceedsRequestBytes(wireLength)) return refusalResponse('too-large')
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = value
    const request: RemoteRequest = {
      method: input.method,
      path: input.path,
      query: new URLSearchParams(input.query ?? ''),
      headers,
      body: input.body,
      remoteAddress: input.remoteAddress ?? '10.0.0.1'
    }
    return this.handler(request, input.signal ?? new AbortController().signal)
  }
}
