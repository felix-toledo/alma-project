// Types shared by the main process, the coordinator utility process and the renderer.
import type { Language } from './i18n/language'
export type { Language }
import type { MessageKey } from './i18n/messages'
import type { FlowStep,HomeEngineStatus, HomePlan, HomeSettings, HomeSnapshot, JudgmentRule, CameraWatch, HomeAutomation } from './home'

export type ProviderId = 'anthropic' | 'xai' | 'deepseek' | 'vercel' | 'meta'

/** The four approval modes of the approval-mode switcher. */
export type ApprovalMode = 'needs-approval' | 'auto-review' | 'always-allow' | 'blocked'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AgentProfile {
  id: string
  name: string
  /** Tells the user and other agents when to use this agent (shown to the delegating agent). */
  description: string
  systemPrompt: string
  provider: ProviderId
  model: string
  effort: Effort
  /** Built-in tool names this agent may use. */
  tools: string[]
  allowMcp: boolean
  /** Whether this agent may delegate work to other agents with `delegate_task`. */
  canDelegate: boolean
  /** Set for agents that work in a company: they only see its vault, its accounts and their part of the org chart. */
  companyId?: string
  /** Tools this agent runs without asking, whatever the approval mode. Publishing always asks. */
  autoApproveTools?: string[]
}

export type ImageProviderId = 'xai' | 'openai' | 'meta'

export type RoutineSchedule =
  | { kind: 'daily'; time: string; /** 0 = Sunday … 6 = Saturday; empty = every day */ days: number[] }
  | { kind: 'interval'; minutes: number }
  /** Fires once at this moment (epoch ms); if the app was closed then, as soon as it opens. */
  | { kind: 'once'; at: number }

/** A task an agent runs on its own on a schedule, or a plain reminder. */
export interface Routine {
  id: string
  name: string
  agentId: string
  workspace: string
  /** For a task: what the agent is told to do. For a reminder: the message shown to the user. */
  prompt: string
  schedule: RoutineSchedule
  enabled: boolean
  createdAt: number
  /** 'reminder' only notifies (no agent, no tokens). Missing = 'task' (routines saved before reminders existed). */
  action?: 'task' | 'reminder'
}

export interface RoutineState {
  lastRunAt?: number
  lastThreadId?: string
  running?: boolean
}

export type McpServerConfig = (
  | {
      type: 'stdio'
      command: string
      args?: string[]
      env?: Record<string, string>
      cwd?: string
      enabled: boolean
    }
  | {
      type: 'http'
      url: string
      headers?: Record<string, string>
      enabled: boolean
    }
) & {
  /** Only expose these tool names to agents; empty or missing = all. Large servers (hundreds of tools) need this. */
  tools?: string[]
}

export interface ProviderSecrets {
  anthropic: { apiKey: string }
  xai: { apiKey: string; baseUrl: string }
  deepseek: { apiKey: string }
  /** Vercel AI Gateway: one key, models from many labs (`anthropic/claude-sonnet-4.5`, `openai/gpt-5`…). */
  vercel: { apiKey: string }
  /** Meta Model API: Muse Spark/Wonder (text), Muse Image (images) and Muse Voice Transcribe (speech to text) with a single key. */
  meta: { apiKey: string }
  /** Only used for image generation (and optionally speech-to-text). */
  openai: { apiKey: string }
  /** The Telegram bot token from @BotFather (stored encrypted like the API keys). */
  telegram: { apiKey: string }
  /** Text-to-speech voices for the voice assistant. */
  elevenlabs: { apiKey: string }
  /** The mailbox's app password (IMAP/SMTP), stored encrypted like the API keys. */
  email: { apiKey: string }
}

export type WakeWord = 'hola_alma'
export type TtsEngine = 'kokoro' | 'windows' | 'elevenlabs'

