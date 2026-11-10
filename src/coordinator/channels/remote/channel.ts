import { authorizeRemote, type DeviceAuth } from '../../../shared/remote/authorize'
import {
  REMOTE_LIMITS,
  ROUTES,
  approvalsAnswerBody,
  chatSendBody,
  homeControlBody,
  notesFindBody,
  notesImageBody,
  notesListBody,
  notesReadBody,
  pongBody,
  pushSubscribeBody,
  putBody,
  putThreadBody,
  removeBody,
  sessionBody,
  sessionChallengeBody,
  threadsListBody,
  threadsReadBody,
  threadsSendBody,
  threadsStopBody
} from '../../../shared/remote/api'
import type { RemoteHandler, RemoteRequest, RemoteResponse, RouteSpec } from '../../../shared/remote/api'
import { auditRemote, PAIR_APPROVE_OP, PAIR_REJECT_OP, ROUTE_OPS, targetOf } from './audit'
import { b64u, fingerprint, signEs256, verifyEs256 } from '../../../shared/remote/crypto'
import { statusView } from '../../../shared/remote/status'
import type { DeviceView, LiveEvent, PairingView, PendingApproval, RemoteStatus, Settings, Thread } from '../../../shared/types'
import type { AuditEvent } from '../../../shared/audit'
import { isPrivateHost } from '../../tools/web'
import { ApprovalsFlow } from './approvals'
import { CamerasFlow } from './cameras'
import { ChatFlow } from './chat'
import { DevicesAdmin, SWEEP_MS } from './devices-admin'
import { PushFlow } from './push'
import { HomeFlow, type DirectTools } from './home'
import { RateLimiter } from './limits'
import { NotesFlow, type RemoteVault } from './notes'
import { RunTies, type RunTie } from './runs'
import { ThreadsFlow, type RemoteThreads } from './threads'
import { PairingFlow, type PairApproveResult, type PairStartResult } from './pairing-flow'
import { StepUpFlow } from './stepup'
import type { DeviceStore, RemoteStateStore } from './store'
import { expiredDevices } from './store'
import { SessionStore } from './session'
import { TransportStartError, okResponse, refusalResponse, type RemoteTransport } from './transport'
import { failedResponse, UploadsFlow, type PhoneFilesPort, type PutTarget, type StoredUpload, type UploadTimers } from './uploads'

/** Dependencies of the remote channel. Grows as tasks land; the full shape is plan section 3. */
export interface RemoteDeps {
  settings(): Settings
  now(): number
  random(length: number): Uint8Array
  store: DeviceStore
  state: RemoteStateStore
  transport(): RemoteTransport | Promise<RemoteTransport>
  onStatus(status: RemoteStatus): void
  onPairing(view: PairingView | null): void
  onDevices(devices: DeviceView[]): void
  host: { confirm(kind: 'pair' | 'serve' | 'revokeAll', params: Record<string, string>): Promise<boolean> }
  /** The single shared remote thread (T20; wired to the coordinator in T35). */
  conversation(fresh?: boolean): Thread
  /** Runs the configured agent; resolves after the answer is committed. `attachments` are the ids bound to the message (spec 031). */
  ask(threadId: string, text: string, attachments?: string[]): Promise<void>
  /** Cancels the current run of a thread. */
  cancel(threadId: string): void
  /** The existing approval broker, fronted by the approve scope (T21; 'always' cannot be expressed). */
  pendingApprovals(): PendingApproval[]
  respondApproval(approvalId: string, decision: 'allow' | 'deny'): void
  /** Coordinator events, so held polls wake when an approval arrives or resolves. */
  onEvent(listener: (event: LiveEvent) => void): () => void
  /** The narrow API's direct tools: house control and camera stills (T23, T24). */
  direct: DirectTools
  /** The active vault at this moment (read at each request; null when none is open), for the Notes scope. */
  vault(): RemoteVault | null
  /** The thread store as the Conversations feature reads it (spec 028). */
  threads: RemoteThreads
  /** The attachment store as a phone's upload reaches it (spec 031); this module imports no file-system API. */
  files: PhoneFilesPort
  /** Timers behind the 15-minute expiry of a pending upload. */
  timers: UploadTimers
  /** The remote audit entry of a phone-initiated call (AC-7.7; T26 owns the mapping). */
  record(entry: AuditEvent): void
  /** A tested phone answered its ping (T25; T35 wires it to the wizard). */
  onTestResult(deviceId: string, ok: boolean): void
  /** The one outbound POST remote access makes: the content-free approval and greeting pushes (T46, 033 BR-30). */
  post(url: string, headers: Record<string, string>, body: Uint8Array): Promise<{ ok: boolean }>
  /** The dream service's pending landing for one device, consumed by asking (spec 033 BR-29). */
  landing?(deviceId: string): string | null
}

