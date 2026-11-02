// Agent coordinator: runs in an Electron utilityProcess and talks to renderers over MessagePorts.
import type { MessagePortMain } from 'electron'
import { audit, initAudit } from '../shared/audit'
import type { JudgmentRule } from '../shared/home'
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
  RequestEnvelope,
  Routine,
  Company,
  Settings,
  Thread
} from '../shared/types'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { repairDanglingToolUses, runAgent } from './agent'
import { ApprovalBroker } from './approval'
import { listImageModels } from './images'
import { erasePersonalFiles, exportPersonalData } from './privacy'
import { TelegramChannel } from './channels/telegram'
import { WhatsAppChannel } from './channels/whatsapp'
import { CompanyEngine } from './company/engine'
import { CompanyStore } from './company/store'
import { HomeService } from './home'
import { look } from './vision'
import { testEmail } from './tools/email'
import { VoiceAssistant } from './voice/assistant'
import { KnowledgeBase } from './knowledge/base'
import { WorkerEmbedder } from './knowledge/embedder'
import { McpManager } from './mcp'
import { getProvider } from './providers'
import { RoutineRunner } from './routines'
import { ThreadStore, summarize, UNTITLED } from './store'
import { imageDataUrl } from './tools/media'
import { resolveInWorkspace } from './tools/paths'
import type { Host } from './tools/types'
import type { StateChange } from './home/hub'

let settings: Settings
let store: ThreadStore
let routines: RoutineRunner
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
  if (approval.toolName === 'instagram_publish') {
    const caption = approval.preview?.caption?.split('\n')[0] ?? ''
    toParent({ type: 'notify', title: 'Post listo para Instagram', body: caption || thread.title, threadId: thread.id })
  } else {
    toParent({ type: 'notify', title: 'Un agente necesita tu aprobación', body: thread.title, threadId: thread.id })
  }
}

const approvals = new ApprovalBroker((event) => {
  broadcast(event)
  if (event.type === 'approval.request') notifyApproval(event.approval)
})
const mcp = new McpManager((servers) => broadcast({ type: 'mcp.status', servers }))

const WELCOME_NOTE = `# Bienvenida

Este es tu vault: una carpeta de notas en markdown.

- Alma busca en estas notas para responderte y guarda lo que aprende en la carpeta \`Alma/\`.
- \`Alma/Recuerdos.md\` tiene lo que Alma recuerda de vos; editalo cuando quieras.
- \`Alma/Conocimientos/\` tiene las notas que escribe Alma.
`

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
    embedder ??= new WorkerEmbedder(join(dataDir, 'models'), () => knowledge?.emitStatus())
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
        onChanged: () => broadcast({ type: 'vault.changed' })
      })
      knowledge.start()
      knowledge.warmUp()
    } catch (error) {
      console.error('[coordinator] no se pudo abrir el vault:', error)
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
      embedder ??= new WorkerEmbedder(join(dataDir, 'models'), () => knowledge?.emitStatus())
      base = new KnowledgeBase({
        root,
        dataDir,
        embedder,
        trash: async (path) => {
          const result = await host.request({ action: 'trash', path })
          if (!result.ok) throw new Error(result.message)
        },
        onStatus: () => {},
        onChanged: () => broadcast({ type: 'vault.changed' })
      })
      base.start()
      companyVaults.set(root.toLowerCase(), base)
    } catch (error) {
      console.error('[coordinator] no se pudo abrir el vault de la empresa:', error)
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
  if (!knowledge) throw new Error('No hay un vault abierto.')
  return knowledge
}

function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0]
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || UNTITLED
}

