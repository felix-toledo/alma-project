import type { AttachmentKind } from '../../../shared/attach/rules'
import type { AuditEvent } from '../../../shared/audit'
import type { DeviceAuth } from '../../../shared/remote/authorize'
import type { RemoteRequest, RouteSpec } from '../../../shared/remote/api'

/** Every route's audit operation (BR-30): changes, pictures and opens of content record it, listings and polling don't. */
export const ROUTE_OPS: Readonly<Record<string, string>> = {
  '/api/hello': 'remote.hello',
  '/api/pair/request': 'remote.pair.request',
  '/api/pair/status': 'remote.pair.status',
  '/api/pair/passkey': 'remote.pair.passkey',
  '/api/session/challenge': 'remote.session.challenge',
  '/api/session': 'remote.session',
  '/api/state': 'remote.state',
  '/api/chat/send': 'remote.chat.send',
  '/api/chat/new': 'remote.chat.new',
  '/api/chat/stop': 'remote.chat.stop',
  '/api/approvals': 'remote.approvals',
  '/api/approvals/answer': 'remote.approvals.answer',
  '/api/home/things': 'remote.home.things',
  '/api/stepup/challenge': 'remote.stepup.challenge',
  '/api/home/control': 'remote.home.control',
  '/api/cameras': 'remote.cameras',
  '/api/cameras/still': 'remote.camera.still',
  '/api/push/key': 'remote.push.key',
  '/api/push/subscribe': 'remote.push.subscribe',
  '/api/push': 'remote.push',
  '/api/pong': 'remote.pong',
  '/api/forget': 'remote.device.forget',
  '/api/status': 'remote.status',
  '/api/notes/list': 'remote.notes.list',
  '/api/notes/find': 'remote.notes.find',
  '/api/notes/read': 'remote.notes.read',
  '/api/notes/image': 'remote.notes.image',
  '/api/threads/list': 'remote.threads.list',
  '/api/threads/read': 'remote.threads.read',
  '/api/threads/send': 'remote.threads.send',
  '/api/threads/stop': 'remote.threads.stop',
  '/api/chat/attach': 'remote.attachments.put',
  '/api/threads/attach': 'remote.attachments.put',
  '/api/attachments/remove': 'remote.attachments.remove'
}

/** The only strings a detail may carry: what kind of file it was, never what it was called (spec 031 AC-7.2). */
// A Record, so a new kind without an entry here is a type error rather than a silently dropped detail.
const KIND_LIST: Record<AttachmentKind, true> = { image: true, text: true, pdf: true, office: true }
const KINDS: ReadonlySet<string> = new Set(Object.keys(KIND_LIST))

/** Window-side pairing operations (AC-7.3): the person's approve and reject. */
export const PAIR_APPROVE_OP = 'remote.pair.approve'
export const PAIR_REJECT_OP = 'remote.pair.reject'

function safeDetail(detail: Record<string, unknown> | undefined): Record<string, number | string> {
  const kept: Record<string, number | string> = {}
  for (const [key, value] of Object.entries(detail ?? {})) {
    if ((typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && KINDS.has(value))) kept[key] = value
  }
  return kept
}

/**
 * The one audit mapping (T26): identifiers and outcomes only, never content (AC-7.2).
 * Failures carry `throttle: true` (AC-7.5); a sink that throws never breaks the
 * operation (AC-7.4). A detail holds numbers (sizes, counts) and kinds of file and nothing else: any other value is dropped
 * here, so a name, an id or a text cannot reach the trail by a caller's mistake (spec 031 AC-7.2).
 */
export function auditRemote(
  record: (entry: AuditEvent) => void,
  op: string,
  outcome: 'ok' | 'denied' | 'error',
  deviceId?: string,
  options?: { actor?: AuditEvent['actor']; target?: string; detail?: Record<string, number | AttachmentKind> }
): void {
  const detail = { ...safeDetail(options?.detail), ...(deviceId ? { deviceId } : {}) }
  try {
    record({
      action: op,
      actor: options?.actor ?? 'remote',
      ...(options?.target ? { target: options.target } : {}),
      outcome,
      ...(Object.keys(detail).length > 0 ? { detail } : {}),
      ...(outcome === 'denied' ? { throttle: true } : {})
    })
  } catch {
    // The trail never breaks the operation (AC-7.4).
  }
}

/**
 * What the entry points at, for the operations that name one. A note is named by the path the vault really has (the
 * response's), falling back to the asked one on a refusal; an image only by the path it resolved to; a conversation by
 * its id. Never a title or text (AC-5.2).
 */
export function targetOf(
  route: RouteSpec,
  request: RemoteRequest,
  device: DeviceAuth | null,
  served?: { path?: string; image?: string }
): string | undefined {
  const body = request.body as { thing?: unknown; path?: unknown; id?: unknown }
  if (route.path === '/api/home/control') return typeof body?.thing === 'string' ? body.thing : undefined
  if (route.path === '/api/cameras/still') return request.query.get('id') ?? undefined
  if (route.path === '/api/forget') return device?.deviceId
  if (route.path === '/api/notes/read') return served?.path ?? (typeof body?.path === 'string' ? body.path : undefined)
  if (route.path === '/api/notes/image') return served?.image
  if (route.path.startsWith('/api/threads/')) return typeof body?.id === 'string' ? body.id : undefined
  return undefined
}
