import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en as phoneEn } from '../src/remote-client/i18n/en'
import { es as phoneEs } from '../src/remote-client/i18n/es'
import { en } from '../src/shared/i18n/en'
import { es } from '../src/shared/i18n/es'
import type { Message } from '../src/shared/i18n/messages'
import { defaultRemote } from '../src/shared/remote/settings'

// Spec 031 AC-8.9 (T64): every text the new PC and phone code asks for is defined in es and en. The dictionaries
// themselves are not scanned (they define keys, they do not use them).
const root = join(__dirname, '..')

function sources(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path).flatMap((name) => sources(join(path, name)))
}
const codeFiles = (paths: string[], skip: RegExp) =>
  paths.flatMap((path) => sources(join(root, path))).filter((file) => /\.tsx?$/.test(file) && !skip.test(file.replace(/\\/g, '/')))

/** The phone: every `remote.pwa.*` string literal outside its dictionaries is a key. A key built at run time cannot be checked, so it fails the scan. */
const PHONE_KEY = /['"`](remote\.pwa\.[\w.-]*)['"`]/g
const PHONE_DYNAMIC = /`remote\.pwa\.[^`]*\$\{/
function phoneKeysUsed(text: string): { keys: string[]; dynamic: boolean } {
  return { keys: [...text.matchAll(PHONE_KEY)].map((match) => match[1]), dynamic: PHONE_DYNAMIC.test(text) }
}

/** The PC: a key is what is passed to `t(...)` or `translate(language, ...)` (other `remote.*` strings are message names, not texts). */
const PC_CALL = /\b(?:t|translate)\(\s*(?:[\w.]+,\s*)?(['"`])((?:main\.)?remote\.[\w.${}]+)\1/g
function pcKeysUsed(text: string): string[] {
  return [...text.matchAll(PC_CALL)].map((match) => match[2])
}

/** Keys missing from a dictionary, and keys whose placeholders differ between the two languages. */
function dictionaryGaps(used: Iterable<string>, a: Record<string, Message>, b: Record<string, Message>): { missingIn: { es: string[]; en: string[] }; placeholders: string[] } {
  const holders = (message: Message): string => [...new Set(JSON.stringify(message).match(/\{\w+\}/g) ?? [])].sort().join(',')
  const keys = [...new Set(used)].sort()
  return {
    missingIn: { es: keys.filter((key) => !(key in a)), en: keys.filter((key) => !(key in b)) },
    placeholders: keys.filter((key) => key in a && key in b && holders(a[key]) !== holders(b[key]))
  }
}

describe('the new PC and phone code only asks for texts that exist (spec 031 AC-8.9)', () => {
  it('AC-8.9 (031) every key used by the new phone code is defined in es and en', () => {
    const used = new Set<string>()
    for (const file of codeFiles(['src/remote-client'], /\/i18n\//)) {
      const { keys, dynamic } = phoneKeysUsed(readFileSync(file, 'utf8'))
      expect(dynamic, `${file} builds a phone key at run time; the scan cannot see it`).toBe(false)
      for (const key of keys) used.add(key)
    }
    // the scan finds the code it is meant to guard: the attach feature and the older screens
    expect(used.size).toBeGreaterThan(100)
    for (const key of ['remote.pwa.can.attach', 'remote.pwa.attach.button', 'remote.pwa.attach.kind.image', 'remote.pwa.attach.off']) expect(used.has(key), key).toBe(true)
    const gaps = dictionaryGaps(used, phoneEs, phoneEn)
    expect(gaps.missingIn).toEqual({ es: [], en: [] })
    expect(gaps.placeholders).toEqual([])
  })

  it('AC-8.9 (031) every key used by the new PC code is defined in es and en', () => {
    const used = new Set<string>()
    const scopes = Object.keys(defaultRemote().scopes)
    for (const file of codeFiles(['src/renderer/src/remote', 'src/main/messages.ts'], /$^/)) {
      for (const key of pcKeysUsed(readFileSync(file, 'utf8'))) {
        // the only key built at run time is the scope's name: check every scope
        if (key.includes('${')) {
          expect(key, file).toMatch(/^remote\.scope\.\$\{[\w.]+\}$/)
          for (const scope of scopes) used.add(`remote.scope.${scope}`)
        } else used.add(key)
      }
    }
    expect(used.size).toBeGreaterThan(40)
    for (const key of ['remote.scope.attachments', 'remote.scope.attachments.hint', 'main.remote.attachments']) expect(used.has(key), key).toBe(true)
    const gaps = dictionaryGaps(used, es, en)
    expect(gaps.missingIn).toEqual({ es: [], en: [] })
    expect(gaps.placeholders).toEqual([])
  })

  it('AC-8.9 (031) the texts of the feature are written in each language, not copied from the other one', () => {
    const own = (dictionary: Record<string, Message>, pattern: RegExp) => Object.keys(dictionary).filter((key) => pattern.test(key)).sort()
    const phone = /^remote\.pwa\.(attach\.|can\.attach$)/
    const pc = /^(remote\.scope\.attachments|main\.remote\.attachments)/
    expect(own(phoneEs, phone).length).toBeGreaterThan(15)
    expect(own(phoneEn, phone)).toEqual(own(phoneEs, phone))
    expect(own(es, pc)).toEqual(['main.remote.attachments', 'remote.scope.attachments', 'remote.scope.attachments.hint'])
    expect(own(en, pc)).toEqual(own(es, pc))
    const same = [
      ...own(phoneEs, phone).filter((key) => phoneEs[key as keyof typeof phoneEs] === phoneEn[key as keyof typeof phoneEn]),
      ...own(es, pc).filter((key) => JSON.stringify(es[key as keyof typeof es]) === JSON.stringify(en[key as keyof typeof en]))
    ]
    // a file type name that reads the same in both languages is the one allowed exception
    expect(same.filter((key) => key !== 'remote.pwa.attach.kind.pdf')).toEqual([])
  })

  it('the scan can fail: a key missing from one language, a differing placeholder and a run-time key are reported', () => {
    const phone = "const key = 'remote.pwa.nowhere'; `remote.pwa.attach.kind.${kind}`"
    expect(phoneKeysUsed(phone)).toEqual({ keys: ['remote.pwa.nowhere'], dynamic: true })
    expect(pcKeysUsed("translate(language, 'main.remote.nowhere') send('remote.detect')")).toEqual(['main.remote.nowhere'])
    expect(pcKeysUsed("t(`remote.scope.${scope}`)")).toEqual(['remote.scope.${scope}'])
    expect(dictionaryGaps(['a', 'b', 'c'], { a: 'x {name}', b: 'y' }, { a: 'x {other}', c: 'z' })).toEqual({ missingIn: { es: ['c'], en: ['b'] }, placeholders: ['a'] })
  })
})
