// Agent coordinator: runs in an Electron utilityProcess and talks to renderers over MessagePorts.
import type { MessagePortMain } from 'electron'
import { audit, initAudit } from '../shared/audit'
import { effectiveProfile } from '../shared/defaults'
import type { JudgmentRule } from '../shared/home'
import { formatDateTime } from '../shared/i18n/format'
import { translate } from '../shared/i18n/messages'
import type {
  AudioEnvelope,
  ChatMessage,
  CoordinatorMessage,
  CoordinatorRequest,
  CoordinatorToParent,
  HostRequest,
  LiveEvent,
  ParentToCoordinator,
  PendingApproval,
  RemoteStatus,
  RequestEnvelope,
  Routine,
  Company,
  Settings,
  Thread
} from '../shared/types'
import { REMOTE_LIMITS } from '../shared/remote/api'
import { signEs256 } from '../shared/remote/crypto'
import { effectiveRelayDomain, RELAY_DOMAIN, relayAvailable } from '../shared/remote/relay-config'
import { readShellManifest } from '../shared/remote/relay-shell'
import { overlayRelayStatus } from '../shared/remote/relay-status'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repairDanglingToolUses, runAgent } from './agent'
import { ApprovalBroker, authorize } from './approval'
import { readRemoteActivity } from './channels/remote/activity'
import { deviceExportList } from './channels/remote/devices-admin'
import { RemoteChannel } from './channels/remote/channel'
import { quietForPhoneRuns } from './channels/remote/quiet'
import type { WebSocketCtor } from './channels/remote/relay-connection'
import { RelayController, runRelayTest } from './channels/remote/relay-controller'
import { eraseRelay, transportExport } from './channels/remote/relay-privacy'
import { RelayStore } from './channels/remote/relay-store'
import { RelayTransport } from './channels/remote/relay-transport'
import { DeviceStore, expiredDevices, RemoteStateStore, type DeviceRecord } from './channels/remote/store'
import { execTailscale, pickFreePort, TailscaleController } from './channels/remote/tailscale'
import { TailscaleTransport } from './channels/remote/tailscale-transport'
import { chooseTransport, planTransportChange } from './channels/remote/transport-choice'
import { TailscaleMonitor } from './channels/remote/monitor'
import { type RemoteTransport, TransportStartError } from './channels/remote/transport'
import { listImageModels } from './images'
import { houseThreadTitle, routineThreadTitle } from './generated'
import { houseRulePrompt } from './prompts/house'
import { approvalNotice, reminderNotice, routineNotice, ruleFailedNotice } from './notices'
import { erasePersonalFiles, exportPersonalData } from './privacy'
import { PresenceService } from './presence'
import { presenceThreshold } from '../shared/presence'
import { DreamService } from './dream/service'
import { hasKey } from '../shared/attach/readers'
import { TelegramChannel } from './channels/telegram'
import { WhatsAppChannel } from './channels/whatsapp'
import { CompanyEngine } from './company/engine'
import { CompanyStore } from './company/store'
import { HomeService } from './home'
import { look } from './vision'
import { testEmail } from './tools/email'
import { folderHasFiles, initVault } from './vault-fs'
import { VoiceAssistant } from './voice/assistant'
import { conversationEnded } from './voice/speech'
import { KnowledgeBase } from './knowledge/base'
import { WorkerEmbedder } from './knowledge/embedder'
import { McpManager } from './mcp'
import { getProvider } from './providers'
import { RoutineRunner } from './routines'
import { isUntitled, ThreadStore, summarize, untitledTitle } from './store'
import { imageDataUrl } from './tools/media'
import { AttachmentService, attachmentLog, composeUserMessage, countsAsOpened, scheduleSweep } from './attachments/service'
import { PhoneFiles } from './attachments/phone'
import { AttachmentStore } from './attachments/store'
import { inboxFileName, resolveInWorkspace } from './tools/paths'
import { shownError, type CompanyAuthoringHost, type Host } from './tools/types'
import type { StateChange } from './home/hub'

let settings: Settings
let store: ThreadStore
let routines: RoutineRunner
/** Built at `init`; a presence message before it is dropped (spec 034 AC-1.4). */
let presence: PresenceService | undefined
/** The nightly dream and the morning greeting (spec 033), built at `init`. */
let dream: DreamService | undefined
let dataDir = ''
let embedder: WorkerEmbedder | null = null
let knowledge: KnowledgeBase | null = null
const clients = new Set<MessagePortMain>()
const runs = new Map<string, AbortController>()

/** In-process listeners (channels like Telegram) that see the same live events as the windows. */
const taps = new Set<(event: LiveEvent) => void>()

function broadcast(event: LiveEvent): void {
  const message: CoordinatorMessage = { kind: 'event', event }
  for (const port of clients) port.postMessage(message)
  for (const tap of taps) tap(event)
}

function onEvent(listener: (event: LiveEvent) => void): () => void {
  taps.add(listener)
  return () => taps.delete(listener)
}

function toParent(message: CoordinatorToParent): void {
  process.parentPort.postMessage(message)
}

// Requests the main process fulfils (it owns windows and the Instagram browser session).
let hostRequestId = 0
const hostWaiters = new Map<number, (result: { ok: boolean; message: string }) => void>()
const host: Host = {
  request(request: HostRequest) {
    const reqId = ++hostRequestId
    return new Promise((resolve) => {
      hostWaiters.set(reqId, resolve)
      toParent({ type: 'host.request', reqId, request })
    })
  }
}

function notifyApproval(approval: PendingApproval): void {
  const thread = store.get(approval.threadId)
  const caption = approval.preview?.caption?.split('\n')[0]
  toParent({ type: 'notify', ...approvalNotice(settings.language, { toolName: approval.toolName, caption }, thread.title), threadId: thread.id })
}

const approvals = new ApprovalBroker((event) => {
  broadcast(event)
  if (event.type === 'approval.request') notifyApproval(event.approval)
})
// What Telegram, WhatsApp and the voice assistant see: nothing of a run a phone started in their conversation (spec 028 BR-34).
const quiet = quietForPhoneRuns((threadId) => remote?.startedByPhone(threadId) ?? false, () => approvals.pending())
const mcp = new McpManager((servers) => broadcast({ type: 'mcp.status', servers }), () => settings.language)

let vaultSync = Promise.resolve()

/** Opens the active vault (closing the previous one) whenever settings change. Serialized: settings can arrive back to back. */
function syncVault(): Promise<void> {
  vaultSync = vaultSync.then(openActiveVault, openActiveVault)
  return vaultSync
}

async function openActiveVault(): Promise<void> {
  const target = settings.activeVault
  if (knowledge?.root === target) return
  const previous = knowledge
  knowledge = null
  await previous?.close()
  if (target && existsSync(target)) {
    embedder ??= new WorkerEmbedder(join(dataDir, 'models'), () => knowledge?.emitStatus(), () => settings.language)
    try {
      knowledge = new KnowledgeBase({
        root: target,
        dataDir,
        embedder,
        trash: async (path) => {
          const result = await host.request({ action: 'trash', path })
          if (!result.ok) throw new Error(result.message)
        },
        onStatus: (status) => broadcast({ type: 'knowledge.status', status }),
        onChanged: () => broadcast({ type: 'vault.changed' }),
        language: () => settings.language
      })
      knowledge.start()
      knowledge.warmUp()
    } catch (error) {
      console.error('[coordinator] could not open the vault:', error)
    }
  }
  broadcast({ type: 'knowledge.status', status: knowledge?.status() ?? null })
  broadcast({ type: 'vault.changed' })
}

