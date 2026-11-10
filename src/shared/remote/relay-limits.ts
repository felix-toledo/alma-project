/** Spec 027 BR-28 defaults. Tunable: tests read this object, never literals. */
export interface RelayLimits {
  frameBytes: number
  pcConnections: number
  phoneConnections: number
  framesPerMinute: number
  bytesPerDay: number
  attemptsPerMinutePerAddress: number
  unknownIdPerMinute: number
  unknownIdBackoffMs: number
  anonymousHandshakesPerMinute: number
  requestTimeoutMs: number
  /** How long a socket that connected may take to prove its key before it is closed. */
  registerTimeoutMs: number
}

export const REMOTE_RELAY_LIMITS: RelayLimits = {
  frameBytes: 4 * 1024 * 1024,
  pcConnections: 1,
  phoneConnections: 15,
  framesPerMinute: 900,
  bytesPerDay: 1024 * 1024 * 1024,
  // Counts every phone request and every PC connection attempt from one address. Twice the channel's 60 a minute per device (BR-10).
  attemptsPerMinutePerAddress: 120,
  unknownIdPerMinute: 10,
  unknownIdBackoffMs: 5 * 60_000,
  anonymousHandshakesPerMinute: 10,
  requestTimeoutMs: 35_000,
  registerTimeoutMs: 10_000
}
