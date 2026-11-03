import { useCallback, useEffect, useReducer, useState } from 'react'
import type { KnowledgeStatus, McpServerStatus, PendingApproval, PublicSettings, RoutineState, TelegramStatus, WhatsAppStatus, Thread, ThreadSummary, VoiceStatus } from '../../shared/types'
import { VoiceLayer } from './voice/VoiceLayer'
import { AlarmClock, MessageSquarePlus, X } from 'lucide-react'
import { Backdrop } from './umbra/Backdrop'
import { Icon } from './umbra/Icon'
import { playUISound } from './umbra/useUISound'
import { ChatView } from './components/ChatView'
import { RoutinesDialog } from './components/RoutinesDialog'
import { SettingsDialog, type Tab as SettingsTab } from './components/SettingsDialog'
import { CompaniesView } from './companies/CompaniesView'
import { HomeSidebar, HomeView } from './home/HomeView'
import { useHome } from './home/useHome'
import { Sidebar, type AppMode } from './components/Sidebar'
import { fileAttachment, type Attachment } from './lib/attachments'
import { onConnected, onEvent, request } from './lib/coordinator'
import { initialState, reducer } from './lib/state'
import { VaultWelcome } from './vault/panels'
import { useVault } from './vault/useVault'
import { onOpenNote } from './vault/vaultLib'
import { VaultSidebar } from './vault/VaultSidebar'
import { VaultView, type VaultPanel } from './vault/VaultView'

const MODE_KEY = 'alma.mode'
const COMPANY_KEY = 'alma.company'
const VAULT_CHAT_KEY = 'alma.vault.chat'

function savedMode(): AppMode {
  try {
    const mode = localStorage.getItem(MODE_KEY)
    return mode === 'vault' || mode === 'companies' || mode === 'home' ? mode : 'chat'
  } catch {
    return 'chat'
  }
}

