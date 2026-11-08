import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as z from 'zod/v4'
import { applyMetaDefault, DEFAULT_AGENTS, defaultSettings, looksLikeApiKey, OFFICE_TOOLS } from '../shared/defaults'
import { type Language, parseLanguage, resolveLanguage } from '../shared/i18n/language'
import { migrateDefaults } from '../shared/migrate'
import { sanitizeRemote } from '../shared/remote/settings'
import { mainError } from './messages'
import type { PublicSettings, SecretProviderId, Settings } from '../shared/types'

const ENC_PREFIX = 'enc:'

const languageSchema = z.enum(['es', 'en'])

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * Secrets are only ever written to disk sealed by the OS (DPAPI, Keychain, libsecret). Where that isn't available,
 * Linux's `basic_text` fallback included (a key sitting in a file), they stay in memory for the session and are
 * not persisted. ALMA_ALLOW_PLAINTEXT_SECRETS=1 brings the old behaviour back for machines that can't do better.
 */
export function secretsProtected(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  return !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')
}

let warnedUnsealed = false

export function encrypt(secret: string): string {
  if (!secret) return ''
  if (secretsProtected()) return ENC_PREFIX + safeStorage.encryptString(secret).toString('base64')
  if (process.env.ALMA_ALLOW_PLAINTEXT_SECRETS === '1') return secret
  if (!warnedUnsealed) {
    warnedUnsealed = true
    console.error('[settings] the system has no secure storage: keys are not saved to disk (they only live in this session).')
  }
  return ''
}

export function decrypt(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
  } catch {
    return ''
  }
}

/** Owns settings.json. API keys are encrypted at rest and never leave the main/coordinator processes. */
export class SettingsStore {
  private settings: Settings
  /** A secret was found unsealed on disk (older versions, or a machine without a keychain): rewrite sealed. */
  private legacyPlaintext = false
  /** Set only when the person chose a language; without it `language` keeps following the system (spec 025 D3). */
  private explicitLanguage: Language | undefined

  constructor(private readonly systemLocales: readonly string[]) {
    this.settings = this.load()
    this.settings.language = resolveLanguage(this.explicitLanguage, this.systemLocales)
    // A key pasted into the image model field would be sent as a model name and sit unencrypted on disk.
    const pastedKey = looksLikeApiKey(this.settings.images.model)
    if (pastedKey) this.settings.images = { ...this.settings.images, model: '' }
    // Meta is the default provider now: saves from before move over once, if there is a Meta key (spec 024).
    const migrated = applyMetaDefault(this.settings, !!(this.settings.providers.meta.apiKey || process.env.META_API_KEY))
    const movedToMeta = migrated !== this.settings
    this.settings = migrated
    // Resealing without a keychain would blank the keys on disk, so only when they can be sealed.
    if (pastedKey || ((this.legacyPlaintext || movedToMeta) && secretsProtected())) this.save()
  }

  private open(stored: string | undefined): string {
    if (stored && !stored.startsWith(ENC_PREFIX)) this.legacyPlaintext = true
    return decrypt(stored ?? '')
  }

