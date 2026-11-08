import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en } from '../src/remote-client/i18n/en'
import { es } from '../src/remote-client/i18n/es'
import { translatePwa } from '../src/remote-client/i18n'
import { FAILURES, OPERATIONS, outcomeKey, retryOffered, type Failure, type Operation } from '../src/remote-client/lib/outcome'
import { LOADING_THRESHOLD_MS, nextScreenState, showLoading, startScreen, type ScreenEvent } from '../src/remote-client/lib/screen-state'

describe('PWA text (028 AC-6.8)', () => {
  it('AC-6.8 (028) translatePwa interpolates {version} and leaves other text alone', () => {
    expect(translatePwa('en', 'remote.pwa.version', { version: '1.4.2' })).toBe('Version 1.4.2')
    expect(translatePwa('es', 'remote.pwa.version', { version: '1.4.2' })).toBe('Versión 1.4.2')
    // No params: the text comes back as written, even a stray {name}.
    expect(translatePwa('en', 'remote.pwa.version')).toBe('Version {version}')
    expect(translatePwa('en', 'remote.pwa.stop')).toBe('Stop')
    // An unknown name stays; a value is inserted as text, not re-expanded.
    expect(translatePwa('en', 'remote.pwa.version', { other: 'x' })).toBe('Version {version}')
    expect(translatePwa('en', 'remote.pwa.version', { version: '{version}' })).toBe('Version {version}')
    expect(translatePwa('en', 'remote.pwa.version', { version: '$&' })).toBe('Version $&')
  })
})

function refusalsInApi(): string[] {
  const source = readFileSync(join(__dirname, '..', 'src', 'shared', 'remote', 'api.ts'), 'utf8')
  const block = /export type Refusal =([\s\S]*?)\r?\n\r?\n/.exec(source)?.[1] ?? ''
  return [...block.matchAll(/'([a-z-]+)'/g)].map((match) => match[1])
}

describe('PWA outcomes (028 AC-6.3, AC-6.6)', () => {
  it('AC-6.3 (028) every refusal and network outcome maps to exactly one key per operation', () => {
    const refusals = refusalsInApi()
    expect(refusals.length).toBeGreaterThan(15)
    // A new Refusal in api.ts with no entry here fails this list, not only the type check.
    expect([...FAILURES].sort()).toEqual([...refusals, 'network', 'not-delivered'].sort())
    for (const reason of FAILURES) {
      for (const operation of OPERATIONS) {
        const key = outcomeKey(reason, operation)
        expect(typeof key, `${reason} ${operation}`).toBe('string')
        expect(es[key], `${key} in es`).toBeTruthy()
        expect(en[key], `${key} in en`).toBeTruthy()
      }
    }
  })

  it('AC-2.2 AC-2.14 AC-3.2 AC-3.5 (028) the concrete causes name their own text', () => {
    expect(outcomeKey('unavailable', 'notes.read')).toBe('remote.pwa.note.unavailable')
    expect(outcomeKey('gone', 'notes.read')).toBe('remote.pwa.note.gone')
    expect(outcomeKey('too-large', 'notes.read')).toBe('remote.pwa.noteTooBig')
    expect(outcomeKey('too-large', 'notes.image')).toBe('remote.pwa.photoTooBig')
    expect(outcomeKey('unsupported', 'notes.read')).toBe('remote.pwa.file.unsupported')
    expect(outcomeKey('gone', 'threads.read')).toBe('remote.pwa.thread.gone')
    expect(outcomeKey('gone', 'threads.send')).toBe('remote.pwa.thread.gone')
    expect(outcomeKey('busy', 'threads.send')).toBe('remote.pwa.thread.busy')
    expect(outcomeKey('run-active', 'threads.send')).toBe('remote.pwa.run.active')
    expect(outcomeKey('write-off', 'threads.send')).toBe('remote.pwa.writeOff')
    expect(outcomeKey('too-large', 'threads.send')).toBe('remote.pwa.tooLong')
    expect(outcomeKey('scope-off', 'notes.list')).toBe('remote.pwa.scopeOff')
    expect(outcomeKey('unknown-device', 'status')).toBe('remote.pwa.revoked')
    expect(outcomeKey('network', 'threads.list')).toBe('remote.pwa.pcUnreachable')
    expect(outcomeKey('invalid', 'notes.find')).toBe('remote.pwa.error.invalid')
  })

  it('AC-6.6 (028) retry only for unreachable and failed loads, never for scope-off, revoked, too big or rate-limited', () => {
    expect(retryOffered('network')).toBe(true)
    for (const reason of ['scope-off', 'write-off', 'sensitive-off', 'unknown-device', 'too-large', 'rate-limited', 'unsupported'] as const) {
      expect(retryOffered(reason), reason).toBe(false)
    }
    // Rate limited names the wait: the text says to wait, it is not a retry button.
    expect(es[outcomeKey('rate-limited', 'notes.read')]).toMatch(/Esper/)
    expect(en[outcomeKey('rate-limited', 'notes.read')]).toMatch(/Wait/)
  })
})

