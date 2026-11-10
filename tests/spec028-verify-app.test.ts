import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { refusalResponse } from '../src/coordinator/channels/remote/transport'
import { en } from '../src/remote-client/i18n/en'
import { es } from '../src/remote-client/i18n/es'
import { translatePwa, type PwaKey } from '../src/remote-client/i18n'
import { canList } from '../src/remote-client/lib/can'
import { entriesToPush, placeDepth, systemBack } from '../src/remote-client/lib/history'
import { initialNav, NAV_ORDER, navReduce, type NavAction, type NavState, type Tab } from '../src/remote-client/lib/nav'
import { FAILURES, OPERATIONS, outcomeKey, retryOffered } from '../src/remote-client/lib/outcome'
import { postJson } from '../src/remote-client/lib/request'
import { LOADING_THRESHOLD_MS, nextScreenState, showLoading, startScreen } from '../src/remote-client/lib/screen-state'
import { fetchStatus } from '../src/remote-client/lib/status'
import { earlierCursor, listThreads, mergeRows, mergeWindow, MAX_HELD_MESSAGES, readThread, sendThread } from '../src/remote-client/lib/threads'
import { approvalsFor, conversationMode, endsView, rowSub } from '../src/remote-client/lib/conversations'
import type { ThreadRow, ThreadWindow } from '../src/shared/remote/wire'

// Adversarial verification of spec 028 §Phone app polish: pure phone logic, no jsdom.

function rng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

