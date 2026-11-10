import * as z from 'zod/v4'
import { chainOfCommand, colleagues, directReports } from '../shared/company'
import { toolTrail } from './tool-trail'
import { formatDateTime } from '../shared/i18n/format'
import { ATTACHMENTS_SYSTEM_SENTENCE } from '../shared/attach/compose'
import { translate, translateText } from '../shared/i18n/messages'
import type { AgentProfile, Block, ChatMessage, EventScope, Language, LiveEvent, ProviderId, Routine, Settings, SubagentRun, Thread, ToolState, ToolText, Usage } from '../shared/types'
import { authorize, type ApprovalBroker } from './approval'
import { expandAttachments } from './attachments/expand'
import { readAttachmentTool } from './attachments/read-tool'
import type { AttachmentReader } from './attachments/store'
import { compactHistory } from './context'
import { CHANNEL_GUIDES, companyBlock, DELEGATE_BLOCK, environmentBlock, fragmentsBlock, HOME_GUIDE, KNOWLEDGE_GUIDE, memoriesBlock, replyLanguageRule, SUBAGENT_BLOCK } from './prompts/system'
import type { KnowledgeBase } from './knowledge/base'
import { knowledgeTools } from './knowledge/tools'
import type { McpManager } from './mcp'
import { getProvider } from './providers'
import type { ToolSpec } from './providers/types'
import { builtinToolsByName } from './tools'
import { companyTools } from './tools/company'
import { companyAuthoringTools, offersCompanyAuthoring } from './tools/company-authoring'
import { homeTools, lookAtImageTool } from './tools/home'
import type { HomeService } from './home'
import { OFFICE_GUIDE } from './tools/office'
import { routineTools } from './tools/routines'
import { emailConfigured, emailTools } from './tools/email'
import { sendTelegramTool } from './tools/telegram'
import { endVoiceConversationTool } from './tools/voice'
import { webTools } from './tools/web'
import { whatsAppTools } from './tools/whatsapp'
import { jsonSchemaOf, ToolError, truncateMiddle, type AuditDetail, type CompanyAuthoringHost, type Host, type ToolContext, type ToolDefinition } from './tools/types'

const MAX_ITERATIONS = 80
const DELEGATE_TOOL = 'delegate_task'
const COMPANY_AUTO_APPROVE = ['write_file', 'edit_file', 'office_create', 'office_edit', 'generate_image', 'compose_image']

export interface RunContext {
  /** Live settings: approval mode and rules changed mid-run apply to the next tool call. */
  getSettings(): Settings
  /** The app language when the run started: a change of `language` mid-run applies to the next run, not this one. */
  language: Language
  thread: Thread
  scope: EventScope
  signal: AbortSignal
  depth: number
  approvals: ApprovalBroker
  mcp: McpManager
  host: Host
  /** The active vault: its memories and relevant notes go into the prompt, and its tools are offered. */
  knowledge: KnowledgeBase | null
  emit(event: LiveEvent): void
  persist(): void
  rememberAlwaysAllow(toolName: string): void
  /** Persists routines created or deleted by an agent. */
  saveRoutines(routines: Routine[]): void
  /** Sends a message to the user's bound Telegram chat; false if Telegram isn't connected. */
  sendTelegram(text: string): Promise<boolean>
  /** The linked WhatsApp, or null when it's off. */
  whatsapp: ToolContext['whatsapp'] | null
  /** A run nobody writes into (routine, company task, house rule): the reply-language rule falls back to the app language. */
  unattended?: boolean
  /** The agent's seat when it works in a company. */
  company?: ToolContext['company'] | null
  /** Lets this run create and edit companies (spec 029); the tools are offered only where `offersCompanyAuthoring` says so. */
  authoring?: CompanyAuthoringHost | null
  /** Tools this run may use without asking (a rule the user already approved). */
  autoApprove?: string[]
  /** The house (domotica); only offered when it is turned on and the agent isn't a company's. */
  home?: HomeService | null
  /** Where pictures the user sent are saved. */
  inboxDir?: string
  sendTelegramPhoto?(jpeg: Buffer, caption: string): Promise<boolean>
  /** The attachments store: `read_attachment` and the history expansion read through it, sub-agents included (spec 030). */
  attachments?: AttachmentReader
  /** Every model turn's token usage (company budgets). */
  onUsage?(usage: Usage, provider: ProviderId): void
}

