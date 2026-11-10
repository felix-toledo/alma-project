import { canAnswerFrom } from '../../../shared/companyAuthoring'
import { REMOTE_LIMITS } from '../../../shared/remote/api'
import type { ApprovalView, PendingApproval, Settings } from '../../../shared/types'
import type { RunTies } from './runs'

/**
 * What the approvals flow needs from the coordinator (wired for real in T35):
 * the existing broker and the current shared remote thread. `respondApproval`
 * cannot express 'always': the phone answers once, allow or deny (BR-12).
 */
export interface ApprovalsDeps {
  pendingApprovals(): PendingApproval[]
  respondApproval(approvalId: string, decision: 'allow' | 'deny'): void
  /** The id of the shared remote thread. */
  threadId(): string
  /** Which device started which run: a conversation's approvals belong to the device that started its run (BR-20). */
  ties: RunTies
  settings(): Settings
}

function cutInput(input: unknown): string {
  const text = JSON.stringify(input, null, 1)
  return text.length > REMOTE_LIMITS.approvalInputChars ? `${text.slice(0, REMOTE_LIMITS.approvalInputChars)}…` : text
}

function viewOf(approval: PendingApproval, shared: string): ApprovalView {
  const reason = approval.reasonShown ?? approval.reason
  return {
    id: approval.approvalId,
    tool: approval.toolName,
    input: cutInput(approval.input),
    flagged: approval.flagged,
    ...(reason !== undefined ? { reason } : {}),
    ...(approval.threadId !== shared ? { thread: approval.threadId } : {}),
    question: approval.flagged ? 'chan.flagged' : 'chan.allowQuestion',
    whole: canAnswerFrom('phone', approval, REMOTE_LIMITS.approvalInputChars)
  }
}

/**
 * The approve scope as a front-end onto the existing approval broker (BR-12):
 * the phone lists and answers the shared remote thread's approvals (every device, as 026) and those of a run
 * the asking device started in a conversation by id, through the same first-answer-wins broker every other
 * surface uses.
 */
export class ApprovalsFlow {
  constructor(private readonly deps: ApprovalsDeps) {}

  /** The shared thread's approvals and the ones of this device's own by-id run; nothing else (AC-5.6, AC-3.15, AC-3.16). */
  list(deviceId: string): ApprovalView[] {
    const shared = this.deps.threadId()
    return this.deps
      .pendingApprovals()
      .filter((approval) => approval.threadId === shared || this.deps.ties.ownerOf(approval.threadId) === deviceId)
      .map((approval) => viewOf(approval, shared))
  }

  /** The device's run is stuck on an approval it may not answer here (approve scope off): say so, not "busy forever" (AC-3.9). */
  waiting(deviceId: string, threadId: string): boolean {
    if (this.deps.settings().remote.scopes.approve) return false
    return this.deps.ties.ownerOf(threadId) === deviceId && this.deps.pendingApprovals().some((approval) => approval.threadId === threadId)
  }

  /**
   * Answers through the broker. Anything not pending on the current thread —
   * unknown, already answered elsewhere, of another thread or another device's run, or lost to a restart —
   * answers the same: already-answered (AC-5.6, AC-5.7, AC-8.3). Another thread's
   * id is indistinguishable from an unknown one, so ids do not leak threads.
   */
  answer(deviceId: string, approvalId: string, decision: 'allow' | 'deny'): 'ok' | 'already-answered' {
    const view = this.list(deviceId).find((row) => row.id === approvalId)
    // A proposal the phone could not show whole is left pending for the desktop; Rechazar still goes through (spec 029 BR-23).
    if (!view || (decision === 'allow' && !view.whole)) return 'already-answered'
    this.deps.respondApproval(approvalId, decision)
    return 'ok'
  }
}
