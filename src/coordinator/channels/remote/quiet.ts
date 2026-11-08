import type { LiveEvent, PendingApproval } from '../../../shared/types'

type Listen = (listener: (event: LiveEvent) => void) => () => void
type Respond = (approvalId: string, decision: 'allow' | 'deny' | 'always') => void

/**
 * Keeps a conversation the phone is running quiet in Telegram, WhatsApp and the voice assistant (spec 028 BR-34):
 * those channels react to the events of their bound thread, so a run the phone started there would send the
 * approval prompt (tool and input) to that chat or speak it, and an answer from there would resolve it. The wrap
 * goes between the coordinator and each channel; the channels themselves are untouched.
 */
export function quietForPhoneRuns(startedByPhone: (threadId: string) => boolean, pending: () => PendingApproval[]): { onEvent(source: Listen): Listen; respondApproval(inner: Respond): Respond } {
  return {
    // The prompt and the streamed text are what a channel would send or speak; the PC windows get every event untouched.
    onEvent: (source) => (listener) =>
      source((event) => {
        const threadId = event.type === 'approval.request' ? event.approval.threadId : event.type === 'stream.text' || event.type === 'stream.tool' ? event.scope.threadId : undefined
        if (threadId === undefined || !startedByPhone(threadId)) listener(event)
      }),
    respondApproval: (inner) => (approvalId, decision) => {
      const thread = pending().find((approval) => approval.approvalId === approvalId)?.threadId
      if (thread === undefined || !startedByPhone(thread)) inner(approvalId, decision)
    }
  }
}