export interface VoiceSettings {
  enabled: boolean
  /** Always-on listening for this phrase; 'off' = only the hotkey. */
  wakeWord: WakeWord | 'off'
  wakeThreshold: number
  /** Electron accelerator, e.g. "Control+Alt+Space"; empty = none. */
  hotkey: string
  /** MediaDeviceInfo.deviceId; empty = the system default microphone. */
  micDeviceId: string
  /** Only answer the enrolled voice when woken by the wake word (the hotkey always works). */
  verifySpeaker: boolean
  speakerThreshold: number
  stt: 'local' | 'openai' | 'meta'
  sttModel: 'whisper-base' | 'whisper-small'
  tts: TtsEngine
  kokoroVoice: string
  /** SpeechSynthesisVoice.name; empty = the first Spanish voice. */
  windowsVoice: string
  elevenVoiceId: string
  elevenModel: 'eleven_multilingual_v2' | 'eleven_flash_v2_5'
  /** Milliseconds between the transcript and sending it to the model, during which it can still be cancelled; 0 = none. */
  sendDelayMs: number
  agentId: string
  /** The conversation voice requests go to; a new one starts after an hour of silence. */
  threadId: string | null
}

export type VoiceState = 'off' | 'loading' | 'listening' | 'recording' | 'transcribing' | 'thinking' | 'speaking' | 'error'

export interface VoiceStatus {
  state: VoiceState
  /** What the user said / what Alma answers, for the on-screen overlay. */
  transcript?: string
  answer?: string
  /** Model download or error details. */
  detail?: string
  /** Recording a follow-up in an ongoing conversation (no chime: the user is already talking with Alma). */
  followUp?: boolean
}

/** Audio for the renderer to play: PCM from Kokoro, encoded bytes from ElevenLabs, or text for the OS voices. */
export type VoicePlayback =
  | { kind: 'pcm'; samples: Float32Array; sampleRate: number }
  | { kind: 'encoded'; data: ArrayBuffer; mime: string }
  | { kind: 'system'; text: string; voice: string; /** The language of the text: the window picks a system voice that speaks it. */ language?: Language }

export interface TelegramSettings {
  enabled: boolean
  /** Telegram usernames (without @) allowed to talk to the bot until a chat is bound. */
  allowedUsers: string[]
  /** Agent that answers Telegram messages. */
  agentId: string
  /** The private chat bound on first contact; only it can talk to the bot afterwards. */
  chatId: number | null
  /** The Alma conversation Telegram messages go to; /nuevo starts another. */
  threadId: string | null
}

/** The user's mailbox over IMAP (read) and SMTP (send); the password lives in providers.email. */
export interface EmailSettings {
  address: string
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
}

export interface WhatsAppSettings {
  enabled: boolean
  /** Agent that answers the user's "Mensajes para mí" chat. */
  agentId: string
  /** The Alma conversation WhatsApp messages go to; /nuevo starts another. */
  threadId: string | null
}

export interface WhatsAppStatus {
  state: 'off' | 'connecting' | 'qr' | 'online' | 'error'
  /** QR to scan from WhatsApp → Dispositivos vinculados, as a data URL. */
  qr?: string
  /** The linked phone number once online. */
  number?: string
  error?: string
}

export interface Settings {
  /** The app language, always resolved: what the person chose, or else the system language (spec 025). */
  language: Language
  home: HomeSettings
  providers: ProviderSecrets
  defaultAgentId: string
  agents: AgentProfile[]
  approvalMode: ApprovalMode
  autoReview: { provider: ProviderId; model: string; instructions: string }
  /** Tool names that skip approval ("Siempre permitir"). */
  alwaysAllowTools: string[]
  mcpServers: Record<string, McpServerConfig>
  defaultWorkspace: string
  /** Empty model = pick the newest image model the account lists. */
  images: { provider: ImageProviderId; model: string }
  /** Test mode fills in the post but never clicks "Compartir". */
  instagram: { testMode: boolean }
  routines: Routine[]
  background: { runInTray: boolean; launchAtLogin: boolean }
  /** Conversations untouched for this many days are deleted; 0 keeps them. */
  privacy: { threadRetentionDays: number }
  /** Vault folders the user opened (absolute paths). */
  vaults: string[]
  /** The vault every conversation draws knowledge from; empty = none. */
  activeVault: string
  telegram: TelegramSettings
  voice: VoiceSettings
  email: EmailSettings
  whatsapp: WhatsAppSettings
  companies: Company[]
  /** Company mailbox passwords by company id, encrypted at rest like the API keys; never sent to the window. */
  companySecrets: Record<string, string>
  /** One-time migration marker: saved agents got the Office tools. */
  officeToolsAdded?: boolean
  /** The default Multimedia agent was added once to a settings file saved before it existed. */
  multimediaAdded?: boolean
  /** One-time migration marker: the default agents, auto-review and images moved to Meta (spec 024). */
  metaDefaultApplied?: boolean
}

