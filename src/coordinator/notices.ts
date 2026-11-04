// Titles and bodies of what the coordinator tells the person (desktop and Telegram). Pure, so they are tested in both
// languages; the caller passes the language in effect when the event happened.
import type { Language } from '../shared/i18n/language'
import { translate } from '../shared/i18n/messages'

export interface Notice {
  title: string
  body: string
}

export function approvalNotice(language: Language, approval: { toolName: string; caption?: string }, threadTitle: string): Notice {
  if (approval.toolName === 'instagram_publish') return { title: translate(language, 'notice.approval.instagram'), body: approval.caption || threadTitle }
  return { title: translate(language, 'notice.approval.agent'), body: threadTitle }
}

export function reminderNotice(language: Language, prompt: string): Notice {
  return { title: translate(language, 'notice.reminder'), body: prompt }
}

export function routineNotice(language: Language, name: string, outcome: { ok: true; threadTitle: string } | { ok: false; message: string }): Notice {
  return outcome.ok
    ? { title: translate(language, 'notice.routine.done', { name }), body: outcome.threadTitle }
    : { title: translate(language, 'notice.routine.failed', { name }), body: outcome.message }
}

export function ruleFailedNotice(language: Language, name: string, message: string): Notice {
  return { title: translate(language, 'notice.rule.failed', { name }), body: message }
}

export function watchEndedNotice(language: Language, camera: string, checks: number, condition: string): Notice {
  return { title: translate(language, 'notice.watch.ended', { camera }), body: translate(language, 'notice.watch.endedBody', { checks, condition }) }
}

export function watchMatchNotice(language: Language, camera: string, condition: string, note?: string): Notice {
  return { title: `${camera}: ${condition}`, body: note ?? translate(language, 'notice.watch.matched') }
}

export type CompanyNotice =
  | { kind: 'budget'; level: '100' | '80'; company: string; who: string; used: number; cap: number }
  | { kind: 'stuck'; company: string; title: string; revisions: number }
  | { kind: 'delivery'; company: string; title: string; who: string }
  | { kind: 'meeting'; company: string; topic: string }

export function companyNotice(language: Language, notice: CompanyNotice): Notice {
  switch (notice.kind) {
    case 'budget': {
      const out = notice.level === '100'
      return {
        title: translate(language, out ? 'notice.company.budgetOut' : 'notice.company.budget80', { company: notice.company }),
        body: translate(language, out ? 'notice.company.spentOut' : 'notice.company.spentWarn', { who: notice.who, used: notice.used.toFixed(2), cap: notice.cap })
      }
    }
    case 'stuck':
      return {
        title: translate(language, 'notice.company.stuck', { company: notice.company }),
        body: translate(language, 'notice.company.stuckBody', { title: notice.title, count: notice.revisions })
      }
    case 'delivery':
      return {
        title: translate(language, 'notice.company.delivery', { company: notice.company }),
        body: translate(language, 'notice.company.deliveryBody', { title: notice.title, who: notice.who })
      }
    case 'meeting':
      return {
        title: translate(language, 'notice.company.meeting', { company: notice.company }),
        body: translate(language, 'notice.company.meetingBody', { topic: notice.topic })
      }
  }
}
