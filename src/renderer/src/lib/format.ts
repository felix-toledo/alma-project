import type { Language } from '../../../shared/i18n/language'
import { isMessageKey, type MessageKey } from '../../../shared/i18n/messages'
import { namesOf } from '../../../shared/i18n/names'
import type { AgentProfile, ApprovalMode } from '../../../shared/types'
import type { T } from '../i18n/useT'

const MODES: ApprovalMode[] = ['needs-approval', 'auto-review', 'always-allow', 'blocked']

export const approvalModes = (t: T): { value: ApprovalMode; label: string; hint: string }[] =>
  MODES.map((value) => ({ value, label: t(`approval.${value}.label`), hint: t(`approval.${value}.hint`) }))

export function relativeTime(ts: number, t: T): string {
  const seconds = Math.round((Date.now() - ts) / 1000)
  if (seconds < 60) return t('time.now')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('time.minutes', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('time.hours', { count: hours })
  const days = Math.round(hours / 24)
  return days === 1 ? t('time.yesterday') : t('time.days', { count: days })
}

export function agentName(agents: AgentProfile[], id: string): string {
  return agents.find((a) => a.id === id)?.name ?? id
}

export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** The vault note a knowledge tool call is about, so the chat can link to it. */
export function knowledgeNotePath(name: string, input: unknown, result: string | undefined, language: Language = 'es'): string | undefined {
  const data = (input ?? {}) as Record<string, unknown>
  if (name === 'read_note' && typeof data.path === 'string') return data.path
  // `remember` says which file it wrote; otherwise the memory file under the app language's name.
  if (name === 'remember' || name === 'forget') return result ? (/\bin (Alma\/[^\s)]+\.md)\)\.?$/.exec(result)?.[1] ?? `Alma/${namesOf('names.memoryFile')[language]}`) : undefined
  if (name === 'save_knowledge') return result ? /(\S+\.md)\b/.exec(result)?.[1] : undefined
  return undefined
}

export function toolLabel(name: string, t: T): string {
  const key = `toolLabel.${name}`
  // Only the tool labels take no params, so the cast is safe for any key under `toolLabel.`
  if (isMessageKey(key)) return t(key as Extract<MessageKey, `toolLabel.${string}`>)
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name
}

/** One-line summary of a tool call's input for the collapsed card. */
export function toolSummary(name: string, input: unknown, t: T): string {
  const data = (input ?? {}) as Record<string, unknown>
  const pick = (key: string): string => (typeof data[key] === 'string' ? (data[key] as string) : '')
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return pick('path')
    case 'list_dir':
      return pick('path') || '.'
    case 'search_files':
      return `${pick('pattern')}${pick('glob') ? `  (${pick('glob')})` : ''}`
    case 'run_command':
      return pick('command')
    case 'delegate_task':
      return pick('title')
    case 'generate_image':
      return pick('prompt').slice(0, 140)
    case 'compose_image':
      return [pick('template'), pick('title')].filter(Boolean).join(' · ').slice(0, 140)
    case 'instagram_publish':
      return pick('caption').split('\n')[0].slice(0, 140)
    case 'search_knowledge':
    case 'web_search':
      return pick('query')
    case 'fetch_url':
      return pick('url')
    case 'office_read':
    case 'office_create':
    case 'office_edit':
    case 'excalidraw_read':
    case 'excalidraw_draw':
      return pick('path')
    case 'assign_task':
    case 'schedule_meeting':
      return pick('title') || pick('topic')
    case 'ask_colleague':
      return pick('question').slice(0, 140)
    case 'escalate':
      return pick('message').slice(0, 140)
    case 'email_search':
      return pick('query') || t('toolSummary.recentMails')
    case 'email_send':
      return `${pick('to')} · ${pick('subject')}`.slice(0, 140)
    case 'send_whatsapp':
      return `${pick('to')} · ${pick('text')}`.slice(0, 140)
    case 'send_telegram':
      return pick('text').slice(0, 140)
    case 'read_note':
      return pick('path')
    case 'save_knowledge':
      return pick('title')
    case 'remember':
    case 'forget':
      return pick('text')
    default: {
      const text = JSON.stringify(data)
      return text === '{}' ? '' : text.slice(0, 120)
    }
  }
}

/** Old routine titles started with an emoji; they are shown without it. */
export const threadTitle = (title: string, t: T): string => title.replace(/^\u{1F501}\s*/u, t('thread.routinePrefix'))