// ---------------------------------------------------------------------------
// Companies: teams of agents running a business, each with its own vault and accounts

/** A position in the org chart. Its agent is the AgentProfile with the same id (companyId set). */
export interface CompanyMember {
  id: string
  /** The position: "Community manager", "Analista de datos". */
  title: string
  /** Member id of the boss; null = reports to the user (the board). */
  reportsTo: string | null
  /** Dotted lines: peers it may ask for help (ask_colleague), besides its boss and its reports. */
  collaborates: string[]
  /** Monthly cap in USD for this agent; 0 = only the company's cap applies. */
  budgetUsd: number
}

export interface Company {
  id: string
  name: string
  /** What the company does and for whom: every member reads it. */
  mission: string
  /** Current goals, one per line. */
  goals: string
  /** The company's own vault (absolute folder); documents agents make are saved there too. */
  vault: string
  color: string
  /** Monthly cap in USD for the whole company; 0 = no cap. */
  budgetUsd: number
  members: CompanyMember[]
  /** Its own mailbox; empty address = use the user's. The password is stored encrypted (companySecrets). */
  email: EmailSettings
  /** Its own WhatsApp number, linked by QR (answered by the top of the org chart). */
  whatsapp: boolean
  createdAt: number
}

export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done' | 'blocked'

/** Who wrote or did something in a company: a member id, the user (the board), or the system. */
export type CompanyActor = string | 'user' | 'system'

export interface TaskComment {
  author: CompanyActor
  text: string
  at: number
}

export interface CompanyTask {
  id: string
  companyId: string
  title: string
  description: string
  /** Member id, or 'user' when it's waiting on the user. */
  assignee: string
  createdBy: CompanyActor
  status: TaskStatus
  createdAt: number
  updatedAt: number
  due?: string
  /** What the assignee delivered. */
  result?: string
  comments: TaskComment[]
  /** Times it came back from review. */
  revisions: number
  /** The conversation where the assignee worked on it. */
  threadId?: string
  /** A meeting that produced it. */
  meetingId?: string
}

export interface MeetingTurn {
  speaker: CompanyActor
  text: string
  at: number
}

export interface Meeting {
  id: string
  companyId: string
  topic: string
  agenda: string[]
  participants: string[]
  /** Runs the meeting: opens, gives the floor, closes and writes the minutes. */
  chair: string
  /** Scheduled start (epoch ms). */
  at: number
  /** Hours before the start when each participant prepares (one run each, with tools). */
  prepHours: number
  status: 'scheduled' | 'preparing' | 'live' | 'done' | 'cancelled'
  /** What each participant prepared to say. */
  prep: Record<string, string>
  transcript: MeetingTurn[]
  /** Vault path of the minutes. */
  minutesPath?: string
  decisions?: string[]
  createdBy: CompanyActor
}

export interface CompanyActivity {
  at: number
  actor: CompanyActor
  text: string
  taskId?: string
  meetingId?: string
}

/** Spend this month (estimated from token usage). */
export interface CompanySpend {
  month: string
  totalUsd: number
  byMember: Record<string, number>
}

export interface CompanySnapshot {
  tasks: CompanyTask[]
  meetings: Meeting[]
  activity: CompanyActivity[]
  spend: CompanySpend
  /** Members working right now (a task, a meeting prep, a chat). */
  working: string[]
}

/** Settings as the renderer sees them: API keys are never sent back, only whether one is stored. */
export interface PublicSettings extends Omit<Settings, 'providers' | 'companySecrets'> {
  /** Which companies have a mailbox password stored. */
  companyPasswords: Record<string, boolean>
  providers: {
    anthropic: { hasKey: boolean; fromEnv: boolean }
    xai: { hasKey: boolean; fromEnv: boolean; baseUrl: string }
    deepseek: { hasKey: boolean; fromEnv: boolean }
    vercel: { hasKey: boolean; fromEnv: boolean }
    meta: { hasKey: boolean; fromEnv: boolean }
    openai: { hasKey: boolean; fromEnv: boolean }
    telegram: { hasKey: boolean; fromEnv: boolean }
    elevenlabs: { hasKey: boolean; fromEnv: boolean }
    email: { hasKey: boolean; fromEnv: boolean }
  }
}