const NO_STORE = { 'cache-control': 'no-store' }

/** The long-poll slot one request holds, so `handle` can free it on any exit (AC-10.3). */
interface PollSlot {
  deviceId: string | null
  done: boolean
}

/** A request that may be held up to 25 s: the Chat tab's poll with a cursor, or a conversation read that waits. */
function isHeldPoll(route: RouteSpec, request: RemoteRequest): boolean {
  if (route.path === '/api/state') return /^\d+$/.test(request.query.get('since') ?? '')
  if (route.path === '/api/threads/read') {
    const body = request.body as { wait?: unknown; since?: unknown } | null
    return body?.wait === true && typeof body.since === 'number'
  }
  return false
}

type Handler =(request: RemoteRequest, device: DeviceAuth | null, signal: AbortSignal) => Promise<RemoteResponse>

/**
 * The one security layer (BR-1): every request, whatever carries it, runs the same pipeline of
 * Host/Origin check, route lookup, session, limits, schema, authorization and handler.
 */
export class RemoteChannel {
  private transport: RemoteTransport | null = null
  private expectedHost: string | null = null
  private expectedOrigin: string | null = null
  private lastStatus: RemoteStatus = { state: 'off' }
  private readonly limiter: RateLimiter
  private readonly sessions: SessionStore
  private readonly flow: PairingFlow
  private readonly stepUp: StepUpFlow
  private readonly approvals: ApprovalsFlow
  private readonly chat: ChatFlow
  private readonly home: HomeFlow
  private readonly cameras: CamerasFlow
  private readonly notes: NotesFlow
  private readonly threadsFlow: ThreadsFlow
  private readonly uploads: UploadsFlow
  /** What the two sends need of the pending list; late-bound because the flows are built before it. */
  private readonly pendingUploads: Pick<UploadsFlow, 'claimForSend' | 'bound'> = {
    claimForSend: (deviceId, threadId, ids, text) => this.uploads.claimForSend(deviceId, threadId, ids, text),
    bound: (deviceId, ids) => this.uploads.bound(deviceId, ids)
  }
  private readonly ties = new RunTies()
  private readonly followMarks = new Map<string, number>()
  /** The vault path an image request resolved to, so its audit entry can name it without the flow knowing about audit. */
  private readonly resolvedImages = new WeakMap<RemoteRequest, string>()
  /** What a put stored (kind and size, never a name), so its audit entry can say so without the flow knowing about audit. */
  private readonly storedUploads = new WeakMap<RemoteRequest, StoredUpload>()
  private readonly devices: DevicesAdmin
  private readonly push: PushFlow
  private syncing: Promise<void> = Promise.resolve()
  private unsubscribeEvents: (() => void) | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private readonly handlers: ReadonlyMap<string, Handler> = new Map<string, Handler>([
    ['GET /api/hello', () => this.hello()],
    ['GET /api/status', (_request, device) => this.status(device)],
    ['POST /api/session/challenge', (request) => this.sessionChallenge(request)],
    ['POST /api/session', (request) => this.session(request)],
    ['POST /api/pair/request', (request) => this.flow.pairRequest(request)],
    ['GET /api/pair/status', (request) => this.flow.pairStatus(request)],
    ['POST /api/pair/passkey', (request) => this.flow.pairPasskey(request)],
    ['POST /api/stepup/challenge', (request, device) => this.stepUp.stepupChallenge(request, device)],
    ['GET /api/state', (request, device, signal) => this.chatState(request, device, signal)],
    ['POST /api/chat/send', (request, device) => this.chatSend(request, device)],
    ['POST /api/chat/new', () => this.chatNew()],
    ['POST /api/chat/stop', () => this.chatStop()],
    ['GET /api/approvals', (_request, device) => this.approvalsList(device)],
    ['POST /api/approvals/answer', (request, device) => this.approvalsAnswer(request, device)],
    ['GET /api/home/things', () => this.home.things()],
    ['POST /api/home/control', (request, device) => this.homeControl(request, device)],
    ['GET /api/cameras', () => this.cameras.list()],
    ['GET /api/cameras/still', (request, device) => this.cameraStill(request, device)],
    ['POST /api/forget', (_request, device) => this.forget(device)],
    ['POST /api/pong', (request, device) => this.pong(request, device)],
    ['GET /api/push/key', () => this.pushKey()],
    ['POST /api/push/subscribe', (request, device) => this.pushSubscribe(request, device)],
    ['DELETE /api/push', (_request, device) => this.pushUnsubscribe(device)],
    ['POST /api/notes/list', (request) => this.notes.list(notesListBody.parse(request.body).folder)],
    ['POST /api/notes/find', (request) => this.notes.find(notesFindBody.parse(request.body).query)],
    ['POST /api/notes/read', (request) => this.notes.read(notesReadBody.parse(request.body).path)],
    ['POST /api/notes/image', (request) => {
      const body = notesImageBody.parse(request.body)
      return this.notes.image(body.target, body.from, (path) => this.resolvedImages.set(request, path))
    }],
    ['POST /api/threads/list', async (request) => this.threadsFlow.list(threadsListBody.parse(request.body).offset)],
    ['POST /api/threads/read', async (request, device, signal) => {
      if (!device) return refusalResponse('unknown-device')
      const body = threadsReadBody.parse(request.body)
      return this.threadsFlow.read(device.deviceId, body.id, { before: body.before, since: body.since, wait: body.wait }, signal)
    }],
    ['POST /api/threads/send', async (request, device) => {
      if (!device) return refusalResponse('unknown-device')
      const body = threadsSendBody.parse(request.body)
      return this.threadsFlow.send(device.deviceId, body.id, body.text, body.attachments)
    }],
    ['POST /api/chat/attach', async (request, device) => this.attach(request, device, { shared: true }, putBody.parse(request.body))],
    ['POST /api/threads/attach', async (request, device) => {
      const { id, ...file } = putThreadBody.parse(request.body)
      return this.attach(request, device, { shared: false, id }, file)
    }],
    ['POST /api/attachments/remove', async (request, device) => {
      if (!device) return refusalResponse('unknown-device')
      return this.uploads.remove(device.deviceId, removeBody.parse(request.body).id)
    }],
    ['POST /api/threads/stop', async (request, device) => {
      if (!device) return refusalResponse('unknown-device')
      return this.threadsFlow.stop(device.deviceId, threadsStopBody.parse(request.body).id)
    }]
  ])

