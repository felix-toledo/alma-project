// What the code itself says on Telegram and WhatsApp (the agent's own answers follow the person's language, not
// this). Pure and in the app language of the moment, so both channels share it and the tests can read it.
import type { Language } from '../../shared/i18n/language'
import { translate } from '../../shared/i18n/messages'
import type { PendingApproval } from '../../shared/types'

const INPUT_LIMIT = 1500

/** The approval question as plain text; WhatsApp adds how to answer it. */
export function approvalPrompt(language: Language, approval: PendingApproval, options: { askYesNo?: boolean } = {}): string {
  const input = JSON.stringify(approval.input, null, 1)
  return [
    translate(language, approval.flagged ? 'chan.flagged' : 'chan.allowQuestion'),
    approval.reason ?? '',
    translate(language, 'chan.tool', { name: approval.toolName }),
    input.length > INPUT_LIMIT ? `${input.slice(0, INPUT_LIMIT)}…` : input,
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