/** Starts an agent run on a thread. Throws right away if one is already running; `done` settles when it ends. */
function startRun(threadId: string, text: string, options: { noAsk?: boolean; autoApprove?: string[] } = {}): { done: Promise<void> } {
  if (runs.has(threadId)) throw new Error('Ya hay una ejecución en curso en esta conversación.')
  const thread = store.get(threadId)
  const profile = settings.agents.find((a) => a.id === thread.agentId) ?? settings.agents[0]
  if (!profile) throw new Error('No hay agentes configurados.')
  // A company agent works with its company's vault, accounts and budget.
  const company = profile.companyId ? settings.companies.find((c) => c.id === profile.companyId) : undefined
  if (company) {
    const why = companies.overBudget(company, profile.id)
    if (why) throw new Error(`No puede trabajar: ${why}.`)
  }

  repairDanglingToolUses(thread.messages)
  const userMessage: ChatMessage = { role: 'user', content: [{ type: 'text', text }], ts: Date.now() }
  thread.messages.push(userMessage)
  if (thread.title === UNTITLED) thread.title = titleFrom(text)
  store.save(thread.id)
  broadcast({ type: 'message', scope: { threadId }, message: userMessage })
  broadcast({ type: 'thread.updated', summary: summarize(thread) })

  const controller = new AbortController()
  runs.set(threadId, controller)
  broadcast({ type: 'run.started', threadId })

  const done = runAgent(profile, thread.messages, {
    getSettings: () => (company ? companySettings(company) : settings),
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
    rememberAlwaysAllow: (toolName) => {
      if (!settings.alwaysAllowTools.includes(toolName)) {
        settings = { ...settings, alwaysAllowTools: [...settings.alwaysAllowTools, toolName] }
        toParent({ type: 'alwaysAllow', toolName })
      }
    },
    saveRoutines,
    sendTelegram: (text) => telegram.notify(text),
    whatsapp: company ? (company.whatsapp ? companyWhatsApp(company) : null) : settings.whatsapp.enabled ? whatsapp : null,
    company: company ? { company, memberId: profile.id, engine: companies, noAsk: options.noAsk } : null,
    home: company ? null : home,
    autoApprove: options.autoApprove,
    inboxDir: inboxDir(),
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
  return { done }
}

/** Applied locally right away (the next tool call sees it), then persisted by main, which pushes settings back. */
function saveRoutines(routines: Routine[]): void {
  patchSettings({ routines })
}

function patchSettings(patch: Partial<Omit<Settings, 'providers'>>): void {
  settings = { ...settings, ...patch }
  toParent({ type: 'settings.patch', patch })
}

/** Where a reminder reaches the user: the desktop and, if connected, Telegram. */
function deliverReminder(routine: Routine): void {
  toParent({ type: 'notify', title: 'Recordatorio', body: routine.prompt, always: true })
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
  onEvent,
  respondApproval: (approvalId, decision) => approvals.respond(approvalId, decision),
  onStatus: (status) => broadcast({ type: 'telegram.status', status })
})

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
    onEvent,
    respondApproval: (approvalId, decision) => approvals.respond(approvalId, decision),
    onStatus: (status) => broadcast({ type: 'whatsapp.status', status })
  })
}

let companies: CompanyEngine

// Created on init (it keeps its plan and rules in the data folder).
let home: HomeService

const inboxDir = (): string => join(dataDir, 'inbox')

