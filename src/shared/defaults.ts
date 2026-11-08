import { defaultTexts } from './i18n/defaultTexts'
import { defaultRemote } from './remote/settings'
import type { Language } from './i18n/language'
import type { AgentProfile, ProviderId, Settings, Thread } from './types'

/** Word, Excel, PowerPoint and PDF: read, create and edit (src/coordinator/tools/office). */
export const OFFICE_TOOLS = ['office_read', 'office_create', 'office_edit']
const FILE_TOOLS = ['read_file', 'list_dir', 'search_files', 'write_file', 'edit_file', 'run_command', ...OFFICE_TOOLS]
export const BUILTIN_TOOLS = [...FILE_TOOLS, 'generate_image', 'compose_image', 'instagram_publish'] as const
export const READ_ONLY_TOOLS: readonly string[] = ['read_file', 'list_dir', 'search_files', 'office_read']

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'
/** Empty = the newest Muse Spark the account lists (muse-spark-1.3 today). */
export const DEFAULT_META_MODEL = ''
export const CLAUDE_MODELS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5-1',
  'claude-opus-5'
]
export const XAI_BASE_URL = 'https://api.x.ai/v1'
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
export const VERCEL_BASE_URL = 'https://ai-gateway.vercel.sh/v1'
export const META_BASE_URL = 'https://api.meta.ai/v1'

export const PROVIDER_NAMES: Record<ProviderId, string> = { anthropic: 'Claude', xai: 'Grok', deepseek: 'DeepSeek', vercel: 'Vercel AI Gateway', meta: 'Meta (Muse)' }

/** True for xAI/OpenAI/Anthropic-style API keys, which don't belong in model fields. */
export function looksLikeApiKey(value: string): boolean {
  return /^(?:xai|sk)-[\w-]{16,}$/.test(value.trim())
}

const ALL_TOOLS = [...FILE_TOOLS, 'generate_image', 'compose_image']
const READ_TOOLS = ['read_file', 'list_dir', 'search_files', 'office_read']

/** What an agent is apart from its words: the names, descriptions and prompts come from the language's texts. */
const AGENT_STRUCTURE: Omit<AgentProfile, 'name' | 'description' | 'systemPrompt'>[] = [
  { id: 'general', provider: 'meta', model: DEFAULT_META_MODEL, effort: 'high', tools: ALL_TOOLS, allowMcp: true, canDelegate: true },
  { id: 'investigador', provider: 'meta', model: DEFAULT_META_MODEL, effort: 'medium', tools: READ_TOOLS, allowMcp: false, canDelegate: false },
  { id: 'programador', provider: 'meta', model: DEFAULT_META_MODEL, effort: 'medium', tools: ALL_TOOLS, allowMcp: true, canDelegate: false },
  { id: 'revisor', provider: 'meta', model: DEFAULT_META_MODEL, effort: 'medium', tools: READ_TOOLS, allowMcp: false, canDelegate: false },
  { id: 'grok', provider: 'xai', model: '', effort: 'high', tools: ALL_TOOLS, allowMcp: true, canDelegate: true },
  { id: 'deepseek', provider: 'deepseek', model: '', effort: 'high', tools: ALL_TOOLS, allowMcp: true, canDelegate: true },
  { id: 'vercel', provider: 'vercel', model: '', effort: 'high', tools: ALL_TOOLS, allowMcp: true, canDelegate: true },
  {
    id: 'multimedia',
    provider: 'meta',
    model: DEFAULT_META_MODEL,
    effort: 'medium',
    tools: ALL_TOOLS,
    allowMcp: false,
    canDelegate: false,
    autoApproveTools: ['generate_image', 'compose_image', 'write_file', 'edit_file']
  },
  {
    id: 'community-manager',
    provider: 'meta',
    model: DEFAULT_META_MODEL,
    effort: 'medium',
    tools: ['read_file', 'list_dir', 'search_files', 'write_file', 'edit_file', ...OFFICE_TOOLS, 'generate_image', 'compose_image', 'instagram_publish'],
    allowMcp: false,
    canDelegate: false,
    // Only publishing waits for the user; preparing the post doesn't.
    autoApproveTools: ['generate_image', 'compose_image', 'write_file', 'edit_file']
  }
]

/** The nine shipped agents, written in the language in effect when the defaults are created (BR-16). */
export function defaultAgents(language: Language = 'es'): AgentProfile[] {
  const texts = defaultTexts(language).agents
  return AGENT_STRUCTURE.map(({ id, provider, model, effort, tools, allowMcp, canDelegate, autoApproveTools }) => ({
    id,
    name: texts[id].name,
    description: texts[id].description,
    systemPrompt: texts[id].systemPrompt,
    provider,
    model,
    effort,
    tools: [...tools],
    allowMcp,
    canDelegate,
    ...(autoApproveTools ? { autoApproveTools: [...autoApproveTools] } : {})
  }))
}

export const DEFAULT_AGENTS: AgentProfile[] = defaultAgents('es')

export const OPENAI_BASE_URL = 'https://api.openai.com/v1'