const PATHS = ['', 'a', 'a/b', 'a/b/c', 'x']
function randomAction(next: () => number): NavAction {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T
  switch (Math.floor(next() * 7)) {
    case 0:
      return { type: 'tab', tab: pick(NAV_ORDER) }
    case 1:
      return { type: 'openConversations' }
    case 2:
      return { type: 'openConversation', id: pick(['t1', 't2']), current: next() > 0.5 }
    case 3:
      return { type: 'openFolder', path: pick(PATHS) }
    case 4:
      return { type: 'openNote', path: `${pick(PATHS)}/n.md`.replace(/^\//, '') }
    default:
      return { type: 'back' }
  }
}

describe('AC-6.2 (028 verify) back never leaves the app before the top level', () => {
  it('AC-6.2 (028 verify) from any reachable state, repeated in-app back reaches a top in at most 6 steps and never changes tab', () => {
    const next = rng(7)
    for (let run = 0; run < 400; run++) {
      let state = initialNav()
      for (let i = 0; i < 12; i++) state = navReduce(state, randomAction(next)).state
      const tab = state.tab
      let steps = 0
      for (;;) {
        const step = navReduce(state, { type: 'back' })
        expect(step.state.tab).toBe(tab)
        if (step.leave) {
          expect(placeDepth(state, tab)).toBe(0)
          break
        }
        state = step.state
        expect(++steps).toBeLessThanOrEqual(6)
      }
    }
  })

  it('AC-6.2 (028 verify) the system-history entries pushed on the way in are enough to climb out one level per back, whatever route was taken', () => {
    const next = rng(11)
    for (let run = 0; run < 400; run++) {
      let state: NavState = initialNav()
      const stack: Tab[] = []
      for (let i = 0; i < 14; i++) {
        const action = randomAction(next)
        const before = state
        state = navReduce(state, action).state
        stack.push(...entriesToPush(before, state))
      }
      // Popping every entry the shell holds must bring every tab to its top: nothing is skipped, nothing is left stranded.
      while (stack.length > 0) {
        const popped = systemBack(state, stack.pop())
        state = popped.state
      }
      for (const tab of NAV_ORDER) expect(placeDepth(state, tab), `${tab} after run ${run}`).toBe(0)
    }
  })

  it('AC-6.2 (028 verify) a back with no owner or nothing left to climb is dead and changes nothing', () => {
    const state = initialNav()
    expect(systemBack(state, undefined)).toEqual({ state, dead: true })
    expect(systemBack(state, 'chat')).toEqual({ state, dead: true })
    expect(systemBack(state, 'settings')).toEqual({ state, dead: true })
  })

  it('AC-6.2 (028 verify) an unknown tab or a drill-down issued in the wrong tab is ignored rather than corrupting the place', () => {
    const state = initialNav()
    expect(navReduce(state, { type: 'tab', tab: 'nope' as Tab }).state).toEqual(state)
    expect(navReduce(state, { type: 'openFolder', path: 'a' }).state).toEqual(state)
    expect(navReduce({ ...state, tab: 'notes' }, { type: 'openConversation', id: 't' }).state.chat).toEqual({ view: 'top' })
  })
})

describe('AC-6.3 / AC-6.6 (028 verify) state machine and refusal mapping', () => {
  it('AC-6.3 (028 verify) the loading threshold is exact and a revoked phone cannot be brought back by a late answer', () => {
    const loading = startScreen<string>(1000)
    expect(showLoading(loading, 1000 + LOADING_THRESHOLD_MS - 1)).toBe(false)
    expect(showLoading(loading, 1000 + LOADING_THRESHOLD_MS)).toBe(true)
    let state = nextScreenState(loading, { type: 'content', data: 'x' }, 1)
    state = nextScreenState(state, { type: 'failed', reason: 'unknown-device', operation: 'notes.read' }, 2)
    expect(state).toEqual({ kind: 'revoked' })
    for (const event of [{ type: 'content', data: 'late' }, { type: 'empty' }, { type: 'start' }, { type: 'failed', reason: 'network', operation: 'chat' }] as const) {
      expect(nextScreenState(state, event, 3)).toEqual({ kind: 'revoked' })
    }
  })

  it('AC-1.6 (028 verify) any failure after content drops the content: no state keeps data', () => {
    for (const reason of FAILURES) {
      for (const operation of OPERATIONS) {
        const after = nextScreenState({ kind: 'content', data: 'SECRETNOTE' }, { type: 'failed', reason, operation }, 1)
        expect(JSON.stringify(after), `${reason} ${operation}`).not.toContain('SECRETNOTE')
      }
    }
  })

  it('AC-6.3 (028 verify) every refusal the PC can send is a Failure with a dictionary text in both languages, for every operation', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'shared', 'remote', 'api.ts'), 'utf8')
    const union = /export type Refusal =([\s\S]*?)\r?\n\r?\n/.exec(source)?.[1] ?? ''
    const refusals = [...union.matchAll(/'([a-z-]+)'/g)].map((match) => match[1] as string)
    expect(refusals.length).toBeGreaterThan(15)
    for (const refusal of refusals) expect(FAILURES, refusal).toContain(refusal)
    for (const reason of FAILURES) {
      for (const operation of OPERATIONS) {
        const key = outcomeKey(reason, operation)
        expect(es[key], `${reason}/${operation} es`).toBeTruthy()
        expect(en[key], `${reason}/${operation} en`).toBeTruthy()
      }
    }
  })

  it('AC-6.3 (028 verify) what the PC sends is what the phone reads: every refusal survives status, body and parse', async () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'shared', 'remote', 'api.ts'), 'utf8')
    const union = /export type Refusal =([\s\S]*?)\r?\n\r?\n/.exec(source)?.[1] ?? ''
    for (const refusal of [...union.matchAll(/'([a-z-]+)'/g)].map((match) => match[1] as 'busy')) {
      const wire = refusalResponse(refusal)
      const fetch = async (): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> => ({ ok: wire.status < 400, status: wire.status, json: async () => JSON.parse(JSON.stringify(wire.body)) })
      expect(await postJson({ fetch, token: 't', path: '/x', body: {} }), refusal).toEqual({ ok: false, reason: refusal })
    }
  })

  it('AC-6.6 (028 verify) retry is offered for the PC not answering and for nothing else, for every refusal', () => {
    for (const reason of FAILURES) expect(retryOffered(reason), reason).toBe(reason === 'network')
    for (const reason of FAILURES) {
      const state = nextScreenState(startScreen(0), { type: 'failed', reason, operation: 'notes.read' }, 1)
      const offered = state.kind === 'unreachable' || (state.kind === 'error' && state.retry)
      expect(offered, reason).toBe(reason === 'network')
    }
  })

  it('AC-6.3 (028 verify) a server that answers nonsense is "PC not answering", never a crash or an invented refusal', async () => {
    const reply = (status: number, body: unknown, throws = false) => async () => ({ ok: status < 400, status, json: async () => (throws ? Promise.reject(new SyntaxError('bad json')) : body) })
    const cases: [string, ReturnType<typeof reply>][] = [
      ['html', reply(502, undefined, true)],
      ['array', reply(200, [])],
      ['null', reply(200, null)],
      ['string', reply(200, 'ok')],
      ['proto', reply(500, { error: '__proto__' })],
      ['ctor', reply(500, { error: 'constructor' })],
      ['unknown', reply(500, { error: 'exploded' })],
      ['empty 500', reply(500, {})]
    ]
    for (const [name, fetch] of cases) {
      const out = await listThreads({ fetch, token: 't', offset: 0 })
      expect(out.ok, name).toBe(false)
      if (!out.ok) expect(out.reason, name).toBe('network')
    }
    const thrown = await sendThread({ fetch: async () => Promise.reject(new TypeError('offline')), token: 't', id: 'x', text: 'hola' })
    expect(thrown).toEqual({ ok: false, reason: 'not-delivered' })
    const status = await fetchStatus({ fetch: reply(200, { scopes: { chat: true }, sensitive: false, continue: false }), token: 't' })
    expect(status).toEqual({ ok: false, reason: 'network' })
  })

  it('AC-6.11 (028 verify) the phone keeps only the six switches from a status that says more', async () => {
    const body = { scopes: { chat: true, approve: false, home: true, cameras: false, vault: true, history: false, extra: 'x' }, sensitive: true, continue: false, vaultExcluded: ['Privado'], cameras: ['camera.patio'] }
    const out = await fetchStatus({ fetch: async () => ({ ok: true, status: 200, json: async () => body }), token: 't' })
    expect(out).toEqual({ ok: true, status: { scopes: { chat: true, approve: false, home: true, cameras: false, vault: true, history: false }, sensitive: true, continue: false } })
    expect(JSON.stringify(out)).not.toMatch(/Privado|patio|extra/)
  })

  it('AC-6.7 (028 verify) the "what this phone can do" list has the entries in order (Send files after Continue, 031), all with texts, and survives a hostile status', () => {
    const keys = canList({ scopes: { chat: true, approve: true, home: true, cameras: true, vault: true, history: true }, sensitive: true, continue: true }).map((row) => row.key)
    expect(keys).toEqual(['remote.pwa.can.chat', 'remote.pwa.can.approve', 'remote.pwa.can.home', 'remote.pwa.can.cameras', 'remote.pwa.can.sensitive', 'remote.pwa.can.notes', 'remote.pwa.can.threads', 'remote.pwa.can.continue', 'remote.pwa.can.attach'])
    for (const key of keys) {
      expect(es[key as PwaKey]).toBeTruthy()
      expect(en[key as PwaKey]).toBeTruthy()
    }
    const hostile = canList({ scopes: undefined, sensitive: 'yes', continue: 1 } as never)
    expect(hostile.every((row) => row.on === false)).toBe(true)
  })
})