const companyVaults = new Map<string, KnowledgeBase>()

/** The knowledge base of a company's vault, opened on first use (the active vault is reused if it's the same folder). */
function vaultFor(root: string): KnowledgeBase | null {
  if (!root) return null
  if (knowledge?.root.toLowerCase() === root.toLowerCase()) return knowledge
  let base = companyVaults.get(root.toLowerCase())
  if (!base) {
    try {
      mkdirSync(root, { recursive: true })
      embedder ??= new WorkerEmbedder(join(dataDir, 'models'), () => knowledge?.emitStatus(), () => settings.language)
      base = new KnowledgeBase({
        root,
        dataDir,
        embedder,
        trash: async (path) => {
          const result = await host.request({ action: 'trash', path })
          if (!result.ok) throw new Error(result.message)
        },
        onStatus: () => {},
        onChanged: () => broadcast({ type: 'vault.changed' }),
        language: () => settings.language
      })
      base.start()
      companyVaults.set(root.toLowerCase(), base)
    } catch (error) {
      console.error('[coordinator] could not open the company vault:', error)
      return null
    }
  }
  return base
}

/** Settings as a company agent sees them: the company's own mailbox when it has one. */
function companySettings(company: Company): Settings {
  if (!company.email.address) return settings
  return { ...settings, email: company.email, providers: { ...settings.providers, email: { apiKey: settings.companySecrets[company.id] ?? '' } } }
}

function activeVault(): KnowledgeBase {
  if (!knowledge) throw new Error(translate(settings.language, 'error.noVault'))
  return knowledge
}

/** Starts an agent run on a thread. Throws right away if one is already running; `done` settles when it ends. */
function startRun(threadId: string, text: string, options: { noAsk?: boolean; autoApprove?: string[]; unattended?: boolean; attachments?: string[] } = {}): { done: Promise<void> } {
  if (runs.has(threadId)) throw new Error(translate(settings.language, 'error.runBusy'))
  const thread = store.get(threadId)
  const agent = settings.agents.find((a) => a.id === thread.agentId) ?? settings.agents[0]
  if (!agent) throw new Error(translate(settings.language, 'error.noAgents'))
  // The model chosen in the chat header answers instead of the agent's own.
  const profile = effectiveProfile(agent, thread)
  // A company agent works with its company's vault, accounts and budget.
  const company = profile.companyId ? settings.companies.find((c) => c.id === profile.companyId) : undefined
  if (company) {
    const why = companies.overBudget(company, profile.id)
    if (why) throw new Error(translate(settings.language, 'error.cannotWork', { why }))
  }

  // After the guards above and before anything is changed: a refused attachment leaves the thread and the stored files as they were (spec 030 AC-1.3).
  const { message: userMessage, title } = composeUserMessage({ text, ids: options.attachments, threadId, reader: attachments, language: settings.language, untitled: untitledTitle(settings.language), now: Date.now() })
  repairDanglingToolUses(thread.messages)
  thread.messages.push(userMessage)
  if (isUntitled(thread.title)) thread.title = title
  // A routine, a house rule or a company run is not the person opening the conversation (AC-6.7).
  if (countsAsOpened(options)) store.markOpened(thread.id, userMessage.ts)
  store.save(thread.id)
  broadcast({ type: 'message', scope: { threadId }, message: userMessage })
  broadcast({ type: 'thread.updated', summary: summarize(thread) })

  const controller = new AbortController()
  runs.set(threadId, controller)
  broadcast({ type: 'run.started', threadId })

  const done = runAgent(profile, thread.messages, {
    getSettings: () => (company ? companySettings(company) : settings),
    language: settings.language,
    thread,
    scope: { threadId },
    signal: controller.signal,
    depth: 0,
    approvals,
    mcp,
    host,
    knowledge: company ? vaultFor(company.vault) : knowledge,
    emit: broadcast,
    persist: () => store.save(thread.id),
    rememberAlwaysAllow,
    saveRoutines,
    sendTelegram: (text) => telegram.notify(text),
    whatsapp: company ? (company.whatsapp ? companyWhatsApp(company) : null) : settings.whatsapp.enabled ? whatsapp : null,
    company: company ? { company, memberId: profile.id, engine: companies, noAsk: options.noAsk } : null,
    authoring: company ? null : companyAuthoring(),
    home: company ? null : home,
    autoApprove: options.autoApprove,
    unattended: options.unattended,
    inboxDir: inboxDir(),
    attachments,
    sendTelegramPhoto: (jpeg, caption) => telegram.notifyPhoto(jpeg, caption),
    onUsage: company ? (usage, provider) => companies.recordUsage(company, profile.id, provider, usage) : undefined
  })
    .then(() => broadcast({ type: 'run.finished', threadId }))
    .catch((error: Error) => {
      const cancelled = controller.signal.aborted
      if (!cancelled) console.error('[coordinator] run failed:', error)
      broadcast({ type: 'run.finished', threadId, error: cancelled ? undefined : error.message })
      if (!cancelled) throw error
    })
    .finally(() => {
      runs.delete(threadId)
      store.save(thread.id)
      broadcast({ type: 'thread.updated', summary: summarize(thread) })
    })
  // Callers that don't await `done` must not trigger unhandled rejections.
  done.catch(() => {})
  // The person's own message, not a routine, a house rule or a company's conversation: a wake signal for the greeting (spec 033 BR-12).
  if (!options.unattended && !company && !thread.companyId) dream?.personMessage(threadId, done)
  return { done }
}

/** The nightly dream's service (spec 033): every collaborator injected, the decisions in shared/dream. */
function createDream(): DreamService {
  const say = (thread: Thread, text: string): void => {
    const message: ChatMessage = { role: 'assistant', content: [{ type: 'text', text }], ts: Date.now() }
    thread.messages.push(message)
    store.save(thread.id)
    broadcast({ type: 'message', scope: { threadId: thread.id }, message })
    broadcast({ type: 'thread.updated', summary: summarize(thread) })
  }
  return new DreamService({
    file: join(dataDir, 'dream-state.json'),
    now: () => new Date(),
    settings: () => settings,
    knowledge: () => knowledge,
    hasKey: (provider) => hasKey(settings, provider, process.env),
    provider: (row) => getProvider(row.provider, settings),
    online: async () => (await host.request({ action: 'net.online' })).ok,
    threads: () => store.list().map(({ id }) => store.get(id)),
    audit,
    log: (line) => console.warn(line),
    broadcast: (status) => broadcast({ type: 'dream.status', status }),
    notify: (title, body, threadId) => toParent({ type: 'notify', title, body, threadId, always: true }),
    createThread: (agentId, title, text) => {
      const thread = store.create(agentId, settings.defaultWorkspace)
      thread.title = title
      say(thread, text)
      return thread.id
    },
    greetingText: (threadId) => (store.list().some((t) => t.id === threadId) ? lastAnswer(threadId) : undefined),
    telegram: { notify: (text) => telegram.notify(text), append: (text) => say(channelConversation('telegram'), text) },
    push: { notifyGreeting: async () => remote?.notifyGreeting() },
    landing: (threadId) => toParent({ type: 'landing', threadId }),
    devices: async () => (await loadRemoteDevices()).map((device) => device.id)
  })
}