/** The voice each language starts with (Kokoro, and the Windows one: empty = the first the system has in the language). One line to change if the product choice changes. */
export const DEFAULT_VOICES: Record<Language, { kokoro: string; windows: string }> = {
  es: { kokoro: 'ef_dora', windows: '' },
  en: { kokoro: 'af_heart', windows: '' }
}

export const DEFAULT_REVIEW_INSTRUCTIONS = defaultTexts('es').reviewInstructions

/** The settings of a fresh install: the shipped words (agents, review instructions) follow `language`. */
export function defaultSettings(language: Language = 'es'): Settings {
  return {
    language,
    providers: {
      anthropic: { apiKey: '' },
      xai: { apiKey: '', baseUrl: XAI_BASE_URL },
      deepseek: { apiKey: '' },
      vercel: { apiKey: '' },
      meta: { apiKey: '' },
      openai: { apiKey: '' },
      telegram: { apiKey: '' },
      elevenlabs: { apiKey: '' },
      email: { apiKey: '' }
    },
    defaultAgentId: 'general',
    agents: defaultAgents(language),
    approvalMode: 'needs-approval',
    autoReview: { provider: 'meta', model: DEFAULT_META_MODEL, instructions: defaultTexts(language).reviewInstructions },
    alwaysAllowTools: [],
    mcpServers: {},
    defaultWorkspace: '',
    images: { provider: 'meta', model: '' },
    instagram: { testMode: true },
    routines: [],
    background: { runInTray: true, launchAtLogin: false },
    privacy: { threadRetentionDays: 0 },
    vaults: [],
    activeVault: '',
    telegram: { enabled: true, allowedUsers: [], agentId: 'general', chatId: null, threadId: null },
    voice: {
      enabled: false,
      wakeWord: 'hola_alma',
      wakeThreshold: 0.5,
      hotkey: 'Control+Alt+Space',
      micDeviceId: '',
      verifySpeaker: true,
      speakerThreshold: 0.86,
      stt: 'local',
      sttModel: 'whisper-base',
      tts: 'kokoro',
      kokoroVoice: DEFAULT_VOICES[language].kokoro,
      windowsVoice: DEFAULT_VOICES[language].windows,
      elevenVoiceId: '',
      elevenModel: 'eleven_multilingual_v2',
      sendDelayMs: 1000,
      agentId: 'general',
      threadId: null
    },
    email: { address: '', imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465 },
    whatsapp: { enabled: false, agentId: 'general', threadId: null },
    remote: defaultRemote(),
    companies: [],
    companySecrets: {},
    home: { enabled: false, mode: 'managed', externalUrl: '', mirrored: false, agentId: '', visionProvider: '', visionModel: '' }
  }
}

/** IMAP/SMTP servers for the usual providers, guessed from the address (the user can still edit them). */
export function emailServersFor(address: string): Partial<Settings['email']> {
  const domain = address.split('@')[1]?.toLowerCase() ?? ''
  if (/^(gmail|googlemail)\.com$/.test(domain)) return { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 }
  if (/^(outlook|hotmail|live|msn)\.[a-z.]+$/.test(domain)) return { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp-mail.outlook.com', smtpPort: 587 }
  if (/^yahoo\.[a-z.]+$/.test(domain)) return { imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465 }
  if (/^(icloud|me|mac)\.com$/.test(domain)) return { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587 }
  return domain ? { imapHost: `imap.${domain}`, imapPort: 993, smtpHost: `smtp.${domain}`, smtpPort: 465 } : {}
}

/**
 * Settings saved before Meta became the default: the untouched default agents, the review and the image service move to
 * Meta, once, and only when there is a Meta key (without it they'd stop working). Choices the person made stay.
 */
export function applyMetaDefault(settings: Settings, hasMetaKey: boolean): Settings {
  if (settings.metaDefaultApplied || !hasMetaKey) return settings
  const defaults = new Set(DEFAULT_AGENTS.map((a) => a.id))
  const { autoReview, images } = settings
  return {
    ...settings,
    metaDefaultApplied: true,
    agents: settings.agents.map((a) =>
      defaults.has(a.id) && !a.companyId && a.provider === 'anthropic' && a.model === DEFAULT_CLAUDE_MODEL ? { ...a, provider: 'meta', model: DEFAULT_META_MODEL } : a
    ),
    autoReview: autoReview.provider === 'anthropic' && autoReview.model === DEFAULT_CLAUDE_MODEL ? { ...autoReview, provider: 'meta', model: DEFAULT_META_MODEL } : autoReview,
    images: images.provider === 'xai' && !images.model ? { provider: 'meta', model: '' } : images
  }
}

/** The agent as it runs in a conversation: a model chosen in the header replaces the agent's own provider and model. */
export function effectiveProfile(profile: AgentProfile, thread: Pick<Thread, 'model'>): AgentProfile {
  return thread.model ? { ...profile, provider: thread.model.provider, model: thread.model.model } : profile
}

const NOT_CHAT_MODEL = /image|imagine|vision|video|embed|voice|transcribe|tts|stt|realtime|multi-agent|(^|[-_/])sam([-_.\d]|$)/

/** Provider listings mix in image, voice and embedding models; the header only offers the ones that chat. */
export function isChatModel(id: string): boolean {
  return !NOT_CHAT_MODEL.test(id)
}
