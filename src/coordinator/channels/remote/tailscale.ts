// The Tailscale side of remote access (T30/T31): detection, download, the
// connection check, Serve lifecycle. The CLI is injected, so tests feed it
// the spike S2 recordings.
import { execFile } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'
import type { RemoteFailure, WizardTailscale } from '../../../shared/types'
import { isValidPort, parseStatus, serveCommand, serveOwner, serveRemoveCommand, TAILSCALE_EXE } from '../../../shared/remote/tailscale'

/**
 * One CLI run. Code 127 means the binary itself is missing (the real exec maps
 * ENOENT to it); any other non-zero code means the binary ran and failed.
 */
export interface TailscaleExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface TailscaleDeps {
  exec(file: string, args: string[]): Promise<TailscaleExecResult>
  openExternal(target: 'tailscale-download' | 'tailscale-terms'): Promise<boolean>
  online(): Promise<boolean>
  pickPort(): Promise<number>
  store: {
    readonly state: { port: number | null; hostName: string | null }
    update(patch: { port?: number | null; hostName?: string | null }): Promise<void>
  }
  now(): number
  confirm(kind: 'serve', params: Record<string, string>): Promise<boolean>
}

export interface DetectFailure {
  failure: RemoteFailure
  detail?: string
}

export interface DetectResult {
  tailscale: WizardTailscale
  failure: DetectFailure | null
}

export interface ListenerState {
  listenerUp: boolean
  listenerDetail?: string
  channelFailure?: RemoteFailure
}

export type ServeResult = { ok: true } | { ok: false; failure: 'serveBusy' | 'denied' | 'tailscaleDown'; detail?: string }

const caused = (failure: RemoteFailure, detail?: string): DetectFailure => (detail === undefined ? { failure } : { failure, detail })

export class TailscaleController {
  constructor(private readonly deps: TailscaleDeps) {}

  /** Runs one tailscale command, falling back to the absolute path (S2: PATH alone is not enough). */
  private async run(args: string[]): Promise<{ missing: boolean; code: number; stdout: string; stderr: string }> {
    for (const file of ['tailscale', TAILSCALE_EXE]) {
      const result = await this.deps.exec(file, args)
      if (result.code !== 127) return { missing: false, code: result.code, stdout: result.stdout, stderr: result.stderr }
    }
    return { missing: true, code: 127, stdout: '', stderr: '' }
  }

  /** Reads status and serve-status once; both callers (detect, serve) share the parsing. */
  private async readState(): Promise<{ parsed: ReturnType<typeof parseStatus>; serveOut: string }> {
    const statusRun = await this.run(['status', '--json'])
    const serveRun = await this.run(['serve', 'status', '--json'])
    return {
      parsed: statusRun.missing ? null : parseStatus(statusRun.code === 0 ? statusRun.stdout : ''),
      serveOut: serveRun.code === 0 ? serveRun.stdout : ''
    }
  }

  /**
   * AC-2.1 + AC-2.4: detect Tailscale and run the ordered connection check
   * (internet, Tailscale, HTTPS/MagicDNS, serve path, listener). A channel
   * portTaken or serveBusy survives as the listener cause so the tab keeps
   * its remedy.
   */
  async detect(listener: ListenerState): Promise<DetectResult> {
    const statusRun = await this.run(['status', '--json'])
    const serveRun = await this.run(['serve', 'status', '--json'])
    const parsed = statusRun.missing ? null : parseStatus(statusRun.code === 0 ? statusRun.stdout : '')
    const serveOut = serveRun.code === 0 ? serveRun.stdout : ''
    const connected = parsed !== null && parsed.backendState === 'Running' && parsed.online
    const owner =
      parsed?.dnsName == null ? 'none' : serveOwner(serveOut, { dnsName: parsed.dnsName, port: this.deps.store.state.port ?? -1 })
    const tailscale: WizardTailscale = statusRun.missing
      ? { state: 'missing', https: false, serving: false }
      : {
          state: connected ? 'connected' : 'disconnected',
          https: (parsed?.magicDNSEnabled ?? false) && (parsed?.certDomains.length ?? 0) > 0,
          serving: owner === 'mine'
        }
    if (!(await this.deps.online())) return { tailscale, failure: caused('noInternet') }
    if (tailscale.state !== 'connected') return { tailscale, failure: caused('tailscaleDown') }
    if (!tailscale.https) return { tailscale, failure: caused('httpsOff') }
    if (owner === 'other') return { tailscale, failure: caused('serveBusy') }
    if (listener.channelFailure === 'portTaken' || listener.channelFailure === 'serveBusy') {
      return { tailscale, failure: caused(listener.channelFailure, listener.listenerDetail) }
    }
    if (!listener.listenerUp) return { tailscale, failure: caused('listener', listener.listenerDetail) }
    return { tailscale, failure: null }
  }

