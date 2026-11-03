import type { AgentProfile, McpServerStatus, PendingApproval, ThreadSummary, VoiceState } from '../../../shared/types'
import { request } from '../lib/coordinator'
import { agentName, relativeTime, threadTitle } from '../lib/format'
import { BookOpen, Briefcase, Building2, Home, MessageCircle, MessageSquare, Mic, Plus, Repeat, Send, Settings, X } from 'lucide-react'
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
  const connected = props.mcp.filter((s) => s.state === 'connected').length
  const failing = props.mcp.filter((s) => s.state === 'error').length

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">
          <Logo size={24} /> Alma
        </div>
        <div className="mode-switch tabs" role="tablist" aria-label="Vista">
          <button role="tab" aria-selected={props.mode === 'chat'} className={props.mode === 'chat' ? 'active' : ''} onClick={() => props.onMode('chat')}>
            <Icon icon={MessageSquare} size={16} /> Chat
          </button>
          <button role="tab" aria-selected={props.mode === 'vault'} className={props.mode === 'vault' ? 'active' : ''} onClick={() => props.onMode('vault')} title="Conocimientos">
            <Icon icon={BookOpen} size={16} /> Vault
          </button>
          <button role="tab" aria-selected={props.mode === 'companies'} className={props.mode === 'companies' ? 'active' : ''} onClick={() => props.onMode('companies')}>
            <Icon icon={Building2} size={16} /> Empresas
          </button>
          <button role="tab" aria-selected={props.mode === 'home'} className={props.mode === 'home' ? 'active' : ''} onClick={() => props.onMode('home')} title="Domótica">
            <Icon icon={Home} size={16} /> Casa
          </button>
        </div>
        {props.mode === 'chat' && (
          <button className="primary block" onClick={props.onNew}>
            <Icon icon={Plus} size="sm" /> Nueva conversación
          </button>
        )}
      </div>

      {props.mode === 'companies' ? props.companiesPane : props.mode === 'vault' ? props.vaultPane : props.mode === 'home' ? props.homePane : (
      <nav className="thread-list" aria-label="Conversaciones">
        {props.threads.length === 0 && <p className="muted small pad">Todavía no hay conversaciones.</p>}
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
                {waiting ? <span className="dot warn" title="Esperando tu aprobación" /> : isRunning && <span className="dot live" title="Trabajando" />}
                {thread.channel === 'telegram' && <span className="channel-icon" title="Conversación de Telegram"><Icon icon={Send} size={14} /></span>}
                {thread.channel === 'voice' && <span className="channel-icon" title="Conversación por voz"><Icon icon={Mic} size={14} /></span>}
                {thread.channel === 'whatsapp' && <span className="channel-icon" title="Conversación de WhatsApp"><Icon icon={MessageCircle} size={14} /></span>}
                {thread.channel === 'company' && <span className="channel-icon" title="Trabajo de una empresa (tarea, revisión o preparación)"><Icon icon={Briefcase} size={14} /></span>}
                <span className="ellipsis">{threadTitle(thread.title)}</span>
              </div>
              <div className="thread-meta">
                <span>{agentName(props.agents, thread.agentId)}</span>
                <span>{relativeTime(thread.updatedAt)}</span>
              </div>
              <button
                className="icon-button thread-delete"
                title="Borrar conversación"
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm(`¿Borrar «${thread.title}»?`)) props.onDelete(thread.id)
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
            MCP: {connected} conectado{connected === 1 ? '' : 's'}
            {failing > 0 && <span className="text-danger"> · {failing} con error</span>}
          </div>
        )}
        {props.voiceEnabled && (
          <button
            className={`ghost block voice-button state-${props.voiceState}`}
            title={props.voiceState === 'speaking' ? 'Callar' : 'Hablar (o decí la palabra de activación / usá el atajo)'}
            onClick={() => void request({ method: 'voice.trigger' })}
          >
            <Icon icon={Mic} size="sm" />{' '}
            {props.voiceState === 'listening' ? 'Hablar' : props.voiceState === 'speaking' ? 'Callar' : props.voiceState === 'error' ? 'Voz con error' : 'Voz…'}
          </button>
        )}
        <button className="ghost block" onClick={props.onOpenRoutines}>
          <Icon icon={Repeat} size="sm" /> Rutinas{props.routineCount > 0 ? ` (${props.routineCount})` : ''}
        </button>
        <button className="ghost block" onClick={props.onOpenSettings}>
          <Icon icon={Settings} size="sm" /> Configuración
        </button>
      </div>
    </aside>
  )
}