export interface TelegramStatus {
  state: 'off' | 'connecting' | 'online' | 'error'
  /** The bot's @username once connected. */
  username?: string
  error?: string
}

export type SecretProviderId = keyof ProviderSecrets

export interface InstagramStatus {
  connected: boolean
}

/** Everything the "Reglas" panel shows: HA automations plus Alma's own rules and camera watches. */
export interface HomeRulesView {
  automations: HomeAutomation[]
  judgment: JudgmentRule[]
  watches: CameraWatch[]
}

// ---------------------------------------------------------------------------
// Conversation model (provider-neutral)

/** Text Alma wrote for a tool result or error: a dictionary key, so a card can show it in the language of the moment. */
export interface ToolText {
  key: MessageKey
  params?: Record<string, string | number>
}

export type Block =
  | { type: 'text'; text: string }
  /** A picture for the model (vision): base64 data without the data: prefix. */
  | { type: 'image'; mediaType: string; data: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  /** `content` is what the model read (English); `i18n` is the same text as a key for display, absent in older threads. */
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; i18n?: ToolText }

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: Block[]
  ts: number
  /** Provider and model that produced an assistant message. */
  provider?: ProviderId
  model?: string
  /**
   * Provider-native assistant content, replayed unchanged on the next request to the same provider.
   * Claude needs its thinking blocks (with signatures) back exactly as returned.
   */
  raw?: unknown
  usage?: Usage
  /** Set when the model stopped for a reason the user should see (refusal, truncation). */
  notice?: string
}

export type ToolStatus = 'pending-approval' | 'reviewing' | 'running' | 'done' | 'denied' | 'error'

export interface ToolState {
  status: ToolStatus
  /** Why it was approved, flagged or denied (auto-review verdict, approval mode, user). */
  note?: string
}

export interface SubagentRun {
  id: string
  agentId: string
  agentName: string
  title: string
  task: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  startedAt: number
  endedAt?: number
  messages: ChatMessage[]
}

export interface Thread {
  id: string
  title: string
  agentId: string
  /** Who answers in this conversation, over the agent's own provider and model. */
  model?: ModelChoice
  workspace: string
  /** Where the conversation happens besides the app; shown as an icon in the sidebar. */
  /** 'company': a task, review or meeting prep an agent of a company worked on by itself. */
  channel?: 'telegram' | 'voice' | 'whatsapp' | 'company'
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  /** Keyed by the `delegate_task` tool_use id that started the run. */
  subagents: Record<string, SubagentRun>
  toolStates: Record<string, ToolState>
}

export interface ModelChoice {
  provider: ProviderId
  model: string
}

export type ThreadSummary = Pick<Thread, 'id' | 'title' | 'agentId' | 'model' | 'workspace' | 'updatedAt' | 'channel'>

export interface McpServerStatus {
  name: string
  state: 'disabled' | 'connecting' | 'connected' | 'error'
  error?: string
  tools: { name: string; description?: string }[]
}

// ---------------------------------------------------------------------------
// Vault and knowledge

/** A file or folder in the vault. Paths are vault-relative with forward slashes. */
export interface VaultEntry {
  path: string
  kind: 'file' | 'folder'
  size: number
  mtime: number
}

export interface SearchHit {
  path: string
  /** Heading path of the matching chunk, e.g. "Proyecto › Ideas". */
  heading: string
  snippet: string
  line: number
  /** Fused rank score (RRF); only comparable within one search. */
  score: number
  /** Cosine similarity, when the semantic index took part. */
  similarity?: number
}

export type EmbedderState = 'idle' | 'downloading' | 'loading' | 'ready' | 'error'

export interface KnowledgeStatus {
  vault: string
  scanning: boolean
  files: number
  chunks: number
  /** Chunks still waiting for an embedding. */
  pending: number
  model: { state: EmbedderState; progress?: number; error?: string }
}