/** Applied locally right away (the next tool call sees it), then persisted by main, which pushes settings back. */
function saveRoutines(routines: Routine[]): void {
  patchSettings({ routines })
}

// Sent by main in `init`: only it knows the Documents folder (spec 029).
let defaultVaultPath = ''

/** What `create_company` / `edit_company` use, fresh for each run (`calls` counts that run's creations). */
function companyAuthoring(): CompanyAuthoringHost {
  return { defaultVaultPath, folderHasFiles, initVault: (path) => initVault(path, settings.language), save: (update) => patchSettings(update(settings)), calls: { create: 0 } }
}

function patchSettings(patch: Partial<Omit<Settings, 'providers'>>): void {
  settings = { ...settings, ...patch }
  toParent({ type: 'settings.patch', patch })
}

function rememberAlwaysAllow(toolName: string): void {
  if (!settings.alwaysAllowTools.includes(toolName)) {
    settings = { ...settings, alwaysAllowTools: [...settings.alwaysAllowTools, toolName] }
    toParent({ type: 'alwaysAllow', toolName })
  }
}

/** Where a reminder reaches the user: the desktop and, if connected, Telegram. */
function deliverReminder(routine: Routine): void {
  toParent({ type: 'notify', ...reminderNotice(settings.language, routine.prompt), always: true })
  void telegram.notify(`⏰ ${routine.prompt}`).catch((error: Error) => console.error('[telegram] reminder:', error.message))
}

function lastAnswer(threadId: string): string {
  const last = [...store.get(threadId).messages].reverse().find((m) => m.role === 'assistant')
  return last?.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim() ?? ''
}

/** The conversation a chat channel talks to (`fresh` starts another), answered by the agent chosen for it. */
function channelConversation(channel: 'telegram' | 'whatsapp', fresh = false): Thread {
  const { threadId, agentId } = settings[channel]
  const existing = !fresh && threadId ? store.list().find((t) => t.id === threadId) : undefined
  const agent = settings.agents.some((a) => a.id === agentId) ? agentId : settings.defaultAgentId
  if (existing) {
    // The agent chosen in settings answers, even in a conversation started with another one.
    const thread = store.get(existing.id)
    if (thread.agentId !== agent) {
      thread.agentId = agent
      store.save(thread.id)
    }
    return thread
  }
  const thread = store.create(agent, settings.defaultWorkspace, channel)
  patchSettings({ [channel]: { ...settings[channel], threadId: thread.id } })
  broadcast({ type: 'thread.updated', summary: summarize(thread) })
  return thread
}

const telegram = new TelegramChannel({
  settings: () => settings,
  token: () => settings.providers.telegram.apiKey || process.env.TELEGRAM_BOT_TOKEN || '',
  patch: (patch) => patchSettings({ telegram: { ...settings.telegram, ...patch } }),
  conversation: (fresh) => channelConversation('telegram', fresh),
  ask: (threadId, text) => startRun(threadId, text).done,
  lastAnswer,
  transcribe: (audio, mime) => voice.transcribeFile(audio, mime),
  saveImage: saveInboxImage,
  onEvent: quiet.onEvent(onEvent),
  respondApproval: quiet.respondApproval((approvalId, decision) => approvals.respond(approvalId, decision, 'telegram')),
  onStatus: (status) => broadcast({ type: 'telegram.status', status }),
  home: {
    enabled: () => settings.home.enabled,
    snapshot: () => (home.hub.ready ? home.hub.snapshot() : null),
    status: () => home.engine.status().state,
    control: (entityId, service, data) => home.hub.control(entityId, service, data),
    cameraPhoto: (entityId) => home.hub.cameraSnapshot(entityId)
  }
})

// Created on init (devices and pairing state live under <dataDir>/remote).
let remote: RemoteChannel | null = null
let remoteState: RemoteStateStore | null = null
let tailscaleController: TailscaleController | null = null
let tailscaleMonitor: TailscaleMonitor | null = null
// The relay (spec 027): its own state and credentials, apart from the channel, which only knows Tailscale's.
let relayController: RelayController | null = null
let relayStore: RelayStore | null = null
// The load itself is kept, not its result, so two first calls at once share one load.
let relayStoreLoad: Promise<RelayStore> | null = null
let packaged = false
// The transport the channel is running with; a change of the setting restarts it (spec 027 AC-1.10).
let activeTransport: 'tailscale' | 'relay' = 'tailscale'
const phoneTestWaiters = new Map<string, (ok: boolean) => void>()

const relayDomain = (): string => effectiveRelayDomain({ build: RELAY_DOMAIN, override: process.env['ALMA_RELAY_DOMAIN'], packaged })
/** The relay is the transport only when it is selected and this build offers it (a packaged app with the placeholder domain does not, AC-6.7). */
const relaySelected = (): boolean => chooseTransport({ transport: settings.remote.transport, available: relayAvailable({ domain: relayDomain(), packaged }) }) === 'relay'
/** The channel's status with the relay's state laid over it (PD-11), and the tab told when this build has no relay to offer. */
const remoteStatusNow = (channel: RemoteStatus): RemoteStatus => ({
  ...overlayRelayStatus(channel, relayController?.current() ?? null),
  ...(relayAvailable({ domain: relayDomain(), packaged }) ? {} : { relayHidden: true })
})

/**
 * The official shell of this build, announced to phones over the relay: the version and root hash the PWA build wrote
 * (scripts/shell-manifest.mts) next to the app this process serves. A build that did not write one (development) has none.
 */
function officialShell(): { version: number; rootHash: string } | null {
  try {
    // The bundle is CJS: the coordinator runs from out/main, the PWA builds into out/remote.
    return readShellManifest(JSON.parse(readFileSync(join(__dirname, '..', 'remote', 'shell-manifest.json'), 'utf8')))
  } catch {
    return null
  }
}

function relayStoreNow(): Promise<RelayStore> {
  const sealBox = {
    seal: async (text: string) => (await host.request({ action: 'secret.seal', text })).message,
    open: async (text: string) => (await host.request({ action: 'secret.open', text })).message
  }
  relayStoreLoad ??= RelayStore.load({
    dir: join(dataDir, 'remote'),
    sealBox,
    random: (length) => crypto.getRandomValues(new Uint8Array(length)),
    domain: relayDomain,
    // A file that could not be read means a new routing id will be made, and a change that could not be saved is lost on restart: both are worth an entry.
    onProblem: (problem) => audit({ action: `remote.relay.${problem}`, actor: 'system', outcome: 'error' })
  }).then(
    (loaded) => (relayStore = loaded),
    (error: unknown) => {
      relayStoreLoad = null
      throw error
    }
  )
  return relayStoreLoad
}