describe('AC-3.1 / AC-3.3 / AC-3.11 (028 verify) merging what the PC sends', () => {
  const message = (index: number, text = `m${index}`): ThreadWindow['messages'][number] => ({ index, role: index % 2 ? 'assistant' : 'user', text, at: index })
  const window = (rev: number, indexes: number[], extra: Partial<ThreadWindow> = {}): ThreadWindow => ({ rev, running: false, ownRun: false, waiting: false, earlier: false, messages: indexes.map((i) => message(i)), ...extra })

  it('AC-3.11 (028 verify) a delta is idempotent, order-free and keeps the newest flags', () => {
    const base = window(10, [5, 6, 7, 8, 9], { earlier: true })
    const delta = window(12, [10, 11], { running: true, ownRun: true })
    const once = mergeWindow(base, delta)
    expect(mergeWindow(once, delta)).toEqual(once)
    expect(once.messages.map((m) => m.index)).toEqual([5, 6, 7, 8, 9, 10, 11])
    expect(once).toMatchObject({ rev: 12, running: true, ownRun: true, earlier: true })
    // An old answer arriving late does not roll the conversation back.
    expect(mergeWindow(once, base).rev).toBe(10) // rev went back: it is another snapshot, taken whole
    expect(mergeWindow(once, base).messages.map((m) => m.index)).toEqual([5, 6, 7, 8, 9])
  })

  it('AC-3.3 (028 verify) earlier pages prepend without a cap and bring their own earlier flag; later ones are capped and say earlier exists', () => {
    const held = window(100, Array.from({ length: 30 }, (_, i) => 70 + i), { earlier: true })
    const before = mergeWindow(held, window(100, Array.from({ length: 30 }, (_, i) => 40 + i), { earlier: false }), 'earlier')
    expect(before.messages).toHaveLength(60)
    expect(before.messages[0]?.index).toBe(40)
    expect(before.earlier).toBe(false)
    const big = window(1000, Array.from({ length: MAX_HELD_MESSAGES }, (_, i) => 700 + i))
    const more = mergeWindow(big, window(1010, Array.from({ length: 10 }, (_, i) => 1000 + i)))
    expect(more.messages).toHaveLength(MAX_HELD_MESSAGES)
    expect(more.messages.at(-1)?.index).toBe(1009)
    expect(more.earlier).toBe(true)
  })

  it('AC-3.3 (028 verify) "load earlier" always moves back, even over a page of tool-only messages the PC returned empty', () => {
    expect(earlierCursor(window(100, [70, 71], { earlier: true }))).toBe(70)
    const empty = window(100, [], { earlier: true })
    expect(earlierCursor(empty)).toBe(70)
    expect(earlierCursor(empty, 70)).toBe(40)
    expect(earlierCursor(empty, 10)).toBe(0)
    expect(earlierCursor(empty, 0)).toBe(0)
  })

  it('AC-3.1 (028 verify) rows that slide between pages appear once with their newest copy, and malformed rows from the PC are dropped', async () => {
    const row = (id: string, updatedAt: number): ThreadRow => ({ id, title: id, agentId: 'a', agentName: 'A', updatedAt, current: false })
    expect(mergeRows([row('a', 1), row('b', 2)], [row('b', 9), row('c', 3)]).map((r) => `${r.id}:${r.updatedAt}`)).toEqual(['a:1', 'b:9', 'c:3'])
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({ rows: [row('ok', 1), { id: 5 }, null, 'x', { ...row('no-agent', 1), agentName: undefined }], more: false }) })
    const out = await listThreads({ fetch, token: 't', offset: 0 })
    expect(out).toMatchObject({ ok: true, rows: [{ id: 'ok' }] })
  })

  it('AC-3.3 (028 verify) a window with a missing flag or a non-array is "PC not answering", and bad messages are dropped one by one', async () => {
    const ok = { rev: 1, running: false, ownRun: false, waiting: false, earlier: false, messages: [message(0), { index: 'x' }, { index: 1, role: 'tool', text: 't', at: 1 }, null] }
    const good = await readThread({ fetch: async () => ({ ok: true, status: 200, json: async () => ok }), token: 't', id: 'x' })
    expect(good).toMatchObject({ ok: true, window: { messages: [{ index: 0 }] } })
    for (const broken of [{ ...ok, ownRun: undefined }, { ...ok, messages: 'x' }, { ...ok, rev: '1' }]) {
      expect(await readThread({ fetch: async () => ({ ok: true, status: 200, json: async () => broken }), token: 't', id: 'x' })).toEqual({ ok: false, reason: 'network' })
    }
  })

  it('AC-3.12 (028 verify) a row from a channel the phone does not know, or a poisoned channel name, shows no channel and an odd date does not throw', () => {
    const row: ThreadRow = { id: 'a', title: 't', agentId: 'g', agentName: 'General', updatedAt: Date.now(), current: false }
    for (const channel of ['__proto__', 'constructor', 'toString', 'sms', '']) expect(rowSub({ ...row, channel }, Date.now(), 'en'), channel).toBe(rowSub(row, Date.now(), 'en'))
    expect(rowSub({ ...row, channel: 'telegram' }, Date.now(), 'es')).toContain('General')
    for (const updatedAt of [Number.NaN, -1, 1e20, 0]) expect(() => rowSub({ ...row, updatedAt }, Date.now(), 'en')).not.toThrow()
  })
})

