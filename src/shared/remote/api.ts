import * as z from 'zod/v4'
import { PENDING_ID_MAX } from '../attach/phone'
import { decodedLength } from '../attach/request'
import type { RemoteScope } from '../types'
import { REMOTE_LIMITS } from './limits'

export { REMOTE_LIMITS }

export interface RouteSpec {
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  auth: 'none' | 'pairing' | 'session'
  scope?: RemoteScope | readonly RemoteScope[]
  /** 'open' writes an entry with a target for a read of content (spec 028 BR-30); 'none' reads are not audited. */
  audit: 'none' | 'change' | 'picture' | 'open' | 'upload'
  body?: z.ZodType
  sensitive?: true
  /** Needs the continue-conversations sub-switch (spec 028 BR-18). */
  continue?: true
  /** Needs the send-files sub-switch (spec 031): always, or only when the body carries attachment ids. */
  files?: 'always' | 'with-ids'
}

export interface RemoteRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: Record<string, string>
  body: unknown
  /** For logs only: no function reads it to decide. */
  remoteAddress: string
}

export interface RemoteResponse {
  status: number
  headers?: Record<string, string>
  body?: unknown | Uint8Array
}

export type RemoteHandler = (request: RemoteRequest, signal: AbortSignal) => Promise<RemoteResponse>

/** What the phone sees of a pending approval: only what the Telegram surface shows (plan 3, PD-12). */
export interface ApprovalView {
  id: string
  tool: string
  /** The input as JSON, cut at REMOTE_LIMITS.approvalInputChars. */
  input: string
  flagged: boolean
  reason?: string
  /** The conversation the run belongs to; absent means the shared remote thread (spec 028 BR-20). */
  thread?: string
  /** The question the card asks, as the same key Telegram uses. */
  question: 'chan.allowQuestion' | 'chan.flagged'
  /** False when the input does not fit in the cut above and the tool is a company one: the phone shows no Permitir (spec 029 BR-23). */
  whole: boolean
}

export type Refusal =
  | 'unknown-device'
  | 'scope-off'
  | 'sensitive-off'
  | 'step-up-required'
  | 'camera-not-allowed'
  | 'rate-limited'
  | 'invalid'
  | 'too-large'
  | 'unknown-route'
  | 'already-answered'
  | 'locked'
  | 'expired'
  | 'busy'
  | 'limit'
  | 'write-off'
  | 'unavailable'
  | 'gone'
  | 'unsupported'
  | 'run-active'
  | 'attach-off'
  | 'notice-needed'
  | 'too-many'
  | 'secret-name'
  | 'file-type'
  | 'file-content'
  | 'file-empty'
  | 'file-malformed'
  | 'storage'

/** Request bodies. Top level is strict (unknown keys are rejected); only specified limits are enforced. */
/** Counted in UTF-16 units like the phone's own check; a text that is blank after trim starts no run. */
const sendText = z.string().max(REMOTE_LIMITS.chatChars)
/**
 * Pending upload ids a send binds (spec 031 AC-4.1). Only each id is bounded here; the length of the list is bounded by the
 * request cap. More than 5 ids, a duplicate or an empty id are the claim's to refuse as `unavailable`, one answer for every cause (AC-4.2).
 */
