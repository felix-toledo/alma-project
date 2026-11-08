import { navReduce, type NavState, type Tab } from './nav'

const levels = (path: string): number => path.split('/').filter(Boolean).length

/** How many levels below the top of its tab the person is: the number of back steps `navReduce` needs to get to the top. */
export function placeDepth(state: NavState, tab: Tab): number {
  if (tab === 'chat') return state.chat.view === 'top' ? 0 : state.chat.view === 'conversations' ? 1 : 2
  if (tab === 'notes') return levels(state.notes.path)
  return 0
}

/**
 * The entries a step adds to the system history: one per level gone down, owned by the tab. A tab switch adds none, and neither
 * does a link that goes up or sideways, so the entries never run out before the places do. Extra ones are dead (see `systemBack`).
 */
export function entriesToPush(before: NavState, after: NavState): Tab[] {
  if (before.tab !== after.tab) return []
  return Array<Tab>(Math.max(0, placeDepth(after, after.tab) - placeDepth(before, before.tab))).fill(after.tab)
}

/**
 * The system back popped the newest entry, owned by `owner`: that tab goes up one level and the screen follows it, even from
 * another tab, so a drilled view is never skipped on the way out. `dead` is an entry with nothing left to climb (the shell pops on).
 */
export function systemBack(state: NavState, owner: Tab | undefined): { state: NavState; dead: boolean } {
  if (!owner) return { state, dead: true }
  const step = navReduce({ ...state, tab: owner }, { type: 'back' })
  return step.leave ? { state, dead: true } : { state: step.state, dead: false }
}
