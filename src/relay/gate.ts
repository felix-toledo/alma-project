import type { RelayLimits } from '../shared/remote/relay-limits'
import { type AddressLimits, createAddressLimits } from './limits-state'

export type GateOp = 'attempt' | 'miss'

/**
 * What the one shared object answers. A room is alone with its own id, so the limits that count one address across all ids
 * live here. A call that is not an attempt or a miss for an address gets no verdict.
 */
export function answerGate(limits: RelayLimits, now: () => number): (call: unknown) => boolean | undefined {
  const addresses = createAddressLimits(limits, now)
  return (call) => {
    if (typeof call !== 'object' || call === null) return undefined
    const { op, address } = call as { op?: unknown; address?: unknown }
    if (typeof address !== 'string' || address === '') return undefined
    if (op === 'attempt') return addresses.attempt(address) as boolean
    if (op === 'miss') return addresses.miss(address) as boolean
    return undefined
  }
}

/** The room's side: each question goes to the shared object. If it cannot be reached the answer is no, so a failure never opens the door. */
export function remoteAddressLimits(call: (op: GateOp, address: string) => Promise<boolean>): AddressLimits {
  const ask = (op: GateOp, address: string): Promise<boolean> => call(op, address).catch(() => false)
  return { attempt: (address) => ask('attempt', address), miss: (address) => ask('miss', address) }
}
