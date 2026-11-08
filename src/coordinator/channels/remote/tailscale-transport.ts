// The production remote transport (T32): plain HTTP on loopback behind
// `tailscale serve`. The API runs the channel handler; anything else serves
// the built PWA with traversal protection and a strict CSP.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import http from 'node:http'
import type { Socket } from 'node:net'
import { extname, join, sep } from 'node:path'
import type { RemoteHandler, RemoteRequest, RemoteResponse } from '../../../shared/remote/api'
import { translate } from '../../../shared/i18n/messages'
import { exceedsRequestBytes } from './limits'
import { refusalResponse, type RemoteTransport, TransportStartError } from './transport'

export interface TailscaleTransportDeps {
  port: number
  assetsDir: string
  dnsName: string
}

/** AC-3.4: loopback is the only address we bind; anything else throws. */
export function bindAddress(address: string): '127.0.0.1' {
  if (address !== '127.0.0.1') throw new RangeError(`refusing to bind ${address}: loopback only`)
  return '127.0.0.1'
}

/**
 * Maps a URL path to a file under the assets root, or null when it must be
 * refused: bad encoding, empty/dot/dot-dot segments, backslashes (a Windows
 * separator), drive or stream colons, null bytes. Symlink escapes are caught
 * again by the realpath check at serve time.
 */
export function resolveAssetPath(assetsDir: string, pathname: string): string | null {
  const stripped = pathname.replace(/^\/+/, '')
  if (stripped === '') return join(assetsDir, 'index.html')
  let decoded: string
  try {
    decoded = decodeURIComponent(stripped)
  } catch {
    return null
  }
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes(':') || segment.includes('\0')) {
      return null
    }
  }
  return join(assetsDir, ...decoded.split('/'))
}

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
}

// data: only for images: camera stills and note images arrive as base64 (never https:, never blob:).
const PWA_CSP = "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"

/** The phone's browser language is unknown, so the notice renders in both PC languages. */
export const notBuiltPage = (): string =>
  '<!doctype html><html><head><meta charset="utf-8"><title>Alma</title></head>' +
  `<body><p>${translate('en', 'remote.serve.notBuilt')}</p><p>${translate('es', 'remote.serve.notBuilt')}</p></body></html>`

export class TailscaleTransport implements RemoteTransport {
  readonly id = 'tailscale' as const
  private server: http.Server | null = null
  private handler: RemoteHandler | null = null
  private readonly sockets = new Set<Socket>()
  private readonly socketTokens = new Map<Socket, Set<string>>()
  private readonly tokenDevice = new Map<string, string>()

  constructor(private readonly deps: TailscaleTransportDeps) {}

