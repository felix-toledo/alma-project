import { describe, expect, it } from 'vitest'
import { en } from '../src/remote-client/i18n/en'
import { es } from '../src/remote-client/i18n/es'
import { dictionaryDiff } from './support/dictionaries'

describe('T40 PWA dictionaries (AC-9.3, BR-20)', () => {
  it('AC-9.3 the PWA dictionaries match', () => {
    expect(dictionaryDiff(es, en)).toEqual({ onlyInA: [], onlyInB: [] })
  })

  it('AC-6.8 (028) parity holds for every key of spec 028 section 6.1 and plan 3.9', () => {
    const required = [
      'tab.notes', 'vault.none', 'folder.empty', 'note.unavailable', 'note.gone', 'noteTooBig', 'file.unsupported', 'notes.noMatch',
      'threads.title', 'threads.none', 'thread.gone', 'thread.current', 'thread.busy', 'thread.waiting', 'run.active', 'writeOff',
      'loadMore', 'loadEarlier', 'retry', 'loading', 'back', 'connection.ok', 'can.title', 'can.approve', 'can.sensitive', 'can.continue',
      'version', 'can.chat', 'can.home', 'can.cameras', 'can.notes', 'can.threads', 'can.on', 'can.off', 'notes.title', 'notes.find',
      'nav', 'thread.compose', 'error.invalid'
    ].map((key) => `remote.pwa.${key}`)
    for (const key of required) {
      expect(Object.keys(es), key).toContain(key)
      expect(Object.keys(en), key).toContain(key)
    }
    expect(dictionaryDiff(es, en)).toEqual({ onlyInA: [], onlyInB: [] })
  })

  it('the diff fixture: a missing key is reported on its side', () => {
    const keys = Object.keys(es) as (keyof typeof es)[]
    expect(keys.length).toBeGreaterThan(0)
    const dropped = Object.fromEntries(keys.slice(1).map((key) => [key, es[key]]))
    expect(dictionaryDiff(dropped, en)).toEqual({ onlyInA: [], onlyInB: [keys[0]] })
  })
})