export interface KnowledgeOverview {
  /** One line each, from the memory file. */
  memories: string[]
  /** The vault path of the memory file (`Alma/Recuerdos.md` or `Alma/Memories.md`). */
  memoryFile: string
  /** Notes Alma wrote in its knowledge folder, newest first. */
  notes: { path: string; title: string; mtime: number }[]
}

export interface PendingApproval {
  approvalId: string
  threadId: string
  subagentId?: string
  toolUseId: string
  toolName: string
  input: unknown
  /** Auto-review flagged this call as potentially dangerous. */
  flagged: boolean
  reason?: string
  /** The reason in the person's language, when it arrives after the card (a translation of the reviewer's English). */
  reasonShown?: string
  /** False for actions that must be approved every time, like publishing. */
  allowAlways: boolean
  /** What will be published, so the user approves the actual post. */
  preview?: { imageDataUrl?: string; caption?: string; note?: string }
}

// ---------------------------------------------------------------------------
// Renderer ⇄ coordinator protocol (over a MessagePort)

export type CoordinatorRequest =
  | { method: 'threads.list' }
  | { method: 'threads.get'; threadId: string }
  | { method: 'threads.create'; agentId: string; workspace: string }
  | { method: 'threads.update'; threadId: string; title?: string; agentId?: string; workspace?: string; /** null = back to the agent's own model */ model?: ModelChoice | null }
  | { method: 'threads.delete'; threadId: string }
  | { method: 'chat.send'; threadId: string; text: string }
  | { method: 'chat.stop'; threadId: string }
  | { method: 'approval.respond'; approvalId: string; decision: 'allow' | 'deny' | 'always' }
  | { method: 'approval.pending' }
  | { method: 'mcp.status' }
  /** Copies the conversations and what Alma remembers of the person into a new folder inside `targetDir`; returns its path. */
  | { method: 'privacy.export'; targetDir: string }
  /** Deletes every conversation, the received files and the voice print. Not the vault, nor keys or channels. */
  | { method: 'privacy.erase' }
  | { method: 'mcp.reconnect' }
  | { method: 'models.list'; provider: ProviderId }
  | { method: 'runs.active' }
  | { method: 'images.models'; provider?: ImageProviderId }
  /** A workspace image as a data URL, for previews (confined to the thread's workspace). */
  | { method: 'files.image'; threadId: string; path: string }
  | { method: 'routines.state' }
  | { method: 'routines.runNow'; routineId: string }
  // Vault (paths are relative to the active vault)
  | { method: 'vault.tree' }
  | { method: 'vault.read'; path: string }
  | { method: 'vault.write'; path: string; content: string }
  // Not `kind`: that name belongs to the envelope (RequestEnvelope.kind = 'request') and would overwrite it.
  | { method: 'vault.create'; path: string; entry: 'file' | 'folder' }
  | { method: 'vault.rename'; from: string; to: string }
  | { method: 'vault.delete'; path: string }
  | { method: 'vault.search'; query: string; limit?: number }
  /** Creates the folder (if needed) with a welcome note, so it can be added as a vault. */
  | { method: 'vault.init'; path: string }
  | { method: 'knowledge.status' }
  | { method: 'knowledge.overview' }
  | { method: 'knowledge.forget'; text: string }
  | { method: 'telegram.status' }
  | { method: 'whatsapp.status' }
  /** Unlinks this device from WhatsApp (a new QR appears). */
  | { method: 'whatsapp.logout' }
  /** Logs in to IMAP and SMTP with the saved settings, without reading or sending anything. */
  | { method: 'email.test' }
  | { method: 'company.snapshot'; companyId: string }
  | { method: 'company.task.create'; companyId: string; title: string; description: string; assignee: string }
  | { method: 'company.task.comment'; companyId: string; taskId: string; text: string }
  /** The user's answer to a task waiting on them (review): approve, or send it back with a comment. */
  | { method: 'company.task.review'; companyId: string; taskId: string; approve: boolean; comment?: string }
  | { method: 'company.task.move'; companyId: string; taskId: string; status: TaskStatus }
  | { method: 'company.task.delete'; companyId: string; taskId: string }
  | { method: 'company.meeting.create'; companyId: string; topic: string; agenda: string[]; participants: string[]; chair: string; at: number; prepHours: number }
  /** Starts now (preparing first if nobody prepared yet). */
  | { method: 'company.meeting.start'; companyId: string; meetingId: string }
  | { method: 'company.meeting.say'; companyId: string; meetingId: string; text: string }
  | { method: 'company.meeting.end'; companyId: string; meetingId: string }
  | { method: 'company.meeting.cancel'; companyId: string; meetingId: string }
  | { method: 'company.whatsapp.status'; companyId: string }
  | { method: 'company.whatsapp.logout'; companyId: string }
  | { method: 'voice.status' }
  /** Hotkey or button: start listening now, skipping the wake word. Pressed while speaking: stop. */
  | { method: 'voice.trigger' }
  /** Throws away what is being recorded or pending, stops Alma and ends the conversation. */
  | { method: 'voice.cancel' }
  /** The renderer finished playing what Alma said (or the user cut it off). */
  | { method: 'voice.played' }
  /** Mono 16 kHz Int16 PCM recordings of the user reading, to learn their voice. */
  | { method: 'voice.enroll'; samples: ArrayBuffer[] }
  | { method: 'voice.profile' }
  | { method: 'voice.forgetProfile' }
  /** Similarity of a recording to the enrolled voice (0–1), to tune the threshold. */
  | { method: 'voice.testSpeaker'; sample: ArrayBuffer }
  | { method: 'voice.say'; text: string }
  | { method: 'voice.elevenVoices' }
  // Home automation (Casa)
  | { method: 'home.status' }
  | { method: 'home.install' }
  | { method: 'home.start' }
  | { method: 'home.stop' }
  | { method: 'home.uninstall' }
  /** Connects to a Home Assistant the user already has (the token is stored encrypted). */
  | { method: 'home.connectExternal'; url: string; token: string }
  /** Home Assistant's own address and login, for the "avanzado" button (managed mode only). */
  | { method: 'home.advanced' }
  | { method: 'home.snapshot' }
  /** The user toggles or sets a device from the window: `service` is an HA service like light/turn_on. */
  | { method: 'home.control'; entityId: string; service: string; data?: Record<string, unknown> }
  | { method: 'home.thing.update'; id: string; name?: string; areaId?: string | null }
  | { method: 'home.thing.remove'; id: string }
  | { method: 'home.integrations' }
  | { method: 'home.entries' }
  | { method: 'home.flow.start'; domain: string }
  /** Without data or menu it asks where the flow stands (external steps). */
  | { method: 'home.flow.step'; flowId: string; data?: Record<string, unknown>; menu?: string }
  | { method: 'home.flow.abort'; flowId: string }
  | { method: 'home.entry.remove'; entryId: string }
  | { method: 'home.plan.get' }
  | { method: 'home.plan.set'; plan: HomePlan }
  /** Builds the rooms of a floor from an Excalidraw drawing in the vault. */
  | { method: 'home.plan.fromDrawing'; path: string; floorId?: string }
  | { method: 'home.camera.snapshot'; entityId: string }
  | { method: 'home.rules' }
  | { method: 'home.rule.toggle'; kind: 'ha' | 'judgment'; id: string; enabled: boolean }
  | { method: 'home.rule.delete'; kind: 'ha' | 'judgment' | 'watch'; id: string }
  /** Saves a picture the user pasted or dropped in the chat; returns the path the agent can look at. */
  | { method: 'files.saveImage'; name: string; base64: string }