  /** AC-2.2: ask main to open the download page (main confirms and owns the URL). */
  async download(): Promise<boolean> {
    return this.deps.openExternal('tailscale-download')
  }

  /** AC-2.11: the saved port, or a freshly picked and saved one (an unusable saved port is picked again). */
  async ensurePort(): Promise<number> {
    const saved = this.deps.store.state.port
    if (saved !== null && isValidPort(saved)) return saved
    const port = await this.deps.pickPort()
    await this.deps.store.update({ port })
    return port
  }

  /**
   * AC-2.8/2.11/2.13: publish our Serve entry (confirm first, never overwrite
   * a foreign one). `previousPort` is the port being replaced (AC-2.16): an
   * entry pointing at it is ours and the same-path serve replaces it (PD-3).
   */
  async serve(previousPort: number | null = null): Promise<ServeResult> {
    const port = await this.ensurePort()
    const { parsed, serveOut } = await this.readState()
    if (parsed === null || parsed.dnsName === null) return { ok: false, failure: 'tailscaleDown' }
    const owner = serveOwner(serveOut, { dnsName: parsed.dnsName, port })
    const replaceable = previousPort !== null && serveOwner(serveOut, { dnsName: parsed.dnsName, port: previousPort }) === 'mine'
    if (owner === 'other' && !replaceable) return { ok: false, failure: 'serveBusy' }
    const cmd = serveCommand(port)
    if (!(await this.deps.confirm('serve', { command: cmd.display }))) return { ok: false, failure: 'denied' }
    const published = await this.run(cmd.argv)
    if (published.missing || published.code !== 0) {
      const detail = published.stderr || published.stdout || undefined
      return detail === undefined ? { ok: false, failure: 'tailscaleDown' } : { ok: false, failure: 'tailscaleDown', detail }
    }
    return { ok: true }
  }

  /** AC-2.16: drop the saved port, pick another, and serve again (asks again). */
  async pickPort(): Promise<ServeResult> {
    const previous = this.deps.store.state.port
    await this.deps.store.update({ port: null })
    return this.serve(previous)
  }

  /**
   * AC-2.12: remove our Serve entry and only it, with no dialog (it narrows
   * access). A failed removal resolves: the entry self-heals on the next serve.
   */
  async unserve(): Promise<void> {
    const port = this.deps.store.state.port
    if (port === null) return
    const { parsed, serveOut } = await this.readState()
    if (parsed === null || parsed.dnsName === null) return
    if (serveOwner(serveOut, { dnsName: parsed.dnsName, port }) !== 'mine') return
    await this.run(serveRemoveCommand().argv)
  }

  /** The current *.ts.net DNS name, for the transport's public address (T32). */
  async dnsName(): Promise<string | null> {
    const { parsed } = await this.readState()
    return parsed?.dnsName ?? null
  }

  /** The monitor's one read (T33): connected, key expiry and DNS name. */
  async probe(): Promise<{ connected: boolean; keyExpiry: string | null; dnsName: string | null }> {
    const { parsed } = await this.readState()
    return {
      connected: parsed !== null && parsed.backendState === 'Running' && parsed.online,
      keyExpiry: parsed?.keyExpiry ?? null,
      dnsName: parsed?.dnsName ?? null
    }
  }
}

const execFileAsync = promisify(execFile)

/** No free loopback port could be allocated. Carries no prose: shownError would echo the message to the UI. */
export class PortAllocationError extends Error {
  constructor() {
    super()
    this.name = 'PortAllocationError'
  }
}

/** The real free-port picker (glue): binds :0 on loopback, reads the port back, closes. */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (typeof address === 'object' && address !== null && address.port > 0) resolve(address.port)
        else reject(new PortAllocationError())
      })
    })
  })
}

/** The real CLI runner (glue): ENOENT reads as 127, anything else resolves with its code. */
export async function execTailscale(file: string, args: string[]): Promise<TailscaleExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown }
    if (failure.code === 'ENOENT') return { code: 127, stdout: '', stderr: 'not found' }
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr : ''
    }
  }
}