/** Tools every agent gets regardless of its profile: they act on the app (vault, schedule), not on the workspace. */
export function appTools(ctx: RunContext): ToolDefinition[] {
  return [
    ...(ctx.knowledge ? knowledgeTools : []),
    ...routineTools,
    ...webTools,
    sendTelegramTool,
    lookAtImageTool,
    readAttachmentTool,
    ...(ctx.home && !ctx.company && ctx.getSettings().home.enabled ? homeTools : []),
    ...(emailConfigured(ctx.getSettings()) ? emailTools : []),
    ...(ctx.whatsapp ? whatsAppTools : []),
    ...(ctx.company ? companyTools : []),
    ...(ctx.authoring && offersCompanyAuthoring({ depth: ctx.depth, unattended: ctx.unattended, hasSeat: !!ctx.company, channel: ctx.thread.channel }) ? companyAuthoringTools : []),
    ...(ctx.depth === 0 && ctx.thread.channel === 'voice' ? [endVoiceConversationTool] : [])
  ]
}

/** "Tuesday, 10/21/2026, 10:05 (America/Argentina/Buenos_Aires)": models need the local day and time to schedule. English whatever the app language: the model reads it (AC-4.3). */
export function localNow(now = new Date()): string {
  return `${formatDateTime('en', now, 'longDate')} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`
}

type ToolUse = Extract<Block, { type: 'tool_use' }>
type ToolResult = Extract<Block, { type: 'tool_result' }>

/**
 * If the app stopped while tools were running, the history ends with tool calls that never got results,
 * which the APIs reject. Close them with error results so the conversation can continue.
 */
export function repairDanglingToolUses(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return false
  const uses = last.content.filter((b): b is ToolUse => b.type === 'tool_use')
  if (uses.length === 0) return false
  messages.push({
    role: 'user',
    content: uses.map((use) => errorResult(use.id, { key: 'tool.interrupted' })),
    ts: Date.now()
  })
  return true
}

const DelegateInput = z.object({
  agent: z.string().describe('id of the agent that will do the task'),
  title: z.string().describe('Short title of the subtask (shown to the user)'),
  task: z
    .string()
    .describe('Complete, self-contained instructions: the subagent does not see this conversation, include all the necessary context.')
})

export function delegateSpec(agents: AgentProfile[]): ToolSpec {
  const roster = agents.map((a) => `- ${a.id} (${a.name}): ${a.description}`).join('\n')
  return {
    name: DELEGATE_TOOL,
    description: `Delegates a subtask to another agent, who works on their own and returns their final result. Use it when the task has independent parts or needs a specialist; several calls in the same response run in parallel.\nAvailable agents:\n${roster}`,
    inputSchema: jsonSchemaOf(DelegateInput)
  }
}

function systemPrompt(profile: AgentProfile, ctx: RunContext, canDelegate: boolean, knowledge: string): string {
  const shell = process.platform === 'win32' ? 'PowerShell (Windows)' : 'bash'
  const parts = [profile.systemPrompt.trim(), environmentBlock(ctx.thread.workspace, shell, localNow()), replyLanguageRule(ctx.unattended ? 'unattended' : 'attended', ctx.language)]
  // always present, with the tool (spec 030 G9): attachments are data, never instructions
  parts.push(ATTACHMENTS_SYSTEM_SENTENCE)
  if (ctx.depth > 0) parts.push(SUBAGENT_BLOCK)
  if (canDelegate) parts.push(DELEGATE_BLOCK)
  const channel = ctx.depth === 0 && ctx.thread.channel ? CHANNEL_GUIDES[ctx.thread.channel] : ''
  if (channel) parts.push(channel)
  if (ctx.company) parts.push(companyContext(ctx.company, ctx.getSettings()))
  else if (ctx.home && ctx.getSettings().home.enabled) parts.push(HOME_GUIDE)
  if (profile.tools.some((t) => t.startsWith('office_'))) parts.push(OFFICE_GUIDE)
  if (knowledge) parts.push(knowledge)
  return parts.join('\n\n')
}

