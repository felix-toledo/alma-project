import type { AgentProfile, Language, LiveEvent, PendingApproval, ProviderId, Settings, ToolText } from '../shared/types'
import { translate } from '../shared/i18n/messages'
import { APPROVAL_INPUT_LIMIT, canAnswerFrom, type AnswerChannel } from '../shared/companyAuthoring'
import { autoReviewPrompt, BOSS_SYSTEM, bossReviewPrompt, REVIEW_SYSTEM } from './prompts/review'
import { getProvider } from './providers'
import { reviewerReasonForDisplay } from './reviewer-reason'
import type { ToolRisk } from './tools/types'

export type Decision = 'allow' | 'deny' | 'always'

/** The answer and the channel it came through; a run that was stopped settles as a deny with no channel. */
export interface Answer {
  decision: Decision
  via?: AnswerChannel
}

interface Waiter {
  approval: PendingApproval
  resolve(answer: Answer): void
}

/** Holds tool calls waiting for the user's answer in the UI. */
export class ApprovalBroker {
  private waiting = new Map<string, Waiter>()

  constructor(private emit: (event: LiveEvent) => void) {}

  /** `asked` gets the id as soon as the card is out, for what arrives later (the translated reason). */
  ask(approval: Omit<PendingApproval, 'approvalId'>, signal: AbortSignal, asked?: (approvalId: string) => void): Promise<Decision> {
    return this.askAnswer(approval, signal, asked).then((answer) => answer.decision)
  }

  /** The same as `ask`, with the channel the answer came through. */
  askAnswer(approval: Omit<PendingApproval, 'approvalId'>, signal: AbortSignal, asked?: (approvalId: string) => void): Promise<Answer> {
    const approvalId = crypto.randomUUID()
    const full: PendingApproval = { ...approval, approvalId }
    return new Promise<Answer>((resolve) => {
      const settle = (answer: Answer): void => {
        if (!this.waiting.delete(approvalId)) return
        signal.removeEventListener('abort', onAbort)
        this.emit({ type: 'approval.resolved', approvalId })
        resolve(answer)
      }
      const onAbort = (): void => settle({ decision: 'deny' })
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiting.set(approvalId, { approval: full, resolve: settle })
      this.emit({ type: 'approval.request', approval: full })
      asked?.(approvalId)
    })
  }

  /** The card keeps the reviewer's English and swaps to this when it arrives. */
  setReasonShown(approvalId: string, reasonShown: string): void {
    const waiter = this.waiting.get(approvalId)
    if (!waiter) return
    waiter.approval = { ...waiter.approval, reasonShown }
    this.emit({ type: 'approval.reason', approvalId, reasonShown })
  }

  /** A channel that could not show the whole input of a company tool cannot allow it (spec 029 BR-23): the approval stays pending. */
  respond(approvalId: string, decision: Decision, via: AnswerChannel): void {
    const waiter = this.waiting.get(approvalId)
    if (!waiter) return
    if (decision !== 'deny' && !canAnswerFrom(via, waiter.approval, APPROVAL_INPUT_LIMIT)) return
    waiter.resolve({ decision, via })
  }

  pending(): PendingApproval[] {
    return [...this.waiting.values()].map((waiter) => waiter.approval)
  }
}

export interface AuthorizationRequest {
  settings: Settings
  threadId: string
  subagentId?: string
  toolUseId: string
  toolName: string
  risk: ToolRisk
  input: unknown
  workspace: string
  /** The user's latest request, so auto-review can judge whether the action fits the task. */
  taskContext: string
  /** Tools the running agent may use without asking (per-agent setting). */
  autoApprove: string[]
  preview?: PendingApproval['preview']
  signal: AbortSignal
  broker: ApprovalBroker
  /** The language the run started in: the notes and denials of this call keep it even if the setting changes meanwhile (spec 025 AC-1.8). Without it, the setting of the moment. */
  language?: Language
  setState(state: 'pending-approval' | 'reviewing', note?: string): void
  rememberAlwaysAllow(toolName: string): void
  /** In a company, the agent's boss sees what goes out first; only if they agree does it reach the user. */
  boss?: { name: string; profile: AgentProfile }
}

/** A refusal also carries what the model is told (English) and what the card shows, as one key (BR-18). */
export type Authorization = ({ allowed: true; note: string } | { allowed: false; note: string; denial: ToolText }) & {
  /** The channel the person answered through, when someone did and the caller named it. */
  via?: AnswerChannel
}

function deny(language: Language, why: 'blocked' | 'cancelled' | 'rejectedByYou'): Authorization {
  return { allowed: false, note: translate(language, `approval.note.${why}`), denial: { key: `tool.denied.${why}` } }
}

async function autoReview(request: AuthorizationRequest): Promise<{ verdict: 'allow' | 'flag'; reason: string }> {
  const { autoReview: config } = request.settings
  const provider = getProvider(config.provider, request.settings)
  const prompt = autoReviewPrompt(request, config.instructions)
  return provider.review({ model: config.model, system: REVIEW_SYSTEM, prompt, signal: request.signal })
}

