// Pure Tailscale CLI parsing (T29): `tailscale status --json` and
// `tailscale serve status --json`, recorded by spike S2.

/** The absolute install path (S2): a process started before the install lacks it on PATH. */
export const TAILSCALE_EXE = 'C:\\Program Files\\Tailscale\\tailscale.exe'

/** The slice of `tailscale status --json` Alma reads (AC-2.1, S2). */
export interface TailscaleStatus {
  backendState: string
  online: boolean
  hostName: string | null
  dnsName: string | null
  magicDNSSuffix: string | null
  magicDNSEnabled: boolean
  certDomains: string[]
  keyExpiry: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/**
 * The DNS name without its one root dot. Tailscale emits `host.ts.net.` but
 * aborts a TLS handshake whose SNI carries the dot (alert 50), so no URL,
 * origin or rpId is ever built from the dotted form.
 */
export function bareDnsName(name: string): string {
  return name.endsWith('.') ? name.slice(0, -1) : name
}

/** Parses `tailscale status --json`; garbage and empty input read as null. */
export function parseStatus(json: string): TailscaleStatus | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const self = isRecord(parsed.Self) ? parsed.Self : {}
  const tailnet = isRecord(parsed.CurrentTailnet) ? parsed.CurrentTailnet : {}
  const rawDns = asString(self.DNSName)
  return {
    backendState: asString(parsed.BackendState) ?? '',
    online: self.Online === true,
    hostName: asString(self.HostName),
    dnsName: rawDns === null ? null : bareDnsName(rawDns),
    magicDNSSuffix: asString(parsed.MagicDNSSuffix),
    magicDNSEnabled: tailnet.MagicDNSEnabled === true,
    certDomains: Array.isArray(parsed.CertDomains) ? parsed.CertDomains.filter((domain): domain is string => typeof domain === 'string') : [],
    keyExpiry: asString(self.KeyExpiry)
  }
}

export interface ServeCommand {
  argv: string[]
  display: string
}

/** A usable TCP port for our listener (AC-2.11): integers 1-65535. */
export function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
}

/** The only serve command Alma ever runs (AC-2.8): always `serve`, never `funnel`. */
export function serveCommand(port: number): ServeCommand {
  if (!isValidPort(port)) throw new RangeError(`port out of range: ${port}`)
  const argv = ['serve', '--bg', String(port)]
  return { argv, display: argv.join(' ') }
}

/**
 * The only removal Alma ever runs (AC-2.12, verified on a live tailnet): `off`
 * with `--set-path /` removes one path; without it, `off` disables the whole
 * proxy, and `reset` wipes everything, so neither is ever used.
 */
export function serveRemoveCommand(): ServeCommand {
  const argv = ['serve', '--https=443', '--set-path', '/', 'off']
  return { argv, display: argv.join(' ') }
}

/** Who owns Alma's slot (`/<dnsName>:443` `/`) in `serve status --json`. */
export type ServeOwner = 'none' | 'mine' | 'other'

/**
 * Reads who owns Alma's slot (AC-2.12/2.13): entries on other paths or ports are
 * ignored, so a foreign `/other` or `:8444` never blocks Alma. Garbage fails
 * closed to 'other': never publish blind.
 */
export function serveOwner(serveJson: string, self: { dnsName: string; port: number }): ServeOwner {
  let parsed: unknown
  try {
    parsed = JSON.parse(serveJson)
  } catch {
    return 'other'
  }
  if (!isRecord(parsed)) return 'other'
  const slot = `${self.dnsName.toLowerCase().replace(/\.$/, '')}:443`
  const web = isRecord(parsed.Web) ? parsed.Web : {}
  let entry: unknown
  for (const [key, value] of Object.entries(web)) {
    if (key.toLowerCase() === slot) entry = value
  }
  const handlers = isRecord(entry) && isRecord(entry.Handlers) ? entry.Handlers : {}
  const root = isRecord(handlers['/']) ? handlers['/'] : null
  const proxy = root !== null && typeof root.Proxy === 'string' ? root.Proxy : null
  if (proxy === null) return 'none'
  return proxy.toLowerCase() === `http://127.0.0.1:${self.port}` ? 'mine' : 'other'
}

/** Whole days from now to the ISO expiry (AC-2.10): null stays null, past goes negative. */
export function daysToExpiry(keyExpiry: string | null, now: number): number | null {
  if (keyExpiry === null) return null
  const expiry = Date.parse(keyExpiry)
  if (Number.isNaN(expiry)) return null
  return Math.floor((expiry - now) / 86_400_000)
}

/** The recorded *.ts.net name differs from the current one (AC-2.15); unknown on either side is not a rename. */
export function isHostRenamed(recorded: string | null, current: string | null): boolean {
  if (recorded === null || current === null) return false
  const normalize = (name: string): string => name.toLowerCase().replace(/\.$/, '')
  return normalize(recorded) !== normalize(current)
}