/** The agent's boss in its company (the user, when it reports straight to the board, approves alone). */
function bossOf(ctx: RunContext): { name: string; profile: AgentProfile } | undefined {
  if (!ctx.company) return undefined
  const boss = chainOfCommand(ctx.company.company, ctx.company.memberId)[0]
  const profile = boss && ctx.getSettings().agents.find((a) => a.id === boss.id)
  return profile ? { name: `${profile.name} (${boss.title})`, profile } : undefined
}

/** Where the agent sits: the company, its position, who it answers to and who it can work with. */
function companyContext(seat: NonNullable<ToolContext['company']>, settings: Settings): string {
  const { company, memberId } = seat
  const label = (id: string): string => {
    const member = company.members.find((m) => m.id === id)
    const agent = settings.agents.find((a) => a.id === id)
    return `${agent?.name ?? id} — ${member?.title ?? ''} (id ${id})`
  }
  const boss = chainOfCommand(company, memberId)[0]
  const team = directReports(company, memberId)
  const peers = colleagues(company, memberId).filter((m) => m.id !== boss?.id && !team.some((t) => t.id === m.id))
  return companyBlock({
    company: company.name,
    mission: company.mission,
    goals: company.goals,
    title: company.members.find((m) => m.id === memberId)?.title ?? '',
    memberId,
    boss: boss ? label(boss.id) : null,
    team: team.map((m) => label(m.id)),
    peers: peers.map((m) => label(m.id))
  })
}

/** Layered memory, as in ChatGPT/Letta: core memories always, plus the vault fragments closest to this request (ALMA-style RAG). */
async function knowledgeContext(ctx: RunContext, request: string): Promise<string> {
  if (!ctx.knowledge) return ''
  const { memories, fragments } = await ctx.knowledge.recall(request).catch((error: Error) => {
    console.error('[agent] recall failed:', error)
    return { memories: [] as string[], fragments: [] }
  })
  const parts: string[] = []
  if (memories.length) parts.push(memoriesBlock(memories, ctx.knowledge.memoryFile()))
  if (fragments.length) {
    const body = fragments
      .map((hit, i) => `[${i + 1}] ${hit.path}:${hit.line}${hit.heading ? ` › ${hit.heading}` : ''}\n${hit.snippet}`)
      .join('\n\n')
    parts.push(fragmentsBlock(body))
  }
  parts.push(KNOWLEDGE_GUIDE)
  return parts.join('\n\n')
}

function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = messages[i].content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n')
    if (messages[i].role === 'user' && text) return text
  }
  return ''
}

function finalText(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'assistant')
  return last?.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim() ?? ''
}

function setToolState(ctx: RunContext, toolUseId: string, state: ToolState): void {
  ctx.thread.toolStates[toolUseId] = state
  ctx.emit({ type: 'tool.state', threadId: ctx.thread.id, toolUseId, state })
}

/** The key kept for display carries the same data the model got, cut to the same limit, so a thread does not store a big output twice. */
function capParams(text: ToolText): ToolText {
  if (!text.params) return text
  return { ...text, params: Object.fromEntries(Object.entries(text.params).map(([name, value]) => [name, typeof value === 'string' ? truncateMiddle(value) : value])) }
}

/** An error result: a plain string, or a key that reads in English for the model and is kept for display (BR-18). */
function errorResult(toolUseId: string, text: string | ToolText): ToolResult {
  if (typeof text === 'string') return { type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: true }
  return { type: 'tool_result', tool_use_id: toolUseId, content: translateText('en', text), is_error: true, i18n: text }
}

/**
 * Runs one agent until it stops calling tools. `messages` is the conversation and is appended to in place,
 * so the caller's thread (or subagent run) always holds a valid, append-only history.
 */
