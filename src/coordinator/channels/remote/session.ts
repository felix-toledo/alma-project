import { b64u } from '../../../shared/remote/crypto'

export const SESSION_MS = 3_600_000
export const CHALLENGE_MS = 60_000

interface PendingChallenge {
  nonce: Uint8Array
  issuedAt: number
}

interface LiveSession {
  deviceId: string
  issuedAt: number
}

/**
 * Memory-only challenges and bearer tokens (PD-1). One pending challenge per device; a token is
 * an opaque random string, good for an hour. Expired entries drop lazily; no timers of its own.
 */
export class SessionStore {
  private readonly challenges = new Map<string, PendingChallenge>()
  private readonly tokens = new Map<string, LiveSession>()

  constructor(private readonly deps: { now(): number; random(length: number): Uint8Array }) {}

  /** A fresh single-use nonce for the device; a previous pending one is replaced. */
  challenge(deviceId: string): string {
    this.prune()
    const nonce = this.deps.random(32)
    this.challenges.set(deviceId, { nonce, issuedAt: this.deps.now() })
    return b64u.encode(nonce)
  }

  /** Consumes the pending challenge: one attempt per challenge, whatever its outcome. */
  attempt(deviceId: string): Uint8Array | null {
    this.prune()
    const pending = this.challenges.get(deviceId)
    this.challenges.delete(deviceId)
    return pending ? pending.nonce : null
  }

  issue(deviceId: string): { token: string; expiresIn: number } {
    this.prune()
    const token = b64u.encode(this.deps.random(32))
    this.tokens.set(token, { deviceId, issuedAt: this.deps.now() })
    return { token, expiresIn: SESSION_MS / 1000 }
  }

  resolve(token: string): { deviceId: string } | null {
    const found = this.tokens.get(token)
    if (!found) return null
    if (this.deps.now() - found.issuedAt >= SESSION_MS) {
      this.tokens.delete(token)
      return null
    }
    return { deviceId: found.deviceId }
  }

  revoke(deviceId: string): void {
    for (const [token, session] of this.tokens) if (session.deviceId === deviceId) this.tokens.delete(token)
    this.challenges.delete(deviceId)
  }

  private prune(): void {
    const now = this.deps.now()
    for (const [deviceId, pending] of this.challenges) if (now - pending.issuedAt >= CHALLENGE_MS) this.challenges.delete(deviceId)
    for (const [token, session] of this.tokens) if (now - session.issuedAt >= SESSION_MS) this.tokens.delete(token)
  }
}
