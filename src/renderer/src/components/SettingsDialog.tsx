import { useEffect, useMemo, useState } from 'react'
import { BUILTIN_TOOLS, CLAUDE_MODELS, emailServersFor, looksLikeApiKey, PROVIDER_NAMES, READ_ONLY_TOOLS } from '../../../shared/defaults'
import { importMcpJson } from '../../../shared/mcp-import'
import type {
  AgentProfile,
  Effort,
  ImageProviderId,
  InstagramStatus,
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
import { recordFor } from '../voice/audio'
import { request } from '../lib/coordinator'
import { APPROVAL_MODES, toolLabel } from '../lib/format'
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
const TABS: { id: Tab; label: string }[] = [
  { id: 'providers', label: 'Proveedores' },
  { id: 'agents', label: 'Agentes' },
  { id: 'teams', label: 'Equipos' },
  { id: 'approvals', label: 'Aprobaciones' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'email', label: 'Mail' },
  { id: 'voice', label: 'Voz' },
  { id: 'images', label: 'Imágenes' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'home', label: 'Casa' },
  { id: 'mcp', label: 'Conectores MCP' },
  { id: 'general', label: 'General' },
  { id: 'ambience', label: 'Sonido y ambiente' }
]
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export function SettingsDialog(props: Props): React.JSX.Element {
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
      <div className="modal" role="dialog" aria-label="Configuración">
        <header className="modal-header">
          <h2>Configuración</h2>
          <button className="icon-button" onClick={props.onClose} title="Cerrar">
            <Icon icon={X} size="sm" />
          </button>
        </header>
        <div className="modal-body">
          <nav className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
                {t.label}
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

const PROVIDER_INFO: Record<ModelProviderId, { name: string; envVar: string; source: ModelSource }> = {
  anthropic: { name: 'Anthropic (Claude)', envVar: 'ANTHROPIC_API_KEY', source: 'anthropic' },
  xai: { name: 'xAI (Grok) · texto e imágenes', envVar: 'XAI_API_KEY', source: 'xai' },
  deepseek: { name: 'DeepSeek · solo texto', envVar: 'DEEPSEEK_API_KEY', source: 'deepseek' },
  vercel: { name: 'Vercel AI Gateway · solo texto', envVar: 'AI_GATEWAY_API_KEY', source: 'vercel' },
  meta: { name: 'Meta (Muse) · texto, imágenes y transcripción', envVar: 'META_API_KEY', source: 'meta' },
  openai: { name: 'OpenAI · solo imágenes', envVar: 'OPENAI_API_KEY', source: 'image-openai' }
}

function ProviderCard({ provider, settings, onSettingsReplaced }: { provider: ModelProviderId } & Props): React.JSX.Element {
  const info = settings.providers[provider]
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(settings.providers.xai.baseUrl)
  const { name, envVar, source } = PROVIDER_INFO[provider]
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
          {info.hasKey ? 'Key guardada' : info.fromEnv ? `Usa ${envVar}` : 'Sin configurar'}
        </span>
      </div>
      <div className="row">
        <input
          type="password"
          placeholder={info.hasKey ? '•••••••• (escribí una nueva para reemplazarla)' : 'Pegá tu API key'}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="grow"
        />
        <button className="primary" disabled={!key.trim()} onClick={() => void saveKey(key)}>
          Guardar
        </button>
        {info.hasKey && (
          <button className="ghost" onClick={() => void saveKey('')}>
            Borrar
          </button>
        )}
      </div>
      {provider === 'xai' && (
        <label className="field">
          <span>URL base</span>
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
              Guardar URL
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
          {loading ? 'Probando…' : 'Probar conexión'}
        </button>
        {tested && !loading && (error ? <span className="text-danger small">{error}</span> : <span className="text-ok small">Conectado · {models.length} modelos disponibles</span>)}
      </div>
      {provider === 'vercel' && (
        <p className="muted small">
          Para crear la key: <code>npx vercel@latest ai-gateway setup</code> en una terminal, o desde el panel de AI Gateway en vercel.com.
        </p>
      )}
      <p className="muted small">La key se guarda cifrada con el almacén seguro del sistema y nunca vuelve a la interfaz.</p>
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

function newAgent(): AgentProfile {
  return {
    id: `agente-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Nuevo agente',
    description: 'Describí cuándo conviene usar este agente.',
    systemPrompt: 'Sos un agente que ayuda al usuario.',
    provider: 'anthropic',
    model: CLAUDE_MODELS[0],
    effort: 'medium',
    tools: ['read_file', 'list_dir', 'search_files'],
    allowMcp: false,
    canDelegate: false
  }
}

function AgentsTab({ settings, onChange }: Props): React.JSX.Element {
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

  if (!draft) return <p>No hay agentes.</p>
  return (
    <div className="split">
      <div className="split-list">
        {settings.agents.filter((a) => !a.companyId).map((agent) => (
          <button key={agent.id} className={agent.id === selected?.id ? 'active' : ''} onClick={() => setSelectedId(agent.id)}>
            <span className="ellipsis">{agent.name}</span>
            <span className="muted small">
              {PROVIDER_NAMES[agent.provider]}
              {agent.id === settings.defaultAgentId ? ' · por defecto' : ''}
            </span>
          </button>
        ))}
        <button
          className="ghost"
          onClick={() => {
            const agent = newAgent()
            void saveAgents([...settings.agents, agent]).then(() => setSelectedId(agent.id))
          }}
        >
          + Nuevo agente
        </button>
      </div>

      <div className="split-detail">
        <label className="field">
          <span>Nombre</span>
          <input value={draft.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label className="field">
          <span>Descripción (los demás agentes la leen para decidir cuándo delegarle)</span>
          <input value={draft.description} onChange={(e) => set('description', e.target.value)} />
        </label>
        <div className="row">
          <label className="field">
            <span>Proveedor</span>
            <select
              value={draft.provider}
              onChange={(e) => {
                const provider = e.target.value as ProviderId
                setDraft({ ...draft, provider, model: provider === 'anthropic' ? CLAUDE_MODELS[0] : '' })
              }}
            >
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="xai">xAI (Grok)</option>
              <option value="deepseek">DeepSeek</option>
              <option value="vercel">Vercel AI Gateway</option>
              <option value="meta">Meta (Muse)</option>
            </select>
          </label>
          <label className="field grow">
            <span>Modelo {draft.provider === 'xai' ? '(vacío = el Grok más nuevo disponible)' : draft.provider === 'deepseek' ? '(vacío = deepseek-v4-pro)' : draft.provider === 'vercel' ? '(formato lab/modelo; vacío = Claude Sonnet)' : draft.provider === 'meta' ? '(vacío = muse-spark-1.3)' : ''}</span>
            <div className="row">
              <input list={`models-${draft.provider}`} value={draft.model} onChange={(e) => set('model', e.target.value)} className="grow" />
              <button className="ghost small" onClick={models.load} disabled={models.loading} title="Traer la lista de modelos de la API">
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
            <span>Esfuerzo</span>
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
          <legend>Herramientas</legend>
          <div className="checks">
            {BUILTIN_TOOLS.map((tool) => (
              <label key={tool} className="check">
                <input
                  type="checkbox"
                  checked={draft.tools.includes(tool)}
                  onChange={(e) => set('tools', e.target.checked ? [...draft.tools, tool] : draft.tools.filter((t) => t !== tool))}
                />
                {toolLabel(tool)}
              </label>
            ))}
            <label className="check">
              <input type="checkbox" checked={draft.allowMcp} onChange={(e) => set('allowMcp', e.target.checked)} />
              Conectores MCP
            </label>
            <label className="check">
              <input type="checkbox" checked={draft.canDelegate} onChange={(e) => set('canDelegate', e.target.checked)} />
              Puede delegar en otros agentes
            </label>
          </div>
        </fieldset>
        <fieldset className="field">
          <legend>Sin pedir aprobación (para este agente). Publicar en Instagram siempre pide aprobación.</legend>
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
                  {toolLabel(tool)}
                </label>
              ))}
          </div>
        </fieldset>
        <label className="field">
          <span>Instrucciones (prompt de sistema)</span>
          <textarea rows={8} value={draft.systemPrompt} onChange={(e) => set('systemPrompt', e.target.value)} />
        </label>
        <div className="row">
          <button
            className="primary"
            disabled={!dirty}
            onClick={() => void saveAgents(settings.agents.map((a) => (a.id === draft.id ? draft : a)))}
          >
            Guardar cambios
          </button>
          <button className="ghost" disabled={!dirty} onClick={() => setDraft(selected)}>
            Descartar
          </button>
          <span className="grow" />
          {draft.id !== settings.defaultAgentId && (
            <button className="ghost" onClick={() => void onChange({ defaultAgentId: draft.id })}>
              Usar por defecto
            </button>
          )}
          <button
            className="danger"
            disabled={settings.agents.length <= 1 || draft.id === settings.defaultAgentId}
            title={draft.id === settings.defaultAgentId ? 'Elegí otro agente por defecto antes de borrar este' : undefined}
            onClick={() => {
              if (confirm(`¿Borrar el agente «${draft.name}»?`)) {
                void saveAgents(settings.agents.filter((a) => a.id !== draft.id)).then(() => setSelectedId(settings.agents[0].id))
              }
            }}
          >
            Borrar
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function ApprovalsTab({ settings, onChange }: Props): React.JSX.Element {
  const [review, setReview] = useState(settings.autoReview)
  const dirty = JSON.stringify(review) !== JSON.stringify(settings.autoReview)
  return (
    <>
      <div className="card">
        <h3>Modo de aprobación</h3>
        <p className="muted small">Las lecturas (leer, listar, buscar) nunca piden aprobación.</p>
        {APPROVAL_MODES.map((mode) => (
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
        <h3>Auto-review</h3>
        <div className="row">
          <label className="field">
            <span>Proveedor del revisor</span>
            <select value={review.provider} onChange={(e) => setReview({ ...review, provider: e.target.value as ProviderId, model: e.target.value === 'anthropic' ? CLAUDE_MODELS[0] : '' })}>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="xai">xAI (Grok)</option>
              <option value="deepseek">DeepSeek</option>
              <option value="vercel">Vercel AI Gateway</option>
            </select>
          </label>
          <label className="field grow">
            <span>Modelo</span>
            <input list="review-models" value={review.model} placeholder={review.provider === 'xai' ? 'vacío = el Grok más nuevo' : review.provider === 'deepseek' ? 'vacío = deepseek-v4-pro' : review.provider === 'vercel' ? 'lab/modelo; vacío = Claude Sonnet' : ''} onChange={(e) => setReview({ ...review, model: e.target.value })} />
            <datalist id="review-models">
              {(review.provider === 'anthropic' ? CLAUDE_MODELS : []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
        </div>
        <label className="field">
          <span>Instrucciones: qué debe marcar como peligroso</span>
          <textarea rows={7} value={review.instructions} onChange={(e) => setReview({ ...review, instructions: e.target.value })} />
        </label>
        <button className="primary" disabled={!dirty} onClick={() => void onChange({ autoReview: review })}>
          Guardar auto-review
        </button>
      </div>

      <div className="card">
        <h3>Siempre permitir</h3>
        {settings.alwaysAllowTools.length === 0 ? (
          <p className="muted small">Ninguna. Aparecen acá cuando elegís «Siempre permitir» en una aprobación.</p>
        ) : (
          <ul className="plain-list">
            {settings.alwaysAllowTools.map((tool) => (
              <li key={tool} className="row space">
                <span>{toolLabel(tool)}</span>
                <button className="ghost small" onClick={() => void onChange({ alwaysAllowTools: settings.alwaysAllowTools.filter((t) => t !== tool) })}>
                  Quitar
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
          <h3>Servidores</h3>
          <button className="ghost small" onClick={() => void request({ method: 'mcp.reconnect' })}>
            <Icon icon={RefreshCw} size="sm" /> Reconectar
          </button>
        </div>
        {servers.length === 0 && <p className="muted small">No hay conectores. Agregá uno o importá tu mcp.json.</p>}
        {!settings.mcpServers[CHROME_MCP] && (
          <div className="row space">
            <p className="muted small">
              <strong>Chrome DevTools</strong>: el agente abre un Chrome propio y navega, hace clic, completa formularios y saca capturas. Las
              sesiones que inicies en esa ventana quedan guardadas. Necesita Google Chrome instalado.
            </p>
            <button
              className="ghost small"
              onClick={() =>
                void save({ ...settings.mcpServers, [CHROME_MCP]: { type: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.11.0'], enabled: true } })
              }
            >
              Agregar Chrome
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
                    {status?.state === 'connected' ? `${status.tools.length} herramientas` : status?.state ?? 'desconocido'}
                  </span>
                  <div className="muted small mono ellipsis">
                    {config.type === 'stdio' ? `${config.command} ${(config.args ?? []).join(' ')}` : config.url}
                  </div>
                </div>
                <div className="row">
                  <label className="check">
                    <input type="checkbox" checked={config.enabled} onChange={(e) => void save({ ...settings.mcpServers, [name]: { ...config, enabled: e.target.checked } })} />
                    Activo
                  </label>
                  <button
                    className="danger small"
                    onClick={() => {
                      const { [name]: _removed, ...rest } = settings.mcpServers
                      void save(rest)
                    }}
                  >
                    Quitar
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
          <h3>Nuevo servidor</h3>
          <div className="row">
            <label className="field grow">
              <span>Nombre</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="github" />
            </label>
            <label className="field">
              <span>Tipo</span>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as 'stdio' | 'http' })}>
                <option value="stdio">Comando local (stdio)</option>
                <option value="http">Remoto (HTTPS)</option>
              </select>
            </label>
          </div>
          {form.type === 'stdio' ? (
            <>
              <label className="field">
                <span>Comando</span>
                <input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="npx" />
              </label>
              <label className="field">
                <span>Argumentos (uno por línea)</span>
                <textarea rows={3} value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\proyectos'} />
              </label>
              <label className="field">
                <span>Variables de entorno (CLAVE=valor, una por línea)</span>
                <textarea rows={2} value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} />
              </label>
            </>
          ) : (
            <>
              <label className="field">
                <span>URL</span>
                <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://ejemplo.com/mcp" />
              </label>
              <label className="field">
                <span>Headers (Nombre: valor, uno por línea)</span>
                <textarea rows={2} value={form.headers} onChange={(e) => setForm({ ...form, headers: e.target.value })} />
              </label>
            </>
          )}
          <label className="field">
            <span>Herramientas permitidas (separadas por coma o línea; vacío = todas)</span>
            <textarea rows={2} className="mono" value={form.tools} onChange={(e) => setForm({ ...form, tools: e.target.value })} placeholder="analyze_javascript_application, inspect_artifact" />
          </label>
          <div className="row">
            <button className="primary" onClick={addServer} disabled={!form.name.trim() || (form.type === 'stdio' ? !form.command.trim() : !form.url.trim())}>
              Agregar
            </button>
            <button className="ghost" onClick={() => setAdding(false)}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <button className="ghost" onClick={() => setAdding(true)}>
          + Agregar servidor
        </button>
      )}

      <div className="card">
        <h3>Importar mcp.json</h3>
        <p className="muted small">Compatible con el formato de Claude Desktop y Cursor ({'{ "mcpServers": { … } }'}).</p>
        <textarea rows={5} className="mono" value={json} onChange={(e) => setJson(e.target.value)} />
        {jsonError && <div className="text-danger small">{jsonError}</div>}
        <button
          className="ghost"
          disabled={!json.trim()}
          onClick={() => {
            try {
              const imported = importMcpJson(json)
              if (Object.keys(imported).length === 0) throw new Error('No se encontró ningún servidor.')
              void save({ ...settings.mcpServers, ...imported })
              setJson('')
              setJsonError('')
            } catch (error) {
              setJsonError((error as Error).message)
            }
          }}
        >
          Importar
        </button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------

function GeneralTab({ settings, onChange }: Props): React.JSX.Element {
  return (
    <>
      <div className="card">
        <h3>Carpeta de trabajo por defecto</h3>
        <p className="muted small">
          Las conversaciones nuevas empiezan en esta carpeta. Los agentes no pueden leer ni escribir fuera de la carpeta de la conversación.
        </p>
        <div className="row">
          <input readOnly value={settings.defaultWorkspace || '(ninguna)'} className="grow" />
          <button
            className="ghost"
            onClick={async () => {
              const folder = await window.desktop.pickFolder()
              if (folder) await onChange({ defaultWorkspace: folder })
            }}
          >
            Elegir…
          </button>
        </div>
      </div>
      <div className="card">
        <h3>Segundo plano</h3>
        <p className="muted small">Las rutinas solo se ejecutan mientras la app está abierta o en la bandeja del sistema.</p>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.background.runInTray}
            onChange={(e) => void onChange({ background: { ...settings.background, runInTray: e.target.checked } })}
          />
          Al cerrar la ventana, seguir en la bandeja del sistema
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.background.launchAtLogin}
            onChange={(e) => void onChange({ background: { ...settings.background, launchAtLogin: e.target.checked } })}
          />
          Abrir al iniciar Windows (minimizada)
        </label>
      </div>
      <PrivacyCard settings={settings} onChange={onChange} />
    </>
  )
}

/** Retention, a copy of what Alma keeps about the person, and erasing it. */
function PrivacyCard({ settings, onChange }: Pick<Props, 'settings' | 'onChange'>): React.JSX.Element {
  const [note, setNote] = useState('')
  const run = (job: () => Promise<string>): void => void job().then(setNote).catch((e: Error) => setNote(e.message))
  return (
    <div className="card">
      <h3>Privacidad</h3>
      <p className="muted small">
        Las conversaciones, los archivos que recibís y la huella de tu voz viven solo en esta computadora. Lo que le escribís a un agente viaja al proveedor de modelos que ese agente use.
      </p>
      <label className="field">
        <span>Borrar conversaciones sin actividad</span>
        <select value={settings.privacy.threadRetentionDays} onChange={(e) => void onChange({ privacy: { threadRetentionDays: Number(e.target.value) } })}>
          <option value={0}>Nunca (las guardo yo)</option>
          <option value={30}>A los 30 días</option>
          <option value={90}>A los 90 días</option>
          <option value={180}>A los 180 días</option>
          <option value={365}>Al año</option>
        </select>
      </label>
      <div className="row">
        <button
          className="ghost"
          onClick={() =>
            run(async () => {
              const folder = await window.desktop.pickFolder()
              return folder ? `Copia guardada en ${await request({ method: 'privacy.export', targetDir: folder })}` : ''
            })
          }
        >
          Exportar mis datos…
        </button>
        <button
          className="danger"
          onClick={() => {
            if (confirm('¿Borrar TODAS las conversaciones, los archivos recibidos y la huella de tu voz? No se puede deshacer. Tu vault, tus claves y tus canales no se tocan.')) {
              run(async () => {
                await request({ method: 'privacy.erase' })
                // ponytail: the conversation list lives in App state; reloading the window is the cheap way to empty it.
                setTimeout(() => location.reload(), 1200)
                return 'Listo: conversaciones, archivos recibidos y huella de voz borrados.'
              })
            }
          }}
        >
          Borrar mi historial
        </button>
      </div>
      {note && <p className="muted small">{note}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------

function ImagesTab({ settings, onChange }: Props): React.JSX.Element {
  const [model, setModel] = useState(settings.images.model)
  const source: ModelSource = `image-${settings.images.provider}`
  const models = useModels(source)
  const hasKey = (provider: ImageProviderId): boolean => settings.providers[provider].hasKey || settings.providers[provider].fromEnv
  const isKey = looksLikeApiKey(model)
  return (
    <div className="card">
      <h3>Generación de imágenes</h3>
      <p className="muted small">
        La usa la herramienta «Generar imagen». Claude no genera imágenes, y DeepSeek tampoco lo ofrece por API, así que se usa xAI, OpenAI o Meta (Muse Image, USD 0,01 por imagen).
      </p>
      <div className="row">
        <label className="field">
          <span>Servicio</span>
          <select
            value={settings.images.provider}
            onChange={(e) => {
              setModel('')
              void onChange({ images: { provider: e.target.value as ImageProviderId, model: '' } })
            }}
          >
            <option value="xai">xAI (Grok){hasKey('xai') ? '' : ' · falta la key'}</option>
            <option value="openai">OpenAI{hasKey('openai') ? '' : ' · falta la key'}</option>
            <option value="meta">Meta (Muse Image){hasKey('meta') ? '' : ' · falta la key'}</option>
          </select>
        </label>
        <label className="field grow">
          <span>Modelo (vacío = el más nuevo disponible)</span>
          <div className="row">
            <input list="image-models" value={model} onChange={(e) => setModel(e.target.value)} className="grow" />
            <button className="ghost small" onClick={models.load} disabled={models.loading} title="Traer la lista de modelos de imagen">
              <Icon icon={RefreshCw} size="sm" />
            </button>
            <button
              className="primary small"
              disabled={model === settings.images.model || isKey}
              onClick={() => void onChange({ images: { ...settings.images, model: model.trim() } })}
            >
              Guardar
            </button>
          </div>
          {isKey && (
            <span className="text-danger small">Eso es una API key, no un modelo. Las keys van en la pestaña Proveedores.</span>
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

const WHATSAPP_STATE: Record<WhatsAppStatus['state'], { text: string; badge: string }> = {
  off: { text: 'Apagado', badge: '' },
  connecting: { text: 'Conectando…', badge: 'warn' },
  qr: { text: 'Esperando el QR', badge: 'warn' },
  online: { text: 'Conectado', badge: 'ok' },
  error: { text: 'Error', badge: 'danger' }
}

function WhatsAppTab({ settings, onChange, whatsapp }: Props): React.JSX.Element {
  const config = settings.whatsapp
  const patch = (next: Partial<WhatsAppSettings>): Promise<void> => onChange({ whatsapp: { ...config, ...next } })
  const state = WHATSAPP_STATE[whatsapp.state]
  return (
    <>
      <div className="card">
        <div className="row space">
          <h3>WhatsApp</h3>
          <span className={`badge ${state.badge}`}>
            {state.text}
            {whatsapp.number ? ` · +${whatsapp.number}` : ''}
          </span>
        </div>
        <p className="muted small">
          Alma se vincula a tu número como un dispositivo más (igual que WhatsApp Web). Le hablás desde tu chat <strong>«Mensajes para mí»</strong>{' '}
          y te contesta ahí (sus mensajes empiezan con 🤖). Puede escribirle a tus contactos solo si se lo pedís, y cada envío lo aprobás vos.
        </p>
        <p className="small text-danger">
          No es la API oficial de WhatsApp: si WhatsApp detecta un uso raro (muchos mensajes, a desconocidos) puede bloquear el número. Alma
          nunca escribe por su cuenta.
        </p>
        <label className="check">
          <input type="checkbox" checked={config.enabled} onChange={(e) => void patch({ enabled: e.target.checked })} />
          Activar WhatsApp
        </label>
        {whatsapp.state === 'error' && <p className="text-danger small">{whatsapp.error}</p>}
        {whatsapp.state === 'qr' && whatsapp.qr && (
          <div className="row">
            <img src={whatsapp.qr} alt="Código QR para vincular WhatsApp" width={240} height={240} style={{ background: '#fff', borderRadius: 8 }} />
            <p className="small">
              En el celular: WhatsApp → <strong>Dispositivos vinculados</strong> → <strong>Vincular un dispositivo</strong>, y escaneá este código.
            </p>
          </div>
        )}
        {whatsapp.state === 'online' && (
          <button className="ghost small" onClick={() => void request({ method: 'whatsapp.logout' })}>
            Desvincular este dispositivo
          </button>
        )}
      </div>

      <div className="card">
        <h3>Agente que responde</h3>
        <p className="muted small">
          Tus mensajes de «Mensajes para mí» llegan a una conversación de Alma con el ícono de WhatsApp. Escribí /nuevo para empezar otra. Si
          hace falta tu permiso, te lo pregunta ahí y contestás «sí» o «no».
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
        <h3>Tu casilla</h3>
        <p className="muted small">
          Con esto los agentes pueden buscar y leer tus mails, y mandar mails en tu nombre (cada envío lo aprobás vos). Funciona con Gmail,
          Outlook, Yahoo, iCloud o el mail de tu dominio.
        </p>
        <label className="field">
          <span>Dirección</span>
          <input
            type="email"
            placeholder="vos@gmail.com"
            value={config.address}
            onChange={(e) => void patch({ address: e.target.value.trim() })}
            onBlur={() => !config.imapHost && config.address.includes('@') && void patch(emailServersFor(config.address))}
          />
        </label>
        <label className="field">
          <span>Contraseña de aplicación</span>
          <div className="row">
            <input
              type="password"
              className="grow"
              placeholder={hasPassword ? 'Guardada (pegá otra para reemplazarla)' : 'xxxx xxxx xxxx xxxx'}
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
              Guardar
            </button>
            {hasPassword && (
              <button className="ghost" onClick={async () => onSettingsReplaced(await window.desktop.settings.setApiKey('email', ''))}>
                Borrar
              </button>
            )}
          </div>
        </label>
        {gmail && (
          <p className="small">
            En Gmail: activá la verificación en 2 pasos y creá una contraseña en{' '}
            <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
              myaccount.google.com/apppasswords
            </a>
            . No uses tu contraseña normal.
          </p>
        )}
      </div>

      <div className="card">
        <h3>Servidores</h3>
        <div className="row">
          <label className="field grow">
            <span>IMAP (leer)</span>
            <input value={config.imapHost} placeholder="imap.gmail.com" onChange={(e) => void patch({ imapHost: e.target.value.trim() })} />
          </label>
          <label className="field">
            <span>Puerto</span>
            <input type="number" value={config.imapPort} onChange={(e) => void patch({ imapPort: Number(e.target.value) || 993 })} />
          </label>
        </div>
        <div className="row">
          <label className="field grow">
            <span>SMTP (mandar)</span>
            <input value={config.smtpHost} placeholder="smtp.gmail.com" onChange={(e) => void patch({ smtpHost: e.target.value.trim() })} />
          </label>
          <label className="field">
            <span>Puerto</span>
            <input type="number" value={config.smtpPort} onChange={(e) => void patch({ smtpPort: Number(e.target.value) || 465 })} />
          </label>
        </div>
        <div className="row">
          <button className="ghost small" onClick={() => void patch(emailServersFor(config.address))} disabled={!config.address.includes('@')}>
            Completar según la dirección
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
            {testing ? 'Probando…' : 'Probar conexión'}
          </button>
        </div>
        {test && <p className={`small ${test.ok ? '' : 'text-danger'}`}>{test.text}</p>}
      </div>
    </>
  )
}

const TELEGRAM_STATE: Record<TelegramStatus['state'], { text: string; badge: string }> = {
  off: { text: 'Apagado', badge: '' },
  connecting: { text: 'Conectando…', badge: 'warn' },
  online: { text: 'Conectado', badge: 'ok' },
  error: { text: 'Error', badge: 'danger' }
}

function TelegramTab({ settings, onChange, onSettingsReplaced, telegram }: Props): React.JSX.Element {
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
          <h3>Bot de Telegram</h3>
          <span className={`badge ${state.badge}`}>
            {state.text}
            {telegram.username ? ` como @${telegram.username}` : ''}
          </span>
        </div>
        <p className="muted small">
          Hablale a Alma desde el celular. Creá un bot con <strong>@BotFather</strong> en Telegram (comando /newbot) y pegá acá el token
          que te da. El bot corre dentro de Alma: la app tiene que estar abierta o en la bandeja.
        </p>
        {telegram.state === 'error' && <p className="text-danger small">{telegram.error}</p>}
        <div className="row">
          <input
            type="password"
            className="grow"
            placeholder={hasToken ? 'Token guardado (pegá otro para reemplazarlo)' : '123456789:AA…'}
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
            Guardar token
          </button>
          {settings.providers.telegram.hasKey && (
            <button className="ghost" onClick={async () => onSettingsReplaced(await window.desktop.settings.setApiKey('telegram', ''))}>
              Borrar
            </button>
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={config.enabled} onChange={(e) => void patch({ enabled: e.target.checked })} />
          Bot activo
        </label>
        {telegram.username && (
          <p className="small">
            Abrí <a href={`https://t.me/${telegram.username}`} target="_blank" rel="noreferrer">t.me/{telegram.username}</a> en el celular y
            mandale /start.
          </p>
        )}
      </div>

      <div className="card">
        <h3>Quién puede escribirle</h3>
        {config.chatId !== null ? (
          <>
            <p className="small">
              Vinculado a tu chat privado. Solo ese chat puede usar el bot, aunque cambies de nombre de usuario.
            </p>
            <button className="ghost small" onClick={() => void patch({ chatId: null })}>
              Desvincular (el próximo usuario permitido que escriba queda vinculado)
            </button>
          </>
        ) : (
          <p className="muted small">
            El primer usuario de esta lista que le escriba por privado queda vinculado, y desde ahí solo ese chat puede usarlo. Los grupos
            no se aceptan.
          </p>
        )}
        <div className="row wrap">
          {config.allowedUsers.map((name) => (
            <span key={name} className="badge">
              @{name}{' '}
              <button className="icon-button" title="Quitar" onClick={() => void patch({ allowedUsers: config.allowedUsers.filter((u) => u !== name) })}>
                <Icon icon={X} size={12} />
              </button>
            </span>
          ))}
        </div>
        <div className="row">
          <input
            className="grow"
            placeholder="tu_usuario (sin @)"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addUser()}
          />
          <button className="ghost" onClick={addUser} disabled={!user.trim()}>
            Agregar
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Agente que responde</h3>
        <p className="muted small">
          Los mensajes de Telegram llegan a una conversación de Alma (con el ícono de Telegram en la barra lateral). Con /nuevo empezás
          otra. Si el agente necesita aprobación, te llegan botones Permitir / Rechazar en Telegram.
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

const ENROLL_PHRASES = [
  'Hola Alma, hoy quiero organizar mis notas y revisar los pendientes de la semana.',
  'El viernes a la tarde tengo una reunión con el equipo para hablar del proyecto.',
  'Recordame comprar yerba, pan y frutas cuando salga del trabajo.'
]
const ENROLL_MS = 5500

const KOKORO_VOICES = [
  { id: 'ef_dora', label: 'Dora (mujer, la de ALMA)' },
  { id: 'em_alex', label: 'Alex (hombre)' },
  { id: 'em_santa', label: 'Santa (hombre, grave)' }
]

function VoiceTab({ settings, onChange, onSettingsReplaced }: Props): React.JSX.Element {
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
    const loadVoices = (): void => setSystemVoices(speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('es')))
    loadVoices()
    speechSynthesis.addEventListener('voiceschanged', loadVoices)
    void request<{ enrolled: boolean; enrolledAt?: number }>({ method: 'voice.profile' }).then(setProfile)
    return () => speechSynthesis.removeEventListener('voiceschanged', loadVoices)
  }, [])

  const run = async (label: string, work: () => Promise<string | void>): Promise<void> => {
    setBusy(label)
    setMessage('')
    try {
      const result = await work()
      if (result) setMessage(result)
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    } finally {
      setBusy('')
    }
  }

  const enroll = (): Promise<void> =>
    run('enroll', async () => {
      const samples: ArrayBuffer[] = []
      for (let step = 0; step < ENROLL_PHRASES.length; step++) {
        setEnrolling({ step, level: 0 })
        samples.push(await recordFor(ENROLL_MS, voice.micDeviceId, (level) => setEnrolling({ step, level })))
      }
      setEnrolling(null)
      const { consistency } = await request<{ consistency: number }>({ method: 'voice.enroll', samples })
      setProfile(await request({ method: 'voice.profile' }))
      return consistency < 0.75
        ? `Listo, pero las grabaciones salieron poco parecidas entre sí (${Math.round(consistency * 100)}%). Si hubo ruido, volvé a entrenar.`
        : `¡Listo! Aprendí tu voz (consistencia ${Math.round(consistency * 100)}%).`
    }).finally(() => setEnrolling(null))

  const testSpeaker = (): Promise<void> =>
    run('test', async () => {
      setMessage('Hablá unos segundos…')
      const sample = await recordFor(3500, voice.micDeviceId)
      const score = await request<number>({ method: 'voice.testSpeaker', sample })
      return `Parecido con tu voz: ${Math.round(score * 100)}% (umbral ${Math.round(voice.speakerThreshold * 100)}%) → ${score >= voice.speakerThreshold ? 'te reconocería ✓' : 'no te reconocería'}`
    })

  return (
    <>
      <div className="card">
        <div className="row space">
          <h3>Asistente de voz</h3>
          <button className="switch" role="switch" aria-checked={voice.enabled} aria-label="Asistente de voz" onClick={() => void patch({ enabled: !voice.enabled })}>
            <span className="switch-knob" />
          </button>
        </div>
        <p className="muted small">
          Como en ALMA: Alma escucha la palabra de activación, verifica que seas vos, transcribe lo que decís, se lo pasa al agente y
          responde en voz alta. Todo corre en tu PC (sin Python); los modelos se descargan la primera vez. Las conversaciones de voz
          aparecen en la barra lateral con un micrófono.
        </p>
        <label className="field">
          <span>Agente que responde</span>
          <select value={voice.agentId} onChange={(e) => void patch({ agentId: e.target.value })}>
            {settings.agents.filter((a) => !a.companyId).map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Micrófono</span>
          <select value={voice.micDeviceId} onChange={(e) => void patch({ micDeviceId: e.target.value })}>
            <option value="">El predeterminado de Windows</option>
            {mics.filter((m) => m.deviceId && m.deviceId !== 'default').map((mic) => (
              <option key={mic.deviceId} value={mic.deviceId}>
                {mic.label || 'Micrófono'}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="card">
        <h3>Cómo se activa</h3>
        <div className="row">
          <label className="field grow">
            <span>Palabra de activación</span>
            <select value={voice.wakeWord} onChange={(e) => void patch({ wakeWord: e.target.value as VoiceSettings['wakeWord'] })}>
              <option value="hola_alma">«Hola Alma»</option>
              <option value="off">Ninguna, solo el atajo</option>
            </select>
          </label>
          <label className="field">
            <span>Sensibilidad</span>
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
          <span>Atajo de teclado (funciona desde cualquier programa; también corta a Alma cuando habla)</span>
          <input value={voice.hotkey} placeholder="Control+Alt+Space" onChange={(e) => void patch({ hotkey: e.target.value })} />
        </label>
        <p className="muted small">Una palabra propia («Hola Alma») necesita entrenar un modelo aparte; por ahora usá una de estas.</p>
      </div>

      <div className="card">
        <div className="row space">
          <h3>Tu voz</h3>
          <span className={`badge ${profile.enrolled ? 'ok' : 'warn'}`}>{profile.enrolled ? 'Entrenada' : 'Sin entrenar'}</span>
        </div>
        <p className="muted small">
          Leé tres frases en voz alta para que Alma aprenda tu voz. Con la palabra de activación solo te responde a vos; con el atajo
          responde siempre (estás en la computadora).
        </p>
        {enrolling ? (
          <div className="enroll-step">
            <div className="muted small">Frase {enrolling.step + 1} de {ENROLL_PHRASES.length} — leé en voz alta:</div>
            <blockquote>{ENROLL_PHRASES[enrolling.step]}</blockquote>
            <div className="level-meter">
              <span style={{ width: `${Math.min(100, enrolling.level * 180)}%` }} />
            </div>
          </div>
        ) : (
          <div className="row">
            <button className="primary" disabled={!!busy} onClick={() => void enroll()}>
              {profile.enrolled ? 'Volver a entrenar' : 'Entrenar mi voz'}
            </button>
            <button className="ghost" disabled={!!busy || !profile.enrolled} onClick={() => void testSpeaker()}>
              Probar si me reconoce
            </button>
            {profile.enrolled && (
              <button
                className="ghost"
                disabled={!!busy}
                onClick={() => void request({ method: 'voice.forgetProfile' }).then(() => setProfile({ enrolled: false }))}
              >
                Olvidar mi voz
              </button>
            )}
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={voice.verifySpeaker} onChange={(e) => void patch({ verifySpeaker: e.target.checked })} />
          Solo responder a mi voz
        </label>
        <label className="field">
          <span>Exigencia: {Math.round(voice.speakerThreshold * 100)}%</span>
          <input type="range" min={0.6} max={0.95} step={0.01} value={voice.speakerThreshold} onChange={(e) => void patch({ speakerThreshold: Number(e.target.value) })} />
        </label>
      </div>

      <div className="card">
        <h3>Transcripción</h3>
        <div className="row">
          <label className="check">
            <input type="radio" checked={voice.stt === 'local'} onChange={() => void patch({ stt: 'local' })} />
            En tu PC (Whisper, gratis)
          </label>
          <label className="check">
            <input type="radio" checked={voice.stt === 'openai'} onChange={() => void patch({ stt: 'openai' })} />
            OpenAI (más rápido, usa tu key de OpenAI)
          </label>
          <label className="check">
            <input type="radio" checked={voice.stt === 'meta'} onChange={() => void patch({ stt: 'meta' })} />
            Meta (Muse Voice, USD 0,18 por hora de audio)
          </label>
        </div>
        {voice.stt === 'local' ? (
          <select value={voice.sttModel} onChange={(e) => void patch({ sttModel: e.target.value as VoiceSettings['sttModel'] })}>
            <option value="whisper-base">Whisper base: ~1 s por frase, ~80 MB</option>
            <option value="whisper-small">Whisper small: más preciso, ~2,5 s por frase, ~250 MB</option>
          </select>
        ) : (
          (() => {
            const provider = voice.stt === 'meta' ? settings.providers.meta : settings.providers.openai
            return !provider.hasKey && !provider.fromEnv && <p className="text-warn small">Cargá una API key de {voice.stt === 'meta' ? 'Meta' : 'OpenAI'} en Proveedores.</p>
          })()
        )}
      </div>

      <div className="card">
        <h3>Voz de Alma</h3>
        <div className="row">
          <label className="check">
            <input type="radio" checked={voice.tts === 'kokoro'} onChange={() => void patch({ tts: 'kokoro' })} />
            Kokoro (gratis, natural)
          </label>
          <label className="check">
            <input type="radio" checked={voice.tts === 'windows'} onChange={() => void patch({ tts: 'windows' })} />
            Windows (gratis, instantánea)
          </label>
          <label className="check">
            <input type="radio" checked={voice.tts === 'elevenlabs'} onChange={() => void patch({ tts: 'elevenlabs' })} />
            ElevenLabs (la mejor, con tu key)
          </label>
        </div>

        {voice.tts === 'kokoro' && (
          <select value={voice.kokoroVoice} onChange={(e) => void patch({ kokoroVoice: e.target.value })}>
            {KOKORO_VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        )}

        {voice.tts === 'windows' && (
          <select value={voice.windowsVoice} onChange={(e) => void patch({ windowsVoice: e.target.value })}>
            <option value="">La primera en español</option>
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
                placeholder={settings.providers.elevenlabs.hasKey ? 'Key guardada (pegá otra para reemplazarla)' : 'API key de ElevenLabs'}
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
                Guardar key
              </button>
              <button
                className="ghost"
                disabled={!!busy || !(settings.providers.elevenlabs.hasKey || settings.providers.elevenlabs.fromEnv)}
                onClick={() => void run('voices', async () => setElevenVoices(await request({ method: 'voice.elevenVoices' })))}
              >
                {busy === 'voices' ? 'Cargando…' : 'Ver voces'}
              </button>
            </div>
            <select value={voice.elevenModel} onChange={(e) => void patch({ elevenModel: e.target.value as VoiceSettings['elevenModel'] })}>
              <option value="eleven_multilingual_v2">Multilingual v2 (mejor calidad)</option>
              <option value="eleven_flash_v2_5">Flash v2.5 (más rápida y barata)</option>
            </select>
            {elevenVoices.length > 0 && (
              <div className="voice-list">
                {elevenVoices.map((v) => (
                  <div key={v.id} className={`voice-row${voice.elevenVoiceId === v.id ? ' active' : ''}`}>
                    <button className="icon-button" title="Escuchar muestra" onClick={() => void new Audio(v.preview).play()}>
                      <Icon icon={Play} size={14} />
                    </button>
                    <div className="grow">
                      <strong>{v.name}</strong>
                      <div className="muted small">{v.labels}</div>
                    </div>
                    <button className={voice.elevenVoiceId === v.id ? 'primary small' : 'ghost small'} onClick={() => void patch({ elevenVoiceId: v.id })}>
                      {voice.elevenVoiceId === v.id ? 'Elegida' : 'Elegir'}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {!voice.elevenVoiceId && <p className="muted small">Elegí una voz (si no hay voz o key, Alma usa la de Windows).</p>}
          </>
        )}

        <button className="ghost" disabled={!!busy} onClick={() => void run('say', () => request({ method: 'voice.say', text: 'Hola, soy Alma. ¿En qué te puedo ayudar hoy?' }))}>
          {busy === 'say' ? 'Hablando…' : 'Probar la voz'}
        </button>
      </div>

      {message && <p className="small">{message}</p>}
    </>
  )
}

function InstagramTab({ settings, onChange }: Props): React.JSX.Element {
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
          <h3>Cuenta de Instagram</h3>
          <span className={`badge ${status?.connected ? 'ok' : 'warn'}`}>{status ? (status.connected ? 'Conectada' : 'Sin conectar') : '…'}</span>
        </div>
        <p className="muted small">
          Se abre Instagram en una ventana de la app y vos iniciás sesión ahí, como en cualquier navegador. La contraseña la escribís en la página de
          Instagram; la app solo guarda la sesión, en este equipo y separada del resto.
        </p>
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void run(() => window.desktop.instagram.connect())}>
            {status?.connected ? 'Abrir Instagram para revisar la sesión' : 'Conectar Instagram'}
          </button>
          {status?.connected && (
            <button className="ghost" disabled={busy} onClick={() => void run(() => window.desktop.instagram.disconnect())}>
              Desconectar
            </button>
          )}
        </div>
      </div>
      <div className="card">
        <h3>Modo de prueba</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.instagram.testMode}
            onChange={(e) => void onChange({ instagram: { testMode: e.target.checked } })}
          />
          Completar el post pero no tocar «Compartir»
        </label>
        <p className="muted small">
          Dejalo activado las primeras veces: el agente sube la imagen y escribe el texto en una ventana de Instagram, y vos verificás que todo
          quedó bien. Cuando lo desactives, después de tu aprobación el agente toca «Compartir» solo.
        </p>
      </div>
      <div className="card">
        <h3>Antes de automatizar</h3>
        <p className="muted small">
          Instagram no permite automatizar acciones sin su autorización. Si detecta publicaciones automatizadas puede bloquear acciones
          temporalmente o, si se repite, suspender la cuenta. Publicá poco (1 o 2 posts por día). Si Instagram cambia su página, la publicación
          automática puede fallar: en ese caso la ventana queda abierta para que termines a mano.
        </p>
      </div>
    </>
  )
}