async function relayTransport(deviceStore: DeviceStore, relays: RelayStore): Promise<RemoteTransport> {
  // The runtime's own WebSocket client: the relay path adds no dependency.
  const WebSocketClient = (globalThis as { WebSocket?: unknown }).WebSocket
  if (typeof WebSocketClient !== 'function') throw new TransportStartError('listener', 'no WebSocket client')
  if (!remoteState) throw new TransportStartError('listener', 'remote state not ready')
  const key = remoteState.state.pcKey
  const routingId = await relays.ensureRoutingId()
  // The pairing QR and the passkeys name the PC by this host while the relay is the transport.
  await remoteState.update({ hostName: `${routingId}.${relayDomain()}` })
  return new RelayTransport({
    routingId,
    relayDomain: relayDomain(),
    identity: { publicKey: key.public, sign: (data) => signEs256(key.private, data) },
    // Null for a revoked or idle-expired device, which the handshake cannot tell from an unknown one.
    deviceKey: (id) => {
      const device = deviceStore.devices().find((known) => known.id === id)
      return device && expiredDevices([device], Date.now()).length === 0 ? device.publicKey : null
    },
    webSocket: WebSocketClient as WebSocketCtor,
    random: (length) => crypto.getRandomValues(new Uint8Array(length)),
    now: Date.now,
    schedule: (fn, ms) => {
      const handle = setTimeout(fn, ms)
      return () => clearTimeout(handle)
    },
    jitter: Math.random,
    onState: (state) => relayController?.report(state),
    onHandshakeFailed: () => relayController?.handshakeFailed(),
    shell: officialShell
  })
}

/** Back on Tailscale: the host name the relay left in the state must not read as a PC rename. */
async function leaveRelayHost(dnsName: string): Promise<void> {
  const recorded = remoteState?.state.hostName
  if (recorded?.endsWith(`.${relayDomain()}`)) await remoteState?.update({ hostName: dnsName })
}

/** The relay check's second step: the connection the controller already has, settled one way or the other. */
async function settledRelayState() {
  for (let waited = 0; waited < 10_000; waited += 200) {
    const state = relayController?.current()
    if (state && (state.state === 'online' || state.state === 'error')) return state
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return relayController?.current() ?? { state: 'off' as const }
}

/** The relay check's last step: a paired phone answering a test message (026 AC-2.5), if there is one. */
async function pingRelayPhone(): Promise<'none' | 'answered' | 'silent'> {
  const target = [...(remote?.currentDevices() ?? [])].filter((device) => !device.dormant).sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))[0]
  if (!target) return 'none'
  const answered = new Promise<boolean>((resolve) => phoneTestWaiters.set(target.id, resolve))
  if (!remote?.testDevice(target.id)) {
    phoneTestWaiters.delete(target.id)
    return 'none'
  }
  const timer = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), REMOTE_LIMITS.testWaitMs).unref())
  const ok = await Promise.race([answered, timer])
  phoneTestWaiters.delete(target.id)
  return ok ? 'answered' : 'silent'
}

/** Reads the device records fresh from disk (T28/T35): works even when the channel is off. */
async function loadRemoteDevices(): Promise<DeviceRecord[]> {
  const sealBox = {
    seal: async (text: string) => (await host.request({ action: 'secret.seal', text })).message,
    open: async (text: string) => (await host.request({ action: 'secret.open', text })).message
  }
  return (await DeviceStore.load({ dir: join(dataDir, 'remote'), now: Date.now, sealBox })).devices()
}

/** The single shared remote thread; its id lives in state.json, never in settings (AC-1.5). */
function remoteConversation(fresh = false): Thread {
  const threadId = remoteState?.state.threadId
  const existing = !fresh && threadId ? store.list().find((t) => t.id === threadId) : undefined
  const agent = settings.agents.some((a) => a.id === settings.remote.agentId) ? settings.remote.agentId : settings.defaultAgentId
  if (existing) {
    const thread = store.get(existing.id)
    if (thread.agentId !== agent) {
      thread.agentId = agent
      store.save(thread.id)
    }
    return thread
  }
  const thread = store.create(agent, settings.defaultWorkspace, 'remote')
  void remoteState?.update({ threadId: thread.id })
  broadcast({ type: 'thread.updated', summary: summarize(thread) })
  return thread
}

function createRemote(): Promise<RemoteChannel> {
  const dir = join(dataDir, 'remote')
  const sealBox = {
    seal: async (text: string) => (await host.request({ action: 'secret.seal', text })).message,
    open: async (text: string) => (await host.request({ action: 'secret.open', text })).message
  }
  return (async () => {
    const deviceStore = await DeviceStore.load({ dir, now: Date.now, sealBox })
    remoteState = await RemoteStateStore.load({ dir, sealBox })
    relayController = new RelayController({
      record: (entry) => audit(entry),
      notify: () => toParent({ type: 'notify', title: translate(settings.language, 'remote.notice.relayDown.title'), body: translate(settings.language, 'remote.notice.relayDown') }),
      onChange: () => broadcast({ type: 'remote.status', status: remoteStatusNow(remote?.currentStatus() ?? { state: 'off' }) })
    })
    const relays = await relayStoreNow()
    activeTransport = relaySelected() ? 'relay' : 'tailscale'
    relayController.select(relaySelected())
    relayController.setRenamed(relays.renamed())
    const tails = new TailscaleController({
      exec: execTailscale,
      openExternal: async (target) => (await host.request({ action: 'remote.open', target })).ok,
      online: async () => (await host.request({ action: 'net.online' })).ok,
      pickPort: pickFreePort,
      store: remoteState,
      now: Date.now,
      confirm: async (kind, params) => (await host.request({ action: 'remote.confirm', kind, params })).ok
    })
    tailscaleController = tails
    const channel = new RemoteChannel({
      settings: () => settings,
      now: Date.now,
      random: (length: number) => crypto.getRandomValues(new Uint8Array(length)),
      store: deviceStore,
      state: remoteState,
      transport: async () => {
        if (relaySelected()) return relayTransport(deviceStore, relays)
        if (!tailscaleController) throw new TransportStartError('tailscaleDown', 'tailscale not ready')
        const dnsName = await tailscaleController.dnsName()
        if (!dnsName) throw new TransportStartError('tailscaleDown', 'tailscale not connected')
        await leaveRelayHost(dnsName)
        // The bundle is CJS: the coordinator runs from out/main, the PWA builds into out/remote.
        return new TailscaleTransport({ port: await tailscaleController.ensurePort(), assetsDir: join(__dirname, '..', 'remote'), dnsName })
      },
      host: {
        confirm: async (kind, params) => (await host.request({ action: 'remote.confirm', kind, params })).ok
      },
      onStatus: (status) => broadcast({ type: 'remote.status', status: remoteStatusNow(status) }),
      onPairing: (pairing) => broadcast({ type: 'remote.pairing', pairing }),
      onDevices: (devices) => {
        broadcast({ type: 'remote.devices', devices })
        toParent({ type: 'remote.devices', names: devices.map((device) => device.name) })
      },
      conversation: (fresh) => remoteConversation(fresh),
      ask: (threadId, text, attachmentIds) => startRun(threadId, text, { attachments: attachmentIds }).done,
      cancel: (threadId) => runs.get(threadId)?.abort(),
      pendingApprovals: () => approvals.pending(),
      respondApproval: (approvalId, decision) => approvals.respond(approvalId, decision, 'phone'),
      onEvent,
      direct: {
        home,
        toolContext: () => ({
          workspace: settings.defaultWorkspace,
          signal: new AbortController().signal,
          settings,
          host,
          home,
          language: settings.language
        }),
        authorize: (request) => authorize({ ...request, broker: approvals, rememberAlwaysAllow })
      },
      // The active vault of this moment, never a company's (BR-22); its folder can vanish after it was opened.
      vault: () => {
        const base = knowledge
        if (!base) return null
        return {
          state: () => (existsSync(base.root) ? 'ready' : 'none'),
          tree: () => base.tree(),
          readText: (path) => base.read(path),
          readBytes: (path, maxBytes) => base.readBytes(path, maxBytes)
        }
      },
      // `store.get` throws on a missing id, so the lookup checks the list first (T36).
      threads: {
        list: () => store.list(),
        get: (id) => (store.list().some((summary) => summary.id === id) ? store.get(id) : undefined),
        isRunning: (id) => runs.has(id),
        markOpened: (id, at) => store.markOpened(id, at)
      },
      files: new PhoneFiles({
        store: attachments,
        threads: { get: (id) => (store.list().some((summary) => summary.id === id) ? store.get(id) : undefined) },
        settings: () => settings,
        env: () => process.env
      }),
      // Expiry timers of pending uploads never keep the process alive.
      timers: {
        set: (fn, ms) => setTimeout(fn, ms).unref(),
        clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
      },
      record: (entry) => audit(entry),
      onTestResult: (testedDeviceId, ok) => {
        phoneTestWaiters.get(testedDeviceId)?.(ok)
        broadcast({ type: 'remote.tested', deviceId: testedDeviceId, ok })
      },
      // The only outbound call remote access makes (AC-9.1): approval pushes with an empty body, and the greeting's encrypted fixed code (spec 033 D-1).
      post: async (url, headers, body) => ({ ok: (await fetch(url, { method: 'POST', headers, body })).ok }),
      landing: (deviceId) => dream?.phoneLanding(deviceId) ?? null
    })
    const monitor = new TailscaleMonitor({
      read: () => tails.probe(),
      now: Date.now,
      store: remoteState,
      channel,
      notify: () => toParent({ type: 'notify', title: translate(settings.language, 'remote.notice.down.title'), body: translate(settings.language, 'remote.notice.down') })
    })
    tailscaleMonitor = monitor
    if (settings.remote.enabled && !relaySelected()) monitor.start()
    return channel
  })()
}