export async function runAgent(profile: AgentProfile, messages: ChatMessage[], ctx: RunContext): Promise<string> {
  const builtins = profile.tools.map((name) => builtinToolsByName.get(name)).filter((t): t is ToolDefinition => !!t)
  // Company agents work for their company only: the user's own agents don't delegate to them.
  const delegates = ctx.getSettings().agents.filter((a) => a.id !== profile.id && !a.companyId)
  // Only the top-level agent delegates, so subagents can't fan out without bound. In a company, work goes through
  // the org chart (assign_task, ask_colleague) instead.
  const canDelegate = profile.canDelegate && ctx.depth === 0 && delegates.length > 0 && !ctx.company

  const tools: ToolSpec[] = [
    ...builtins.map((t) => ({ name: t.name, description: t.description, inputSchema: jsonSchemaOf(t.schema) })),
    ...(canDelegate ? [delegateSpec(delegates)] : []),
    ...appTools(ctx).map((t) => ({ name: t.name, description: t.description, inputSchema: jsonSchemaOf(t.schema) })),
    ...(profile.allowMcp ? ctx.mcp.toolSpecs() : [])
  ]
  const allowed = new Set(tools.map((t) => t.name))
  const provider = getProvider(profile.provider, ctx.getSettings())
  // Retrieved once per user message: the system prompt then stays fixed across tool iterations (prompt cache).
  const system = systemPrompt(profile, ctx, canDelegate, await knowledgeContext(ctx, lastUserText(messages)))

  for (let iteration = 0; iteration < MAX_ITERATIONS && !ctx.signal.aborted; iteration++) {
    const turn = await provider.streamTurn({
      model: profile.model,
      // In a spoken conversation every second of thinking is dead air: answer fast, think little.
      effort: ctx.depth === 0 && ctx.thread.channel === 'voice' ? 'low' : profile.effort,
      system,
      tools,
      messages: compactHistory(expandAttachments(messages, ctx.attachments)),
      signal: ctx.signal,
      onText: (text) => ctx.emit({ type: 'stream.text', scope: ctx.scope, text }),
      onThinking: (text) => ctx.emit({ type: 'stream.thinking', scope: ctx.scope, text }),
      onToolStart: (id, name) => ctx.emit({ type: 'stream.tool', scope: ctx.scope, id, name })
    })

    const toolUses = turn.content.filter((b): b is ToolUse => b.type === 'tool_use')
    let notice: string | undefined
    if (turn.stopReason === 'refusal') notice = turn.stopDetail ? translate(ctx.language, 'run.refusedWith', { detail: turn.stopDetail }) : translate(ctx.language, 'run.refused')
    else if (turn.stopReason === 'max_tokens') notice = translate(ctx.language, 'run.maxTokens')

    const assistant: ChatMessage = {
      role: 'assistant',
      content: turn.content,
      raw: turn.raw,
      provider: profile.provider,
      model: turn.model,
      usage: turn.usage,
      ts: Date.now(),
      ...(notice ? { notice } : {})
    }
    messages.push(assistant)
    if (turn.usage) ctx.onUsage?.(turn.usage, profile.provider)
    ctx.emit({ type: 'message', scope: ctx.scope, message: assistant })
    ctx.persist()

    // A refusal can cut a tool call off mid-input: never run that turn's tools.
    if (toolUses.length === 0 || turn.stopReason === 'refusal') break

    const results: ToolResult[] =
      turn.stopReason === 'max_tokens'
        ? toolUses.map((use) => errorResult(use.id, { key: 'tool.truncatedInput' }))
        : await Promise.all(toolUses.map((use) => executeTool(use, allowed, profile, messages, ctx)))

    const toolMessage: ChatMessage = { role: 'user', content: results, ts: Date.now() }
    messages.push(toolMessage)
    ctx.emit({ type: 'message', scope: ctx.scope, message: toolMessage })
    ctx.persist()
  }
  return finalText(messages)
}

