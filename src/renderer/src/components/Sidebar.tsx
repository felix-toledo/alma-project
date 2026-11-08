import type { AgentProfile, McpServerStatus, PendingApproval, ThreadSummary, VoiceState } from '../../../shared/types'
import { request } from '../lib/coordinator'
import { agentName, relativeTime, threadTitle } from '../lib/format'
import { BookOpen, Briefcase, Building2, Home, MessageCircle, MessageSquare, Mic, Plus, Repeat, Send, Settings, Smartphone, X } from 'lucide-react'
import { useT } from '../i18n/useT'
import { Icon } from '../umbra/Icon'
import { Logo } from './Logo'

export type AppMode = 'chat' | 'vault' | 'companies' | 'home'

interface Props {
  mode: AppMode
  onMode(mode: AppMode): void
  /** What the vault mode shows instead of the conversation list. */
  vaultPane: React.ReactNode
  /** What the companies mode shows: the list of companies. */
  companiesPane: React.ReactNode
  /** What the home mode shows: the engine, the modes and a shortcut to add a device. */
  homePane: React.ReactNode
  threads: ThreadSummary[]
  activeId: string | null
  running: string[]
  approvals: PendingApproval[]
  mcp: McpServerStatus[]
  agents: AgentProfile[]
  onSelect(id: string): void
  onNew(): void
  onDelete(id: string): void
  onOpenSettings(): void
  routineCount: number
  onOpenRoutines(): void
  voiceEnabled: boolean
  voiceState: VoiceState
}

export function Sidebar(props: Props): React.JSX.Element {
  const t = useT()
  const connected = props.mcp.filter((s) => s.state === 'connected').length
  const failing = props.mcp.filter((s) => s.state === 'error').length

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">
          <Logo size={24} /> {t('common.appName')}
        </div>
        <div className="mode-switch tabs" role="tablist" aria-label={t('sidebar.view')}>
          <button role="tab" aria-selected={props.mode === 'chat'} className={props.mode === 'chat' ? 'active' : ''} onClick={() => props.onMode('chat')}>
            <Icon icon={MessageSquare} size={16} /> {t('sidebar.mode.chat')}
          </button>
          <button role="tab" aria-selected={props.mode === 'vault'} className={props.mode === 'vault' ? 'active' : ''} onClick={() => props.onMode('vault')} title={t('sidebar.mode.vaultTitle')}>
            <Icon icon={BookOpen} size={16} /> {t('sidebar.mode.vault')}
          </button>
          <button role="tab" aria-selected={props.mode === 'companies'} className={props.mode === 'companies' ? 'active' : ''} onClick={() => props.onMode('companies')}>
            <Icon icon={Building2} size={16} /> {t('common.companies')}
          </button>
          <button role="tab" aria-selected={props.mode === 'home'} className={props.mode === 'home' ? 'active' : ''} onClick={() => props.onMode('home')} title={t('sidebar.mode.homeTitle')}>
            <Icon icon={Home} size={16} /> {t('sidebar.mode.home')}
          </button>
        </div>
        {props.mode === 'chat' && (
          <button className="primary block" onClick={props.onNew}>
            <Icon icon={Plus} size="sm" /> {t('common.newConversation')}
          </button>
        )}
      </div>

      {props.mode === 'companies' ? props.companiesPane : props.mode === 'vault' ? props.vaultPane : props.mode === 'home' ? props.homePane : (
      <nav className="thread-list" aria-label={t('sidebar.threads')}>
        {props.threads.length === 0 && <p className="muted small pad">{t('sidebar.noThreads')}</p>}
        {props.threads.map((thread) => {
          const isRunning = props.running.includes(thread.id)
          const waiting = props.approvals.some((a) => a.threadId === thread.id)
          return (
            <div
              key={thread.id}
              className={`thread-item${thread.id === props.activeId ? ' active' : ''}`}
              onClick={() => props.onSelect(thread.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && props.onSelect(thread.id)}
            >
              <div className="thread-title">
                {waiting ? <span className="dot warn" title={t('sidebar.waiting')} /> : isRunning && <span className="dot live" title={t('sidebar.working')} />}
                {thread.channel === 'telegram' && <span className="channel-icon" title={t('sidebar.channel.telegram')}><Icon icon={Send} size={14} /></span>}
                {thread.channel === 'voice' && <span className="channel-icon" title={t('sidebar.channel.voice')}><Icon icon={Mic} size={14} /></span>}
                {thread.channel === 'whatsapp' && <span className="channel-icon" title={t('sidebar.channel.whatsapp')}><Icon icon={MessageCircle} size={14} /></span>}
                {thread.channel === 'remote' && <span className="channel-icon" title={t('sidebar.channel.remote')}><Icon icon={Smartphone} size={14} /></span>}
                {thread.channel === 'company' && <span className="channel-icon" title={t('sidebar.channel.company')}><Icon icon={Briefcase} size={14} /></span>}
                <span className="ellipsis">{threadTitle(thread.title, t)}</span>
              </div>
              <div className="thread-meta">
                <span>{agentName(props.agents, thread.agentId)}</span>
                <span>{relativeTime(thread.updatedAt, t)}</span>
              </div>
              <button
                className="icon-button thread-delete"
                title={t('sidebar.delete')}
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm(t('sidebar.deleteConfirm', { title: thread.title }))) props.onDelete(thread.id)
                }}
              >
                <Icon icon={X} size="sm" />
              </button>
            </div>
          )
        })}
      </nav>
      )}

      <div className="sidebar-bottom">
        {props.mcp.length > 0 && (
          <div className="small muted pad">
            {t('sidebar.mcp.connected', { count: connected })}
            {failing > 0 && <span className="text-danger"> · {t('sidebar.mcp.failing', { count: failing })}</span>}
          </div>
        )}
        {props.voiceEnabled && (
          <button
            className={`ghost block voice-button state-${props.voiceState}`}
            title={props.voiceState === 'speaking' ? t('sidebar.voice.speaking') : t('sidebar.voice.hint')}
            onClick={() => void request({ method: 'voice.trigger' })}
          >
            <Icon icon={Mic} size="sm" />{' '}
            {props.voiceState === 'listening' ? t('sidebar.voice.listening') : props.voiceState === 'speaking' ? t('sidebar.voice.speaking') : props.voiceState === 'error' ? t('sidebar.voice.error') : t('sidebar.voice.idle')}
          </button>
        )}
        <button className="ghost block" onClick={props.onOpenRoutines}>
          <Icon icon={Repeat} size="sm" /> {t('sidebar.routines')}{props.routineCount > 0 ? ` (${props.routineCount})` : ''}
        </button>
        <button className="ghost block" onClick={props.onOpenSettings}>
          <Icon icon={Settings} size="sm" /> {t('common.settings')}
        </button>
      </div>
    </aside>
  )
}