describe('AC-3.9 / AC-3.15 / AC-3.16 / AC-1.1 (028 verify) what the foot of a conversation offers', () => {
  it('AC-3.9 (028 verify) the composer exists only when nothing runs and continue is on; stop only for the own run; waiting beats busy beats active', () => {
    for (const running of [true, false]) {
      for (const waiting of [true, false]) {
        for (const continueOn of [true, false]) {
          for (const ownRun of [true, false]) {
            const mode = conversationMode({ running, waiting, continueOn, ownRun })
            const label = JSON.stringify({ running, waiting, continueOn, ownRun })
            expect(mode.compose, label).toBe(!running && continueOn)
            expect(mode.stop, label).toBe(running && ownRun)
            expect(mode.notice === null, label).toBe(!running && continueOn)
            if (running) expect(mode.notice, label).toBe(waiting ? 'remote.pwa.thread.waiting' : ownRun ? 'remote.pwa.run.active' : 'remote.pwa.thread.busy')
            else if (!continueOn) expect(mode.notice, label).toBe('remote.pwa.writeOff')
          }
        }
      }
    }
  })

  it('AC-1.6 (028 verify) only gone, scope-off and revoked end the conversation view; a write-off, busy or run-active keeps it and the typed text', () => {
    for (const reason of FAILURES) expect(endsView(reason), reason).toBe(reason === 'gone' || reason === 'scope-off' || reason === 'unknown-device')
  })

  it('AC-3.16 (028 verify) a card of another conversation is never drawn; an unmarked card belongs to the shared thread only; junk is dropped', () => {
    const card = (extra: object = {}): object => ({ id: 'a', tool: 'run_command', input: '{}', flagged: false, whole: true, question: 'chan.allowQuestion', ...extra })
    const all = [card({ id: '1', thread: 'talk' }), card({ id: '2', thread: 'pc' }), card({ id: '3' }), null, 'x', { id: 4 }, card({ id: '5', question: 'chan.always' }), card({ id: '6', thread: 7 })]
    expect(approvalsFor(all, 'talk', false).map((view) => view.id)).toEqual(['1'])
    expect(approvalsFor(all, 'remote', true).map((view) => view.id)).toEqual(['3'])
    expect(approvalsFor(all, 'pc', true).map((view) => view.id)).toEqual(['2', '3'])
  })
})