async function askUser(request: AuthorizationRequest, flagged: boolean, reason?: string, allowAlways = true, source?: { provider: ProviderId; model: string }): Promise<Authorization> {
  const language = request.language ?? request.settings.language
  request.setState('pending-approval', reason)
  const { decision, via } = await request.broker.askAnswer(
    {
      threadId: request.threadId,
      subagentId: request.subagentId,
      toolUseId: request.toolUseId,
      toolName: request.toolName,
      input: request.input,
      flagged,
      reason,
      allowAlways,
      ...(request.preview ? { preview: request.preview } : {})
    },
    request.signal,
    // Under es the reviewer's English reason is translated lazily and the card swaps to it when it arrives.
    (approvalId) => {
      if (!reason || !source || language !== 'es') return
      void reviewerReasonForDisplay(reason, language, getProvider(source.provider, request.settings), source.model, request.signal).then((shown) => {
        if (shown !== reason) request.broker.setReasonShown(approvalId, shown)
      })
    }
  )
  const answered = (authorization: Authorization): Authorization => (via ? { ...authorization, via } : authorization)
  if (decision === 'always' && allowAlways) {
    request.rememberAlwaysAllow(request.toolName)
    return answered({ allowed: true, note: translate(language, 'approval.note.alwaysAllowed') })
  }
  if (decision === 'always') return answered({ allowed: true, note: translate(language, 'approval.note.approvedByYou') })
  if (decision === 'allow') return answered({ allowed: true, note: translate(language, 'approval.note.approvedByYou') })
  return answered(deny(language, request.signal.aborted ? 'cancelled' : 'rejectedByYou'))
}

/** The boss's verdict on an outgoing action, in their own voice (their instructions shape the judgment). */
async function bossReview(request: AuthorizationRequest): Promise<{ verdict: 'allow' | 'flag'; reason: string }> {
  const { profile } = request.boss!
  const provider = getProvider(profile.provider, request.settings)
  const prompt = bossReviewPrompt(request, profile.systemPrompt)
  return provider.review({ model: profile.model, system: BOSS_SYSTEM, prompt, signal: request.signal })
}

/**
 * Applies the approval mode to one tool call. Read-only tools never need approval; publishing always does,
 * whatever the mode or rules, because it acts in the user's name outside this computer.
 */
export async function authorize(request: AuthorizationRequest): Promise<Authorization> {
  const { settings } = request
  const language = request.language ?? settings.language
  if (request.risk === 'read') return { allowed: true, note: translate(language, 'approval.note.readOnly') }
  if (settings.approvalMode === 'blocked') return deny(language, 'blocked')
  if (request.risk === 'memory') return { allowed: true, note: translate(language, 'approval.note.memory') }
  if (request.risk === 'home') return { allowed: true, note: translate(language, 'approval.note.home') }
  if (request.risk === 'publish') {
    if (!request.boss) return askUser(request, false, undefined, false)
    request.setState('reviewing', translate(language, 'approval.note.reviewing', { name: request.boss.name }))
    try {
      const verdict = await bossReview(request)
      if (verdict.verdict === 'flag') {
        const params = { name: request.boss.name, reason: verdict.reason }
        return { allowed: false, note: translate(language, 'approval.note.rejectedBy', params), denial: { key: 'tool.denied.rejectedBy', params } }
      }
      return askUser(request, false, translate(language, 'approval.note.approvedBy', { name: request.boss.name, reason: verdict.reason }), false)
    } catch (error) {
      if (request.signal.aborted) return deny(language, 'cancelled')
      return askUser(request, false, translate(language, 'approval.note.reviewFailed', { name: request.boss.name, message: (error as Error).message }), false)
    }
  }
  if (request.autoApprove.includes(request.toolName)) return { allowed: true, note: translate(language, 'approval.note.forAgent') }
  if (settings.alwaysAllowTools.includes(request.toolName)) return { allowed: true, note: translate(language, 'approval.note.byRule') }

  switch (settings.approvalMode) {
    case 'always-allow':
      return { allowed: true, note: translate(language, 'approval.note.alwaysMode') }
    case 'auto-review': {
      request.setState('reviewing')
      try {
        const verdict = await autoReview(request)
        if (verdict.verdict === 'allow') return { allowed: true, note: translate(language, 'approval.note.autoReview', { reason: verdict.reason }) }
        return askUser(request, true, verdict.reason, true, { provider: settings.autoReview.provider, model: settings.autoReview.model })
      } catch (error) {
        if (request.signal.aborted) return deny(language, 'cancelled')
        return askUser(request, false, translate(language, 'approval.note.autoReviewDown', { message: (error as Error).message }))
      }
    }
    case 'needs-approval':
    default:
      return askUser(request, false)
  }
}