  constructor(private readonly deps: RemoteDeps) {
    this.limiter = new RateLimiter(deps.now)
    this.sessions = new SessionStore({ now: deps.now, random: deps.random })
    this.flow = new PairingFlow(deps)
    this.stepUp = new StepUpFlow(deps)
    this.approvals = new ApprovalsFlow({ ...deps, threadId: () => deps.conversation().id, ties: this.ties })
    this.chat = new ChatFlow({ ...deps, approvals: (deviceId) => this.approvals.list(deviceId),
      waiting: (deviceId) => this.approvals.waiting(deviceId, deps.conversation().id),
      ties: this.ties,
      uploads: this.pendingUploads
    })
    this.home = new HomeFlow({
      settings: deps.settings,
      conversationId: () => deps.conversation().id,
      agentId: () => deps.settings().remote.agentId,
      direct: deps.direct,
      stepUp: this.stepUp
    })
    this.cameras = new CamerasFlow({
      settings: deps.settings,
      conversationId: () => deps.conversation().id,
      agentId: () => deps.settings().remote.agentId,
      direct: deps.direct
    })
    this.notes = new NotesFlow({ vault: deps.vault, settings: deps.settings, now: deps.now })
    this.threadsFlow = new ThreadsFlow({
      ...deps,
      sharedId: () => deps.conversation().id,
      ties: this.ties,
      waiting: (deviceId, threadId) => this.approvals.waiting(deviceId, threadId),
      sendShared: (deviceId, text, ids) => this.chat.send(deviceId, text, ids),
      uploads: this.pendingUploads
    })
    this.uploads = new UploadsFlow({
      now: deps.now,
      sharedId: () => deps.conversation().id,
      reachable: (id) => this.threadsFlow.reachable(id),
      isRunning: (id) => deps.threads.isRunning(id),
      files: deps.files,
      timers: deps.timers,
      onLeftover: () => auditRemote(deps.record, 'remote.attachments.discard', 'error')
    })
    this.devices = new DevicesAdmin({
      settings: deps.settings,
      now: deps.now,
      random: deps.random,
      store: deps.store,
      revokeSessions: (deviceId) => this.sessions.revoke(deviceId),
      closeConnections: (deviceId) => this.transport?.closeDevice(deviceId),
      onDeviceGone: (deviceId) => {
        this.abortRuns((tie) => tie.deviceId === deviceId)
        this.uploads.dropDevice(deviceId)
        for (const key of this.followMarks.keys()) if (key.startsWith(`${deviceId}|`)) this.followMarks.delete(key)
        this.releaseHeld()
      },
      onDevices: deps.onDevices,
      confirmRevokeAll: () => deps.host.confirm('revokeAll', {}),
      onTestResult: deps.onTestResult,
      record: deps.record
    })
    this.push = new PushFlow({
      store: deps.store,
      state: deps.state,
      settings: deps.settings,
      now: deps.now,
      threadId: () => deps.conversation().id,
      ties: this.ties,
      post: deps.post,
      isPrivate: isPrivateHost
    })
  }

