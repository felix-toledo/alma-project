// What the company engine says to its agents: task runs, reviews, meeting preparation and turns, the minutes. English
// whatever the app language (spec 025 BR-17). Names and what people wrote go in as they are.
import type { Language } from '../../shared/i18n/language'
import { replyLanguageRule } from './system'

export interface TaskPromptInput {
  company: string
  id: string
  title: string
  description?: string
  due?: string
  askedBy: string
  previousResult?: string
  comments: { author: string; text: string }[]
}

export const taskPrompt = (t: TaskPromptInput): string =>
  [
    `You have this task from the board of ${t.company}:`,
    `Task ${t.id}: ${t.title}`,
    t.description,
    t.due ? `Due: ${t.due}` : '',
    `Asked by ${t.askedBy}.`,
    t.previousResult ? `Your previous delivery:\n${t.previousResult}` : '',
    t.comments.length ? `Comments (the latest rules):\n${t.comments.map((c) => `- ${c.author}: ${c.text}`).join('\n')}` : '',
    'Do it from start to finish with your tools. When done, call update_task with status "review" (or "done" if you assigned it to yourself) and in result a summary of what you did and where it ended up (vault paths). If you cannot go on, update_task with status "blocked" and why.'
  ]
    .filter(Boolean)
    .join('\n\n')

export interface ReviewPromptInput {
  id: string
  title: string
  description?: string
  assignee: string
  result?: string
  comments: { author: string; text: string }[]
}

export const reviewPrompt = (t: ReviewPromptInput): string =>
  [
    `Review this delivery from your team and decide with review_task (approve, or changes with what to fix).`,
    `Task ${t.id}: ${t.title}`,
    t.description && `Request:\n${t.description}`,
    `Delivery from ${t.assignee}:\n${t.result ?? '(no text)'}`,
    t.comments.length ? `Comments:\n${t.comments.map((c) => `- ${c.author}: ${c.text}`).join('\n')}` : '',
    'Check that it meets the request and the company goal, that the data have a source and that nothing is made up. If it is fine, approve it without fuss.'
  ]
    .filter(Boolean)
    .join('\n\n')

const agendaList = (agenda: string[]): string => agenda.map((a, i) => `${i + 1}. ${a}`).join('\n')

export const meetingPrepPrompt = (m: { when: string; company: string; topic: string; agenda: string[]; participants: string[] }): string =>
  [
    `On ${m.when} there is a ${m.company} meeting: “${m.topic}”.`,
    `Agenda:\n${agendaList(m.agenda)}`,
    `Participants: ${m.participants.join(', ')}.`,
    'Prepare your part: find out with your tools what you need (tasks, data, vault, web) and answer with your points for the meeting in no more than 12 lines: progress, data with their source, problems and concrete proposals. You do not need to do the work now.'
  ].join('\n\n')

export const meetingSystem = (profilePrompt: string, company: string, name: string, language: Language): string =>
  `${profilePrompt}\n\nYou are in a ${company} meeting as ${name}. You speak in the first person, briefly (at most 120 words), without repeating what was already said and without courtesy greetings. If the Board (the user) spoke, answer them first.\n\n${replyLanguageRule('unattended', language)}`

export const meetingTurnPrompt = (m: { topic: string; agenda: string[]; prepared?: string; transcript: string; instruction: string }): string =>
  [
    `Meeting: “${m.topic}”. Agenda:\n${agendaList(m.agenda)}`,
    m.prepared ? `What you prepared:\n${m.prepared}` : '',
    m.transcript ? `What has been said so far:\n${m.transcript}` : '',
    m.instruction
  ]
    .filter(Boolean)
    .join('\n\n')

export const MEETING_BOARD_SPOKE = 'The Board has just spoken: answer them and, if it changes anything in the meeting, say so.'
export const MEETING_OPEN = 'Open the meeting: the goal in one sentence, and start with the first point.'
export const meetingNextPoint = (i: number, point: string): string => `Move on to point ${i}: “${point}”.`
export const meetingMemberPoint = (i: number, point: string): string => `Point ${i}: “${point}”. Contribute your part.`
export const meetingClosePoint = (i: number): string => `Close point ${i}: what is decided and who does what.`

export const askPrompt = (from: string, question: string): string => `${from} asks you:\n\n${question}\n\nAnswer concretely and with sources if you give data.`

export const MINUTES_SYSTEM = 'You write the minutes of a meeting. Answer ONLY with valid JSON, with no text around it.'

export const minutesPrompt = (m: { topic: string; company: string; roster: string; transcript: string }): string =>
  `Meeting “${m.topic}” of ${m.company}.\nParticipants (id = name):\n${m.roster}\n\nTranscript:\n${m.transcript}\n\nReturn {"summary": "3-5 sentences", "decisions": ["…"], "actions": [{"owner": "id of a participant", "title": "…", "description": "what exactly to do", "due": "date or empty"}]}. Only actions that were agreed.`
