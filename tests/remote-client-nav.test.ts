import { describe, expect, it } from 'vitest'
import { entriesToPush, placeDepth, systemBack } from '../src/remote-client/lib/history'
import { initialNav, NAV_ORDER, navReduce, type NavAction, type NavState, type Tab } from '../src/remote-client/lib/nav'

const run = (actions: NavAction[], from: NavState = initialNav()): NavState => actions.reduce((state, action) => navReduce(state, action).state, from)

describe('PWA navigation (028 AC-6.1, AC-6.2)', () => {
  it('AC-6.1 (028) order is Chat, Notes, Home, Cameras, Settings', () => {
    expect([...NAV_ORDER]).toEqual(['chat', 'notes', 'home', 'cameras', 'settings'])
    expect(initialNav().tab).toBe('chat')
  })

  it('AC-6.2 (028) back from a note goes to its folder, up folder by folder, and at the top asks the shell to leave', () => {
    let state = run([{ type: 'tab', tab: 'notes' }, { type: 'openFolder', path: 'Docs' }, { type: 'openFolder', path: 'Docs/Ideas' }, { type: 'openNote', path: 'Docs/Ideas/a.md' }])
    expect(state.notes).toEqual({ view: 'note', path: 'Docs/Ideas/a.md' })
    let step = navReduce(state, { type: 'back' })
    expect(step.leave).toBe(false)
    expect(step.state.notes).toEqual({ view: 'folder', path: 'Docs/Ideas' })
    step = navReduce(step.state, { type: 'back' })
    expect(step.state.notes).toEqual({ view: 'folder', path: 'Docs' })
    step = navReduce(step.state, { type: 'back' })
    expect(step.state.notes).toEqual({ view: 'folder', path: '' })
    expect(step.leave).toBe(false)
    // The top level: nothing to go up to, the shell lets the system leave.
    step = navReduce(step.state, { type: 'back' })
    expect(step.leave).toBe(true)
    expect(step.state.notes).toEqual({ view: 'folder', path: '' })
    // A note opened from search or a link returns to its own folder, not to where the person was.
    state = run([{ type: 'tab', tab: 'notes' }, { type: 'openNote', path: 'Otro/b.md' }])
    expect(navReduce(state, { type: 'back' }).state.notes).toEqual({ view: 'folder', path: 'Otro' })
    state = run([{ type: 'tab', tab: 'notes' }, { type: 'openNote', path: 'raiz.md' }])
    expect(navReduce(state, { type: 'back' }).state.notes).toEqual({ view: 'folder', path: '' })
  })

  it('AC-6.2 (028) back from a conversation goes to the list, then to Chat, then leaves', () => {
    let state = run([{ type: 'openConversations' }, { type: 'openConversation', id: 't1' }])
    expect(state.chat).toEqual({ view: 'conversation', id: 't1' })
    let step = navReduce(state, { type: 'back' })
    expect(step.state.chat).toEqual({ view: 'conversations' })
    expect(step.leave).toBe(false)
    step = navReduce(step.state, { type: 'back' })
    expect(step.state.chat).toEqual({ view: 'top' })
    expect(step.leave).toBe(false)
    expect(navReduce(step.state, { type: 'back' }).leave).toBe(true)
    // Every other tab is at its top already.
    state = run([{ type: 'tab', tab: 'home' }])
    expect(navReduce(state, { type: 'back' }).leave).toBe(true)
  })

  it('AC-3.11 (028) an opened conversation remembers whether the list marked it as the one the Chat tab writes to', () => {
    expect(run([{ type: 'openConversations' }, { type: 'openConversation', id: 't1', current: true }]).chat).toEqual({ view: 'conversation', id: 't1', current: true })
    expect(run([{ type: 'openConversations' }, { type: 'openConversation', id: 't2', current: false, title: 'Plan' }]).chat).toEqual({ view: 'conversation', id: 't2', current: false, title: 'Plan' })
  })

  it('AC-6.2 (028) changing tab keeps the other tab place while the app is open, and only then', () => {
    let state = run([{ type: 'openConversations' }, { type: 'openConversation', id: 't1' }, { type: 'tab', tab: 'notes' }, { type: 'openNote', path: 'Docs/a.md' }])
    state = run([{ type: 'tab', tab: 'home' }, { type: 'tab', tab: 'chat' }], state)
    expect(state.chat).toEqual({ view: 'conversation', id: 't1' })
    state = run([{ type: 'tab', tab: 'notes' }], state)
    expect(state.notes).toEqual({ view: 'note', path: 'Docs/a.md' })
    // Nothing is persisted: a new session starts at the top of Chat with every place reset.
    expect(initialNav()).toEqual({ tab: 'chat', chat: { view: 'top' }, notes: { view: 'folder', path: '' } })
    // The same tab again, and an unknown tab, change nothing.
    expect(navReduce(state, { type: 'tab', tab: 'notes' }).state).toEqual(state)
    expect(navReduce(state, { type: 'tab', tab: 'nope' as never }).state).toEqual(state)
  })

  it('AC-6.2 (028) a drill-down in a tab the person is not on is ignored', () => {
    const home = run([{ type: 'tab', tab: 'home' }])
    expect(navReduce(home, { type: 'openNote', path: 'a.md' }).state).toEqual(home)
    expect(navReduce(home, { type: 'openConversation', id: 't1' }).state).toEqual(home)
    expect(navReduce(initialNav(), { type: 'openFolder', path: 'x' }).state).toEqual(initialNav())
    expect(navReduce(home, { type: 'back' }).leave).toBe(true)
  })
})

