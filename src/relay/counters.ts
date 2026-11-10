// The only place the relay writes a log line, and it writes aggregate numbers: no payload, no address, no routing id (spec 027 AC-6.2).

/** Every reason the relay refuses something, plus a failed PC registration. */
const REASONS = ['offline', 'full', 'timeout', 'version', 'gone', 'malformed', 'registration'] as const
export type Refusal = (typeof REASONS)[number]

export interface CountersSnapshot {
  framesForwarded: number
  pcRegistrations: number
  refusals: Record<Refusal, number>
}

export interface RelayCounters {
  forwarded(): void
  registered(): void
  refused(reason: Refusal): void
  snapshot(): CountersSnapshot
}

export function createCounters(): RelayCounters {
  let framesForwarded = 0
  let pcRegistrations = 0
  const refusals = Object.fromEntries(REASONS.map((reason) => [reason, 0])) as Record<Refusal, number>
  return {
    forwarded: () => void framesForwarded++,
    registered: () => void pcRegistrations++,
    refused: (reason) => void refusals[reason]++,
    snapshot: () => ({ framesForwarded, pcRegistrations, refusals: { ...refusals } })
  }
}

export function logCounters(counters: RelayCounters, write: (line: string) => void = (line) => console.log(line)): void {
  write(JSON.stringify(counters.snapshot()))
}