  /** Notifies subscribed phones of a remote-thread approval (T46; silent when there is nothing to tell). */
  async notifyPush(approval: { threadId: string }): Promise<void> {
    await this.push.notify(approval.threadId)
  }

  /** The morning greeting's push to every subscribed phone (spec 033 BR-30); silent when there is nothing to tell. */
  async notifyGreeting(): Promise<void> {
    await this.push.notifyGreeting()
  }

  /** Reconciles the transport with the settings: off stops everything, on starts it once. Calls queue, so a second one never starts a second listener. */
  sync(): Promise<void> {
    const run = this.syncing.then(() => this.reconcile())
    this.syncing = run.catch(() => undefined)
    return run
  }

  private async reconcile(): Promise<void> {
    const remote = this.deps.settings().remote
    // Files not yet sent never outlive the switch that allowed them (spec 031 AC-3.1); History and continue are not part of it.
    if (!remote.sendFiles || !remote.scopes.chat) this.uploads.dropAll()
    if (!remote.enabled) {
      await this.stop()
      return
    }
    // Conversations by id need History and the continue sub-switch; the shared thread answers to the chat scope alone (BR-18, BR-35).
    if (!remote.scopes.history || !remote.continueHistory) this.abortRuns((tie) => !tie.shared)
    this.releaseHeld()
    if (this.transport) return
    this.setStatus({ state: 'connecting' })
    let transport: RemoteTransport | null = null
    try {
      transport = await this.deps.transport()
      const { address } = await transport.start(this.handle)
      const url = new URL(address)
      // The sweep can throw, so it runs before anything that needs undoing is set up.
      await this.devices.sweep()
      this.chat.open()
      this.threadsFlow.open()
      this.unsubscribeEvents = this.deps.onEvent((event) => {
        if (event.type === 'approval.request' || event.type === 'approval.resolved') this.chat.poke()
        if (event.type === 'message' || event.type === 'run.started' || event.type === 'run.finished' || event.type === 'approval.request' || event.type === 'approval.resolved') this.threadsFlow.poke()
        if (event.type === 'approval.request') void this.push.notify(event.approval.threadId)
        if (event.type === 'vault.changed') this.notes.invalidate()
      })
      this.sweepTimer = setInterval(() => {
        void this.devices.sweep()
      }, SWEEP_MS)
      this.transport = transport
      this.expectedHost = url.host.toLowerCase()
      this.expectedOrigin = url.origin
      this.setStatus({ state: 'online', address })
    } catch (error) {
      await transport?.stop().catch(() => undefined)
      const failure = error instanceof TransportStartError ? error.failure : 'listener'
      this.setStatus({ state: 'error', failure, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  /** A phone started the run going on this thread (the other channels keep quiet about it: BR-34). */
  startedByPhone(threadId: string): boolean {
    return this.ties.ownerOf(threadId) !== null
  }

  /** Cancels the runs phones started that match, through the same abort the PC's stop uses: their approvals resolve as denied (AC-3.20). */
  private abortRuns(matches: (tie: RunTie) => boolean): void {
    this.ties.abortWhere(matches, (threadId) => this.deps.cancel(threadId))
  }

  /** Settings or devices changed: held polls answer now, and the pipeline re-checks access on the way out. */
  private releaseHeld(): void {
    this.chat.release()
    this.threadsFlow.release()
  }

  async stop(): Promise<void> {
    this.abortRuns(() => true)
    this.uploads.dropAll()
    this.chat.close()
    this.threadsFlow.close()
    this.unsubscribeEvents?.()
    this.unsubscribeEvents = null
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    if (this.transport) {
      await this.transport.stop()
      this.transport = null
      this.expectedHost = null
      this.expectedOrigin = null
    }
    this.setStatus({ state: 'off' })
  }

  currentStatus(): RemoteStatus {
    return { ...this.lastStatus }
  }

  /**
   * The Tailscale monitor reports an outage (T33): the listener stays up, the
   * status flips, the failure is audited. Idempotent per outage.
   */
  reportOutage(): void {
    if (this.lastStatus.state === 'error' && this.lastStatus.failure === 'tailscaleDown') return
    this.setStatus({ ...this.lastStatus, state: 'error', failure: 'tailscaleDown', detail: undefined })
    auditRemote(this.deps.record, 'remote.tailscale.down', 'error')
  }

  /** Recovery: Tailscale is back (T33). Restarts the listener when it never started. */
  async reportRecovery(): Promise<void> {
    if (!this.transport) {
      await this.sync()
      return
    }
    this.setStatus({ ...this.lastStatus, state: 'online', failure: undefined, detail: undefined })
  }

  /** The monitor's per-poll facts (T33): key countdown and rename flag (setStatus dedupes). */
  reportFacts(facts: { keyExpiresInDays?: number; renamed?: boolean }): void {
    this.setStatus({ ...this.lastStatus, ...facts })
  }

  /** The current device list, behind the window's `remote.devices` (T37). */
  currentDevices(): DeviceView[] {
    return this.devices.list()
  }

  /** The methods behind the window's remote.pair.* requests (wired in T35). */
  pairStart(): Promise<PairStartResult> {
    return this.flow.start()
  }

  pairCancel(): { ok: true } {
    return this.flow.cancel()
  }

  pairApprove(name: string): Promise<PairApproveResult> {
    return this.flow.approve(name).then((result) => {
      if (result.ok) auditRemote(this.deps.record, PAIR_APPROVE_OP, 'ok', result.deviceId, { actor: 'user', target: result.deviceId })
      return result
    })
  }

  pairReject(): Promise<{ ok: true }> {
    return this.flow.reject().then((result) => {
      auditRemote(this.deps.record, PAIR_REJECT_OP, 'ok', undefined, { actor: 'user' })
      return result
    })
  }

  /** Revokes one device (AC-6.2), behind the window's `remote.revoke` (wired in T35). */
  async revokeDevice(deviceId: string): Promise<void> {
    await this.devices.revoke(deviceId)
  }

  /** Revokes every device after the native confirmation (AC-6.5), behind `remote.revokeAll`. */
  async revokeAll(): Promise<{ ok: true } | { ok: false }> {
    return this.devices.revokeAll()
  }

  /** Erases every device for privacy.erase (AC-9.4): already confirmed, so no second ask. */
  async erase(): Promise<{ devices: number }> {
    return this.devices.eraseAll()
  }

  /** Tests one device (AC-2.5), behind `remote.test`: the ping id, or null when unknown. */
  testDevice(deviceId: string): string | null {
    return this.devices.test(deviceId)
  }

  /** Removes devices idle past 15 days (AC-6.9): runs at start and hourly. */
  async sweepDevices(): Promise<void> {
    await this.devices.sweep()
  }

  /** Every request is cut at 30 seconds with the generic failure answer (AC-10.4); the 25 s long poll answers first. */
  handle: RemoteHandler = async (request, signal): Promise<RemoteResponse> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cut = new Promise<RemoteResponse>((resolve) => {
      timer = setTimeout(() => resolve(failedResponse()), REMOTE_LIMITS.timeoutMs)
    })
    const slot: PollSlot = { deviceId: null, done: false }
    try {
      return await Promise.race([this.pipeline(request, signal, slot), cut])
    } finally {
      clearTimeout(timer)
      slot.done = true
      // Closing here frees the slot on every exit: an answer, an abort, an error and the 30 s cut.
      if (slot.deviceId) this.limiter.close(slot.deviceId)
    }
  }

  private async pipeline(request: RemoteRequest, signal: AbortSignal, slot: PollSlot): Promise<RemoteResponse> {
    if (!this.checkHost(request)) return refusalResponse('invalid')
    const route = ROUTES.find((known) => known.method === request.method && known.path === request.path)
    if (!route) return refusalResponse('unknown-route')
    let device: DeviceAuth | null = null
    if (route.auth === 'session') {
      device = await this.resolveSession(request.headers['authorization'] ?? null)
      if (!device) {
        this.auditDenied(route, undefined)
        return refusalResponse('unknown-device')
      }
    }
    // AC-4.9 budgets pair/request calls; status polls must not consume it or polling dies after five.
    if (route.path === '/api/pair/request' && !this.limiter.takePairing()) return refusalResponse('rate-limited')
    if (route.auth === 'session' && device && !this.limiter.takeRequest(device.deviceId)) return refusalResponse('rate-limited')
    if (route.body) {
      const parsed = route.body.safeParse(request.body)
      if (!parsed.success) {
        if (route.path.startsWith('/api/pair/')) this.auditDenied(route, undefined)
        return refusalResponse('invalid')
      }
    }
    const cameraId = route.path === '/api/cameras/still' ? (request.query.get('id') ?? undefined) : undefined
    // A send needs the Files sub-switch only when its body names pending uploads (the schema already passed).
    const ids = (request.body as { attachments?: unknown } | null)?.attachments
    const carriesFiles = route.files === 'with-ids' && Array.isArray(ids) && ids.length > 0
    const refused = this.refusal(route, device, cameraId, carriesFiles)
    if (refused) return refused
    const handler = this.handlers.get(`${route.method} ${route.path}`)
    if (!handler) return { status: 500, headers: { ...NO_STORE }, body: { error: 'not-implemented' } }
    // AC-10.3: only a read that can be held counts as a connection; short requests have the 60 a minute limit.
    if (device && isHeldPoll(route, request)) {
      if (slot.done || !this.limiter.open(device.deviceId)) return refusalResponse('rate-limited')
      slot.deviceId = device.deviceId
    }
    const response = await handler(request, device, signal)
    // A held read can outlive the access it started with: its content never leaves after the access is cut.
    const held = route.path === '/api/state' || route.path === '/api/threads/read'
    const cut = held ? this.refusal(route, this.deviceStillPaired(device), cameraId) : null
    if (cut) return cut
    this.auditResponse(route, request, device, response)
    return response
  }

  private deviceStillPaired(device: DeviceAuth | null): DeviceAuth | null {
    return device && this.deps.store.devices().some((known) => known.id === device.deviceId) ? device : null
  }

  /** The uniform refusal when the settings do not allow this device the route, or null (audited like any denial). */
  private refusal(route: RouteSpec, device: DeviceAuth | null, cameraId: string | undefined, carriesFiles = false): RemoteResponse | null {
    const verdict = authorizeRemote({ device, remote: this.deps.settings().remote, route, cameraId, carriesFiles })
    if (verdict.ok) return null
    if (verdict.reason === 'scope-off' || verdict.reason === 'write-off' || verdict.reason === 'sensitive-off' || verdict.reason === 'camera-not-allowed' || verdict.reason === 'attach-off') {
      this.auditDenied(route, device?.deviceId)
    } else if (verdict.reason === 'unknown-device') {
      this.auditDenied(route, undefined)
    }
    return refusalResponse(verdict.reason)
  }

  /**
   * A conversation read is audited unless it is the live follow: a `since` that answers no message (an idle poll), or
   * one at or past the thread length the device already had served by an earlier audited read (or follow). Such a delta
   * can only carry messages written after that read, so it cannot be used to read old content unaudited (`since: 0` is
   * an open). The mark is kept per device and thread.
   */
  private isFollow(route: RouteSpec, request: RemoteRequest, device: DeviceAuth | null, response: RemoteResponse): boolean {
    if (route.path !== '/api/threads/read' || !device) return false
    const body = request.body as { id?: unknown; since?: unknown } | null
    const { rev, messages } = (response.body ?? {}) as { rev?: unknown; messages?: unknown }
    if (typeof body?.id !== 'string' || typeof rev !== 'number') return false
    const key = `${device.deviceId}|${body.id}`
    const mark = this.followMarks.get(key)
    this.followMarks.set(key, Math.max(mark ?? 0, rev))
    if (typeof body.since !== 'number') return false
    return (Array.isArray(messages) && messages.length === 0) || (mark !== undefined && body.since >= mark)
  }

  private auditDenied(route: RouteSpec, deviceId: string | undefined): void {
    auditRemote(this.deps.record, ROUTE_OPS[route.path] ?? route.path, 'denied', deviceId)
  }

  /**
   * Records the route's outcome from its audit class (T26): changes and pictures with
   * actor remote, flow-level scope/step-up/pairing failures as denied. Lists, polling,
   * tool-policy denials and run failures are not remote entries (BR-30).
   */
  private auditResponse(route: RouteSpec, request: RemoteRequest, device: DeviceAuth | null, response: RemoteResponse): void {
    const body = response.body as { error?: unknown; path?: unknown } | null
    const error = body?.error
    // A send that carries attachments says how many, never which (spec 031 AC-7.1).
    const ids = route.files === 'with-ids' ? (request.body as { attachments?: unknown[] } | null)?.attachments : undefined
    const count = ids?.length ? { attachments: ids.length } : undefined
    if (route.audit === 'upload') {
      // One entry for every put that reached the PC: kind and size when it was stored, only the outcome when it was not.
      const outcome = typeof error !== 'string' ? 'ok' : error === 'storage' || error === 'failed' ? 'error' : 'denied'
      auditRemote(this.deps.record, ROUTE_OPS[route.path] ?? route.path, outcome, device?.deviceId, { detail: { ...this.storedUploads.get(request) } })
      return
    }
    if (route.audit === 'open') {
      if (this.isFollow(route, request, device, response)) return
      const served = { path: typeof body?.path === 'string' ? body.path : undefined, image: this.resolvedImages.get(request) }
      const target = targetOf(route, request, device, served)
      auditRemote(this.deps.record, ROUTE_OPS[route.path] ?? route.path, typeof error === 'string' ? 'error' : 'ok', device?.deviceId, { target, detail: count })
      return
    }
    if (typeof error === 'string') {
      if (error === 'step-up-required' || error === 'sensitive-off') this.auditDenied(route, device?.deviceId)
      else if (route.path.startsWith('/api/pair/') && (error === 'invalid' || error === 'expired' || error === 'busy')) {
        this.auditDenied(route, undefined)
      }
      return
    }
    if (route.audit === 'change' || route.audit === 'picture') {
      auditRemote(this.deps.record, ROUTE_OPS[route.path] ?? route.path, 'ok', device?.deviceId, { target: targetOf(route, request, device), detail: count })
    }
  }

  /**
   * Only the PC's own host and origin get through (PD-8). A loopback host
   * carries no authority (a proxy may have rewritten it): a page still needs
   * our origin, and a bare local process still needs a device credential (AC-3.4).
   */
  private checkHost(request: RemoteRequest): boolean {
    if (!this.expectedHost || !this.expectedOrigin) return false
    const host = (request.headers['host'] ?? '').toLowerCase()
    const origin = request.headers['origin']
    if (host === this.expectedHost) return origin === undefined || origin === this.expectedOrigin
    if (/^127\.0\.0\.1(?::\d+)?$/.test(host)) return origin === undefined || origin === this.expectedOrigin
    return false
  }

  private async resolveSession(authorization: string | null): Promise<DeviceAuth | null> {
    const match = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(authorization ?? '')
    if (!match) return null
    const found = this.sessions.resolve(match[1])
    if (!found) return null
    const device = this.deps.store.devices().find((known) => known.id === found.deviceId)
    if (!device || expiredDevices([device], this.deps.now()).length > 0) return null
    await this.deps.store.touch(device.id)
    this.transport?.track(match[1], device.id)
    return { deviceId: device.id }
  }

  private async sessionChallenge(request: RemoteRequest): Promise<RemoteResponse> {
    const body = sessionChallengeBody.parse(request.body)
    const device = this.deps.store.devices().find((known) => known.id === body.deviceId)
    if (!device || expiredDevices([device], this.deps.now()).length > 0) return refusalResponse('unknown-device')
    return this.ok({ nonce: this.sessions.challenge(device.id) })
  }

  private async session(request: RemoteRequest): Promise<RemoteResponse> {
    const body = sessionBody.parse(request.body)
    const device = this.deps.store.devices().find((known) => known.id === body.deviceId)
    if (!device || expiredDevices([device], this.deps.now()).length > 0) return refusalResponse('unknown-device')
    // Every failure below answers the same: authentication either proves the key or it does not (AC-5.3).
    const nonce = this.sessions.attempt(device.id)
    if (!nonce) return refusalResponse('unknown-device')
    let signature: Uint8Array
    try {
      signature = b64u.decode(body.signature)
    } catch {
      return refusalResponse('unknown-device')
    }
    if (!(await verifyEs256(device.publicKey, nonce, signature))) return refusalResponse('unknown-device')
    await this.deps.store.touch(device.id)
    return this.ok(this.sessions.issue(device.id))
  }

  private async hello(): Promise<RemoteResponse> {
    const pcKey = this.deps.state.state.pcKey
    const nonce = this.deps.random(32)
    const signature = await signEs256(pcKey.private, nonce)
    return this.ok({ publicKey: pcKey.public, fingerprint: await fingerprint(pcKey.public), nonce: b64u.encode(nonce), signature: b64u.encode(signature) })
  }

  private async status(device: DeviceAuth | null): Promise<RemoteResponse> {
    if (!device) return refusalResponse('unknown-device')
    const remote = this.deps.settings().remote
    // Asked even with History off: that first opening is the landing, and the app opens as today (BR-29).
    const landing = this.deps.landing?.(device.deviceId)
    return this.ok({ ...statusView(remote), ...(landing && remote.scopes.history ? { landing } : {}) })
  }

  /**
   * The PD-12 shape. The route admits either scope, so content is filtered here:
   * no chat scope, no messages (T21 adds the same gate for approvals). `rev` stays
   * visible either way: a bare count the approve surface needs for its own polling.
   */
  private async chatState(request: RemoteRequest, device: DeviceAuth | null, signal: AbortSignal): Promise<RemoteResponse> {
    if (!device) return refusalResponse('unknown-device')
    const raw = request.query.get('since')
    const since = raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined
    const state = await this.chat.state(since, device.deviceId, signal)
    const scopes = this.deps.settings().remote.scopes
    const ping = this.devices.statePing(device.deviceId)
    return this.ok({
      ...state,
      messages: scopes.chat ? state.messages : [],
      approvals: scopes.approve ? state.approvals : [],
      ...(ping ? { ping } : {})
    })
  }

  /**
   * Runs the configured agent on the shared remote thread. A run already in progress
   * answers 409 busy and a failed start 500 failed; the PWA shows chan.failed for
   * both, and a message over 8000 characters never reaches here (400 tooLong: AC-5.5).
   */
  private async chatSend(request: RemoteRequest, device: DeviceAuth | null): Promise<RemoteResponse> {
    if (!device) return refusalResponse('unknown-device')
    const body = chatSendBody.parse(request.body)
    const result = this.chat.send(device.deviceId, body.text, body.attachments)
    if ('ok' in result) return this.ok({ ok: true })
    return result.error === 'failed' ? failedResponse() : refusalResponse(result.error)
  }

  /** A file for the Chat tab's thread or a conversation by id; the pending list and every rule about the file live in the flow and the store. */
  private async attach(request: RemoteRequest, device: DeviceAuth | null, target: PutTarget, file: { name: string; size: number; base64: string }): Promise<RemoteResponse> {
    if (!device) return refusalResponse('unknown-device')
    const { response, stored } = this.uploads.put(device.deviceId, target, file)
    if (stored) this.storedUploads.set(request, stored)
    return response
  }

  private async chatNew(): Promise<RemoteResponse> {
    const replaced = this.deps.conversation().id
    this.chat.newThread()
    this.uploads.dropThread(replaced)
    return this.ok({ ok: true })
  }

  private async chatStop(): Promise<RemoteResponse> {
    this.chat.stopThread()
    return this.ok({ ok: true })
  }

  private async approvalsList(device: DeviceAuth | null): Promise<RemoteResponse> {
    if (!device) return refusalResponse('unknown-device')
    return this.ok({ approvals: this.approvals.list(device.deviceId) })
  }

  /**
   * Answers once through the broker. An id that is not pending on the current remote
   * thread answers 404 already-answered (the PWA shows remote.pwa.alreadyAnswered),
   * whether it is unknown, answered elsewhere, of another thread or lost to a restart.
   */
  private async approvalsAnswer(request: RemoteRequest, device: DeviceAuth | null): Promise<RemoteResponse> {
    if (!device) return refusalResponse('unknown-device')
    const body = approvalsAnswerBody.parse(request.body)
    if (this.approvals.answer(device.deviceId, body.id, body.decision) === 'already-answered') {
      return refusalResponse('already-answered')
    }
    this.chat.poke()
    return this.ok({ ok: true })
  }

  private async homeControl(request: RemoteRequest, device: DeviceAuth | null): Promise<RemoteResponse> {
    if (!device) return refusalResponse('unknown-device')
    const body = homeControlBody.parse(request.body)
    return this.home.control(device.deviceId, body.thing, body.action, body.assertion)
  }

  private async cameraStill(request: RemoteRequest, device: DeviceAuth | null): Promise<RemoteResponse> {
    if (!device) return refusalResponse('unknown-device')
    return this.cameras.still(request.query.get('id'))
  }

  private async forget(device: DeviceAuth | null): Promise<RemoteResponse> {
    if (!device) return refusalResponse('unknown-device')
    await this.devices.forget(device.deviceId)
    return this.ok({ ok: true })
  }

  /**
   * Answers a connection-test ping. A late, repeated or foreign id answers 404
   * unknown-ping (the PWA shows remote.pwa.phoneSilent).
   */
  private async pong(request: RemoteRequest, device: DeviceAuth | null): Promise<RemoteResponse> {
    if (!device) return refusalResponse('unknown-device')
    const body = pongBody.parse(request.body)
    if (!this.devices.pong(device.deviceId, body.ping).ok) {
      return { status: 404, headers: { ...NO_STORE }, body: { error: 'unknown-ping' } }
    }
    return this.ok({ ok: true })
  }

  private async pushKey(): Promise<RemoteResponse> {
    return this.ok({ key: this.push.key() })
  }

  private async pushSubscribe(request: RemoteRequest, device: DeviceAuth | null): Promise<RemoteResponse> {
    if (!device) return refusalResponse('unknown-device')
    const body = pushSubscribeBody.parse(request.body)
    const saved = await this.push.subscribe(device.deviceId, body)
    if (!saved.ok) return refusalResponse('invalid')
    return this.ok({ ok: true })
  }

  private async pushUnsubscribe(device: DeviceAuth | null): Promise<RemoteResponse> {
    if (!device) return refusalResponse('unknown-device')
    await this.push.unsubscribe(device.deviceId)
    return this.ok({ ok: true })
  }

  private ok(body: unknown): RemoteResponse {
    return okResponse(body)
  }

  private setStatus(next: RemoteStatus): void {
    if (JSON.stringify(next) === JSON.stringify(this.lastStatus)) return
    this.lastStatus = next
    this.deps.onStatus({ ...next })
  }
}
