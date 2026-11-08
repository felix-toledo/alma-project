import { parentOf } from '../../shared/vault/paths'

export const NAV_ORDER = ['chat', 'notes', 'home', 'cameras', 'settings'] as const
export type Tab = (typeof NAV_ORDER)[number]

/** `current` is the list's mark: this is the conversation the Chat tab writes to (so it follows live and shows the Chat approvals); `title` is the list's, for the header. */
export type ChatPlace = { view: 'top' } | { view: 'conversations' } | { view: 'conversation'; id: string; current?: boolean; title?: string }
export type NotesPlace = { view: 'folder'; path: string } | { view: 'note'; path: string }

/** Where the person is: the tab, and the place inside the two tabs that have levels. Memory only, never stored (BR-26). */
export interface NavState {
  tab: Tab
  chat: ChatPlace
  notes: NotesPlace
}

export type NavAction =
  | { type: 'tab'; tab: Tab }
  | { type: 'openConversations' }
  | { type: 'openConversation'; id: string; current?: boolean; title?: string }
  | { type: 'openFolder'; path: string }
  | { type: 'openNote'; path: string }
  | { type: 'back' }

export const initialNav = (): NavState => ({ tab: 'chat', chat: { view: 'top' }, notes: { view: 'folder', path: '' } })

/**
 * One step. Switching tab keeps the other tabs' places as they were; a drill-down applies only in its own tab. `back` goes up
 * one level (note to its folder, folder to its parent, conversation to the list, the list to Chat) and, at a top level,
 * is not consumed: `leave` tells the shell to let the system's back leave the app (AC-6.2).
 */
export function navReduce(state: NavState, action: NavAction): { state: NavState; leave: boolean } {
  const to = (change: Partial<NavState>): { state: NavState; leave: boolean } => ({ state: { ...state, ...change }, leave: false })
  const stay = to({})
  switch (action.type) {
    case 'tab':
      return NAV_ORDER.includes(action.tab) ? to({ tab: action.tab }) : stay
    case 'openConversations':
      return state.tab === 'chat' ? to({ chat: { view: 'conversations' } }) : stay
    case 'openConversation':
      return state.tab === 'chat' ? to({ chat: { view: 'conversation', id: action.id, current: action.current, title: action.title } }) : stay
    case 'openFolder':
      return state.tab === 'notes' ? to({ notes: { view: 'folder', path: action.path } }) : stay
    case 'openNote':
      return state.tab === 'notes' ? to({ notes: { view: 'note', path: action.path } }) : stay
    case 'back': {
      if (state.tab === 'chat' && state.chat.view === 'conversation') return to({ chat: { view: 'conversations' } })
      if (state.tab === 'chat' && state.chat.view === 'conversations') return to({ chat: { view: 'top' } })
      if (state.tab === 'notes' && state.notes.view === 'note') return to({ notes: { view: 'folder', path: parentOf(state.notes.path) } })
      if (state.tab === 'notes' && state.notes.path !== '') return to({ notes: { view: 'folder', path: parentOf(state.notes.path) } })
      return { state, leave: true }
    }
  }
}
