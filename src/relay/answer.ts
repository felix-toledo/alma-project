import { RELAY_PROTOCOL } from './frames'
import type { ForwardResult } from './room'

export interface HttpAnswer {
  status: number
  body: string
  headers: Record<string, string>
}

// Relay-level answers are plain JSON with an HTTP status and no secret (spec 027 PD-2).
const REFUSAL_STATUS = { offline: 503, full: 429, timeout: 504, version: 426, gone: 410, malformed: 400, 'not-found': 404 } as const
const HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' }

/** What the phone's HTTP request gets back for one forwarding result: the PC's frame, or a plain refusal. */
export function answerFor(result: ForwardResult | 'not-found'): HttpAnswer {
  if (typeof result === 'string') return { status: REFUSAL_STATUS[result], body: JSON.stringify({ error: result }), headers: { ...HEADERS } }
  return { status: 200, body: JSON.stringify(result), headers: { ...HEADERS } }
}

/** The same answer as an HTTP response. */
export const toResponse = (answer: HttpAnswer): Response => new Response(answer.body, { status: answer.status, headers: answer.headers })

/** What `/relay/v1/info` says: this address is a relay. The phone's shell asks once to know which way to talk. */
export const infoAnswer = (): HttpAnswer => ({ status: 200, body: JSON.stringify({ relay: true, v: RELAY_PROTOCOL.current }), headers: { ...HEADERS } })
