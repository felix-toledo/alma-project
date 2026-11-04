import { useEffect, useMemo, useState } from 'react'
import { BUILTIN_TOOLS, CLAUDE_MODELS, emailServersFor, looksLikeApiKey, PROVIDER_NAMES, READ_ONLY_TOOLS } from '../../../shared/defaults'
import { importMcpJson } from '../../../shared/mcp-import'
import type {
  AgentProfile,
  Effort,
  ImageProviderId,
  InstagramStatus,
  Language,
  McpServerConfig,
  McpServerStatus,
  ProviderId,
  PublicSettings,
  SecretProviderId,
  TelegramSettings,
  TelegramStatus,
  VoiceSettings,
  WhatsAppSettings,
  WhatsAppStatus
} from '../../../shared/types'
import { useLanguage, useT, type T } from '../i18n/useT'
import { enrollmentPhrases, kokoroVoices, windowsVoices } from '../../../shared/voices'
import { recordFor } from '../voice/audio'
import { request } from '../lib/coordinator'
import { approvalModes, toolLabel } from '../lib/format'
import { Play, RefreshCw, X } from 'lucide-react'
import { AmbienceSettings } from '../umbra/AmbienceControls'
import { Icon } from '../umbra/Icon'
import { TeamsSettings } from '../companies/TeamsSettings'
import { HomeSettings } from '../home/HomeSettings'

interface Props {
  settings: PublicSettings
  mcp: McpServerStatus[]
  telegram: TelegramStatus
  whatsapp: WhatsAppStatus
  onChange(patch: Partial<PublicSettings>): Promise<void>
  onSettingsReplaced(settings: PublicSettings): void
  onClose(): void
  /** Tab to open on (e.g. Equipos from the Empresas view). */
  initialTab?: Tab
}