// Created on init (it keeps its session in the data folder).
let whatsapp: WhatsAppChannel

function createWhatsApp(): WhatsAppChannel {
  return new WhatsAppChannel({
    settings: () => settings,
    dataDir,
    patch: (patch) => patchSettings({ whatsapp: { ...settings.whatsapp, ...patch } }),
    conversation: (fresh) => channelConversation('whatsapp', fresh),
    ask: (threadId, text) => startRun(threadId, text).done,
    lastAnswer,
    transcribe: (audio, mime) => voice.transcribeFile(audio, mime),
    onEvent: quiet.onEvent(onEvent),
    respondApproval: quiet.respondApproval((approvalId, decision) => approvals.respond(approvalId, decision, 'whatsapp')),
    onStatus: (status) => broadcast({ type: 'whatsapp.status', status })
  })
}

let companies: CompanyEngine

// Created on init (it keeps its plan and rules in the data folder).
let home: HomeService

const inboxDir = (): string => join(dataDir, 'inbox')

// Created on init: the files people attach to a message (spec 030), indexed under inbox/attachments.
let attachments: AttachmentStore
// The page's requests about them (store, remove, preview, open, readers, threads.open); created on init next to the store.
let attachmentService: AttachmentService

/** Saves a picture the user sent (chat, Telegram) where look_at_image can read it. */
function saveInboxImage(bytes: Buffer, name: string): string {
  mkdirSync(inboxDir(), { recursive: true })
  const path = join(inboxDir(), `${Date.now().toString(36)}-${inboxFileName(name)}`)
  writeFileSync(path, bytes)
  return path
}

/** Where a home notice reaches the user: the desktop and, if connected, Telegram (with the picture when there is one). */
function notifyHome(title: string, body: string, photo?: Buffer): void {
  toParent({ type: 'notify', title, body, always: true })
  const sent = photo ? telegram.notifyPhoto(photo, `${title}
${body}`) : telegram.notify(`${title}
${body}`)
  void sent.catch((error: Error) => console.error('[telegram] home:', error.message))
}

/** A rule that needs judgment fired: an agent works on it in a conversation of its own. */
function launchHomeRule(rule: JudgmentRule, change: StateChange, thingName: string): void {
  const agentId = settings.agents.some((a) => a.id === settings.home.agentId) ? settings.home.agentId : settings.defaultAgentId
  const thread = store.create(agentId, settings.defaultWorkspace)
  const at = formatDateTime(settings.language, new Date(), 'dayTime')
  thread.title = houseThreadTitle(settings.language, rule.name, at)
  store.save(thread.id)
  broadcast({ type: 'thread.updated', summary: summarize(thread) })
  const prompt = houseRulePrompt({ rule: rule.name, thing: thingName, entityId: change.entityId, from: change.from, to: change.to, at: formatDateTime('en', new Date(), 'dayTime'), instructions: rule.prompt })
  // The user approved this rule's instructions when it was made, so the camera it asks for doesn't ask again.
  startRun(thread.id, prompt, { autoApprove: ['camera_look'], unattended: true }).done.catch((error: Error) => toParent({ type: 'notify', ...ruleFailedNotice(settings.language, rule.name, error.message), threadId: thread.id }))
}

function createHome(): HomeService {
  return new HomeService({
    dataDir,
    settings: () => settings,
    host,
    emit: broadcast,
    launchRule: launchHomeRule,
    notify: notifyHome,
    readVault: async (path) => (await activeVault().read(path)).content,
    look: (pictures, question) => look(settings, pictures, question)
  })
}

function createCompanies(): CompanyEngine {
  return new CompanyEngine({
    settings: () => settings,
    store: new CompanyStore(dataDir),
    runMember: (company, memberId, title, prompt, options) => {
      const thread = store.create(memberId, company.vault, 'company')
      thread.title = title
      store.save(thread.id)
      broadcast({ type: 'thread.updated', summary: summarize(thread) })
      const { done } = startRun(thread.id, prompt, { ...options, unattended: true })
      return { threadId: thread.id, done: done.then(() => lastAnswer(thread.id)) }
    },
    complete: async (profile, system, prompt) => {
      const provider = getProvider(profile.provider, settings)
      let text = ''
      const turn = await provider.streamTurn({
        model: profile.model,
        effort: 'low',
        system,
        tools: [],
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], ts: Date.now() }],
        signal: new AbortController().signal,
        onText: (delta) => (text += delta),
        onThinking: () => {},
        onToolStart: () => {}
      })
      const final = turn.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
      return { text: final || text, usage: turn.usage }
    },
    writeNote: async (company, path, content) => {
      const base = vaultFor(company.vault)
      if (!base) throw new Error(translate(settings.language, 'error.companyNoVault'))
      await base.write(path, content)
    },
    noteExists: (company, path) => {
      const base = vaultFor(company.vault)
      return !!base && existsSync(join(base.root, ...path.split('/')))
    },
    notify: (title, body) => {
      toParent({ type: 'notify', title, body, always: true })
      void telegram.notify(`${title}\n${body}`).catch(() => {})
    },
    emit: broadcast
  })
}

