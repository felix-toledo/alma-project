// What the code itself says on Telegram and WhatsApp (the agent's own answers follow the person's language, not
// this). Pure and in the app language of the moment, so both channels share it and the tests can read it.
import { APPROVAL_INPUT_LIMIT, canAnswerFrom } from '../../shared/companyAuthoring'
import type { Language } from '../../shared/i18n/language'
import { translate } from '../../shared/i18n/messages'
import type { PendingApproval } from '../../shared/types'

export { APPROVAL_INPUT_LIMIT }

/** The approval question as plain text; WhatsApp adds how to answer it. A company proposal that does not fit is not cut: it is left to the desktop (spec 029 BR-23). */
export function approvalPrompt(language: Language, approval: PendingApproval, options: { askYesNo?: boolean } = {}): string {
  const input = JSON.stringify(approval.input, null, 1)
  const shown = !canAnswerFrom('telegram', approval, APPROVAL_INPUT_LIMIT)
    ? translate(language, 'chan.seeOnDesktop')
    : input.length > APPROVAL_INPUT_LIMIT
      ? `${input.slice(0, APPROVAL_INPUT_LIMIT)}…`
      : input
  return [
    translate(language, approval.flagged ? 'chan.flagged' : 'chan.allowQuestion'),
    approval.reason ?? '',
    translate(language, 'chan.tool', { name: approval.toolName }),
    shown,
    options.askYesNo ? translate(language, 'wa.yesNo') : ''
  ]
    .filter(Boolean)
    .join('\n')
}

export function approvalButtons(language: Language): { allow: string; always: string; deny: string } {
  return { allow: translate(language, 'tg.allow'), always: translate(language, 'tg.always'), deny: translate(language, 'tg.deny') }
}

/** The line Telegram shows briefly after a button press. */
export function approvalToast(language: Language, decision: 'allow' | 'always' | 'deny'): string {
  return translate(language, decision === 'deny' ? 'tg.toastDenied' : 'tg.toastAllowed')
}

/** A Telegram failure in words the person can act on; anything else keeps its own message. */
export function describeTelegramError(language: Language, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/401|unauthorized/i.test(message)) return translate(language, 'tg.tokenInvalid')
  if (/409|conflict/i.test(message)) return translate(language, 'tg.conflict')
  return message
}
