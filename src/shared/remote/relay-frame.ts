// The wire contract of the relay (spec 027 PD-2). Imported by the PC, the phone and src/relay: browser-safe, nothing but zod.
import * as z from 'zod/v4'
import type { PublicJwk } from './crypto'
import { REMOTE_RELAY_LIMITS } from './relay-limits'

export const RELAY_PROTOCOL = { current: 1, previous: 0 } as const

/** WebSocket close codes between the PC and the relay (PD-2). 4010 is the relay telling the PC it has ended for good (BR-29). */
export const RELAY_CLOSE = { refused: 4001, replaced: 4002, heldByAnotherKey: 4003, full: 4008, version: 4009, gone: 4010 } as const

export type RelayFrame =
  | { v: number; t: 'hs1'; ea: string; na: string }
  | { v: number; t: 'hs2'; sid: string; eb: string; nb: string; pc: PublicJwk; sig: string }
  | { v: number; t: 'hs3'; sid: string; ct: string }
  | { v: number; t: 'hs4'; sid: string; ct: string }
  | { v: number; t: 'q' | 'a'; sid: string; ctr: number; ct: string }
export type RelayRefusal = 'offline' | 'full' | 'timeout' | 'version' | 'gone'
export type PcToRelay =
  | { k: 'reg'; pub: PublicJwk; sig: string }
  | { k: 'r'; rid: string; frame: RelayFrame }
  // The PC refuses a request it cannot answer: its session is unknown, expired or failed authentication.
  | { k: 'x'; rid: string; refusal: 'gone' }
export type RelayToPc = { k: 'challenge'; nonce: string } | { k: 'ready' } | { k: 'f'; rid: string; frame: RelayFrame } | { k: 'abort'; rid: string }

const text = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/)
// AES-GCM adds a 16-byte tag, which alone is 22 base64url characters.
const sealed = z.string().min(22).max(REMOTE_RELAY_LIMITS.frameBytes).regex(/^[A-Za-z0-9_-]+$/)
const version = z.union([z.literal(RELAY_PROTOCOL.current), z.literal(RELAY_PROTOCOL.previous)])
const sid = text(64)
const publicKey = z.strictObject({ kty: z.literal('EC'), crv: z.literal('P-256'), x: text(64), y: text(64) })

export const relayFrameSchema: z.ZodType<RelayFrame> = z.discriminatedUnion('t', [
  z.strictObject({ v: version, t: z.literal('hs1'), ea: text(128), na: text(64) }),
  z.strictObject({ v: version, t: z.literal('hs2'), sid, eb: text(128), nb: text(64), pc: publicKey, sig: text(128) }),
  z.strictObject({ v: version, t: z.literal('hs3'), sid, ct: sealed }),
  z.strictObject({ v: version, t: z.literal('hs4'), sid, ct: sealed }),
  z.strictObject({ v: version, t: z.enum(['q', 'a']), sid, ctr: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), ct: sealed })
])

const rid = text(64)

export const pcToRelaySchema: z.ZodType<PcToRelay> = z.discriminatedUnion('k', [
  z.strictObject({ k: z.literal('reg'), pub: publicKey, sig: text(128) }),
  z.strictObject({ k: z.literal('r'), rid, frame: relayFrameSchema }),
  z.strictObject({ k: z.literal('x'), rid, refusal: z.literal('gone') })
])

export const relayToPcSchema: z.ZodType<RelayToPc> = z.discriminatedUnion('k', [
  z.strictObject({ k: z.literal('challenge'), nonce: text(64) }),
  z.strictObject({ k: z.literal('ready') }),
  z.strictObject({ k: z.literal('f'), rid, frame: relayFrameSchema }),
  z.strictObject({ k: z.literal('abort'), rid })
])

/** What the PC signs to register a routing id. The NUL separators keep the id and the nonce from sliding into each other. */
export function registrationMessage(routingId: string, nonce: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(`alma-relay-reg\0${routingId}\0`)
  const message = new Uint8Array(head.length + nonce.length)
  message.set(head)
  message.set(nonce, head.length)
  return message
}

export type ParsedFrame = { ok: true; frame: RelayFrame } | { ok: false; reason: 'version' | 'malformed' }

/** Where the version check lives: a frame whose `v` is an integer this build does not speak reads as `version`, whatever else it holds (a newer protocol may change the shape); everything else that fails the schema is `malformed`. */
export function parseRelayFrame(raw: unknown): ParsedFrame {
  const parsed = relayFrameSchema.safeParse(raw)
  if (parsed.success) return { ok: true, frame: parsed.data }
  const v = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as { v?: unknown }).v : undefined
  const supported = v === RELAY_PROTOCOL.current || v === RELAY_PROTOCOL.previous
  return { ok: false, reason: typeof v === 'number' && Number.isInteger(v) && !supported ? 'version' : 'malformed' }
}
