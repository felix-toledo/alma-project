import type { PhoneAttachmentView } from '../attach/phone'

/** What the narrow API returns for notes, conversations and status (spec 028). Types only, so the phone can import it. */

export interface NoteEntry {
  name: string
  kind: 'file' | 'folder'
  size: number
  mtime: number
}
export interface NoteList {
  folder: string
  entries: NoteEntry[]
}
/** No active vault is a state, not a refusal. */
export type NoteListResult = { vault: 'none' } | NoteList
export interface NoteFound {
  path: string
  name: string
}
/** The name search answers the whole reachable vault; no vault is a state here too. */
export type NoteFindResult = { vault: 'none' } | { found: NoteFound[] }
export interface NoteText {
  path: string
  content: string
  mtime: number
}
export interface NoteImage {
  /** Base64 of the bytes, like a camera still. */
  photo: string
  mediaType: string
}

export interface ThreadRow {
  id: string
  title: string
  agentId: string
  /** The name of the agent that answers (the id when the PC no longer knows it). */
  agentName: string
  channel?: string
  updatedAt: number
  /** The shared remote thread the Chat tab writes into. */
  current: boolean
}
export interface ThreadPage {
  rows: ThreadRow[]
  more: boolean
}
export interface ThreadWindow {
  rev: number
  running: boolean
  /** The running run was started by the asking device, the only one that can stop it. */
  ownRun: boolean
  waiting: boolean
  messages: { index: number; role: 'user' | 'assistant'; text: string; at: number; attachments?: PhoneAttachmentView[] }[]
  /** More messages exist before the first one returned. */
  earlier: boolean
}

export interface StatusView {
  scopes: Record<'chat' | 'approve' | 'home' | 'cameras' | 'vault' | 'history', boolean>
  sensitive: boolean
  continue: boolean
  /** The send-files sub-switch, counted only while Chat is on (spec 031 AC-1.9). A PC that predates it omits the key: the phone reads that as off. */
  sendFiles?: boolean
  /** The morning greeting's conversation, once per device after delivery and only with History on (spec 033 BR-29). */
  landing?: string
}