// Each company with its own WhatsApp number gets its own linked session.
const companyChannels = new Map<string, WhatsAppChannel>()

function companyWhatsApp(company: Company): WhatsAppChannel {
  let channel = companyChannels.get(company.id)
  if (!channel) {
    channel = new WhatsAppChannel({
      settings: () => settings,
      dataDir,
      authDir: join(dataDir, `whatsapp-auth-${company.id}`),
      config: () => {
        const current = settings.companies.find((c) => c.id === company.id)
        return { enabled: !!current?.whatsapp, threadId: current ? (companyThreads.get(current.id) ?? null) : null }
      },
      patch: (patch) => {
        if (patch.threadId !== undefined) companyThreads.set(company.id, patch.threadId)
      },
      conversation: (fresh = false) => {
        const current = settings.companies.find((c) => c.id === company.id) ?? company
        const existing = !fresh && companyThreads.get(current.id)
        if (existing && store.list().some((t) => t.id === existing)) return store.get(existing)
        const thread = store.create(companies.head(current) ?? settings.defaultAgentId, current.vault, 'whatsapp')
        thread.title = `${current.name} · WhatsApp`
        // Marks it as the company's whoever answers it: with no head the main agent does, and the dream must still skip it (033 AC-3.4).
        thread.companyId = current.id
        store.save(thread.id)
        companyThreads.set(current.id, thread.id)
        broadcast({ type: 'thread.updated', summary: summarize(thread) })
        return thread
      },
      ask: (threadId, text) => startRun(threadId, text).done,
      lastAnswer,
      transcribe: (audio, mime) => voice.transcribeFile(audio, mime),
      onEvent: quiet.onEvent(onEvent),
      respondApproval: quiet.respondApproval((approvalId, decision) => approvals.respond(approvalId, decision, 'whatsapp')),
      onStatus: (status) => broadcast({ type: 'company.whatsapp', companyId: company.id, status })
    })
    companyChannels.set(company.id, channel)
  }
  return channel
}
const companyThreads = new Map<string, string | null>()

function syncCompanyChannels(): void {
  for (const company of settings.companies) if (company.whatsapp || companyChannels.has(company.id)) void companyWhatsApp(company).sync()
}

const VOICE_SESSION_MS = 60 * 60_000

// Created on init (it needs the data folder).
let voice: VoiceAssistant

function createVoice(): VoiceAssistant {
  return new VoiceAssistant({
    settings: () => settings,
    dataDir,
    conversation: () => {
      const { threadId, agentId } = settings.voice
      const agent = settings.agents.some((a) => a.id === agentId) ? agentId : settings.defaultAgentId
      const recent = threadId ? store.list().find((t) => t.id === threadId && Date.now() - t.updatedAt < VOICE_SESSION_MS) : undefined
      if (recent) {
        const thread = store.get(recent.id)
        if (thread.agentId !== agent) thread.agentId = agent
        return thread
      }
      const thread = store.create(agent, settings.defaultWorkspace, 'voice')
      patchSettings({ voice: { ...settings.voice, threadId: thread.id } })
      broadcast({ type: 'thread.updated', summary: summarize(thread) })
      return thread
    },
    ask: (threadId, text) => startRun(threadId, text).done,
    stop: (threadId) => runs.get(threadId)?.abort(),
    lastAnswer,
    conversationEnded: (threadId) => conversationEnded(store.get(threadId).messages),
    onEvent: quiet.onEvent(onEvent),
    respondApproval: quiet.respondApproval((approvalId, decision) => approvals.respond(approvalId, decision, 'voice')),
    emit: broadcast
  })
}

function launchRoutine(routine: Routine): { threadId?: string; done: Promise<void> } {
  if (routine.action === 'reminder') {
    deliverReminder(routine)
    return { done: Promise.resolve() }
  }
  const agentId = settings.agents.some((a) => a.id === routine.agentId) ? routine.agentId : settings.defaultAgentId
  const thread = store.create(agentId, routine.workspace || settings.defaultWorkspace)
  const when = formatDateTime(settings.language, new Date(), 'dayTime')
  thread.title = routineThreadTitle(settings.language, routine.name, when)
  store.save(thread.id)
  const { done } = startRun(thread.id, routine.prompt, { unattended: true })
  const finished = done.then(
    () => toParent({ type: 'notify', ...routineNotice(settings.language, routine.name, { ok: true, threadTitle: thread.title }), threadId: thread.id }),
    (error: Error) => toParent({ type: 'notify', ...routineNotice(settings.language, routine.name, { ok: false, message: error.message }), threadId: thread.id })
  )
  return { threadId: thread.id, done: finished }
}

/** Deletes conversations nobody has touched in the configured number of days (0 = keep them), except running ones. */
function applyRetention(): void {
  const days = settings.privacy.threadRetentionDays
  if (!(days > 0) || !store) return
  const cutoff = Date.now() - days * 86_400_000
  const expired = store.list().filter((thread) => thread.updatedAt < cutoff && !runs.has(thread.id))
  for (const thread of expired) store.delete(thread.id)
  if (expired.length) audit({ action: 'privacy.retention', actor: 'system', outcome: 'ok', detail: { threads: expired.length, days } })
}

/** Deletes the attachment files of conversations not opened for 30 days (spec 030), except running ones. */
function sweepAttachments(): void {
  attachments.sweep(
    (threadId) => {
      try {
        return store.get(threadId).lastOpenedAt
      } catch {
        return undefined
      }
    },
    new Set(runs.keys()),
    // a deleted conversation's leftovers (its erase was blocked, plan G7) are swept at once, never kept waiting
    (threadId) => {
      try {
        store.get(threadId)
        return true
      } catch {
        return false
      }
    }
  )
}