describe('PWA system history (028 AC-6.2)', () => {
  it('AC-6.2 (028) a drill-down pushes one entry per level, a tab switch pushes none', () => {
    expect(placeDepth(initialNav(), 'chat')).toBe(0)
    const folder = run([{ type: 'tab', tab: 'notes' }, { type: 'openFolder', path: 'Docs/Ideas' }])
    expect(placeDepth(folder, 'notes')).toBe(2)
    expect(placeDepth(run([{ type: 'openConversations' }, { type: 'openConversation', id: 't1' }]), 'chat')).toBe(2)
    expect(placeDepth(initialNav(), 'home')).toBe(0)
    // A note opened from a result climbs all its levels at once, so back has as many entries as it has steps.
    const atRoot = run([{ type: 'tab', tab: 'notes' }])
    const opened = run([{ type: 'openNote', path: 'Docs/Ideas/a.md' }], atRoot)
    expect(entriesToPush(atRoot, opened)).toEqual(['notes', 'notes', 'notes'])
    expect(entriesToPush(initialNav(), run([{ type: 'openConversations' }]))).toEqual(['chat'])
    // Tab switches, and links that go up or sideways, add nothing.
    expect(entriesToPush(opened, run([{ type: 'tab', tab: 'home' }], opened))).toEqual([])
    expect(entriesToPush(opened, run([{ type: 'openNote', path: 'Docs/b.md' }], opened))).toEqual([])
  })

  it('AC-6.2 (028) the system back unwinds the newest drill-down, also from another tab, and never leaves while one is open', () => {
    let nav = run([{ type: 'tab', tab: 'notes' }, { type: 'openNote', path: 'Docs/Ideas/a.md' }])
    const owners: Tab[] = entriesToPush(run([{ type: 'tab', tab: 'notes' }]), nav)
    nav = run([{ type: 'tab', tab: 'chat' }], nav)
    expect(owners).toHaveLength(3)
    // Three presses of back, one entry each: the notes place climbs to the root and the screen follows it.
    const places: string[] = []
    for (const owner of [...owners].reverse()) {
      const step = systemBack(nav, owner)
      expect(step.dead).toBe(false)
      nav = step.state
      places.push(`${nav.tab}:${nav.notes.view}:${nav.notes.path}`)
    }
    expect(places).toEqual(['notes:folder:Docs/Ideas', 'notes:folder:Docs', 'notes:folder:'])
  })

  it('AC-6.2 (028) an entry whose place is already at the top is dead: the state stays and the shell goes on', () => {
    const nav = run([{ type: 'tab', tab: 'notes' }])
    expect(systemBack(nav, 'notes')).toEqual({ state: nav, dead: true })
    expect(systemBack(nav, undefined)).toEqual({ state: nav, dead: true })
    const chat = run([{ type: 'openConversations' }])
    expect(systemBack(chat, 'chat').state.chat).toEqual({ view: 'top' })
  })
})