export function App(): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState)
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>()
  const [companyId, setCompanyIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(COMPANY_KEY)
    } catch {
      return null
    }
  })
  const setCompanyId = useCallback((id: string | null) => {
    setCompanyIdState(id)
    try {
      if (id) localStorage.setItem(COMPANY_KEY, id)
    } catch {
      // The last company is a convenience.
    }
  }, [])
  /** A note to open once the vault it lives in becomes the active one (minutes of a company meeting). */
  const [pendingNote, setPendingNote] = useState<string | null>(null)
  const [routinesOpen, setRoutinesOpen] = useState(false)
  const [mode, setModeState] = useState<AppMode>(savedMode)
  const home = useHome(!!settings?.home.enabled)
  const [homeAdding, setHomeAdding] = useState(false)
  const [vaultPanel, setVaultPanel] = useState<VaultPanel>('none')
  const vault = useVault(settings?.activeVault ?? '', state.vaultVersion)
  const [vaultChat, setVaultChatState] = useState(() => {
    try {
      return localStorage.getItem(VAULT_CHAT_KEY) === '1'
    } catch {
      return false
    }
  })
  const setVaultChat = useCallback((open: boolean) => {
    setVaultChatState(open)
    try {
      localStorage.setItem(VAULT_CHAT_KEY, open ? '1' : '0')
    } catch {
      // A convenience, like the last view.
    }
  }, [])
  /** What "Preguntarle a Alma" collected for the next message. */
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const attach = useCallback(
    (attachment: Attachment) => {
      setAttachments((list) => [...list.filter((a) => a.body !== attachment.body), attachment])
      setVaultChat(true)
    },
    [setVaultChat]
  )

  const setMode = useCallback((next: AppMode) => {
    setModeState(next)
    try {
      localStorage.setItem(MODE_KEY, next)
    } catch {
      // The last view is a convenience.
    }
  }, [])

  const refreshSettings = useCallback(() => {
    void window.desktop.settings.get().then(setSettings)
  }, [])

  const openThread = useCallback(async (threadId: string | null) => {
    dispatch({ type: 'open', thread: threadId ? await request<Thread>({ method: 'threads.get', threadId }) : null })
  }, [])

  // Load everything from the coordinator, and again whenever it (re)connects.
  const syncAll = useCallback(async () => {
    const [threads, running, approvals, mcp, routines, knowledge, telegram, voiceStatus, whatsapp] = await Promise.all([
      request<ThreadSummary[]>({ method: 'threads.list' }),
      request<string[]>({ method: 'runs.active' }),
      request<PendingApproval[]>({ method: 'approval.pending' }),
      request<McpServerStatus[]>({ method: 'mcp.status' }),
      request<Record<string, RoutineState>>({ method: 'routines.state' }),
      request<KnowledgeStatus | null>({ method: 'knowledge.status' }),
      request<TelegramStatus>({ method: 'telegram.status' }),
      request<VoiceStatus>({ method: 'voice.status' }),
      request<WhatsAppStatus>({ method: 'whatsapp.status' })
    ])
    dispatch({ type: 'voice', status: voiceStatus })
    dispatch({ type: 'routines', state: routines })
    dispatch({ type: 'knowledge', status: knowledge })
    dispatch({ type: 'telegram', status: telegram })
    dispatch({ type: 'whatsapp', status: whatsapp })
    dispatch({ type: 'threads', threads })
    dispatch({ type: 'running', threadIds: running })
    dispatch({ type: 'approvals', approvals })
    dispatch({ type: 'mcp', servers: mcp })
    return threads
  }, [])

  useEffect(() => {
    const offEvent = onEvent((event) => dispatch({ type: 'event', event }))
    const offSettings = window.desktop.settings.onChanged(refreshSettings)
    const offConnected = onConnected(() => void syncAll())
    const offOpenThread = window.desktop.onOpenThread((threadId) => void openThread(threadId))
    refreshSettings()
    void syncAll().then((threads) => {
      // Not a company chat: those open from Empresas. Settings may not be loaded yet, so ask for them.
      void window.desktop.settings.get().then((s) => {
        const company = new Set(s.agents.filter((a) => a.companyId).map((a) => a.id))
        const first = threads.find((t) => !company.has(t.agentId))
        if (first) void openThread(first.id)
      })
    })
    return () => {
      offEvent()
      offSettings()
      offConnected()
      offOpenThread()
    }
  }, [refreshSettings, syncAll, openThread])

  const newThread = useCallback(async () => {
    const current = settings ?? (await window.desktop.settings.get())
    const workspace = state.thread?.workspace || current.defaultWorkspace
    const thread = await request<Thread>({ method: 'threads.create', agentId: current.defaultAgentId, workspace })
    dispatch({ type: 'open', thread })
  }, [settings, state.thread])

  const deleteThread = useCallback(async (threadId: string) => {
    await request({ method: 'threads.delete', threadId })
    dispatch({ type: 'removed', threadId })
  }, [])

  const updateSettings = useCallback(async (patch: Partial<PublicSettings>) => {
    setSettings(await window.desktop.settings.update(patch))
  }, [])

  // "Abrir nota" from a chat tool card or anywhere else: switch to the vault and show it.
  const { open: openInVault } = vault
  useEffect(
    () =>
      onOpenNote((path, line) => {
        setMode('vault')
        openInVault(path, line)
      }),
    [openInVault, setMode]
  )

  const switchVault = useCallback(
    (path: string) => void updateSettings({ activeVault: path, vaults: [...new Set([...(settings?.vaults ?? []), path])] }),
    [settings, updateSettings]
  )

  const createDefaultVault = useCallback(async () => {
    const path = await window.desktop.defaultVaultPath()
    await request({ method: 'vault.init', path })
    switchVault(path)
  }, [switchVault])

  const openFolderAsVault = useCallback(async () => {
    const path = await window.desktop.pickFolder()
    if (path) switchVault(path)
  }, [switchVault])

  // Reminders stay on screen until dismissed (OS toasts vanish after a few seconds).
  const [reminders, setReminders] = useState<{ id: number; title: string; body: string }[]>([])
  useEffect(
    () =>
      window.desktop.onReminder((reminder) => {
        playUISound('notification')
        setReminders((list) => [...list, { ...reminder, id: Date.now() + Math.random() }])
      }),
    []
  )

  const hasVault = !!settings?.activeVault
  const companies = settings?.companies ?? []
  const shownCompany = companies.find((c) => c.id === companyId) ?? companies[0] ?? null
  // Chats with a company's agents live under Empresas, not in the Chat tab.
  const companyAgents = new Set((settings?.agents ?? []).filter((a) => a.companyId).map((a) => a.id))
  const chatThreads = state.threads.filter((t) => !companyAgents.has(t.agentId))
  const companyThreads = state.threads.filter((t) => companyAgents.has(t.agentId))
  const chatThread = state.thread && !companyAgents.has(state.thread.agentId) ? state.thread : null
  const renderChat = (thread: Thread, compact?: boolean): React.JSX.Element => (
    <ChatView
      key={thread.id}
      compact={compact}
      thread={thread}
      settings={settings!}
      drafts={state.drafts}
      running={state.running.includes(thread.id)}
      approvals={state.approvals.filter((a) => a.threadId === thread.id)}
      error={state.errors[thread.id]}
      onDismissError={() => dispatch({ type: 'dismissError', threadId: thread.id })}
      onUpdateSettings={updateSettings}
      onOpenSettings={() => setSettingsOpen(true)}
      attachments={attachments}
      onAttach={attach}
      onRemoveAttachment={(id) => setAttachments((list) => list.filter((a) => a.id !== id))}
      onClearAttachments={() => setAttachments([])}
    />
  )

  useEffect(() => {
    if (!pendingNote || !settings) return
    vault.open(pendingNote)
    setPendingNote(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.activeVault, pendingNote])

  const openSettings = (tab?: SettingsTab): void => {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }

  return (
    <div className="app">
      <Backdrop />
      <Sidebar
        mode={mode}
        onMode={setMode}
        vaultPane={
          settings && hasVault ? (
            <VaultSidebar
              settings={settings}
              entries={vault.entries}
              activePath={vault.active}
              status={state.knowledge}
              onOpen={(path) => vault.open(path)}
              onRenamed={vault.renamed}
              onDeleted={vault.deleted}
              onSearch={() => setVaultPanel('search')}
              onKnowledge={() => setVaultPanel('knowledge')}
              onNewDrawing={() => void vault.createDrawing()}
              onAsk={(path) => void fileAttachment(path).then(attach)}
              onSwitchVault={switchVault}
              onCreateVault={() => void createDefaultVault()}
              onOpenFolder={() => void openFolderAsVault()}
            />
          ) : (
            <p className="muted small pad">Todavía no hay un vault.</p>
          )
        }
        companiesPane={
          <nav className="company-list" aria-label="Empresas">
            {companies.map((c) => (
              <button
                key={c.id}
                className={`company-row${c.id === shownCompany?.id ? ' active' : ''}`}
                style={{ '--company': c.color } as React.CSSProperties}
                onClick={() => setCompanyId(c.id)}
              >
                <span className="company-dot" aria-hidden />
                <span className="grow ellipsis">{c.name}</span>
                <span className="muted small">{c.members.length}</span>
              </button>
            ))}
            <button className="ghost small" onClick={() => openSettings('teams')}>
              ＋ Nueva empresa / editar equipos
            </button>
          </nav>
        }
        homePane={settings ? <HomeSidebar settings={settings} home={home} onAdd={() => (setMode('home'), setHomeAdding(true))} /> : null}
        threads={chatThreads}
        activeId={chatThread?.id ?? null}
        running={state.running}
        approvals={state.approvals}
        mcp={state.mcp}
        agents={settings?.agents ?? []}
        onSelect={(id) => void openThread(id)}
        onNew={() => void newThread()}
        onDelete={(id) => void deleteThread(id)}
        onOpenSettings={() => openSettings()}
        routineCount={settings?.routines.length ?? 0}
        voiceEnabled={!!settings?.voice.enabled}
        voiceState={state.voice.state}
        onOpenRoutines={() => setRoutinesOpen(true)}
      />
      {mode === 'home' && settings ? (
        <HomeView
          settings={settings}
          home={home}
          onUpdateSettings={updateSettings}
          onOpenSettings={() => openSettings('home')}
          onOpenChat={() => setMode('chat')}
          adding={homeAdding}
          onAdding={setHomeAdding}
        />
      ) : mode === 'companies' && settings ? (
        <CompaniesView
          settings={settings}
          companyId={shownCompany?.id ?? null}
          threads={companyThreads}
          activeId={state.activeId}
          running={state.running}
          approvals={state.approvals}
          chat={state.thread && companyAgents.has(state.thread.agentId) ? renderChat(state.thread) : null}
          onOpenThread={(threadId) => void openThread(threadId)}
          onDeleteThread={(threadId) => void deleteThread(threadId)}
          onOpenSettings={() => openSettings('teams')}
          onOpenVault={(path, note) => {
            if (settings.activeVault !== path) switchVault(path)
            setMode('vault')
            if (note) {
              if (settings.activeVault === path) vault.open(note)
              else setPendingNote(note)
            }
          }}
        />
      ) : mode === 'vault' ? (
        settings && hasVault ? (
          <VaultView
            settings={settings}
            vault={vault}
            status={state.knowledge}
            version={state.vaultVersion}
            panel={vaultPanel}
            onPanel={setVaultPanel}
            onAsk={attach}
            onToggleChat={() => setVaultChat(!vaultChat)}
            chat={
              vaultChat ? (
                <aside className="vault-chat" aria-label="Chat con Alma">
                  <div className="vault-chat-bar">
                    <button className="ghost small" onClick={() => void newThread()} title="Empezar otra conversación">
                      <Icon icon={MessageSquarePlus} size={14} /> Nueva
                    </button>
                    <button className="icon-button" onClick={() => setVaultChat(false)} title="Cerrar el chat">
                      <Icon icon={X} size="sm" />
                    </button>
                  </div>
                  {state.thread ? (
                    <ChatView
                      key={state.thread.id}
                      compact
                      thread={state.thread}
                      settings={settings}
                      drafts={state.drafts}
                      running={state.running.includes(state.thread.id)}
                      approvals={state.approvals.filter((a) => a.threadId === state.thread?.id)}
                      error={state.errors[state.thread.id]}
                      onDismissError={() => dispatch({ type: 'dismissError', threadId: state.thread!.id })}
                      onUpdateSettings={updateSettings}
                      onOpenSettings={() => setSettingsOpen(true)}
                      attachments={attachments}
                      onAttach={attach}
                      onRemoveAttachment={(id) => setAttachments((list) => list.filter((a) => a.id !== id))}
                      onClearAttachments={() => setAttachments([])}
                    />
                  ) : (
                    <div className="vault-empty muted">
                      <button className="primary" onClick={() => void newThread()}>
                        Nueva conversación
                      </button>
                    </div>
                  )}
                </aside>
              ) : undefined
            }
          />
        ) : (
          <VaultWelcome onCreate={() => void createDefaultVault()} onOpenFolder={() => void openFolderAsVault()} />
        )
      ) : chatThread && settings ? (
        renderChat(chatThread)
      ) : (
        <main className="empty-state">
          <h1>Alma</h1>
          <p>Agentes con Claude, Grok, DeepSeek o Vercel AI Gateway que trabajan en tu computadora, delegan en subagentes y usan conectores MCP.</p>
          <button className="primary" onClick={() => void newThread()}>
            Nueva conversación
          </button>
          {settings && (['anthropic', 'xai', 'deepseek', 'vercel', 'meta'] as const).every((p) => !settings.providers[p].hasKey && !settings.providers[p].fromEnv) && (
            <p className="hint">
              Primero cargá una API key en <button className="link" onClick={() => setSettingsOpen(true)}>Configuración</button>.
            </p>
          )}
        </main>
      )}
      {settings && <VoiceLayer settings={settings} status={state.voice} />}
      {reminders.length > 0 && (
        <div className="reminder-stack" role="status" aria-live="assertive">
          {reminders.map((reminder) => (
            <div key={reminder.id} className="reminder-toast">
              <Icon icon={AlarmClock} size="sm" />
              <div className="grow">
                <strong>{reminder.title}</strong>
                <div>{reminder.body}</div>
              </div>
              <button className="icon-button" title="Cerrar" onClick={() => setReminders((list) => list.filter((r) => r.id !== reminder.id))}>
                <Icon icon={X} size="sm" />
              </button>
            </div>
          ))}
        </div>
      )}
      {routinesOpen && settings && (
        <RoutinesDialog
          settings={settings}
          state={state.routines}
          onChange={updateSettings}
          onOpenThread={(threadId) => void openThread(threadId)}
          onClose={() => setRoutinesOpen(false)}
        />
      )}
      {settingsOpen && settings && (
        <SettingsDialog
          initialTab={settingsTab}
          settings={settings}
          mcp={state.mcp}
          telegram={state.telegram}
          whatsapp={state.whatsapp}
          onChange={updateSettings}
          onSettingsReplaced={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