async function handle(request: CoordinatorRequest): Promise<unknown> {
  if (request.method.startsWith('home.')) return home.handle(request)
  switch (request.method) {
    case 'threads.list':
      return store.list()
    case 'threads.get':
      return store.get(request.threadId)
    case 'threads.create': {
      const thread = store.create(request.agentId, request.workspace)
      broadcast({ type: 'thread.updated', summary: summarize(thread) })
      return thread
    }
    case 'threads.update': {
      const thread = store.get(request.threadId)
      if (request.title !== undefined) thread.title = request.title.trim() || untitledTitle(settings.language)
      if (request.agentId !== undefined) thread.agentId = request.agentId
      if (request.workspace !== undefined) thread.workspace = request.workspace
      if (request.model !== undefined) {
        if (request.model) thread.model = request.model
        else delete thread.model
      }
      store.save(thread.id)
      broadcast({ type: 'thread.updated', summary: summarize(thread) })
      return summarize(thread)
    }
    case 'threads.delete':
      runs.get(request.threadId)?.abort()
      store.delete(request.threadId)
      return null
    case 'chat.send':
      startRun(request.threadId, request.text, { attachments: request.attachments })
      return null
    case 'attachments.store':
    case 'attachments.remove':
    case 'attachments.preview':
    case 'attachments.open':
    case 'attachments.readers':
    case 'threads.open':
      return attachmentService.handle(request)
    case 'chat.stop':
      runs.get(request.threadId)?.abort()
      return null
    case 'runs.active':
      return [...runs.keys()]
    case 'approval.respond':
      approvals.respond(request.approvalId, request.decision, 'desktop')
      return null
    case 'approval.pending':
      return approvals.pending()
    case 'remote.activity': {
      // The channel owns these when it runs (T35); the request reads them fresh so the
      // tab is always current, even right after a restart.
      return readRemoteActivity({ dataDir, devices: await loadRemoteDevices() })
    }
    case 'remote.pair.start':
      return (await remote?.pairStart()) ?? { ok: false as const, reason: 'off' as const }
    case 'remote.pair.approve':
      if (!remote) throw new Error(translate(settings.language, 'error.noRemote'))
      return remote.pairApprove(request.name).then(async (approved) => {
        // A phone paired through the relay: remember the domain it paired under (spec 027 AC-4.8).
        // A failed save is reported by the store itself (an audit entry) and never undoes the pairing.
        if (approved.ok && relaySelected()) await (await relayStoreNow()).recordPairing()
        return approved
      })
    case 'remote.pair.reject':
      await remote?.pairReject()
      return null
    case 'remote.pair.cancel':
      remote?.pairCancel()
      return null
    case 'remote.revoke':
      await remote?.revokeDevice(request.deviceId)
      return null
    case 'remote.revokeAll': {
      const revoked = (await remote?.revokeAll()) ?? { ok: false as const }
      // Revoking the phones is how the person acts on a renamed relay: the next pairing is the new baseline.
      if (revoked.ok && relayStore?.renamed()) {
        await relayStore.acknowledgeRename()
        relayController?.setRenamed(false)
      }
      return revoked
    }
    case 'remote.test':
      return remote?.testDevice(request.deviceId) ?? null
    case 'remote.status':
      return remoteStatusNow(remote?.currentStatus() ?? { state: 'off' as const })
    case 'remote.relayTest':
      return runRelayTest({ internet: async () => (await host.request({ action: 'net.online' })).ok, connect: settledRelayState, phone: pingRelayPhone })
    case 'remote.detect': {
      if (!tailscaleController || relaySelected()) return undefined
      const current = remote?.currentStatus() ?? { state: 'off' as const }
      const found = await tailscaleController.detect({
        listenerUp: current.state === 'online',
        listenerDetail: current.detail,
        channelFailure: current.state === 'error' ? current.failure : undefined
      })
      if (found.failure) return { tailscale: found.tailscale, status: { state: 'error' as const, ...found.failure } }
      return { tailscale: found.tailscale, status: current }
    }
    case 'remote.serve':
      if (!tailscaleController || relaySelected()) return { ok: false as const, failure: 'tailscaleDown' as const }
      return tailscaleController.serve()
    case 'remote.pickPort':
      if (!tailscaleController || relaySelected()) return { ok: false as const, failure: 'tailscaleDown' as const }
      return tailscaleController.pickPort()
    case 'remote.devices':
      return remote?.currentDevices() ?? []
    case 'remote.open':
      // Main chooses the URL from the fixed id and confirms the download (T16).
      if (request.target === 'tailscale-download' && tailscaleController) return tailscaleController.download()
      await host.request({ action: 'remote.open', target: request.target })
      return null
    case 'mcp.status':
      return mcp.statuses()
    case 'mcp.reconnect':
      await mcp.sync(settings.mcpServers, true)
      return mcp.statuses()
    case 'models.list':
      return (await getProvider(request.provider, settings).listModels()).sort()
    case 'images.models':
      return listImageModels(settings, request.provider)
    case 'files.image':
      return imageDataUrl(resolveInWorkspace(store.get(request.threadId).workspace, request.path))
    case 'routines.state':
      return routines.snapshot()
    case 'dream.status':
      return dream?.status() ?? null
    case 'routines.runNow': {
      const routine = settings.routines.find((r) => r.id === request.routineId)
      if (!routine) throw new Error(translate(settings.language, 'error.routineMissing'))
      // Testing a reminder must not use it up: a one-off would count as already fired.
      if (routine.action === 'reminder') {
        deliverReminder(routine)
        return null
      }
      const threadId = routines.run(routine)
      if (threadId) broadcast({ type: 'thread.updated', summary: summarize(store.get(threadId)) })
      return threadId ?? null
    }
    case 'vault.tree':
      return knowledge ? knowledge.tree() : []
    case 'vault.read':
      return activeVault().read(request.path)
    case 'vault.write':
      return activeVault().write(request.path, request.content)
    case 'vault.create':
      return activeVault().create(request.path, request.entry)
    case 'vault.rename':
      return activeVault().rename(request.from, request.to)
    case 'vault.delete':
      return activeVault().delete(request.path)
    case 'vault.search':
      return activeVault().search(request.query, request.limit)
    case 'vault.init':
      await initVault(request.path, settings.language)
      return null
    case 'knowledge.status':
      return knowledge?.status() ?? null
    case 'knowledge.overview':
      return knowledge ? knowledge.overview() : { memories: [], notes: [] }
    case 'knowledge.forget':
      return activeVault().forget(request.text)
    case 'telegram.status':
      return telegram.currentStatus()
    case 'whatsapp.status':
      return whatsapp.currentStatus()
    case 'whatsapp.logout':
      await whatsapp.logout()
      return null
    case 'email.test':
      return testEmail(settings)
    case 'company.snapshot':
      return companies.snapshot(request.companyId)
    case 'company.task.create':
      return companies.createTask(companies.company(request.companyId), { title: request.title, description: request.description, assignee: request.assignee, createdBy: 'user' })
    case 'company.task.comment':
      companies.comment(companies.company(request.companyId), request.taskId, 'user', request.text)
      return null
    case 'company.task.review':
      return companies.review(companies.company(request.companyId), request.taskId, 'user', request.approve, request.comment)
    case 'company.task.move':
      companies.move(companies.company(request.companyId), request.taskId, request.status, 'user')
      return null
    case 'company.task.delete':
      companies.remove(companies.company(request.companyId), request.taskId)
      return null
    case 'company.meeting.create': {
      const { companyId, topic, agenda, participants, chair, at, prepHours } = request
      return companies.createMeeting(companies.company(companyId), { topic, agenda, participants, chair, at, prepHours, createdBy: 'user' })
    }
    case 'company.meeting.start':
      companies.startNow(companies.company(request.companyId), request.meetingId)
      return null
    case 'company.meeting.say':
      companies.say(companies.company(request.companyId), request.meetingId, request.text)
      return null
    case 'company.meeting.end':
      companies.end(companies.company(request.companyId), request.meetingId)
      return null
    case 'company.meeting.cancel':
      companies.cancel(companies.company(request.companyId), request.meetingId)
      return null
    case 'company.whatsapp.status':
      return companyChannels.get(request.companyId)?.currentStatus() ?? { state: 'off' }
    case 'company.whatsapp.logout':
      await companyChannels.get(request.companyId)?.logout()
      return null
    case 'privacy.export': {
      // The dream journal and the memory file of the active vault (spec 033 BR-23); the rest of the vault is the person's.
      const kb = knowledge
      const vaultFiles = kb ? [kb.journalFolder(), kb.memoryFile()].map((path) => join(kb.root, ...path.split('/'))) : []
      const folder = exportPersonalData(dataDir, request.targetDir, new Date(), vaultFiles)
      // The device list (AC-9.5): names and dates, never key material. Read fresh from
      // disk so the export is complete even when remote access is off.
      writeFileSync(join(folder, 'remote-devices.json'), `${JSON.stringify(deviceExportList(await loadRemoteDevices()), null, 2)}\n`)
      // Which transport is selected and whether the relay is on; never an id or a key (spec 027 AC-8.3).
      writeFileSync(join(folder, 'remote-transport.json'), `${JSON.stringify(transportExport(settings.remote), null, 2)}\n`)
      audit({ action: 'privacy.export', actor: 'user', outcome: 'ok' })
      return folder
    }
    case 'privacy.erase': {
      const threads = store.list()
      for (const thread of threads) {
        runs.get(thread.id)?.abort()
        store.delete(thread.id)
      }
      erasePersonalFiles(inboxDir())
      presence?.clear()
      dream?.clear()
      await voice.forgetProfile()
      // Every device revoked as in AC-6.2 (AC-9.4): the person already confirmed, so
      // no second ask. Counts only in the entry, like the thread count.
      const erased = await remote?.erase()
      // The PC leaves the relay and forgets its routing id; the relay keeps nothing, so it is told nothing (spec 027 AC-8.2).
      await eraseRelay({ store: await relayStoreNow(), disconnect: () => remote?.stop() })
      relayController?.setRenamed(false)
      void remote?.sync()
      audit({ action: 'privacy.erase', actor: 'user', outcome: 'ok', detail: { threads: threads.length, devices: erased?.devices ?? 0 } })
      return null
    }
    case 'voice.status':
      return voice.currentStatus()
    case 'voice.trigger':
      voice.trigger()
      return null
    case 'voice.cancel':
      voice.cancel()
      return null
    case 'voice.played':
      voice.played()
      return null
    case 'voice.enroll':
      return voice.enroll(request.samples)
    case 'voice.profile':
      return voice.profileInfo()
    case 'voice.forgetProfile':
      await voice.forgetProfile()
      return null
    case 'voice.testSpeaker':
      return voice.testSpeaker(request.sample)
    case 'voice.say':
      await voice.say(request.text)
      return null
    case 'voice.elevenVoices':
      return voice.elevenVoices()
  }
}