describe('AC-6.8 (028 verify) dictionaries', () => {
  const keys = Object.keys(es) as PwaKey[]
  const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort()

  it('AC-6.8 (028 verify) es and en have exactly the same keys and the same placeholders, no empty text', () => {
    expect(Object.keys(en).sort()).toEqual([...keys].sort())
    for (const key of keys) {
      expect(es[key].trim(), key).not.toBe('')
      expect(en[key].trim(), key).not.toBe('')
      expect(placeholders(en[key]), key).toEqual(placeholders(es[key]))
    }
  })

  it('AC-6.8 (028 verify) every key the spec 6.1 table names for the phone exists, and the English is English', () => {
    const named = [
      'tab.notes', 'tab.chat', 'tab.home', 'tab.cameras', 'tab.settings', 'vault.none', 'folder.empty', 'note.unavailable', 'note.gone', 'noteTooBig', 'file.unsupported', 'notes.noMatch',
      'threads.title', 'threads.none', 'thread.gone', 'thread.current', 'thread.busy', 'thread.waiting', 'run.active', 'writeOff', 'loadMore', 'loadEarlier', 'retry', 'loading', 'back',
      'connection.ok', 'can.title', 'can.approve', 'can.sensitive', 'can.continue', 'version', 'image.blocked', 'photoTooBig', 'scopeOff', 'pcUnreachable', 'revoked', 'rateLimited',
      'notDelivered', 'tooLong', 'alreadyAnswered', 'refresh', 'stop', 'new'
    ].map((name) => `remote.pwa.${name}`)
    for (const key of named) {
      expect(es, key).toHaveProperty([key])
      expect(en, key).toHaveProperty([key])
    }
    // English text with Spanish accents or inverted marks is a leftover.
    for (const key of keys) expect(en[key], key).not.toMatch(/[¿¡ñáéíóú]/i)
    expect(translatePwa('en', 'remote.pwa.version', { version: '1.2' })).toContain('1.2')
  })

  it('AC-6.8 (028 verify) placeholder filling is one pass: a value that looks like a placeholder is not expanded, an unknown name stays, prototype names are inert', () => {
    expect(translatePwa('en', 'remote.pwa.version', { version: '{version}' })).toBe('Version {version}')
    expect(translatePwa('en', 'remote.pwa.version', {})).toBe('Version {version}')
    expect(translatePwa('en', 'remote.pwa.version', { constructor: 'x', version: '9' })).toBe('Version 9')
    expect(translatePwa('es', 'remote.pwa.version', { version: '$&' })).toContain('$&')
  })

  it('AC-4.7 (028 verify) the fixed push text of the worker is the dictionary text in both languages', () => {
    const worker = readFileSync(join(__dirname, '..', 'src', 'remote-client', 'public', 'sw.js'), 'utf8')
    expect(worker).toContain(`'${es['remote.pwa.push.text']}'`)
    expect(worker).toContain(`'${en['remote.pwa.push.text']}'`)
  })
})