  private load(): Settings {
    // What a fresh install ships is written in the language in effect: the chosen one, or the system's.
    let base = defaultSettings(resolveLanguage(this.explicitLanguage, this.systemLocales))
    if (!existsSync(settingsPath())) return base
    try {
      const stored = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<Settings>
      this.explicitLanguage = parseLanguage(stored.language)
      base = defaultSettings(resolveLanguage(this.explicitLanguage, this.systemLocales))
      const merged: Settings = {
        ...base,
        ...stored,
        providers: {
          anthropic: { apiKey: this.open(stored.providers?.anthropic?.apiKey ?? '') },
          xai: {
            apiKey: this.open(stored.providers?.xai?.apiKey ?? ''),
            baseUrl: stored.providers?.xai?.baseUrl || base.providers.xai.baseUrl
          },
          deepseek: { apiKey: this.open(stored.providers?.deepseek?.apiKey ?? '') },
          vercel: { apiKey: this.open(stored.providers?.vercel?.apiKey ?? '') },
          meta: { apiKey: this.open(stored.providers?.meta?.apiKey ?? '') },
          openai: { apiKey: this.open(stored.providers?.openai?.apiKey ?? '') },
          telegram: { apiKey: this.open(stored.providers?.telegram?.apiKey ?? '') },
          elevenlabs: { apiKey: this.open(stored.providers?.elevenlabs?.apiKey ?? '') },
          email: { apiKey: this.open(stored.providers?.email?.apiKey ?? '') }
        },
        telegram: { ...base.telegram, ...stored.telegram },
        voice: { ...base.voice, ...stored.voice },
        email: { ...base.email, ...stored.email },
        whatsapp: { ...base.whatsapp, ...stored.whatsapp },
        home: { ...base.home, ...stored.home },
        remote: { ...base.remote, ...sanitizeRemote(stored.remote) },
        companies: stored.companies ?? [],
        companySecrets: Object.fromEntries(Object.entries(stored.companySecrets ?? {}).map(([id, value]) => [id, this.open(value)])),
        autoReview: { ...base.autoReview, ...stored.autoReview },
        // Settings saved by older versions lack these sections.
        images: { ...base.images, ...stored.images },
        instagram: { ...base.instagram, ...stored.instagram },
        background: { ...base.background, ...stored.background },
        privacy: { ...base.privacy, ...stored.privacy },
        routines: stored.routines ?? []
      }
      if (!merged.agents?.length) merged.agents = base.agents
      // Only «Ey Alma» ships now (its id stays hola_alma); older saves may still name hey_jarvis, alexa or hey_mycroft.
      if (merged.voice.wakeWord !== 'off') merged.voice.wakeWord = 'hola_alma'
      // Agents saved before the Office tools existed: readers get office_read, writers all three. Once.
      if (!stored.officeToolsAdded) {
        merged.agents = merged.agents.map((agent) => {
          const add = agent.tools.includes('write_file') ? OFFICE_TOOLS : agent.tools.includes('read_file') ? ['office_read'] : []
          return { ...agent, tools: [...new Set([...agent.tools, ...add])] }
        })
        merged.officeToolsAdded = true
      }
      // Saves from before the Multimedia agent get it once (and keep it deleted if they delete it).
      if (!stored.multimediaAdded) {
        const multimedia = DEFAULT_AGENTS.find((a) => a.id === 'multimedia')
        if (multimedia && !merged.agents.some((a) => a.id === 'multimedia')) merged.agents = [...merged.agents, structuredClone(multimedia)]
        merged.multimediaAdded = true
      }
      // Agents saved before compose_image existed get it wherever they could generate images.
      merged.agents = merged.agents.map((agent) =>
        agent.tools.includes('generate_image') && !agent.tools.includes('compose_image')
          ? {
              ...agent,
              tools: [...agent.tools, 'compose_image'],
              autoApproveTools: agent.autoApproveTools?.includes('generate_image')
                ? [...agent.autoApproveTools, 'compose_image']
                : agent.autoApproveTools
            }
          : agent
      )
      return merged
    } catch {
      return base
    }
  }

