// Text Alma writes and stores (thread titles, company logs, meeting minutes, the memory header): in the language in
// effect when it is written, and never rewritten afterwards (spec 025 BR-26). Pure, so both languages are tested.
import type { Language } from '../shared/i18n/language'
import { translate } from '../shared/i18n/messages'
import type { TaskStatus } from '../shared/types'

export const routineThreadTitle = (language: Language, name: string, when: string): string => `${translate(language, 'thread.routinePrefix')}${name} · ${when}`

export const houseThreadTitle = (language: Language, rule: string, at: string): string => `${translate(language, 'thread.housePrefix')}${rule} · ${at}`

export const memoryHeader = (language: Language): string => translate(language, 'knowledge.memoryHeader')

export type CompanyLog =
  | { kind: 'assigned'; title: string; assignee: string }
  | { kind: 'commented'; title: string }
  | { kind: 'moved'; title: string; status: TaskStatus }
  | { kind: 'blocked'; title: string; text: string }
  | { kind: 'delivered'; title: string }
  | { kind: 'approved'; title: string }
  | { kind: 'returnedToBoard'; title: string; revisions: number }
  | { kind: 'changesRequested'; title: string }
  | { kind: 'escalated'; message: string }
  | { kind: 'started'; title: string }
  | { kind: 'consulted'; to: string }
  | { kind: 'meetingScheduled'; topic: string; date: string }
  | { kind: 'meetingCancelled'; topic: string }
  | { kind: 'meetingPreparing'; topic: string }
  | { kind: 'meetingStarted'; topic: string }
  | { kind: 'meetingClosed'; topic: string; decisions: number; actions: number }

/** One line of a company's activity log. */
export function companyLog(language: Language, entry: CompanyLog): string {
  switch (entry.kind) {
    case 'assigned':
      return translate(language, 'log.assigned', { title: entry.title, assignee: entry.assignee })
    case 'commented':
      return translate(language, 'log.commented', { title: entry.title })
    case 'moved':
      return translate(language, 'log.moved', { title: entry.title, status: translate(language, `task.status.${entry.status}`) })
    case 'blocked':
      return translate(language, 'log.blocked', { title: entry.title, text: entry.text })
    case 'delivered':
      return translate(language, 'log.delivered', { title: entry.title })
    case 'approved':
      return translate(language, 'log.approved', { title: entry.title })
    case 'returnedToBoard':
      return translate(language, 'log.returnedToBoard', { title: entry.title, count: entry.revisions })
    case 'changesRequested':
      return translate(language, 'log.changesRequested', { title: entry.title })
    case 'escalated':
      return translate(language, 'log.escalated', { message: entry.message })
    case 'started':
      return translate(language, 'log.started', { title: entry.title })
    case 'consulted':
      return translate(language, 'log.consulted', { to: entry.to })
    case 'meetingScheduled':
      return translate(language, 'log.meetingScheduled', { topic: entry.topic, date: entry.date })
    case 'meetingCancelled':
      return translate(language, 'log.meetingCancelled', { topic: entry.topic })
    case 'meetingPreparing':
      return translate(language, 'log.meetingPreparing', { topic: entry.topic })
    case 'meetingStarted':
      return translate(language, 'log.meetingStarted', { topic: entry.topic })
    case 'meetingClosed':
      return translate(language, 'log.meetingClosed', {
        topic: entry.topic,
        decisions: translate(language, 'log.decisionCount', { count: entry.decisions }),
        actions: translate(language, 'log.taskCount', { count: entry.actions })
      })
  }
}

export interface MinutesInput {
  topic: string
  /** Already formatted for the language (C8). */
  date: string
  chair: string
  participants: { name: string; prep?: string }[]
  summary: string
  decisions: string[]
  actions: { title: string; owner: string; due?: string }[]
  transcript: { speaker: string; text: string }[]
}

/** The minutes of a meeting as a markdown note: headings follow the language, what people said stays as said. */
export function minutesNote(language: Language, minutes: MinutesInput): string {
  const none = `- ${translate(language, 'minutes.none')}`
  return [
    `# ${minutes.topic}`,
    translate(language, 'minutes.header', { date: minutes.date, chair: minutes.chair }),
    translate(language, 'minutes.participants', { names: minutes.participants.map((p) => p.name).join(', ') }),
    `## ${translate(language, 'minutes.summary')}`,
    minutes.summary,
    `## ${translate(language, 'minutes.decisions')}`,
    ...(minutes.decisions.length ? minutes.decisions.map((d) => `- ${d}`) : [none]),
    `## ${translate(language, 'minutes.tasks')}`,
    ...(minutes.actions.length ? minutes.actions.map((a) => `- [ ] ${a.title} — ${a.owner}${a.due ? ` ${translate(language, 'minutes.due', { due: a.due })}` : ''}`) : [none]),
    `## ${translate(language, 'minutes.prep')}`,
    ...minutes.participants.map((p) => `### ${p.name}\n${p.prep ?? translate(language, 'minutes.notPrepared')}`),
    `## ${translate(language, 'minutes.transcript')}`,
    ...minutes.transcript.map((turn) => `**${turn.speaker}:** ${turn.text}`)
  ].join('\n\n')
}

export const summaryFailed = (language: Language, message: string): string => translate(language, 'minutes.summaryFailed', { message })
