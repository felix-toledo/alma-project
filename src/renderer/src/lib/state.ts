import type {
  ChatMessage,
  EventScope,
  KnowledgeStatus,
  LiveEvent,
  McpServerStatus,
  PendingApproval,
  RoutineState,
  TelegramStatus,
  WhatsAppStatus,
  Thread,
  VoiceStatus,
  ThreadSummary
} from '../../../shared/types'

/** Text and tool calls still streaming for one conversation or subagent, before the message commits. */
export interface Draft {
  text: string
  thinking: string
  tools: { id: string; name: string }[]
}

export interface AppState {
  threads: ThreadSummary[]
  activeId: string | null
  thread: Thread | null
  drafts: Record<string, Draft>
  running: string[]
  approvals: PendingApproval[]
  mcp: McpServerStatus[]
  errors: Record<string, string>
  routines: Record<string, RoutineState>
  knowledge: KnowledgeStatus | null
  /** Bumps whenever files in the active vault change, so vault views reload. */
  vaultVersion: number
  telegram: TelegramStatus
  whatsapp: WhatsAppStatus
  voice: VoiceStatus
}

export const initialState: AppState = {
  threads: [],
  activeId: null,
  thread: null,
  drafts: {},
  running: [],
  approvals: [],
  mcp: [],
  errors: {},
  routines: {},
  knowledge: null,
  vaultVersion: 0,
  telegram: { state: 'off' },
  whatsapp: { state: 'off' },
  voice: { state: 'off' }
}

export type Action =
  | { type: 'event'; event: LiveEvent }
  | { type: 'threads'; threads: ThreadSummary[] }
  | { type: 'open'; thread: Thread | null }
  | { type: 'removed'; threadId: string }
  | { type: 'running'; threadIds: string[] }
  | { type: 'approvals'; approvals: PendingApproval[] }
  | { type: 'mcp'; servers: McpServerStatus[] }
  | { type: 'dismissError'; threadId: string }
  | { type: 'routines'; state: Record<string, RoutineState> }
  | { type: 'knowledge'; status: KnowledgeStatus | null }
  | { type: 'telegram'; status: TelegramStatus }
  | { type: 'whatsapp'; status: WhatsAppStatus }
  | { type: 'voice'; status: VoiceStatus }

export function scopeKey(scope: EventScope): string {
  return scope.subagentId ? `${scope.threadId}:${scope.subagentId}` : scope.threadId
}

const emptyDraft = (): Draft => ({ text: '', thinking: '', tools: [] })

function updateDraft(state: AppState, scope: EventScope, update: (draft: Draft) => Draft): AppState {
  const key = scopeKey(scope)
  return { ...state, drafts: { ...state.drafts, [key]: update(state.drafts[key] ?? emptyDraft()) } }
}

function clearDraft(state: AppState, scope: EventScope): AppState {
  const key = scopeKey(scope)
  if (!state.drafts[key]) return state
  const { [key]: _removed, ...rest } = state.drafts
  return { ...state, drafts: rest }
}

function appendMessage(thread: Thread, scope: EventScope, message: ChatMessage): Thread {
  if (!scope.subagentId) return { ...thread, messages: [...thread.messages, message] }
  const run = thread.subagents[scope.subagentId]
  if (!run) return thread
  return {
    ...thread,
    subagents: { ...thread.subagents, [scope.subagentId]: { ...run, messages: [...run.messages, message] } }
  }
}

function upsertSummary(threads: ThreadSummary[], summary: ThreadSummary): ThreadSummary[] {
  return [summary, ...threads.filter((t) => t.id !== summary.id)].sort((a, b) => b.updatedAt - a.updatedAt)
}

