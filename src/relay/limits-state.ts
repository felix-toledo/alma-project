import type { RelayLimits } from '../shared/remote/relay-limits'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
// Idle addresses are dropped at most once every PRUNE_EVERY: an address is gone soon after its window is over (BR-15), a flood
// of addresses cannot grow memory for long, and a busy relay does not walk them all on every call.
const PRUNE_EVERY = 10_000

/** A fixed window: the total since the window opened, reset to zero once `span` has passed. */
function windowed(span: number, now: () => number) {
  let start = now()
  let total = 0
  const roll = (): void => {
    if (now() - start >= span) {
      start = now()
      total = 0
    }
  }
  return {
    used(): number {
      roll()
      return total
    },
    add(amount: number): void {
      roll()
      total += amount
    },
    idle(): boolean {
      roll()
      return total === 0
    }
  }
}

/** The caps that belong to one routing id. Memory only: a restart resets them (BR-28). */
export interface RoomLimits {
  /** True when the request may go to the PC, and then it is counted: one frame in, one out, its bytes, a handshake if it is one. */
  admit(request: { bytes: number; handshake: boolean; inFlight: number }): boolean
  /** The PC's answer: its bytes count toward the day, but an answer is never refused. */
  answered(bytes: number): void
}

export function createRoomLimits(limits: RelayLimits, now: () => number): RoomLimits {
  const frames = windowed(MINUTE, now)
  const handshakes = windowed(MINUTE, now)
  const bytes = windowed(DAY, now)
  return {
    admit({ bytes: size, handshake, inFlight }) {
      if (inFlight >= limits.phoneConnections) return false
      if (frames.used() + 2 > limits.framesPerMinute) return false
      if (bytes.used() + size > limits.bytesPerDay) return false
      if (handshake && handshakes.used() + 1 > limits.anonymousHandshakesPerMinute) return false
      frames.add(2)
      bytes.add(size)
      if (handshake) handshakes.add(1)
      return true
    },
    answered(size) {
      bytes.add(size)
    }
  }
}

/** The caps that belong to a network address, across every routing id that address touches. */
export interface AddressLimits {
  /** A connection attempt, to any id. False while the address is blocked or over its attempts a minute. May answer later: on a platform with one room per id these limits live in one shared place. */
  attempt(address: string): boolean | Promise<boolean>
  /** An attempt at an id with no live PC. Past the cap the address is blocked for the backoff. */
  miss(address: string): boolean | Promise<boolean>
}

/**
 * What an address is counted as. A person on IPv6 holds a whole /64 and can change the rest at will, so the /64 is the key;
 * IPv4 (and an IPv4 inside IPv6) is the address. Anything else is kept as it came.
 */
export function addressKey(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return mapped[1] as string
  if (!address.includes(':')) return address
  const sides = address.toLowerCase().split('::')
  if (sides.length > 2) return address
  const head = sides[0] ? sides[0].split(':') : []
  const tail = sides[1] ? sides[1].split(':') : []
  const gap = 8 - head.length - tail.length
  if (sides.length === 2 ? gap < 1 : gap !== 0) return address
  const groups = [...head, ...Array<string>(sides.length === 2 ? gap : 0).fill('0'), ...tail]
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return address
  return groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(':')
}

export function createAddressLimits(limits: RelayLimits, now: () => number): AddressLimits {
  const seen = new Map<string, { attempts: ReturnType<typeof windowed>; misses: ReturnType<typeof windowed>; blockedUntil: number }>()
  let pruned = now()
  const entry = (address: string) => {
    const key = addressKey(address)
    if (now() - pruned >= PRUNE_EVERY) {
      pruned = now()
      for (const [other, value] of seen) if (value.blockedUntil <= now() && value.attempts.idle() && value.misses.idle()) seen.delete(other)
    }
    let found = seen.get(key)
    if (!found) {
      found = { attempts: windowed(MINUTE, now), misses: windowed(MINUTE, now), blockedUntil: 0 }
      seen.set(key, found)
    }
    return found
  }
  return {
    attempt(address) {
      const state = entry(address)
      if (state.blockedUntil > now()) return false
      if (state.attempts.used() + 1 > limits.attemptsPerMinutePerAddress) return false
      state.attempts.add(1)
      return true
    },
    miss(address) {
      const state = entry(address)
      if (state.blockedUntil > now()) return false
      state.misses.add(1)
      if (state.misses.used() > limits.unknownIdPerMinute) {
        state.blockedUntil = now() + limits.unknownIdBackoffMs
        return false
      }
      return true
    }
  }
}