export type Tab = 'providers' | 'agents' | 'teams' | 'approvals' | 'images' | 'telegram' | 'whatsapp' | 'email' | 'voice' | 'instagram' | 'mcp' | 'home' | 'general' | 'ambience'
const TABS: Tab[] = ['providers', 'agents', 'teams', 'approvals', 'telegram', 'whatsapp', 'email', 'voice', 'images', 'instagram', 'home', 'mcp', 'general', 'ambience']
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export function SettingsDialog(props: Props): React.JSX.Element {
  const t = useT()
  const [tab, setTab] = useState<Tab>(props.initialTab ?? 'providers')
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-label={t('common.settings')}>
        <header className="modal-header">
          <h2>{t('common.settings')}</h2>
          <button className="icon-button" onClick={props.onClose} title={t('common.close')}>
            <Icon icon={X} size="sm" />
          </button>
        </header>
        <div className="modal-body">
          <nav className="tabs">
            {TABS.map((id) => (
              <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
                {t(`settings.tab.${id}`)}
              </button>
            ))}
          </nav>
          <section className="tab-content">
            {tab === 'providers' && <ProvidersTab {...props} />}
            {tab === 'agents' && <AgentsTab {...props} />}
            {tab === 'teams' && <TeamsSettings settings={props.settings} onChange={props.onChange} onSettingsReplaced={props.onSettingsReplaced} />}
            {tab === 'approvals' && <ApprovalsTab {...props} />}
            {tab === 'home' && <HomeSettings settings={props.settings} onChange={props.onChange} onSettingsReplaced={props.onSettingsReplaced} />}
            {tab === 'mcp' && <McpTab {...props} />}
            {tab === 'images' && <ImagesTab {...props} />}
            {tab === 'telegram' && <TelegramTab {...props} />}
            {tab === 'whatsapp' && <WhatsAppTab {...props} />}
            {tab === 'email' && <EmailTab {...props} />}
            {tab === 'voice' && <VoiceTab {...props} />}
            {tab === 'instagram' && <InstagramTab {...props} />}
            {tab === 'general' && <GeneralTab {...props} />}
            {tab === 'ambience' && <AmbienceSettings />}
          </section>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

type ModelSource = ProviderId | `image-${ImageProviderId}`

function fetchModels(source: ModelSource): Promise<string[]> {
  if (source.startsWith('image-')) return request({ method: 'images.models', provider: source.slice(6) as ImageProviderId })
  return request({ method: 'models.list', provider: source as ProviderId })
}

function useModels(source: ModelSource): { models: string[]; error: string; load(): void; loading: boolean } {
  const [models, setModels] = useState<string[]>(source === 'anthropic' ? CLAUDE_MODELS : [])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const load = (): void => {
    setLoading(true)
    setError('')
    fetchModels(source)
      .then((ids) => setModels(ids))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }
  return { models, error, load, loading }
}

/** Providers with models; the other secrets (Telegram, ElevenLabs, mail) live in their own tabs. */
type ModelProviderId = Exclude<SecretProviderId, 'telegram' | 'elevenlabs' | 'email'>

const PROVIDER_INFO: Record<ModelProviderId, { envVar: string; source: ModelSource }> = {
  anthropic: { envVar: 'ANTHROPIC_API_KEY', source: 'anthropic' },
  xai: { envVar: 'XAI_API_KEY', source: 'xai' },
  deepseek: { envVar: 'DEEPSEEK_API_KEY', source: 'deepseek' },
  vercel: { envVar: 'AI_GATEWAY_API_KEY', source: 'vercel' },
  meta: { envVar: 'META_API_KEY', source: 'meta' },
  openai: { envVar: 'OPENAI_API_KEY', source: 'image-openai' }
}

const CHAT_PROVIDERS = ['meta', 'anthropic', 'xai', 'deepseek', 'vercel'] as const

/** The provider choices of the agent and reviewer selects. */
function ProviderOptions(): React.JSX.Element {
  const t = useT()
  return (
    <>
      {CHAT_PROVIDERS.map((provider) => (
        <option key={provider} value={provider}>
          {t(`providers.option.${provider}`)}
        </option>
      ))}
    </>
  )
}

/** What an empty model field means for providers that have a default (the agent's field, and the reviewer's placeholder). */
function emptyModelHint(provider: ProviderId, t: T, key: 'agents' | 'approvals'): string {
  return provider === 'anthropic' ? '' : t(`${key}.modelHint.${provider}`)
}

function ProviderCard({ provider, settings, onSettingsReplaced }: { provider: ModelProviderId } & Props): React.JSX.Element {
  const t = useT()
  const info = settings.providers[provider]
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(settings.providers.xai.baseUrl)
  const { envVar, source } = PROVIDER_INFO[provider]
  const name = t(`providers.name.${provider}`)
  const { models, error, load, loading } = useModels(source)
  const [tested, setTested] = useState(false)

  const saveKey = async (value: string): Promise<void> => {
    onSettingsReplaced(await window.desktop.settings.setApiKey(provider, value))
    setKey('')
  }

  return (
    <div className="card">
      <div className="row space">
        <h3>{name}</h3>
        <span className={`badge ${info.hasKey || info.fromEnv ? 'ok' : 'warn'}`}>
          {info.hasKey ? t('providers.keySaved') : info.fromEnv ? t('providers.usesEnv', { envVar }) : t('providers.notSet')}
        </span>
      </div>
      <div className="row">
        <input
          type="password"
          placeholder={info.hasKey ? t('providers.replaceKey') : t('providers.pasteKey')}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="grow"
        />
        <button className="primary" disabled={!key.trim()} onClick={() => void saveKey(key)}>
          {t('common.save')}
        </button>
        {info.hasKey && (
          <button className="ghost" onClick={() => void saveKey('')}>
            {t('common.delete')}
          </button>
        )}
      </div>
      {provider === 'xai' && (
        <label className="field">
          <span>{t('providers.baseUrl')}</span>
          <div className="row">
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="grow" />
            <button
              className="ghost"
              disabled={baseUrl === settings.providers.xai.baseUrl}
              onClick={() =>
                void window.desktop.settings
                  .update({ providers: { ...settings.providers, xai: { ...settings.providers.xai, baseUrl } } })
                  .then(onSettingsReplaced)
              }
            >
              {t('providers.saveUrl')}
            </button>
          </div>
        </label>
      )}
      <div className="row">
        <button
          className="ghost small"
          disabled={loading}
          onClick={() => {
            setTested(true)
            load()
          }}
        >
          {loading ? t('providers.testing') : t('providers.test')}
        </button>
        {tested && !loading && (error ? <span className="text-danger small">{error}</span> : <span className="text-ok small">{t('providers.connected', { count: models.length })}</span>)}
      </div>
      {provider === 'vercel' && (
        <p className="muted small">
          {t('providers.vercelHint.before')} <code>npx vercel@latest ai-gateway setup</code> {t('providers.vercelHint.after')}
        </p>
      )}
      <p className="muted small">{t('providers.keyNote')}</p>
    </div>
  )
}

function ProvidersTab(props: Props): React.JSX.Element {
  return (
    <>
      <ProviderCard provider="anthropic" {...props} />
      <ProviderCard provider="xai" {...props} />
      <ProviderCard provider="deepseek" {...props} />
      <ProviderCard provider="vercel" {...props} />
      <ProviderCard provider="meta" {...props} />
      <ProviderCard provider="openai" {...props} />
    </>
  )
}

// ---------------------------------------------------------------------------

function newAgent(t: T): AgentProfile {
  return {
    id: `agente-${Math.random().toString(36).slice(2, 8)}`,
    name: t('agents.new.name'),
    description: t('agents.new.description'),
    systemPrompt: t('agents.new.prompt'),
    provider: 'meta',
    model: '',
    effort: 'medium',
    tools: ['read_file', 'list_dir', 'search_files'],
    allowMcp: false,
    canDelegate: false
  }
}

function AgentsTab({ settings, onChange }: Props): React.JSX.Element {
  const t = useT()
  const [selectedId, setSelectedId] = useState(settings.agents[0]?.id ?? '')
  const selected = settings.agents.find((a) => a.id === selectedId) ?? settings.agents[0]
  const [draft, setDraft] = useState<AgentProfile | undefined>(selected)
  useEffect(() => setDraft(selected), [selected])
  const claude = useModels('anthropic')
  const grok = useModels('xai')
  const deepseek = useModels('deepseek')
  const vercel = useModels('vercel')
  const meta = useModels('meta')
  const models = { xai: grok, deepseek, vercel, meta, anthropic: claude }[draft?.provider ?? 'anthropic']
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(selected), [draft, selected])

  const saveAgents = (agents: AgentProfile[]): Promise<void> => onChange({ agents })
  const set = <K extends keyof AgentProfile>(key: K, value: AgentProfile[K]): void => setDraft((d) => (d ? { ...d, [key]: value } : d))

  if (!draft) return <p>{t('agents.none')}</p>
  return (
    <>
    <label className="field">
      <span>{t('agents.default')}</span>
      <select value={settings.defaultAgentId} onChange={(e) => void onChange({ defaultAgentId: e.target.value })}>
        {settings.agents.filter((a) => !a.companyId).map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} · {PROVIDER_NAMES[a.provider]}
          </option>
        ))}
      </select>
    </label>
    <div className="split">
      <div className="split-list">
        {settings.agents.filter((a) => !a.companyId).map((agent) => (
          <button key={agent.id} className={agent.id === selected?.id ? 'active' : ''} onClick={() => setSelectedId(agent.id)}>
            <span className="ellipsis">{agent.name}</span>
            <span className="muted small">
              {PROVIDER_NAMES[agent.provider]}
              {agent.id === settings.defaultAgentId ? ` · ${t('agents.defaultMark')}` : ''}
            </span>
          </button>
        ))}
        <button
          className="ghost"
          onClick={() => {
            const agent = newAgent(t)
            void saveAgents([...settings.agents, agent]).then(() => setSelectedId(agent.id))
          }}
        >
          {t('agents.add')}
        </button>
      </div>

      <div className="split-detail">
        <label className="field">
          <span>{t('common.name')}</span>
          <input value={draft.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label className="field">
          <span>{t('agents.description')}</span>
          <input value={draft.description} onChange={(e) => set('description', e.target.value)} />
        </label>
        <div className="row">
          <label className="field">
            <span>{t('agents.provider')}</span>
            <select
              value={draft.provider}
              onChange={(e) => {
                const provider = e.target.value as ProviderId
                setDraft({ ...draft, provider, model: provider === 'anthropic' ? CLAUDE_MODELS[0] : '' })
              }}
            >
              <ProviderOptions />
            </select>
          </label>
          <label className="field grow">
            <span>{t('model.label')} {emptyModelHint(draft.provider, t, 'agents')}</span>
            <div className="row">
              <input list={`models-${draft.provider}`} value={draft.model} onChange={(e) => set('model', e.target.value)} className="grow" />
              <button className="ghost small" onClick={models.load} disabled={models.loading} title={t('agents.fetchModels')}>
                <Icon icon={RefreshCw} size="sm" />
              </button>
            </div>
            <datalist id={`models-${draft.provider}`}>
              {models.models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            {models.error && <span className="text-danger small">{models.error}</span>}
          </label>
          <label className="field">
            <span>{t('agents.effort')}</span>
            <select value={draft.effort} onChange={(e) => set('effort', e.target.value as Effort)}>
              {EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="field">
          <legend>{t('agents.tools')}</legend>
          <div className="checks">
            {BUILTIN_TOOLS.map((tool) => (
              <label key={tool} className="check">
                <input
                  type="checkbox"
                  checked={draft.tools.includes(tool)}
                  onChange={(e) => set('tools', e.target.checked ? [...draft.tools, tool] : draft.tools.filter((t) => t !== tool))}
                />
                {toolLabel(tool, t)}
              </label>
            ))}
            <label className="check">
              <input type="checkbox" checked={draft.allowMcp} onChange={(e) => set('allowMcp', e.target.checked)} />
              {t('settings.tab.mcp')}
            </label>
            <label className="check">
              <input type="checkbox" checked={draft.canDelegate} onChange={(e) => set('canDelegate', e.target.checked)} />
              {t('agents.canDelegate')}
            </label>
          </div>
        </fieldset>
        <fieldset className="field">
          <legend>{t('agents.noApproval')}</legend>
          <div className="checks">
            {draft.tools
              .filter((tool) => !READ_ONLY_TOOLS.includes(tool) && tool !== 'instagram_publish')
              .map((tool) => (
                <label key={tool} className="check">
                  <input
                    type="checkbox"
                    checked={(draft.autoApproveTools ?? []).includes(tool)}
                    onChange={(e) =>
                      set(
                        'autoApproveTools',
                        e.target.checked
                          ? [...(draft.autoApproveTools ?? []), tool]
                          : (draft.autoApproveTools ?? []).filter((t) => t !== tool)
                      )
                    }
                  />
                  {toolLabel(tool, t)}
                </label>
              ))}
          </div>
        </fieldset>
        <label className="field">
          <span>{t('agents.instructions')}</span>
          <textarea rows={8} value={draft.systemPrompt} onChange={(e) => set('systemPrompt', e.target.value)} />
        </label>
        <div className="row">
          <button
            className="primary"
            disabled={!dirty}
            onClick={() => void saveAgents(settings.agents.map((a) => (a.id === draft.id ? draft : a)))}
          >
            {t('agents.saveChanges')}
          </button>
          <button className="ghost" disabled={!dirty} onClick={() => setDraft(selected)}>
            {t('agents.discard')}
          </button>
          <span className="grow" />
          {draft.id !== settings.defaultAgentId && (
            <button className="ghost" onClick={() => void onChange({ defaultAgentId: draft.id })}>
              {t('agents.makeDefault')}
            </button>
          )}
          <button
            className="danger"
            disabled={settings.agents.length <= 1 || draft.id === settings.defaultAgentId}
            title={draft.id === settings.defaultAgentId ? t('agents.cannotDelete') : undefined}
            onClick={() => {
              if (confirm(t('agents.deleteConfirm', { name: draft.name }))) {
                void saveAgents(settings.agents.filter((a) => a.id !== draft.id)).then(() => setSelectedId(settings.agents[0].id))
              }
            }}
          >
            {t('common.delete')}
          </button>
        </div>
      </div>
    </div>
    </>
  )
}

// ---------------------------------------------------------------------------

function ApprovalsTab({ settings, onChange }: Props): React.JSX.Element {
  const t = useT()
  const [review, setReview] = useState(settings.autoReview)
  const reviewModelHint = emptyModelHint(review.provider, t, 'approvals')
  const dirty = JSON.stringify(review) !== JSON.stringify(settings.autoReview)
  return (
    <>
      <div className="card">
        <h3>{t('approvals.mode')}</h3>
        <p className="muted small">{t('approvals.readsNote')}</p>
        {approvalModes(t).map((mode) => (
          <label key={mode.value} className="radio">
            <input
              type="radio"
              name="approval-mode"
              checked={settings.approvalMode === mode.value}
              onChange={() => void onChange({ approvalMode: mode.value })}
            />
            <div>
              <strong>{mode.label}</strong>
              <div className="muted small">{mode.hint}</div>
            </div>
          </label>
        ))}
      </div>

      <div className="card">
        <h3>{t('approvals.autoReview')}</h3>
        <div className="row">
          <label className="field">
            <span>{t('approvals.reviewerProvider')}</span>
            <select value={review.provider} onChange={(e) => setReview({ ...review, provider: e.target.value as ProviderId, model: e.target.value === 'anthropic' ? CLAUDE_MODELS[0] : '' })}>
              <ProviderOptions />
            </select>
          </label>
          <label className="field grow">
            <span>{t('model.label')}</span>
            <input list="review-models" value={review.model} placeholder={reviewModelHint} onChange={(e) => setReview({ ...review, model: e.target.value })} />
            <datalist id="review-models">
              {(review.provider === 'anthropic' ? CLAUDE_MODELS : []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
        </div>
        <label className="field">
          <span>{t('approvals.instructions')}</span>
          <textarea rows={7} value={review.instructions} onChange={(e) => setReview({ ...review, instructions: e.target.value })} />
        </label>
        <button className="primary" disabled={!dirty} onClick={() => void onChange({ autoReview: review })}>
          {t('approvals.saveReview')}
        </button>
      </div>

      <div className="card">
        <h3>{t('toolcard.always')}</h3>
        {settings.alwaysAllowTools.length === 0 ? (
          <p className="muted small">{t('approvals.noneAlways')}</p>
        ) : (
          <ul className="plain-list">
            {settings.alwaysAllowTools.map((tool) => (
              <li key={tool} className="row space">
                <span>{toolLabel(tool, t)}</span>
                <button className="ghost small" onClick={() => void onChange({ alwaysAllowTools: settings.alwaysAllowTools.filter((t) => t !== tool) })}>
                  {t('common.remove')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------

function parseLines(text: string, separator: RegExp): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = separator.exec(line)
    if (match && line.slice(0, match.index).trim()) out[line.slice(0, match.index).trim()] = line.slice(match.index + match[0].length).trim()
  }
  return out
}

function McpTab({ settings, mcp, onChange }: Props): React.JSX.Element {
  const t = useT()
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', type: 'stdio' as 'stdio' | 'http', command: '', args: '', env: '', url: '', headers: '', tools: '' })
  const [json, setJson] = useState('')
  const [jsonError, setJsonError] = useState('')
  const servers = Object.entries(settings.mcpServers)
  const save = (mcpServers: Record<string, McpServerConfig>): Promise<void> => onChange({ mcpServers })

  const addServer = (): void => {
    const name = form.name.trim().replace(/\s+/g, '-')
    if (!name) return
    const tools = form.tools.split(/[\s,]+/).filter(Boolean)
    const config: McpServerConfig =
      form.type === 'stdio'
        ? {
            type: 'stdio',
            command: form.command.trim(),
            args: form.args.split('\n').map((a) => a.trim()).filter(Boolean),
            env: parseLines(form.env, /=/),
            enabled: true,
            tools
          }
        : { type: 'http', url: form.url.trim(), headers: parseLines(form.headers, /:/), enabled: true, tools }
    void save({ ...settings.mcpServers, [name]: config }).then(() => {
      setAdding(false)
      setForm({ name: '', type: 'stdio', command: '', args: '', env: '', url: '', headers: '', tools: '' })
    })
  }

  return (
    <>
      <div className="card">
        <div className="row space">
          <h3>{t('mcp.servers')}</h3>
          <button className="ghost small" onClick={() => void request({ method: 'mcp.reconnect' })}>
            <Icon icon={RefreshCw} size="sm" /> {t('mcp.reconnect')}
          </button>
        </div>
        {servers.length === 0 && <p className="muted small">{t('mcp.none')}</p>}
        {!settings.mcpServers[CHROME_MCP] && (
          <div className="row space">
            <p className="muted small">
              <strong>{t('mcp.chrome.name')}</strong>: {t('mcp.chrome.text')}
            </p>
            <button
              className="ghost small"
              onClick={() =>
                void save({ ...settings.mcpServers, [CHROME_MCP]: { type: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.11.0'], enabled: true } })
              }
            >
              {t('mcp.chrome.add')}
            </button>
          </div>
        )}
        {servers.map(([name, config]) => {
          const status = mcp.find((s) => s.name === name)
          return (
            <div key={name} className="mcp-row">
              <div className="row space">
                <div>
                  <strong>{name}</strong>{' '}
                  <span className={`badge ${status?.state === 'connected' ? 'ok' : status?.state === 'error' ? 'danger' : ''}`}>
                    {status?.state === 'connected' ? t('mcp.tools', { count: status.tools.length }) : status?.state ?? t('mcp.unknown')}
                  </span>
                  <div className="muted small mono ellipsis">
                    {config.type === 'stdio' ? `${config.command} ${(config.args ?? []).join(' ')}` : config.url}
                  </div>
                </div>
                <div className="row">
                  <label className="check">
                    <input type="checkbox" checked={config.enabled} onChange={(e) => void save({ ...settings.mcpServers, [name]: { ...config, enabled: e.target.checked } })} />
                    {t('mcp.active')}
                  </label>
                  <button
                    className="danger small"
                    onClick={() => {
                      const { [name]: _removed, ...rest } = settings.mcpServers
                      void save(rest)
                    }}
                  >
                    {t('common.remove')}
                  </button>
                </div>
              </div>
              {status?.error && <div className="text-danger small">{status.error}</div>}
              {status?.state === 'connected' && status.tools.length > 0 && (
                <div className="muted small">{status.tools.map((t) => t.name).join(', ')}</div>
              )}
            </div>
          )
        })}
      </div>

      {adding ? (
        <div className="card">
          <h3>{t('mcp.new')}</h3>
          <div className="row">
            <label className="field grow">
              <span>{t('common.name')}</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('mcp.nameExample')} />
            </label>
            <label className="field">
              <span>{t('mcp.type')}</span>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as 'stdio' | 'http' })}>
                <option value="stdio">{t('mcp.type.stdio')}</option>
                <option value="http">{t('mcp.type.http')}</option>
              </select>
            </label>
          </div>
          {form.type === 'stdio' ? (
            <>
              <label className="field">
                <span>{t('mcp.command')}</span>
                <input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder={t('mcp.commandExample')} />
              </label>
              <label className="field">
                <span>{t('mcp.args')}</span>
                <textarea rows={3} value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} placeholder={t('mcp.argsExample')} />
              </label>
              <label className="field">
                <span>{t('mcp.env')}</span>
                <textarea rows={2} value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} />
              </label>
            </>
          ) : (
            <>
              <label className="field">
                <span>{t('mcp.url')}</span>
                <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder={t('mcp.urlExample')} />
              </label>
              <label className="field">
                <span>{t('mcp.headers')}</span>
                <textarea rows={2} value={form.headers} onChange={(e) => setForm({ ...form, headers: e.target.value })} />
              </label>
            </>
          )}
          <label className="field">
            <span>{t('mcp.allowedTools')}</span>
            <textarea rows={2} className="mono" value={form.tools} onChange={(e) => setForm({ ...form, tools: e.target.value })} placeholder={t('mcp.toolsExample')} />
          </label>
          <div className="row">
            <button className="primary" onClick={addServer} disabled={!form.name.trim() || (form.type === 'stdio' ? !form.command.trim() : !form.url.trim())}>
              {t('common.add')}
            </button>
            <button className="ghost" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button className="ghost" onClick={() => setAdding(true)}>
          {t('mcp.addServer')}
        </button>
      )}

      <div className="card">
        <h3>{t('mcp.importTitle')}</h3>
        <p className="muted small">{t('mcp.importHint', { format: '{ "mcpServers": { … } }' })}</p>
        <textarea rows={5} className="mono" value={json} onChange={(e) => setJson(e.target.value)} />
        {jsonError && <div className="text-danger small">{jsonError}</div>}
        <button
          className="ghost"
          disabled={!json.trim()}
          onClick={() => {
            try {
              const imported = importMcpJson(json)
              if (Object.keys(imported).length === 0) throw new Error(t('mcp.importEmpty'))
              void save({ ...settings.mcpServers, ...imported })
              setJson('')
              setJsonError('')
            } catch (error) {
              setJsonError((error as Error).message)
            }
          }}
        >
          {t('mcp.import')}
        </button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------

function GeneralTab({ settings, onChange }: Props): React.JSX.Element {
  const t = useT()
  return (
    <>
      <div className="card">
        <label className="field">
          <span>{t('settings.language.title')}</span>
          <select value={settings.language} onChange={(e) => void onChange({ language: e.target.value as Language })}>
            {(['es', 'en'] as const).map((language) => (
              <option key={language} value={language}>
                {t(`settings.language.${language}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="card">
        <h3>{t('general.workspace.title')}</h3>
        <p className="muted small">
          {t('general.workspace.hint')}
        </p>
        <div className="row">
          <input readOnly value={settings.defaultWorkspace || t('general.workspace.none')} className="grow" />
          <button
            className="ghost"
            onClick={async () => {
              const folder = await window.desktop.pickFolder()
              if (folder) await onChange({ defaultWorkspace: folder })
            }}
          >
            {t('general.pick')}
          </button>
        </div>
      </div>
      <div className="card">
        <h3>{t('general.background.title')}</h3>
        <p className="muted small">{t('general.background.hint')}</p>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.background.runInTray}
            onChange={(e) => void onChange({ background: { ...settings.background, runInTray: e.target.checked } })}
          />
          {t('general.background.tray')}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.background.launchAtLogin}
            onChange={(e) => void onChange({ background: { ...settings.background, launchAtLogin: e.target.checked } })}
          />
          {t('general.background.login')}
        </label>
      </div>
      <PrivacyCard settings={settings} onChange={onChange} />
    </>
  )
}

/** Retention, a copy of what Alma keeps about the person, and erasing it. */
function PrivacyCard({ settings, onChange }: Pick<Props, 'settings' | 'onChange'>): React.JSX.Element {
  const t = useT()
  const [note, setNote] = useState('')
  const run = (job: () => Promise<string>): void => void job().then(setNote).catch((e: Error) => setNote(e.message))
  return (
    <div className="card">
      <h3>{t('privacy.title')}</h3>
      <p className="muted small">
        {t('privacy.about')}
      </p>
      <label className="field">
        <span>{t('privacy.retention')}</span>
        <select value={settings.privacy.threadRetentionDays} onChange={(e) => void onChange({ privacy: { threadRetentionDays: Number(e.target.value) } })}>
          <option value={0}>{t('privacy.never')}</option>
          <option value={30}>{t('privacy.afterDays', { count: 30 })}</option>
          <option value={90}>{t('privacy.afterDays', { count: 90 })}</option>
          <option value={180}>{t('privacy.afterDays', { count: 180 })}</option>
          <option value={365}>{t('privacy.afterYear')}</option>
        </select>
      </label>
      <div className="row">
        <button
          className="ghost"
          onClick={() =>
            run(async () => {
              const folder = await window.desktop.pickFolder()
              return folder ? t('privacy.saved', { path: await request<string>({ method: 'privacy.export', targetDir: folder }) }) : ''
            })
          }
        >
          {t('privacy.export')}
        </button>
        <button
          className="danger"
          onClick={() => {
            if (confirm(t('privacy.eraseConfirm'))) {
              run(async () => {
                await request({ method: 'privacy.erase' })
                // ponytail: the conversation list lives in App state; reloading the window is the cheap way to empty it.
                setTimeout(() => location.reload(), 1200)
                return t('privacy.erased')
              })
            }
          }}
        >
          {t('privacy.erase')}
        </button>
      </div>
      {note && <p className="muted small">{note}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------

function ImagesTab({ settings, onChange }: Props): React.JSX.Element {
  const t = useT()
  const [model, setModel] = useState(settings.images.model)
  const source: ModelSource = `image-${settings.images.provider}`
  const models = useModels(source)
  const hasKey = (provider: ImageProviderId): boolean => settings.providers[provider].hasKey || settings.providers[provider].fromEnv
  const isKey = looksLikeApiKey(model)
  return (
    <div className="card">
      <h3>{t('images.title')}</h3>
      <p className="muted small">
        {t('images.about')}
      </p>
      <div className="row">
        <label className="field">
          <span>{t('images.service')}</span>
          <select
            value={settings.images.provider}
            onChange={(e) => {
              setModel('')
              void onChange({ images: { provider: e.target.value as ImageProviderId, model: '' } })
            }}
          >
            <option value="meta">
              {t('images.option.meta')}
              {hasKey('meta') ? '' : ` · ${t('images.missingKey')}`}
            </option>
            <option value="xai">
              {t('providers.option.xai')}
              {hasKey('xai') ? '' : ` · ${t('images.missingKey')}`}
            </option>
            <option value="openai">
              {t('images.option.openai')}
              {hasKey('openai') ? '' : ` · ${t('images.missingKey')}`}
            </option>
          </select>
        </label>
        <label className="field grow">
          <span>{t('images.model')}</span>
          <div className="row">
            <input list="image-models" value={model} onChange={(e) => setModel(e.target.value)} className="grow" />
            <button className="ghost small" onClick={models.load} disabled={models.loading} title={t('images.fetchModels')}>
              <Icon icon={RefreshCw} size="sm" />
            </button>
            <button
              className="primary small"
              disabled={model === settings.images.model || isKey}
              onClick={() => void onChange({ images: { ...settings.images, model: model.trim() } })}
            >
              {t('common.save')}
            </button>
          </div>
          {isKey && (
            <span className="text-danger small">{t('images.isKey')}</span>
          )}
          <datalist id="image-models">
            {models.models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {models.error && <span className="text-danger small">{models.error}</span>}
        </label>
      </div>
    </div>
  )
}

const CHROME_MCP = 'chrome-devtools'

const WHATSAPP_STATE: Record<WhatsAppStatus['state'], { badge: string }> = {
  off: { badge: '' },
  connecting: { badge: 'warn' },
  qr: { badge: 'warn' },
  online: { badge: 'ok' },
  error: { badge: 'danger' }
}

function WhatsAppTab({ settings, onChange, whatsapp }: Props): React.JSX.Element {
  const t = useT()
  const config = settings.whatsapp
  const patch = (next: Partial<WhatsAppSettings>): Promise<void> => onChange({ whatsapp: { ...config, ...next } })
  const state = WHATSAPP_STATE[whatsapp.state]
  return (
    <>
      <div className="card">
        <div className="row space">
          <h3>{t('settings.tab.whatsapp')}</h3>
          <span className={`badge ${state.badge}`}>
            {t(`channels.state.${whatsapp.state}`)}
            {whatsapp.number ? ` · +${whatsapp.number}` : ''}
          </span>
        </div>
        <p className="muted small">
          {t('whatsapp.about.before')} <strong>{t('whatsapp.about.selfChat')}</strong> {t('whatsapp.about.after')}
        </p>
        <p className="small text-danger">
          {t('whatsapp.warning')}
        </p>
        <label className="check">
          <input type="checkbox" checked={config.enabled} onChange={(e) => void patch({ enabled: e.target.checked })} />
          {t('whatsapp.enable')}
        </label>
        {whatsapp.state === 'error' && <p className="text-danger small">{whatsapp.error}</p>}
        {whatsapp.state === 'qr' && whatsapp.qr && (
          <div className="row">
            <img src={whatsapp.qr} alt={t('whatsapp.qrAlt')} width={240} height={240} style={{ background: '#fff', borderRadius: 8 }} />
            <p className="small">
              {t('whatsapp.qr.before')} <strong>{t('whatsapp.qr.linked')}</strong> → <strong>{t('whatsapp.qr.link')}</strong>
              {t('whatsapp.qr.after')}
            </p>
          </div>
        )}
        {whatsapp.state === 'online' && (
          <button className="ghost small" onClick={() => void request({ method: 'whatsapp.logout' })}>
            {t('whatsapp.unlink')}
          </button>
        )}
      </div>

      <div className="card">
        <h3>{t('channels.agent')}</h3>
        <p className="muted small">
          {t('whatsapp.agentNote')}
        </p>
        <select value={config.agentId} onChange={(e) => void patch({ agentId: e.target.value })}>
          {settings.agents.filter((a) => !a.companyId).map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </div>
    </>
  )
}

function EmailTab({ settings, onChange, onSettingsReplaced }: Props): React.JSX.Element {
  const t = useT()
  const config = settings.email
  const [password, setPassword] = useState('')
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const patch = (next: Partial<typeof config>): Promise<void> => onChange({ email: { ...config, ...next } })
  const hasPassword = settings.providers.email.hasKey
  const gmail = /@(gmail|googlemail)\.com$/i.test(config.address)
  return (
    <>
      <div className="card">
        <h3>{t('email.title')}</h3>
        <p className="muted small">
          {t('email.about')}
        </p>
        <label className="field">
          <span>{t('email.address')}</span>
          <input
            type="email"
            placeholder={t('email.addressExample')}
            value={config.address}
            onChange={(e) => void patch({ address: e.target.value.trim() })}
            onBlur={() => !config.imapHost && config.address.includes('@') && void patch(emailServersFor(config.address))}
          />
        </label>
        <label className="field">
          <span>{t('email.appPassword')}</span>
          <div className="row">
            <input
              type="password"
              className="grow"
              placeholder={hasPassword ? t('email.passwordSaved') : t('email.passwordExample')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              className="primary"
              disabled={!password.trim()}
              onClick={async () => {
                onSettingsReplaced(await window.desktop.settings.setApiKey('email', password.replace(/\s+/g, '')))
                setPassword('')
              }}
            >
              {t('common.save')}
            </button>
            {hasPassword && (
              <button className="ghost" onClick={async () => onSettingsReplaced(await window.desktop.settings.setApiKey('email', ''))}>
                {t('common.delete')}
              </button>
            )}
          </div>
        </label>
        {gmail && (
          <p className="small">
            {t('email.gmail.before')}{' '}
            <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
              myaccount.google.com/apppasswords
            </a>
            . {t('email.gmail.after')}
          </p>
        )}
      </div>

      <div className="card">
        <h3>{t('mcp.servers')}</h3>
        <div className="row">
          <label className="field grow">
            <span>{t('email.imap')}</span>
            <input value={config.imapHost} placeholder="imap.gmail.com" onChange={(e) => void patch({ imapHost: e.target.value.trim() })} />
          </label>
          <label className="field">
            <span>{t('email.port')}</span>
            <input type="number" value={config.imapPort} onChange={(e) => void patch({ imapPort: Number(e.target.value) || 993 })} />
          </label>
        </div>
        <div className="row">
          <label className="field grow">
            <span>{t('email.smtp')}</span>
            <input value={config.smtpHost} placeholder="smtp.gmail.com" onChange={(e) => void patch({ smtpHost: e.target.value.trim() })} />
          </label>
          <label className="field">
            <span>{t('email.port')}</span>
            <input type="number" value={config.smtpPort} onChange={(e) => void patch({ smtpPort: Number(e.target.value) || 465 })} />
          </label>
        </div>
        <div className="row">
          <button className="ghost small" onClick={() => void patch(emailServersFor(config.address))} disabled={!config.address.includes('@')}>
            {t('email.autofill')}
          </button>
          <button
            className="primary small"
            disabled={testing || !hasPassword || !config.imapHost || !config.smtpHost}
            onClick={() => {
              setTesting(true)
              setTest(null)
              request<string>({ method: 'email.test' })
                .then((text) => setTest({ ok: true, text }))
                .catch((error: Error) => setTest({ ok: false, text: error.message }))
                .finally(() => setTesting(false))
            }}
          >
            {testing ? t('providers.testing') : t('providers.test')}
          </button>
        </div>
        {test && <p className={`small ${test.ok ? '' : 'text-danger'}`}>{test.text}</p>}
      </div>
    </>
  )
}

const TELEGRAM_STATE: Record<TelegramStatus['state'], { badge: string }> = {
  off: { badge: '' },
  connecting: { badge: 'warn' },
  online: { badge: 'ok' },
  error: { badge: 'danger' }
}

function TelegramTab({ settings, onChange, onSettingsReplaced, telegram }: Props): React.JSX.Element {
  const t = useT()
  const config = settings.telegram
  const [token, setToken] = useState('')
  const [user, setUser] = useState('')
  const patch = (next: Partial<TelegramSettings>): Promise<void> => onChange({ telegram: { ...config, ...next } })
  const state = TELEGRAM_STATE[telegram.state]
  const hasToken = settings.providers.telegram.hasKey || settings.providers.telegram.fromEnv

  const addUser = (): void => {
    const name = user.trim().replace(/^@/, '')
    if (!name || config.allowedUsers.some((u) => u.toLowerCase() === name.toLowerCase())) return setUser('')
    void patch({ allowedUsers: [...config.allowedUsers, name] }).then(() => setUser(''))
  }

  return (
    <>
      <div className="card">
        <div className="row space">
          <h3>{t('telegram.title')}</h3>
          <span className={`badge ${state.badge}`}>
            {t(`channels.state.${telegram.state}`)}
            {telegram.username ? ` ${t('telegram.as', { username: telegram.username })}` : ''}
          </span>
        </div>
        <p className="muted small">
          {t('telegram.about.before')} <strong>@BotFather</strong> {t('telegram.about.after')}
        </p>
        {telegram.state === 'error' && <p className="text-danger small">{telegram.error}</p>}
        <div className="row">
          <input
            type="password"
            className="grow"
            placeholder={hasToken ? t('telegram.tokenSaved') : '123456789:AA…'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button
            className="primary"
            disabled={!token.trim()}
            onClick={async () => {
              onSettingsReplaced(await window.desktop.settings.setApiKey('telegram', token.trim()))
              setToken('')
            }}
          >
            {t('telegram.saveToken')}
          </button>
          {settings.providers.telegram.hasKey && (
            <button className="ghost" onClick={async () => onSettingsReplaced(await window.desktop.settings.setApiKey('telegram', ''))}>
              {t('common.delete')}
            </button>
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={config.enabled} onChange={(e) => void patch({ enabled: e.target.checked })} />
          {t('telegram.active')}
        </label>
        {telegram.username && (
          <p className="small">
            {t('telegram.open.before')} <a href={`https://t.me/${telegram.username}`} target="_blank" rel="noreferrer">t.me/{telegram.username}</a>{' '}
            {t('telegram.open.after')}
          </p>
        )}
      </div>

      <div className="card">
        <h3>{t('telegram.who')}</h3>
        {config.chatId !== null ? (
          <>
            <p className="small">
              {t('telegram.linked')}
            </p>
            <button className="ghost small" onClick={() => void patch({ chatId: null })}>
              {t('telegram.unlink')}
            </button>
          </>
        ) : (
          <p className="muted small">
            {t('telegram.firstUser')}
          </p>
        )}
        <div className="row wrap">
          {config.allowedUsers.map((name) => (
            <span key={name} className="badge">
              @{name}{' '}
              <button className="icon-button" title={t('common.remove')} onClick={() => void patch({ allowedUsers: config.allowedUsers.filter((u) => u !== name) })}>
                <Icon icon={X} size={12} />
              </button>
            </span>
          ))}
        </div>
        <div className="row">
          <input
            className="grow"
            placeholder={t('telegram.userExample')}
            value={user}
            onChange={(e) => setUser(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addUser()}
          />
          <button className="ghost" onClick={addUser} disabled={!user.trim()}>
            {t('common.add')}
          </button>
        </div>
      </div>

      <div className="card">
        <h3>{t('channels.agent')}</h3>
        <p className="muted small">
          {t('telegram.agentNote')}
        </p>
        <select value={config.agentId} onChange={(e) => void patch({ agentId: e.target.value })}>
          {settings.agents.filter((a) => !a.companyId).map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </div>
    </>
  )
}

const ENROLL_MS = 5500

function VoiceTab({ settings, onChange, onSettingsReplaced }: Props): React.JSX.Element {
  const t = useT()
  const language = useLanguage()
  const phrases = enrollmentPhrases(language)
  const voice = settings.voice
  const patch = (next: Partial<VoiceSettings>): Promise<void> => onChange({ voice: { ...voice, ...next } })
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([])
  const [profile, setProfile] = useState<{ enrolled: boolean; enrolledAt?: number }>({ enrolled: false })
  const [enrolling, setEnrolling] = useState<{ step: number; level: number } | null>(null)
  const [message, setMessage] = useState('')
  const [elevenKey, setElevenKey] = useState('')
  const [elevenVoices, setElevenVoices] = useState<{ id: string; name: string; preview: string; labels: string }[]>([])
  const [busy, setBusy] = useState('')

  useEffect(() => {
    void navigator.mediaDevices.enumerateDevices().then((devices) => setMics(devices.filter((d) => d.kind === 'audioinput')))
    const loadVoices = (): void => setSystemVoices(windowsVoices(speechSynthesis.getVoices(), language))
    loadVoices()
    speechSynthesis.addEventListener('voiceschanged', loadVoices)
    void request<{ enrolled: boolean; enrolledAt?: number }>({ method: 'voice.profile' }).then(setProfile)
    return () => speechSynthesis.removeEventListener('voiceschanged', loadVoices)
  }, [language])

  const run = async (label: string, work: () => Promise<string | void>): Promise<void> => {
    setBusy(label)
    setMessage('')
    try {
      const result = await work()
      if (result) setMessage(result)
    } catch (error) {
      setMessage(t('voice.error', { message: (error as Error).message }))
    } finally {
      setBusy('')
    }
  }

  const enroll = (): Promise<void> =>
    run('enroll', async () => {
      const samples: ArrayBuffer[] = []
      for (let step = 0; step < phrases.length; step++) {
        setEnrolling({ step, level: 0 })
        samples.push(await recordFor(ENROLL_MS, voice.micDeviceId, (level) => setEnrolling({ step, level })))
      }
      setEnrolling(null)
      const { consistency } = await request<{ consistency: number }>({ method: 'voice.enroll', samples })
      setProfile(await request({ method: 'voice.profile' }))
      return consistency < 0.75
        ? t('voice.enrollMixed', { percent: Math.round(consistency * 100) })
        : t('voice.enrollDone', { percent: Math.round(consistency * 100) })
    }).finally(() => setEnrolling(null))

  const testSpeaker = (): Promise<void> =>
    run('test', async () => {
      setMessage(t('voice.speakNow'))
      const sample = await recordFor(3500, voice.micDeviceId)
      const score = await request<number>({ method: 'voice.testSpeaker', sample })
      return t('voice.testResult', {
        score: Math.round(score * 100),
        threshold: Math.round(voice.speakerThreshold * 100),
        verdict: score >= voice.speakerThreshold ? t('voice.recognized') : t('voice.notRecognized')
      })
    })

  return (
    <>
      <div className="card">
        <div className="row space">
          <h3>{t('voice.title')}</h3>
          <button className="switch" role="switch" aria-checked={voice.enabled} aria-label={t('voice.title')} onClick={() => void patch({ enabled: !voice.enabled })}>
            <span className="switch-knob" />
          </button>
        </div>
        <p className="muted small">
          {t('voice.about')}
        </p>
        <label className="field">
          <span>{t('channels.agent')}</span>
          <select value={voice.agentId} onChange={(e) => void patch({ agentId: e.target.value })}>
            {settings.agents.filter((a) => !a.companyId).map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('voice.mic')}</span>
          <select value={voice.micDeviceId} onChange={(e) => void patch({ micDeviceId: e.target.value })}>
            <option value="">{t('voice.micDefault')}</option>
            {mics.filter((m) => m.deviceId && m.deviceId !== 'default').map((mic) => (
              <option key={mic.deviceId} value={mic.deviceId}>
                {mic.label || t('voice.mic')}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="card">
        <h3>{t('voice.activation.title')}</h3>
        <div className="row">
          <label className="field grow">
            <span>{t('voice.wakeWord')}</span>
            <select value={voice.wakeWord} onChange={(e) => void patch({ wakeWord: e.target.value as VoiceSettings['wakeWord'] })}>
              <option value="hola_alma">{t('voice.wakePhrase')}</option>
              <option value="off">{t('voice.wakeOff')}</option>
            </select>
          </label>
          <label className="field">
            <span>{t('voice.sensitivity')}</span>
            <input
              type="range"
              min={0.3}
              max={0.9}
              step={0.05}
              value={1.2 - voice.wakeThreshold}
              onChange={(e) => void patch({ wakeThreshold: Math.round((1.2 - Number(e.target.value)) * 100) / 100 })}
            />
          </label>
        </div>
        <label className="field">
          <span>{t('voice.sendDelay')}</span>
          <select value={voice.sendDelayMs} onChange={(e) => void patch({ sendDelayMs: Number(e.target.value) })}>
            <option value={0}>{t('voice.delay.none')}</option>
            <option value={1000}>{t('voice.delay.1000')}</option>
            <option value={1500}>{t('voice.delay.1500')}</option>
            <option value={2500}>{t('voice.delay.2500')}</option>
            <option value={4000}>{t('voice.delay.4000')}</option>
          </select>
        </label>
        <label className="field">
          <span>{t('voice.hotkey')}</span>
          <input value={voice.hotkey} placeholder="Control+Alt+Space" onChange={(e) => void patch({ hotkey: e.target.value })} />
        </label>
        <p className="muted small">{t('voice.ownWord')}</p>
      </div>

      <div className="card">
        <div className="row space">
          <h3>{t('voice.yours')}</h3>
          <span className={`badge ${profile.enrolled ? 'ok' : 'warn'}`}>{profile.enrolled ? t('voice.trained') : t('voice.untrained')}</span>
        </div>
        <p className="muted small">
          {t('voice.enrollAbout')}
        </p>
        {enrolling ? (
          <div className="enroll-step">
            <div className="muted small">{t('voice.enrollStep', { step: enrolling.step + 1, total: phrases.length })}</div>
            <blockquote>{phrases[enrolling.step]}</blockquote>
            <div className="level-meter">
              <span style={{ width: `${Math.min(100, enrolling.level * 180)}%` }} />
            </div>
          </div>
        ) : (
          <div className="row">
            <button className="primary" disabled={!!busy} onClick={() => void enroll()}>
              {profile.enrolled ? t('voice.retrain') : t('voice.train')}
            </button>
            <button className="ghost" disabled={!!busy || !profile.enrolled} onClick={() => void testSpeaker()}>
              {t('voice.test')}
            </button>
            {profile.enrolled && (
              <button
                className="ghost"
                disabled={!!busy}
                onClick={() => void request({ method: 'voice.forgetProfile' }).then(() => setProfile({ enrolled: false }))}
              >
                {t('voice.forget')}
              </button>
            )}
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={voice.verifySpeaker} onChange={(e) => void patch({ verifySpeaker: e.target.checked })} />
          {t('voice.onlyMine')}
        </label>
        <label className="field">
          <span>{t('voice.strictness', { percent: Math.round(voice.speakerThreshold * 100) })}</span>
          <input type="range" min={0.6} max={0.95} step={0.01} value={voice.speakerThreshold} onChange={(e) => void patch({ speakerThreshold: Number(e.target.value) })} />
        </label>
      </div>

      <div className="card">
        <h3>{t('voice.stt.title')}</h3>
        <div className="row">
          <label className="check">
            <input type="radio" checked={voice.stt === 'local'} onChange={() => void patch({ stt: 'local' })} />
            {t('voice.stt.local')}
          </label>
          <label className="check">
            <input type="radio" checked={voice.stt === 'openai'} onChange={() => void patch({ stt: 'openai' })} />
            {t('voice.stt.openai')}
          </label>
          <label className="check">
            <input type="radio" checked={voice.stt === 'meta'} onChange={() => void patch({ stt: 'meta' })} />
            {t('voice.stt.meta')}
          </label>
        </div>
        {voice.stt === 'local' ? (
          <select value={voice.sttModel} onChange={(e) => void patch({ sttModel: e.target.value as VoiceSettings['sttModel'] })}>
            <option value="whisper-base">{t('voice.stt.base')}</option>
            <option value="whisper-small">{t('voice.stt.small')}</option>
          </select>
        ) : (
          (() => {
            const provider = voice.stt === 'meta' ? settings.providers.meta : settings.providers.openai
            return !provider.hasKey && !provider.fromEnv && <p className="text-warn small">{t('voice.stt.needKey', { provider: voice.stt === 'meta' ? 'Meta' : 'OpenAI' })}</p>
          })()
        )}
      </div>

      <div className="card">
        <h3>{t('voice.tts.title')}</h3>
        <div className="row">
          <label className="check">
            <input type="radio" checked={voice.tts === 'kokoro'} onChange={() => void patch({ tts: 'kokoro' })} />
            {t('voice.tts.kokoro')}
          </label>
          <label className="check">
            <input type="radio" checked={voice.tts === 'windows'} onChange={() => void patch({ tts: 'windows' })} />
            {t('voice.tts.windows')}
          </label>
          <label className="check">
            <input type="radio" checked={voice.tts === 'elevenlabs'} onChange={() => void patch({ tts: 'elevenlabs' })} />
            {t('voice.tts.elevenlabs')}
          </label>
        </div>

        {voice.tts === 'kokoro' && (
          <select value={voice.kokoroVoice} onChange={(e) => void patch({ kokoroVoice: e.target.value })}>
            {kokoroVoices(language, voice.kokoroVoice).map((v) => (
              <option key={v.id} value={v.id}>
                {t(v.label)}
              </option>
            ))}
          </select>
        )}

        {voice.tts === 'windows' && (
          <select value={voice.windowsVoice} onChange={(e) => void patch({ windowsVoice: e.target.value })}>
            <option value="">{t('voice.windowsFirst')}</option>
            {systemVoices.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
        )}

        {voice.tts === 'elevenlabs' && (
          <>
            <div className="row">
              <input
                type="password"
                className="grow"
                placeholder={settings.providers.elevenlabs.hasKey ? t('voice.eleven.keySaved') : t('voice.eleven.keyPlaceholder')}
                value={elevenKey}
                onChange={(e) => setElevenKey(e.target.value)}
              />
              <button
                className="ghost"
                disabled={!elevenKey.trim()}
                onClick={async () => {
                  onSettingsReplaced(await window.desktop.settings.setApiKey('elevenlabs', elevenKey.trim()))
                  setElevenKey('')
                }}
              >
                {t('voice.eleven.saveKey')}
              </button>
              <button
                className="ghost"
                disabled={!!busy || !(settings.providers.elevenlabs.hasKey || settings.providers.elevenlabs.fromEnv)}
                onClick={() => void run('voices', async () => setElevenVoices(await request({ method: 'voice.elevenVoices' })))}
              >
                {busy === 'voices' ? t('voice.eleven.loading') : t('voice.eleven.list')}
              </button>
            </div>
            <select value={voice.elevenModel} onChange={(e) => void patch({ elevenModel: e.target.value as VoiceSettings['elevenModel'] })}>
              <option value="eleven_multilingual_v2">{t('voice.eleven.multilingual')}</option>
              <option value="eleven_flash_v2_5">{t('voice.eleven.flash')}</option>
            </select>
            {elevenVoices.length > 0 && (
              <div className="voice-list">
                {elevenVoices.map((v) => (
                  <div key={v.id} className={`voice-row${voice.elevenVoiceId === v.id ? ' active' : ''}`}>
                    <button className="icon-button" title={t('voice.eleven.play')} onClick={() => void new Audio(v.preview).play()}>
                      <Icon icon={Play} size={14} />
                    </button>
                    <div className="grow">
                      <strong>{v.name}</strong>
                      <div className="muted small">{v.labels}</div>
                    </div>
                    <button className={voice.elevenVoiceId === v.id ? 'primary small' : 'ghost small'} onClick={() => void patch({ elevenVoiceId: v.id })}>
                      {voice.elevenVoiceId === v.id ? t('voice.eleven.chosen') : t('voice.eleven.choose')}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {!voice.elevenVoiceId && <p className="muted small">{t('voice.eleven.pickOne')}</p>}
          </>
        )}

        <button className="ghost" disabled={!!busy} onClick={() => void run('say', () => request({ method: 'voice.say', text: t('voice.testSentence') }))}>
          {busy === 'say' ? t('voice.speaking') : t('voice.testVoice')}
        </button>
      </div>

      {message && <p className="small">{message}</p>}
    </>
  )
}

function InstagramTab({ settings, onChange }: Props): React.JSX.Element {
  const t = useT()
  const [status, setStatus] = useState<InstagramStatus | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void window.desktop.instagram.status().then(setStatus)
  }, [])
  const run = async (action: () => Promise<InstagramStatus>): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await action())
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="card">
        <div className="row space">
          <h3>{t('instagram.title')}</h3>
          <span className={`badge ${status?.connected ? 'ok' : 'warn'}`}>{status ? (status.connected ? t('instagram.connected') : t('instagram.disconnected')) : '…'}</span>
        </div>
        <p className="muted small">
          {t('instagram.about')}
        </p>
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void run(() => window.desktop.instagram.connect())}>
            {status?.connected ? t('instagram.check') : t('instagram.connect')}
          </button>
          {status?.connected && (
            <button className="ghost" disabled={busy} onClick={() => void run(() => window.desktop.instagram.disconnect())}>
              {t('instagram.disconnect')}
            </button>
          )}
        </div>
      </div>
      <div className="card">
        <h3>{t('instagram.testMode')}</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.instagram.testMode}
            onChange={(e) => void onChange({ instagram: { testMode: e.target.checked } })}
          />
          {t('instagram.testModeLabel')}
        </label>
        <p className="muted small">
          {t('instagram.testModeNote')}
        </p>
      </div>
      <div className="card">
        <h3>{t('instagram.beforeTitle')}</h3>
        <p className="muted small">
          {t('instagram.beforeNote')}
        </p>
      </div>
    </>
  )
}