async function executeTool(
  use: ToolUse,
  allowed: Set<string>,
  profile: AgentProfile,
  messages: ChatMessage[],
  ctx: RunContext
): Promise<ToolResult> {
  if (ctx.signal.aborted) {
    setToolState(ctx, use.id, { status: 'denied', note: translate(ctx.language, 'approval.note.cancelled') })
    return errorResult(use.id, { key: 'tool.cancelled' })
  }
  if (!allowed.has(use.name)) {
    setToolState(ctx, use.id, { status: 'error', note: translate(ctx.language, 'toolstate.unavailable') })
    return errorResult(use.id, { key: 'tool.unavailable', params: { name: use.name } })
  }
  if (use.name === DELEGATE_TOOL) return delegate(use, ctx)

  const builtin = builtinToolsByName.get(use.name) ?? appTools(ctx).find((t) => t.name === use.name)
  let input: unknown = use.input
  if (builtin) {
    // Inputs stream eagerly and aren't validated server-side, so validate before running anything.
    const parsed = builtin.schema.safeParse(use.input)
    if (!parsed.success) {
      setToolState(ctx, use.id, { status: 'error', note: translate(ctx.language, 'toolstate.invalidInput') })
      return errorResult(use.id, JSON.stringify({ INVALID_JSON: JSON.stringify(use.input), issues: parsed.error.issues }))
    }
    input = parsed.data
    // Built-in tools act on the workspace; don't ask the user to approve something that can't run.
    if (!builtin.standalone && !ctx.thread.workspace) {
      setToolState(ctx, use.id, { status: 'error', note: translate(ctx.language, 'toolstate.noWorkspace') })
      return errorResult(use.id, { key: 'tool.cwd.notSelected' })
    }
  }

  // What a tool with its own audit action reports (ids and counts), kept for whichever outcome ends the call.
  const audited: AuditDetail = {}
  const toolContext = {
    reportAudit: (detail: AuditDetail) => void Object.assign(audited, detail),
    workspace: ctx.thread.workspace,
    signal: ctx.signal,
    settings: ctx.getSettings(),
    language: ctx.language,
    host: ctx.host,
    knowledge: ctx.knowledge,
    threadId: ctx.thread.id,
    agentId: profile.id,
    saveRoutines: ctx.saveRoutines,
    sendTelegram: ctx.sendTelegram,
    whatsapp: ctx.whatsapp ?? undefined,
    company: ctx.company ?? undefined,
    authoring: ctx.authoring ?? undefined,
    home: ctx.home ?? undefined,
    inboxDir: ctx.inboxDir,
    attachments: ctx.attachments,
    sendTelegramPhoto: ctx.sendTelegramPhoto
  }
  const failed = (error: unknown, note: 'toolstate.invalidInput' | 'toolstate.failed'): ToolResult => {
    setToolState(ctx, use.id, { status: 'error', note: translate(ctx.language, note) })
    return errorResult(use.id, error instanceof ToolError ? error.text : { key: 'tool.error', params: { data: (error as Error).message } })
  }
  const risk = builtin?.risk ?? 'exec'
  // A call that ends before the card is an outcome too (029 AC-6.4): same dedicated action, same ids-and-counts detail.
  const failedBeforeCard = (error: unknown, note: 'toolstate.invalidInput' | 'toolstate.failed'): ToolResult => {
    if (builtin?.auditAction) toolTrail({ risk, name: use.name, input, threadId: ctx.thread.id, agentId: profile.id, note: '' }, 'error', 'tool.run', { action: builtin.auditAction, detail: { ...audited } })
    return failed(error, note)
  }
  if (builtin?.validate) {
    try {
      await builtin.validate(input, toolContext)
    } catch (error) {
      // A `ToolError` from `validate` is the input being refused; anything else is the tool failing.
      return failedBeforeCard(error, error instanceof ToolError ? 'toolstate.invalidInput' : 'toolstate.failed')
    }
  }
  const preview = builtin?.preview ? await builtin.preview(input, toolContext).catch(() => undefined) : undefined
  if (builtin?.previewRequired && !preview) return failedBeforeCard(new ToolError('tool.company.noPreview'), 'toolstate.failed')
  const authorization = await authorize({
    settings: ctx.getSettings(),
    language: ctx.language,
    threadId: ctx.thread.id,
    subagentId: ctx.scope.subagentId,
    toolUseId: use.id,
    toolName: use.name,
    risk,
    input,
    workspace: ctx.thread.workspace,
    taskContext: lastUserText(messages),
    // A company agent works alone: writing in its own vault (its workspace) doesn't wait for anyone. Commands still ask,
    // and anything that goes out goes through its boss and the user (publish).
    autoApprove: [...(ctx.company ? [...(profile.autoApproveTools ?? []), ...COMPANY_AUTO_APPROVE] : (profile.autoApproveTools ?? [])), ...(ctx.autoApprove ?? [])],
    preview,
    signal: ctx.signal,
    broker: ctx.approvals,
    setState: (status, note) => setToolState(ctx, use.id, { status, note }),
    rememberAlwaysAllow: ctx.rememberAlwaysAllow,
    boss: bossOf(ctx)
  })
  const trail = (outcome: 'ok' | 'denied' | 'error', action: string): void => {
    const own = builtin?.auditAction ? { action: builtin.auditAction, detail: { ...audited, ...(authorization.via ? { via: authorization.via } : {}) } } : undefined
    toolTrail({ risk, name: use.name, input, threadId: ctx.thread.id, agentId: profile.id, note: authorization.note }, outcome, action, own)
  }
  if (!authorization.allowed) {
    trail('denied', 'tool.authorize')
    setToolState(ctx, use.id, { status: 'denied', note: authorization.note })
    return errorResult(use.id, authorization.denial)
  }

  setToolState(ctx, use.id, { status: 'running', note: authorization.note })
  try {
    let content: string
    let isError = false
    let said: ToolText | undefined
    if (builtin) {
      // Fresh settings: they may have changed while the call waited for approval.
      content = await builtin.run(input, { ...toolContext, settings: ctx.getSettings(), reportText: (text) => (said = capParams(text)) })
    } else {
      const result = await ctx.mcp.call(use.name, input, ctx.signal)
      content = result.text
      isError = result.isError
    }
    trail(isError ? 'error' : 'ok', 'tool.run')
    setToolState(ctx, use.id, { status: isError ? 'error' : 'done', note: authorization.note })
    return { type: 'tool_result', tool_use_id: use.id, content: truncateMiddle(content, builtin?.maxResultChars), ...(isError ? { is_error: true } : {}), ...(said ? { i18n: said } : {}) }
  } catch (error) {
    const text: ToolText | string = error instanceof ToolError ? error.text : { key: 'tool.error', params: { data: (error as Error).message } }
    trail('error', 'tool.run')
    setToolState(ctx, use.id, { status: 'error', note: authorization.note })
    return errorResult(use.id, text)
  }
}