/** Saves a picture the user sent (chat, Telegram) where look_at_image can read it. */
function saveInboxImage(bytes: Buffer, name: string): string {
  mkdirSync(inboxDir(), { recursive: true })
  const path = join(inboxDir(), `${Date.now().toString(36)}-${name.replace(/[^w.-]+/g, '_').slice(-60)}`)
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
  const at = new Date().toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  thread.title = `Casa · ${rule.name} · ${at}`
  store.save(thread.id)
  broadcast({ type: 'thread.updated', summary: summarize(thread) })
  const prompt = `Se disparó tu regla de la casa «${rule.name}»: «${thingName}» (${change.entityId}) pasó de «${change.from ?? '—'}» a «${change.to ?? '—'}» a las ${at}.
Lo que tenés que hacer: ${rule.prompt}
Actuá ahora con las herramientas de la casa (cámaras con camera_look). Si es algo que el usuario debe saber, avisale con send_telegram; si no pasa nada relevante, no lo molestes y terminá con una línea.`
  // The user approved this rule's instructions when it was made, so the camera it asks for doesn't ask again.
  startRun(thread.id, prompt, { autoApprove: ['camera_look'] }).done.catch((error: Error) => toParent({ type: 'notify', title: `La regla «${rule.name}» falló`, body: error.message, threadId: thread.id }))
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
      const { done } = startRun(thread.id, prompt, options)
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
      if (!base) throw new Error('La empresa no tiene un vault.')
      await base.write(path, content)
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
        store.save(thread.id)
        companyThreads.set(current.id, thread.id)
        broadcast({ type: 'thread.updated', summary: summarize(thread) })
        return thread
      },
      ask: (threadId, text) => startRun(threadId, text).done,
      lastAnswer,
      transcribe: (audio, mime) => voice.transcribeFile(audio, mime),
      onEvent,
      respondApproval: (approvalId, decision) => approvals.respond(approvalId, decision),
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
    onEvent,
    respondApproval: (approvalId, decision) => approvals.respond(approvalId, decision),
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
  const when = new Date().toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  thread.title = `Rutina · ${routine.name} · ${when}`
  store.save(thread.id)
  const { done } = startRun(thread.id, routine.prompt)
  const finished = done.then(
    () => toParent({ type: 'notify', title: `Rutina «${routine.name}» terminada`, body: thread.title, threadId: thread.id }),
    (error: Error) => toParent({ type: 'notify', title: `La rutina «${routine.name}» falló`, body: error.message, threadId: thread.id })
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

async function handle(request: CoordinatorRequest): Promise<unknown> {
  if (request.method.startsWith('home.')) return home.handle(request)
  switch (request.method) {
    case 'files.saveImage':
      return saveInboxImage(Buffer.from(request.base64, 'base64'), request.name)
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
      if (request.title !== undefined) thread.title = request.title.trim() || UNTITLED
      if (request.agentId !== undefined) thread.agentId = request.agentId
      if (request.workspace !== undefined) thread.workspace = request.workspace
      store.save(thread.id)
      broadcast({ type: 'thread.updated', summary: summarize(thread) })
      return summarize(thread)
    }
    case 'threads.delete':
      runs.get(request.threadId)?.abort()
      store.delete(request.threadId)
      return null
    case 'chat.send':
      startRun(request.threadId, request.text)
      return null
    case 'chat.stop':
      runs.get(request.threadId)?.abort()
      return null
    case 'runs.active':
      return [...runs.keys()]
    case 'approval.respond':
      approvals.respond(request.approvalId, request.decision)
      return null
    case 'approval.pending':
      return approvals.pending()
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
    case 'routines.runNow': {
      const routine = settings.routines.find((r) => r.id === request.routineId)
      if (!routine) throw new Error('La rutina no existe.')
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
    case 'vault.init': {
      await mkdir(request.path, { recursive: true })
      const visible = (await readdir(request.path)).filter((name) => !name.startsWith('.'))
      if (visible.length === 0) await writeFile(join(request.path, 'Bienvenida.md'), WELCOME_NOTE, 'utf8')
      return null
    }
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
      const folder = exportPersonalData(dataDir, request.targetDir)
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
      await voice.forgetProfile()
      audit({ action: 'privacy.erase', actor: 'user', outcome: 'ok', detail: { threads: threads.length } })
      return null
    }
    case 'voice.status':
      return voice.currentStatus()
    case 'voice.trigger':
      voice.trigger()
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
      .catch((error: Error) => port.postMessage({ kind: 'response', reqId: request.reqId, ok: false, error: error.message }))
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
      initAudit(dataDir, 'coordinator')
      store = new ThreadStore(message.dataDir)
      routines = new RoutineRunner(message.dataDir, () => settings.routines, launchRoutine, (state) =>
        broadcast({ type: 'routines.state', state })
      )
      routines.start()
      applyRetention()
      setInterval(applyRetention, 12 * 3_600_000).unref()
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
      break
    case 'settings':
      settings = message.settings
      applyRetention()
      void mcp.sync(settings.mcpServers)
      void syncVault()
      void telegram.sync()
      voice.sync()
      void whatsapp.sync()
      syncCompanyChannels()
      void home.sync()
      break
    case 'voice.trigger':
      voice.trigger()
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
  void Promise.all([mcp.closeAll(), knowledge?.close(), embedder?.close(), telegram.stop(), voice?.close(), home?.stop()]).finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('exit', () => store?.flushAll())
