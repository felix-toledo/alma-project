// Which transport the remote channel runs (spec 027 BR-23): one at a time, chosen by the person, never by a failure.
export type TransportKind = 'tailscale' | 'relay'

/** The relay runs only when it is chosen and this build offers it (a packaged app with placeholders does not, AC-6.7). */
export function chooseTransport(input: { transport: TransportKind; available: boolean }): TransportKind {
  return input.transport === 'relay' && input.available ? 'relay' : 'tailscale'
}

export interface TransportPlan {
  use: TransportKind
  /** The Tailscale monitor runs: only for Tailscale, and only while remote access is on. */
  monitor: boolean
  /** Take down the Serve entry Tailscale may have left. With the relay selected Tailscale is touched for nothing else. */
  unserve: boolean
  /** Setup calls to Tailscale (detect, serve, pick a port) are allowed. */
  touchesTailscale: boolean
  /** The running transport is not the chosen one: stop it first, the channel keeps the one it started with. */
  restart: boolean
}

export function planTransportChange(input: { transport: TransportKind; available: boolean; enabled: boolean; active: TransportKind }): TransportPlan {
  const use = chooseTransport(input)
  const monitor = input.enabled && use === 'tailscale'
  return {
    use,
    monitor,
    unserve: !monitor && (use === 'tailscale' || input.active === 'tailscale'),
    touchesTailscale: use === 'tailscale',
    restart: use !== input.active
  }
}