function applyEvent(state: AppState, event: LiveEvent): AppState {
  const isActive = (threadId: string): boolean => state.thread?.id === threadId
  switch (event.type) {
    case 'stream.text':
      return updateDraft(state, event.scope, (d) => ({ ...d, text: d.text + event.text }))
    case 'stream.thinking':
      return updateDraft(state, event.scope, (d) => ({ ...d, thinking: d.thinking + event.text }))
    case 'stream.tool':
      return updateDraft(state, event.scope, (d) => ({ ...d, tools: [...d.tools, { id: event.id, name: event.name }] }))
    case 'message': {
      const next = clearDraft(state, event.scope)
      if (!isActive(event.scope.threadId) || !next.thread) return next
      return { ...next, thread: appendMessage(next.thread, event.scope, event.message) }
    }
    case 'tool.state':
      if (!isActive(event.threadId) || !state.thread) return state
      return { ...state, thread: { ...state.thread, toolStates: { ...state.thread.toolStates, [event.toolUseId]: event.state } } }
    case 'subagent.started':
      if (!isActive(event.threadId) || !state.thread) return state
      return { ...state, thread: { ...state.thread, subagents: { ...state.thread.subagents, [event.run.id]: event.run } } }
    case 'subagent.finished': {
      const run = state.thread?.subagents[event.subagentId]
      if (!isActive(event.threadId) || !state.thread || !run) return state
      return {
        ...state,
        thread: {
          ...state.thread,
          subagents: { ...state.thread.subagents, [run.id]: { ...run, status: event.status, endedAt: Date.now() } }
        }
      }
    }
    case 'run.started': {
      const { [event.threadId]: _cleared, ...errors } = state.errors
      return { ...state, errors, running: [...new Set([...state.running, event.threadId])] }
    }
    case 'run.finished': {
      // Drop leftover drafts from an interrupted stream.
      const drafts = Object.fromEntries(
        Object.entries(state.drafts).filter(([key]) => key !== event.threadId && !key.startsWith(`${event.threadId}:`))
      )
      return {
        ...state,
        drafts,
        running: state.running.filter((id) => id !== event.threadId),
        errors: event.error ? { ...state.errors, [event.threadId]: event.error } : state.errors
      }
    }
    case 'approval.request':
      return { ...state, approvals: [...state.approvals, event.approval] }
    case 'approval.resolved':
      return { ...state, approvals: state.approvals.filter((a) => a.approvalId !== event.approvalId) }
    case 'thread.updated': {
      const threads = upsertSummary(state.threads, event.summary)
      const thread = isActive(event.summary.id) && state.thread ? { ...state.thread, ...event.summary } : state.thread
      return { ...state, threads, thread }
    }
    case 'mcp.status':
      return { ...state, mcp: event.servers }
    case 'routines.state':
      return { ...state, routines: event.state }
    case 'knowledge.status':
      return { ...state, knowledge: event.status }
    case 'vault.changed':
      return { ...state, vaultVersion: state.vaultVersion + 1 }
    case 'telegram.status':
      return { ...state, telegram: event.status }
    case 'whatsapp.status':
      return { ...state, whatsapp: event.status }
    case 'voice.status':
      return { ...state, voice: event.status }
    case 'voice.play':
    case 'voice.stop':
    // Company views load their own snapshot when these arrive.
    case 'company.changed':
    case 'company.whatsapp':
    // The Casa view keeps its own state (useHome).
    case 'home.engine':
    case 'home.snapshot':
    case 'home.plan':
    case 'home.rules':
    case 'home.flow':
      return state
  }
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'event':
      return applyEvent(state, action.event)
    case 'threads':
      return { ...state, threads: action.threads }
    case 'open':
      return { ...state, thread: action.thread, activeId: action.thread?.id ?? null }
    case 'removed':
      return {
        ...state,
        threads: state.threads.filter((t) => t.id !== action.threadId),
        ...(state.activeId === action.threadId ? { thread: null, activeId: null } : {})
      }
    case 'running':
      return { ...state, running: action.threadIds }
    case 'approvals':
      return { ...state, approvals: action.approvals }
    case 'mcp':
      return { ...state, mcp: action.servers }
    case 'routines':
      return { ...state, routines: action.state }
    case 'knowledge':
      return { ...state, knowledge: action.status }
    case 'telegram':
      return { ...state, telegram: action.status }
    case 'whatsapp':
      return { ...state, whatsapp: action.status }
    case 'voice':
      return { ...state, voice: action.status }
    case 'dismissError': {
      const { [action.threadId]: _removed, ...errors } = state.errors
      return { ...state, errors }
    }
  }
}
