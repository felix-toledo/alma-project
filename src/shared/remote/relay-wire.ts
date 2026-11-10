// What travels inside a sealed relay frame (spec 027 PD-12): the request the phone's browser would have made, the
// answer the channel gave, and the control message that asks for the shell announcement. The relay never sees any of it.
import * as z from 'zod/v4'

export const relayRequestSchema = z.strictObject({
  k: z.literal('req'),
  // No shape rules beyond length: what is a route, a method or a path trick is the channel's decision, not the transport's.
  method: z.string().min(1).max(16),
  path: z.string().max(2048),
  query: z.string().max(2048).optional(),
  headers: z.record(z.string().max(64), z.string().max(4096)).optional(),
  body: z.unknown().optional()
})

/** Never routed to the handler, so the closed route table is untouched. */
export const relayControlSchema = z.strictObject({ k: z.literal('ctl'), op: z.literal('shell') })

export const relayPlainSchema = z.discriminatedUnion('k', [relayRequestSchema, relayControlSchema])
export type RelayPlain = z.infer<typeof relayPlainSchema>

export const relayResponseSchema = z.strictObject({
  k: z.literal('res'),
  status: z.number().int().min(100).max(599),
  contentType: z.string().max(200).optional(),
  cache: z.string().max(200).optional(),
  /** The body when it is JSON. */
  json: z.unknown().optional(),
  /** The body when it is bytes, base64url. */
  bytes: z.string().optional()
})
export type RelayWireResponse = z.infer<typeof relayResponseSchema>

export const relayShellAnswerSchema = z.strictObject({
  k: z.literal('shell'),
  announcement: z.strictObject({ version: z.number().int().min(0), rootHash: z.string().min(1).max(128), sig: z.string().min(1).max(128) }).nullable()
})
export type RelayShellAnswer = z.infer<typeof relayShellAnswerSchema>