async function delegate(use: ToolUse, ctx: RunContext): Promise<ToolResult> {
  const parsed = DelegateInput.safeParse(use.input)
  if (!parsed.success) {
    setToolState(ctx, use.id, { status: 'error', note: translate(ctx.language, 'toolstate.invalidInput') })
    return errorResult(use.id, JSON.stringify({ INVALID_JSON: JSON.stringify(use.input) }))
  }
  const { agent, title, task } = parsed.data
  const profile = ctx.getSettings().agents.find((a) => a.id === agent)
  if (!profile) {
    setToolState(ctx, use.id, { status: 'error', note: translate(ctx.language, 'toolstate.unknownAgent') })
    return errorResult(use.id, { key: 'tool.delegate.noAgent', params: { agent } })
  }

  const run: SubagentRun = {
    id: use.id,
    agentId: profile.id,
    agentName: profile.name,
    title,
    task,
    status: 'running',
    startedAt: Date.now(),
    messages: [{ role: 'user', content: [{ type: 'text', text: task }], ts: Date.now() }]
  }
  ctx.thread.subagents[use.id] = run
  ctx.emit({ type: 'subagent.started', threadId: ctx.thread.id, run })
  setToolState(ctx, use.id, { status: 'running', note: profile.name })
  ctx.persist()

  try {
    const result = await runAgent(profile, run.messages, {
      ...ctx,
      scope: { threadId: ctx.thread.id, subagentId: use.id },
      depth: ctx.depth + 1
    })
    run.status = ctx.signal.aborted ? 'cancelled' : 'done'
    setToolState(ctx, use.id, { status: run.status === 'done' ? 'done' : 'denied', note: profile.name })
    return {
      type: 'tool_result',
      tool_use_id: use.id,
      content: truncateMiddle(result || '(the subagent finished without a text answer)')
    }
  } catch (error) {
    run.status = ctx.signal.aborted ? 'cancelled' : 'error'
    setToolState(ctx, use.id, { status: 'error', note: profile.name })
    return errorResult(use.id, { key: 'tool.delegate.failed', params: { name: profile.name, error: (error as Error).message } })
  } finally {
    run.endedAt = Date.now()
    ctx.emit({ type: 'subagent.finished', threadId: ctx.thread.id, subagentId: use.id, status: run.status })
    ctx.persist()
  }
}