export type RequestEnvelope = { kind: 'request'; reqId: number } & CoordinatorRequest
/** Microphone stream from the renderer: 80 ms of mono 16 kHz Int16 PCM, fire-and-forget (no response). */
export type AudioEnvelope = { kind: 'audio'; pcm: ArrayBuffer }
export type ResponseEnvelope =
  | { kind: 'response'; reqId: number; ok: true; result: unknown }
  | { kind: 'response'; reqId: number; ok: false; error: string }

/** Where a live event belongs: the main thread conversation or one subagent run. */
export interface EventScope {
  threadId: string
  subagentId?: string
}

export type LiveEvent =
  /** Something in a company changed (tasks, meetings, activity, spend): the window reloads its snapshot. */
  | { type: 'company.changed'; companyId: string }
  | { type: 'company.whatsapp'; companyId: string; status: WhatsAppStatus }
  | { type: 'run.started'; threadId: string }
  | { type: 'run.finished'; threadId: string; error?: string }
  | { type: 'stream.text'; scope: EventScope; text: string }
  | { type: 'stream.thinking'; scope: EventScope; text: string }
  | { type: 'stream.tool'; scope: EventScope; id: string; name: string }
  | { type: 'message'; scope: EventScope; message: ChatMessage }
  | { type: 'tool.state'; threadId: string; toolUseId: string; state: ToolState }
  | { type: 'subagent.started'; threadId: string; run: SubagentRun }
  | { type: 'subagent.finished'; threadId: string; subagentId: string; status: SubagentRun['status'] }
  | { type: 'approval.request'; approval: PendingApproval }
  | { type: 'approval.resolved'; approvalId: string }
  | { type: 'approval.reason'; approvalId: string; reasonShown: string }
  | { type: 'thread.updated'; summary: ThreadSummary }
  | { type: 'mcp.status'; servers: McpServerStatus[] }
  | { type: 'routines.state'; state: Record<string, RoutineState> }
  /** Files in the active vault changed (from the editor, a tool, or another app). */
  | { type: 'vault.changed' }
  | { type: 'knowledge.status'; status: KnowledgeStatus | null }
  | { type: 'telegram.status'; status: TelegramStatus }
  | { type: 'whatsapp.status'; status: WhatsAppStatus }
  | { type: 'voice.status'; status: VoiceStatus }
  /** `last`: the end of this utterance; the window answers with voice.played once it has played everything. */
  | { type: 'voice.play'; playback: VoicePlayback; last: boolean }
  /** Stop playing immediately (barge-in). */
  | { type: 'voice.stop' }
  | { type: 'home.engine'; status: HomeEngineStatus }
  | { type: 'home.snapshot'; snapshot: HomeSnapshot }
  | { type: 'home.plan'; plan: HomePlan }
  | { type: 'home.rules'; rules: HomeRulesView }
  /** An agent started adding a device and a step needs the window (QR, external page). */
  | { type: 'home.flow'; step: FlowStep }