export const attachmentIds = z.array(z.string().max(PENDING_ID_MAX))
/** A blank text is still refused, unless at least one pending upload goes with it (spec 031 AC-4.1). */
const hasMessage = (body: { text: string; attachments?: string[] }) => body.text.trim().length > 0 || (body.attachments?.length ?? 0) > 0
export const chatSendBody = z.object({ text: sendText, attachments: attachmentIds.optional() }).strict().refine(hasMessage)
export const approvalsAnswerBody = z.object({ id: z.string(), decision: z.enum(['allow', 'deny']) }).strict()
export const homeControlBody = z.object({ thing: z.string(), action: z.string(), assertion: z.unknown().optional() }).strict()
export const stepupChallengeBody = z.object({ thing: z.string(), action: z.string() }).strict()
export const sessionChallengeBody = z.object({ deviceId: z.string() }).strict()
export const sessionBody = z.object({ deviceId: z.string(), signature: z.string() }).strict()
/** 32 bytes as unpadded base64url: the offer secret and the P-256 coordinates are all this shape. */
const b64u32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
/** 16 bytes as unpadded base64url: the PC nonce. */
const b64u16 = z.string().regex(/^[A-Za-z0-9_-]{22}$/)
/** The material members are strict; metadata a real export carries (key_ops, ext) passes through. */
const p256Key = z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: b64u32, y: b64u32 }).catchall(z.unknown())
export const pairRequestBody = z.object({ secret: b64u32, phonePublicKey: p256Key }).strict()
export const pairPasskeyBody = z.object({ offer: b64u32, pcNonce: b64u16, attestationObject: z.string().min(1), clientDataJSON: z.string().min(1) }).strict()
export const pushSubscribeBody = z.object({ endpoint: z.string(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }).strict()
export const pongBody = z.object({ ping: z.string() }).strict()
/** Technical bounds, not business rules: a vault path and a thread id never need more. */
const PATH_MAX = 1024
const pathText = z.string().max(PATH_MAX)
const threadId = z.string().min(1).max(64)
export const notesListBody = z.object({ folder: pathText }).strict()
export const notesFindBody = z.object({ query: z.string().max(200) }).strict()
export const notesReadBody = z.object({ path: pathText }).strict()
export const notesImageBody = z.object({ target: pathText, from: pathText }).strict()
export const threadsListBody = z.object({ offset: z.number().int().min(0) }).strict()
export const threadsReadBody = z
  .object({ id: threadId, before: z.number().int().min(0).optional(), since: z.number().int().min(0).optional(), wait: z.boolean().optional() })
  .strict()
export const threadsSendBody = z.object({ id: threadId, text: sendText, attachments: attachmentIds.optional() }).strict().refine(hasMessage)
export const threadsStopBody = z.object({ id: threadId }).strict()
const putShape = {
  name: z.string().min(1).max(512),
  // The decoded byte count decides, so a claimed size that differs is refused here; an empty file passes and the PC names its reason.
  size: z.number().int().min(0),
  // Bounded by the request cap only: a file over the phone's limit must reach the handler to be refused as too-large (AC-2.3).
  base64: z.string().max(REMOTE_LIMITS.requestBytes)
}
const sizeMatchesBytes = (body: { size: number; base64: string }) => decodedLength(body.base64) === body.size
export const putBody = z.object(putShape).strict().refine(sizeMatchesBytes)
export const putThreadBody = z.object({ id: threadId, ...putShape }).strict().refine(sizeMatchesBytes)
export const removeBody = z.object({ id: z.string().max(PENDING_ID_MAX) }).strict()
/** Bare POSTs take no keys at all (a `thread` key is refused, never ignored: AC-5.17). */
export const emptyBody = z.object({}).strict().optional()

/**
 * The closed list of BR-7: anything else is refused as unknown (AC-3.6).
 * `scope` as an array means any of them grants entry; the handler filters content per scope.
 * `sensitive` marks routes that need the locks-and-alarms sub-switch on.
 */
export const ROUTES: readonly RouteSpec[] = [
  { method: 'GET', path: '/api/hello', auth: 'none', audit: 'none' },
  { method: 'POST', path: '/api/pair/request', auth: 'pairing', audit: 'change', body: pairRequestBody },
  { method: 'GET', path: '/api/pair/status', auth: 'pairing', audit: 'none' },
  { method: 'POST', path: '/api/pair/passkey', auth: 'pairing', audit: 'change', body: pairPasskeyBody },
  { method: 'POST', path: '/api/session/challenge', auth: 'none', audit: 'none', body: sessionChallengeBody },
  { method: 'POST', path: '/api/session', auth: 'none', audit: 'none', body: sessionBody },
  { method: 'GET', path: '/api/state', auth: 'session', scope: ['chat', 'approve'], audit: 'none' },
  { method: 'POST', path: '/api/chat/send', auth: 'session', scope: 'chat', audit: 'change', files: 'with-ids', body: chatSendBody },
  { method: 'POST', path: '/api/chat/new', auth: 'session', scope: 'chat', audit: 'change', body: emptyBody },
  { method: 'POST', path: '/api/chat/stop', auth: 'session', scope: 'chat', audit: 'change', body: emptyBody },
  { method: 'GET', path: '/api/approvals', auth: 'session', scope: 'approve', audit: 'none' },
  { method: 'POST', path: '/api/approvals/answer', auth: 'session', scope: 'approve', audit: 'change', body: approvalsAnswerBody },
  { method: 'GET', path: '/api/home/things', auth: 'session', scope: 'home', audit: 'none' },
  { method: 'POST', path: '/api/stepup/challenge', auth: 'session', scope: 'home', audit: 'none', sensitive: true, body: stepupChallengeBody },
  { method: 'POST', path: '/api/home/control', auth: 'session', scope: 'home', audit: 'change', body: homeControlBody },
  { method: 'GET', path: '/api/cameras', auth: 'session', scope: 'cameras', audit: 'none' },
  { method: 'GET', path: '/api/cameras/still', auth: 'session', scope: 'cameras', audit: 'picture' },
  { method: 'GET', path: '/api/push/key', auth: 'session', audit: 'none' },
  { method: 'POST', path: '/api/push/subscribe', auth: 'session', audit: 'none', body: pushSubscribeBody },
  { method: 'DELETE', path: '/api/push', auth: 'session', audit: 'none' },
  { method: 'POST', path: '/api/pong', auth: 'session', audit: 'none', body: pongBody },
  { method: 'POST', path: '/api/forget', auth: 'session', audit: 'change' },
  { method: 'GET', path: '/api/status', auth: 'session', audit: 'none' },
  { method: 'POST', path: '/api/notes/list', auth: 'session', scope: 'vault', audit: 'none', body: notesListBody },
  { method: 'POST', path: '/api/notes/find', auth: 'session', scope: 'vault', audit: 'none', body: notesFindBody },
  { method: 'POST', path: '/api/notes/read', auth: 'session', scope: 'vault', audit: 'open', body: notesReadBody },
  { method: 'POST', path: '/api/notes/image', auth: 'session', scope: 'vault', audit: 'open', body: notesImageBody },
  { method: 'POST', path: '/api/threads/list', auth: 'session', scope: 'history', audit: 'none', body: threadsListBody },
  { method: 'POST', path: '/api/threads/read', auth: 'session', scope: 'history', audit: 'open', body: threadsReadBody },
  { method: 'POST', path: '/api/threads/send', auth: 'session', scope: 'history', audit: 'open', continue: true, files: 'with-ids', body: threadsSendBody },
  { method: 'POST', path: '/api/threads/stop', auth: 'session', scope: 'history', audit: 'open', body: threadsStopBody },
  { method: 'POST', path: '/api/chat/attach', auth: 'session', scope: 'chat', audit: 'upload', files: 'always', body: putBody },
  { method: 'POST', path: '/api/threads/attach', auth: 'session', scope: 'history', audit: 'upload', continue: true, files: 'always', body: putThreadBody },
  // Removing needs the Send files sub-switch like a put does; History or Chat in scope is enough to reach it.
  { method: 'POST', path: '/api/attachments/remove', auth: 'session', scope: ['chat', 'history'], audit: 'change', files: 'always', body: removeBody }
]