  private save(): void {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    const { language: _resolved, ...saved } = this.settings
    const onDisk: Omit<Settings, 'language'> & { language?: Language } = {
      ...saved,
      ...(this.explicitLanguage ? { language: this.explicitLanguage } : {}),
      providers: {
        anthropic: { apiKey: encrypt(this.settings.providers.anthropic.apiKey) },
        xai: { ...this.settings.providers.xai, apiKey: encrypt(this.settings.providers.xai.apiKey) },
        deepseek: { apiKey: encrypt(this.settings.providers.deepseek.apiKey) },
        vercel: { apiKey: encrypt(this.settings.providers.vercel.apiKey) },
        meta: { apiKey: encrypt(this.settings.providers.meta.apiKey) },
        openai: { apiKey: encrypt(this.settings.providers.openai.apiKey) },
        telegram: { apiKey: encrypt(this.settings.providers.telegram.apiKey) },
        elevenlabs: { apiKey: encrypt(this.settings.providers.elevenlabs.apiKey) },
        email: { apiKey: encrypt(this.settings.providers.email.apiKey) }
      },
      companySecrets: Object.fromEntries(Object.entries(this.settings.companySecrets).map(([id, value]) => [id, encrypt(value)]))
    }
    const tmp = settingsPath() + '.tmp'
    writeFileSync(tmp, JSON.stringify(onDisk, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, settingsPath())
  }

  get(): Settings {
    return this.settings
  }

  getPublic(): PublicSettings {
    const { providers, companySecrets, ...rest } = this.settings
    return {
      ...rest,
      companyPasswords: Object.fromEntries(Object.entries(companySecrets).map(([id, value]) => [id, !!value])),
      providers: {
        anthropic: { hasKey: !!providers.anthropic.apiKey, fromEnv: !!process.env.ANTHROPIC_API_KEY },
        xai: { hasKey: !!providers.xai.apiKey, fromEnv: !!process.env.XAI_API_KEY, baseUrl: providers.xai.baseUrl },
        deepseek: { hasKey: !!providers.deepseek.apiKey, fromEnv: !!process.env.DEEPSEEK_API_KEY },
        vercel: { hasKey: !!providers.vercel.apiKey, fromEnv: !!process.env.AI_GATEWAY_API_KEY },
        meta: { hasKey: !!providers.meta.apiKey, fromEnv: !!process.env.META_API_KEY },
        openai: { hasKey: !!providers.openai.apiKey, fromEnv: !!process.env.OPENAI_API_KEY },
        telegram: { hasKey: !!providers.telegram.apiKey, fromEnv: !!process.env.TELEGRAM_BOT_TOKEN },
        elevenlabs: { hasKey: !!providers.elevenlabs.apiKey, fromEnv: !!process.env.ELEVENLABS_API_KEY },
        email: { hasKey: !!providers.email.apiKey, fromEnv: false }
      }
    }
  }

  /** Applies a partial update from the renderer. Provider secrets are changed only through setApiKey. */
  update(patch: Partial<PublicSettings>): Settings {
    const { providers, companyPasswords: _derived, language, ...rest } = patch
    // Validated before anything changes, so a bad value leaves the settings untouched.
    const parsed = language === undefined ? undefined : languageSchema.safeParse(language)
    if (parsed && !parsed.success) throw new Error(mainError(this.settings.language, 'invalid-language'))
    const chosen = parsed?.data
    const previous = this.settings.language
    this.settings = { ...this.settings, ...rest }
    if (chosen) {
      this.explicitLanguage = chosen
      this.settings.language = chosen
      // The shipped words nobody edited follow the language; what the person wrote stays as it is (AC-8.2, AC-4.1).
      if (chosen !== previous) this.settings = migrateDefaults(this.settings, previous, chosen)
    }
    if (providers?.xai?.baseUrl !== undefined) {
      this.settings.providers.xai.baseUrl = providers.xai.baseUrl.trim() || defaultSettings().providers.xai.baseUrl
    }
    this.save()
    return this.settings
  }

  /** A company's mailbox password (empty = forget it). */
  setCompanySecret(companyId: string, secret: string): Settings {
    const { [companyId]: _old, ...others } = this.settings.companySecrets
    this.settings.companySecrets = secret.trim() ? { ...others, [companyId]: secret.trim() } : others
    this.save()
    return this.settings
  }

  setApiKey(provider: SecretProviderId, apiKey: string): Settings {
    this.settings.providers[provider].apiKey = apiKey.trim()
    this.save()
    return this.settings
  }
}