function attachClient(port: MessagePortMain): void {
  clients.add(port)
  port.on('message', (event) => {
    const data = event.data as RequestEnvelope | AudioEnvelope
    if (data?.kind === 'audio') return voice.audio(data.pcm)
    const request = data as RequestEnvelope
    if (request?.kind !== 'request') return
    handle(request)
      .then((result) => port.postMessage({ kind: 'response', reqId: request.reqId, ok: true, result }))
      .catch((error: Error) => port.postMessage({ kind: 'response', reqId: request.reqId, ok: false, error: shownError(error, settings.language) }))
  })
  port.on('close', () => clients.delete(port))
  port.start()
}

process.parentPort.on('message', (event) => {
  const message = event.data as ParentToCoordinator
  switch (message.type) {
    case 'init':
      settings = message.settings
      dataDir = message.dataDir
      packaged = message.packaged
      defaultVaultPath = message.defaultVaultPath
      initAudit(dataDir, 'coordinator')
      attachments = new AttachmentStore(inboxDir(), { opened: (id, at) => store.markOpened(id, at), log: attachmentLog(audit) })
      store = new ThreadStore(message.dataDir, () => settings.language, (id) => attachments.deleteForThread(id))
      attachmentService = new AttachmentService({ store: attachments, threads: store, settings: () => settings, host })
      routines = new RoutineRunner(
        message.dataDir,
        () => settings.routines,
        launchRoutine,
        (state) => broadcast({ type: 'routines.state', state }),
        () => settings.language
      )
      routines.start()
      dream = createDream()
      dream.start()
      {
        const landing = dream.desktopLanding()
        if (landing) toParent({ type: 'landing', threadId: landing })
      }
      presence = new PresenceService({
        file: join(dataDir, 'presence.json'),
        now: () => new Date(),
        thresholdMs: presenceThreshold(packaged, process.env),
        consumers: () => (dream ? [dream] : []),
        log: (line) => console.warn(line)
      })
      presence.consumersChanged()
      applyRetention()
      setInterval(applyRetention, 12 * 3_600_000).unref()
      scheduleSweep(sweepAttachments)
      void mcp.sync(settings.mcpServers)
      void syncVault()
      void telegram.sync()
      voice = createVoice()
      voice.sync()
      whatsapp = createWhatsApp()
      void whatsapp.sync()
      companies = createCompanies()
      companies.start()
      syncCompanyChannels()
      home = createHome()
      home.start()
      void createRemote()
        .then((channel) => {
          remote = channel
          return remote.sync()
        })
        .catch((error: Error) => console.error(`[remote] boot failed: ${error.message}`))
      break
    case 'settings':
      settings = message.settings
      dream?.settingsChanged()
      presence?.consumersChanged()
      applyRetention()
      void mcp.sync(settings.mcpServers)
      void syncVault()
      void telegram.sync()
      voice.sync()
      void whatsapp.sync()
      syncCompanyChannels()
      void home.sync()
      {
        // With the relay selected Tailscale is left alone (spec 027 AC-1.10), except to take down the Serve entry it left behind.
        const change = planTransportChange({ transport: settings.remote.transport, available: relayAvailable({ domain: relayDomain(), packaged }), enabled: settings.remote.enabled, active: activeTransport })
        relayController?.select(change.use === 'relay')
        if (change.monitor) tailscaleMonitor?.start()
        else {
          tailscaleMonitor?.stop()
          if (change.unserve) void tailscaleController?.unserve()
        }
        if (change.restart) {
          // A new transport means stopping the old one first: the channel keeps the one it started with.
          activeTransport = change.use
          void Promise.resolve(remote?.stop()).then(() => remote?.sync())
        } else void remote?.sync()
      }
      break
    case 'voice.trigger':
      voice.trigger()
      break
    case 'presence':
      // Sleep interrupts a running dream; the resume is a catch-up moment (spec 033 AC-4.4, AC-2.2).
      if (presence?.receive(message.event) === 'resume') dream?.resumed().catch((error: unknown) => console.error(`[dream] the resume check failed: ${error instanceof Error ? error.name : 'error'}`))
      break
    case 'landing.used':
      dream?.landingUsed(message.threadId)
      break
    case 'client':
      attachClient(event.ports[0])
      break
    case 'host.result':
      hostWaiters.get(message.reqId)?.({ ok: message.ok, message: message.message })
      hostWaiters.delete(message.reqId)
      break
  }
})

const shutdown = (): void => {
  routines?.stop()
  for (const controller of runs.values()) controller.abort()
  store?.flushAll()
  void Promise.all([
    mcp.closeAll(),
    knowledge?.close(),
    embedder?.close(),
    telegram.stop(),
    voice?.close(),
    home?.stop(),
    tailscaleController?.unserve(),
    remote?.stop()
  ]).finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('exit', () => store?.flushAll())