describe('PWA screen states (028 AC-6.3, AC-6.4, AC-6.5, AC-1.6, AC-4.2)', () => {
  const ok = (data: string[]): ScreenEvent<string[]> => ({ type: 'content', data })
  const failed = (reason: Failure, operation: Operation = 'notes.read'): ScreenEvent<string[]> => ({ type: 'failed', reason, operation })

  it('AC-6.3 (028) loading shows only after the threshold', () => {
    const loading = startScreen<string[]>(1000)
    expect(loading).toEqual({ kind: 'loading', since: 1000 })
    expect(showLoading(loading, 1000 + LOADING_THRESHOLD_MS - 1)).toBe(false)
    expect(showLoading(loading, 1000 + LOADING_THRESHOLD_MS)).toBe(true)
    // Only a loading state ever shows the skeleton.
    expect(showLoading({ kind: 'content', data: ['x'] }, 99999)).toBe(false)
    expect(showLoading({ kind: 'empty' }, 99999)).toBe(false)
  })

  it('AC-6.3 (028) every outcome lands in exactly one of the five states', () => {
    let state = startScreen<string[]>(0)
    expect(nextScreenState(state, ok(['a']), 1)).toEqual({ kind: 'content', data: ['a'] })
    expect(nextScreenState(state, { type: 'empty' }, 1)).toEqual({ kind: 'empty' })
    expect(nextScreenState(state, failed('scope-off'), 1)).toEqual({ kind: 'scopeOff', key: 'remote.pwa.scopeOff' })
    expect(nextScreenState(state, failed('write-off', 'threads.send'), 1)).toEqual({ kind: 'scopeOff', key: 'remote.pwa.writeOff' })
    expect(nextScreenState(state, failed('network'), 1)).toEqual({ kind: 'unreachable' })
    expect(nextScreenState(state, failed('unknown-device'), 1)).toEqual({ kind: 'revoked' })
    expect(nextScreenState(state, failed('too-large'), 1)).toEqual({ kind: 'error', key: 'remote.pwa.noteTooBig', retry: false })
    expect(nextScreenState(state, failed('rate-limited'), 1)).toEqual({ kind: 'error', key: 'remote.pwa.rateLimited', retry: false })
    state = nextScreenState(state, failed('invalid'), 1)
    expect(state).toEqual({ kind: 'error', key: 'remote.pwa.error.invalid', retry: false })
  })

  it('AC-1.6 (028) content is dropped on scope-off, revoked and unreachable', () => {
    const content = nextScreenState(startScreen<string[]>(0), ok(['secret note']), 1)
    for (const reason of ['scope-off', 'write-off', 'unknown-device', 'network', 'unavailable'] as const) {
      expect(JSON.stringify(nextScreenState(content, failed(reason), 2)), reason).not.toContain('secret note')
    }
    // A revoked phone stays revoked: a late answer cannot bring content back.
    const revoked = nextScreenState(content, failed('unknown-device'), 2)
    expect(nextScreenState(revoked, ok(['late']), 3)).toEqual({ kind: 'revoked' })
    expect(nextScreenState(revoked, { type: 'start' }, 3)).toEqual({ kind: 'revoked' })
  })

  it('AC-6.5 (028) a scope turned off and on again changes the state without a reload', () => {
    let state = nextScreenState(startScreen<string[]>(0), ok(['a']), 1)
    state = nextScreenState(state, failed('scope-off'), 2)
    expect(state.kind).toBe('scopeOff')
    state = nextScreenState(state, { type: 'start' }, 3)
    expect(state).toEqual({ kind: 'loading', since: 3 })
    state = nextScreenState(state, ok(['a']), 4)
    expect(state).toEqual({ kind: 'content', data: ['a'] })
    // The live follow can also recover on its own: unreachable, then an answer.
    state = nextScreenState(state, failed('network'), 5)
    expect(nextScreenState(state, ok(['b']), 6)).toEqual({ kind: 'content', data: ['b'] })
  })

  it('AC-4.2 (028) re-entering a screen starts a new load and drops what was shown', () => {
    const content = nextScreenState(startScreen<string[]>(0), ok(['old']), 1)
    const again = nextScreenState(content, { type: 'start' }, 50)
    expect(again).toEqual({ kind: 'loading', since: 50 })
    expect(JSON.stringify(again)).not.toContain('old')
  })

  it('AC-6.4 (028) the typed message survives unreachable: the state carries no draft and no event touches one', () => {
    const unreachable = nextScreenState(startScreen<string[]>(0), failed('network', 'threads.send'), 1)
    expect(Object.keys(unreachable)).toEqual(['kind'])
    // Retry is the caller's `start`; the reducer takes no text, so it cannot clear any.
    expect(nextScreenState(unreachable, { type: 'start' }, 2)).toEqual({ kind: 'loading', since: 2 })
  })
})