export type EventEnvelope = { kind: 'event'; event: LiveEvent }
export type CoordinatorMessage = ResponseEnvelope | EventEnvelope

// ---------------------------------------------------------------------------
// Main ⇄ coordinator (utilityProcess parentPort)

export type ParentToCoordinator =
  | { type: 'init'; dataDir: string; settings: Settings }
  | { type: 'settings'; settings: Settings }
  | { type: 'client' }
  | { type: 'host.result'; reqId: number; ok: boolean; message: string }
  /** The global voice hotkey was pressed. */
  | { type: 'voice.trigger' }

/** Things only the main process can do for the coordinator: it owns windows and the browser session. */
export type HostRequest =
  | { action: 'instagram.publish'; imagePath: string; caption: string; testMode: boolean }
  /** Rasterizes a composed SVG to a PNG at `outPath` (already checked to be inside the workspace). */
  | { action: 'image.render'; svg: string; width: number; height: number; outPath: string }
  /** Moves a vault file or folder to the system trash (already checked to be inside the active vault). */
  | { action: 'trash'; path: string }
  /** Encrypts / decrypts a secret with the OS keychain (safeStorage), which only main can use. */
  | { action: 'secret.seal'; text: string }
  | { action: 'secret.open'; text: string }

export type CoordinatorToParent =
  /** The user picked "Siempre permitir": main persists it in settings and pushes them back. */
  | { type: 'alwaysAllow'; toolName: string }
  | { type: 'host.request'; reqId: number; request: HostRequest }
  /** Shown as a system notification when the window isn't focused (always, with `always`); clicking opens the thread. */
  | { type: 'notify'; title: string; body: string; threadId?: string; always?: boolean }
  /** The coordinator changed settings (routines from an agent, the bound Telegram chat): main persists and pushes them back. */
  | { type: 'settings.patch'; patch: Partial<Omit<Settings, 'providers'>> }