  async start(handler: RemoteHandler): Promise<{ address: string }> {
    this.handler = handler
    const server = http.createServer((request, response) => void this.onRequest(request, response))
    this.server = server
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => {
        this.sockets.delete(socket)
        this.socketTokens.delete(socket)
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: unknown): void => {
          server.removeListener('error', onError)
          reject(error)
        }
        server.on('error', onError)
        server.listen(this.deps.port, bindAddress('127.0.0.1'), () => {
          server.removeListener('error', onError)
          resolve()
        })
      })
    } catch (error) {
      if ((error as { code?: unknown }).code === 'EADDRINUSE') throw new TransportStartError('portTaken', String(this.deps.port))
      throw new TransportStartError('listener', error instanceof Error ? error.message : String(error))
    }
    server.on('error', (error) => console.error('[remote] listener error:', error instanceof Error ? error.message : String(error)))
    return { address: `https://${this.deps.dnsName.toLowerCase().replace(/\.$/, '')}` }
  }

  async stop(): Promise<void> {
    for (const socket of [...this.sockets]) socket.destroy()
    this.sockets.clear()
    this.socketTokens.clear()
    this.tokenDevice.clear()
    const server = this.server
    this.server = null
    this.handler = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** The loopback port the server holds, once started (ephemeral in tests). */
  localPort(): number | null {
    const address = this.server?.address() ?? null
    return typeof address === 'object' && address !== null ? address.port : null
  }

  track(token: string, deviceId: string): void {
    this.tokenDevice.set(token, deviceId)
  }

  closeDevice(deviceId: string): void {
    for (const [socket, tokens] of this.socketTokens) {
      for (const token of tokens) {
        if (this.tokenDevice.get(token) === deviceId) {
          socket.destroy()
          break
        }
      }
    }
  }

  private async onRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      // Never new URL(): WHATWG parsing normalizes dot segments (even encoded) before we can refuse them.
      const rawPath = (request.url ?? '/').split('?')[0] ?? '/'
      const method = request.method ?? 'GET'
      if (method === 'GET' && rawPath !== '/api' && !rawPath.startsWith('/api/')) return this.serveStatic(response, rawPath)
      if (rawPath !== '/api' && !rawPath.startsWith('/api/')) return this.sendStatus(response, 404)
      await this.serveApi(request, response, rawPath)
    } catch {
      if (!response.headersSent) {
        try {
          this.sendApi(response, { status: 500, body: { error: 'failed' } })
        } catch {
          response.destroy()
        }
      }
    }
  }

  private async serveApi(request: http.IncomingMessage, response: http.ServerResponse, path: string): Promise<void> {
    const handler = this.handler
    if (!handler) return this.sendApi(response, { status: 503, body: { error: 'failed' } })
    const { tooLarge, raw } = await this.readBody(request)
    if (tooLarge) {
      this.sendApi(response, refusalResponse('too-large'))
      request.socket.destroy()
      return
    }
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(request.headers)) headers[name] = Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
    const bearer = /^Bearer (.+)$/.exec(headers['authorization'] ?? '')?.[1]
    if (bearer) {
      let tokens = this.socketTokens.get(request.socket)
      if (!tokens) {
        tokens = new Set()
        this.socketTokens.set(request.socket, tokens)
      }
      tokens.add(bearer)
    }
    let body: unknown
    if (raw !== '') {
      try {
        body = JSON.parse(raw) as unknown
      } catch {
        body = raw
      }
    }
    const remoteRequest: RemoteRequest = {
      method: request.method ?? 'GET',
      path,
      query: new URLSearchParams((request.url ?? '').split('?')[1] ?? ''),
      headers,
      body,
      remoteAddress: request.socket.remoteAddress ?? ''
    }
    const controller = new AbortController()
    // The request's own 'close' fires once the body is read; only the response closing unfinished means the phone left.
    response.on('close', () => {
      if (!response.writableFinished) controller.abort()
    })
    this.sendApi(response, await handler(remoteRequest, controller.signal))
  }

  /** Reads the body, measuring raw bytes before parsing; past the cap it drains and reports. */
  private readBody(request: http.IncomingMessage): Promise<{ tooLarge: boolean; raw: string }> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let tooLarge = false
      request.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (exceedsRequestBytes(size)) {
          tooLarge = true
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => resolve({ tooLarge, raw: Buffer.concat(chunks).toString('utf8') }))
      request.on('error', reject)
    })
  }

  private sendApi(response: http.ServerResponse, result: RemoteResponse): void {
    const headers: Record<string, string> = { ...result.headers, 'cache-control': 'no-store' }
    let payload: Buffer
    let contentType = 'application/json'
    if (result.body instanceof Uint8Array) {
      payload = Buffer.from(result.body.buffer, result.body.byteOffset, result.body.byteLength)
      contentType = 'application/octet-stream'
    } else if (result.body === undefined) {
      payload = Buffer.alloc(0)
    } else {
      payload = Buffer.from(JSON.stringify(result.body))
    }
    if (!headers['content-type']) headers['content-type'] = contentType
    response.writeHead(result.status, headers)
    response.end(payload)
  }

  private serveStatic(response: http.ServerResponse, pathname: string): void {
    if (!existsSync(this.deps.assetsDir)) {
      response.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(notBuiltPage())
      return
    }
    const file = resolveAssetPath(this.deps.assetsDir, pathname)
    if (file === null) return this.sendStatus(response, 404)
    let real: string
    let root: string
    try {
      real = realpathSync(file)
      root = realpathSync(this.deps.assetsDir)
    } catch {
      return this.sendStatus(response, 404)
    }
    if (real !== root && !real.startsWith(root + sep)) return this.sendStatus(response, 404)
    let data: Buffer
    try {
      data = readFileSync(real)
    } catch {
      return this.sendStatus(response, 404)
    }
    response.writeHead(200, {
      'content-type': STATIC_TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream',
      'content-security-policy': PWA_CSP,
      'x-content-type-options': 'nosniff'
    })
    response.end(data)
  }

  private sendStatus(response: http.ServerResponse, status: number): void {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(status === 404 ? 'not found' : 'error')
  }
}
