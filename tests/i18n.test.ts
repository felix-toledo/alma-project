import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { en } from '../src/shared/i18n/en'
import { es } from '../src/shared/i18n/es'
import { compareText, formatDateTime, LOCALE } from '../src/shared/i18n/format'
import { parseLanguage, resolveLanguage } from '../src/shared/i18n/language'
import { isMessageKey, type ParamsOf, translate } from '../src/shared/i18n/messages'
import { dictionaryDiff } from './support/dictionaries'

describe('parseLanguage', () => {
  it('AC-1.3 es and en are read as they are', () => {
    expect(parseLanguage('es')).toBe('es')
    expect(parseLanguage('en')).toBe('en')
  })

  it('AC-1.3 anything else reads as absent and never throws', () => {
    for (const bad of ['fr', 'ES', 'en-GB', '', 7, null, {}, [], undefined, true]) {
      expect(parseLanguage(bad)).toBeUndefined()
    }
  })

  it('AC-1.3 an invalid saved value falls back to the system language', () => {
    expect(resolveLanguage('fr', ['es-MX'])).toBe('es')
    expect(resolveLanguage(7, ['en-GB'])).toBe('en')
    expect(resolveLanguage(null, ['es'])).toBe('es')
    expect(resolveLanguage({}, [])).toBe('en')
  })
})

describe('resolveLanguage', () => {
  it('AC-1.1 a Spanish system language, regional codes included, gives es', () => {
    expect(resolveLanguage(undefined, ['es'])).toBe('es')
    expect(resolveLanguage(undefined, ['es-MX'])).toBe('es')
    expect(resolveLanguage(undefined, ['es-AR'])).toBe('es')
    expect(resolveLanguage(undefined, ['ES-mx'])).toBe('es')
  })

  it('AC-1.1 an English system language, regional codes included, gives en', () => {
    expect(resolveLanguage(undefined, ['en'])).toBe('en')
    expect(resolveLanguage(undefined, ['en-GB'])).toBe('en')
    expect(resolveLanguage(undefined, ['en-US'])).toBe('en')
  })

  it('AC-1.1 any other or unreadable system language gives en', () => {
    expect(resolveLanguage(undefined, ['fr'])).toBe('en')
    expect(resolveLanguage(undefined, ['zh-Hans'])).toBe('en')
    expect(resolveLanguage(undefined, [])).toBe('en')
    expect(resolveLanguage(undefined, [''])).toBe('en')
    // a prefix that merely starts with "es" is not Spanish
    expect(resolveLanguage(undefined, ['est'])).toBe('en')
    expect(resolveLanguage(undefined, ['ast'])).toBe('en')
  })

  it('AC-1.1 only the first preferred system language counts', () => {
    expect(resolveLanguage(undefined, ['fr', 'es'])).toBe('en')
    expect(resolveLanguage(undefined, ['es-MX', 'en'])).toBe('es')
    expect(resolveLanguage(undefined, ['en-GB', 'es'])).toBe('en')
  })

  it('AC-1.2 a saved language wins whatever the system language is', () => {
    expect(resolveLanguage('en', ['es-MX'])).toBe('en')
    expect(resolveLanguage('es', ['en-GB'])).toBe('es')
    expect(resolveLanguage('es', ['fr'])).toBe('es')
    expect(resolveLanguage('en', [])).toBe('en')
  })
})

describe('typed keys', () => {
  // The assertions here are checked by `pnpm run typecheck`; a directive that no longer
  // suppresses an error is itself a type error, so the guard cannot rot silently.
  it('AC-2.4 an unknown key, a missing param and an extra param do not typecheck', () => {
    const calls = (): void => {
      // @ts-expect-error unknown key
      translate('es', 'common.noSuchKey')
      // @ts-expect-error the key needs {name}
      translate('es', 'chat.talkingTo')
      // @ts-expect-error the key needs {name}, got another one
      translate('es', 'chat.talkingTo', { other: 'x' })
      // @ts-expect-error the key takes no params
      translate('es', 'common.cancel', { name: 'x' })
      // @ts-expect-error the plural needs {count}
      translate('en', 'mcp.tools', {})
      // the correct forms compile
      translate('es', 'common.cancel')
      translate('es', 'chat.talkingTo', { name: 'x' })
      translate('en', 'mcp.tools', { count: 2 })
    }
    expect(calls).toBeTypeOf('function')
    expectTypeOf<ParamsOf<'chat.talkingTo'>>().toEqualTypeOf<{ name: string | number }>()
    expectTypeOf<ParamsOf<'mcp.tools'>>().toEqualTypeOf<{ count: string | number }>()
    expectTypeOf<ParamsOf<'common.cancel'>>().toEqualTypeOf<Record<never, never>>()
  })
})

describe('parameters and plurals', () => {
  it('AC-2.6 singular and plural wording is right in both languages', () => {
    const spanish = [0, 1, 2, 21].map((count) => translate('es', 'mcp.tools', { count }))
    const english = [0, 1, 2, 21].map((count) => translate('en', 'mcp.tools', { count }))
    expect(spanish).toEqual(['0 herramientas', '1 herramienta', '2 herramientas', '21 herramientas'])
    expect(english).toEqual(['0 tools', '1 tool', '2 tools', '21 tools'])
  })

  it('AC-2.6 a count that CLDR calls "many" in Spanish still reads as plural', () => {
    expect(translate('es', 'mcp.tools', { count: 1000000 })).toBe('1000000 herramientas')
  })

  it('AC-2.6 values are inserted in both languages, literally', () => {
    expect(translate('es', 'chat.talkingTo', { name: 'Casa' })).toBe('Hablás con Casa')
    expect(translate('en', 'chat.talkingTo', { name: 'Home' })).toBe('You are talking to Home')
    expect(translate('en', 'chat.talkingTo', { name: '$& {name}' })).toBe('You are talking to $& {name}')
    expect(translate('en', 'chat.talkingTo', { name: 7 })).toBe('You are talking to 7')
  })

  it('AC-2.6 a param absent at runtime keeps the placeholder visible', () => {
    const loose = translate as (language: 'es' | 'en', key: string, params?: Record<string, string | number>) => string
    expect(loose('en', 'chat.talkingTo')).toBe('You are talking to {name}')
    expect(loose('es', 'chat.talkingTo', {})).toBe('Hablás con {name}')
    expect(loose('en', 'mcp.tools', {})).toBe('{count} tools')
  })
})

describe('formats and sorting', () => {
  // Built from local components so the expectations do not depend on the machine's time zone.
  const afternoon = new Date(2026, 9, 12, 15, 30)
  const justAfterMidnight = new Date(2026, 9, 12, 0, 5)

  it('AC-3.6 es uses es-AR formats and en uses en-US formats', () => {
    expect(LOCALE).toEqual({ es: 'es-AR', en: 'en-US' })
    expect(formatDateTime('es', afternoon, 'short')).toBe('12/10/26, 15:30')
    expect(formatDateTime('en', afternoon, 'short')).toBe('10/12/26, 15:30')
    expect(formatDateTime('es', afternoon, 'long')).toBe('lunes, 12 de octubre de 2026, 15:30')
    expect(formatDateTime('en', afternoon, 'long')).toBe('Monday, October 12, 2026 at 15:30')
    expect(formatDateTime('es', afternoon, 'weekday')).toBe('lun 12-10, 15:30')
    expect(formatDateTime('en', afternoon, 'weekday')).toBe('Mon, 10/12, 15:30')
  })

  it('AC-3.6 longDate is the long weekday, the numeric date with its year and the time', () => {
    expect(formatDateTime('es', afternoon, 'longDate')).toBe('lunes, 12/10/2026, 15:30')
    expect(formatDateTime('en', afternoon, 'longDate')).toBe('Monday, 10/12/2026, 15:30')
    expect(formatDateTime('en', justAfterMidnight, 'longDate')).toMatch(/, 00:05$/)
  })

  it('AC-3.6 dayTime is the day and month with the time, no year: es keeps the thread titles it always had', () => {
    expect(formatDateTime('es', afternoon, 'dayTime')).toBe('12/10, 15:30')
    expect(formatDateTime('en', afternoon, 'dayTime')).toBe('10/12, 15:30')
    expect(formatDateTime('es', new Date(2026, 9, 12, 9, 5), 'dayTime')).toBe('12/10, 09:05')
  })

  it('AC-3.6 time is 24-hour in both languages, midnight included', () => {
    for (const language of ['es', 'en'] as const) {
      expect(formatDateTime(language, afternoon, 'time')).toBe('15:30')
      expect(formatDateTime(language, justAfterMidnight, 'time')).toBe('00:05')
      expect(formatDateTime(language, justAfterMidnight, 'short')).toMatch(/, 00:05$/)
      expect(formatDateTime(language, afternoon, 'long')).not.toMatch(/PM|p\. m\./i)
    }
  })

  it('AC-3.6 an instant given as a number reads like the same Date', () => {
    expect(formatDateTime('en', afternoon.getTime(), 'short')).toBe(formatDateTime('en', afternoon, 'short'))
  })

  it('AC-3.6 sorting puts ñ after n in Spanish and treats it as a plain n in English', () => {
    const words = ['o', 'ñu', 'nz', 'a']
    expect([...words].sort(compareText('es'))).toEqual(['a', 'nz', 'ñu', 'o'])
    expect([...words].sort(compareText('en'))).toEqual(['a', 'ñu', 'nz', 'o'])
  })

  it('AC-3.6 sorting is numeric-aware and puts lowercase before its uppercase twin', () => {
    for (const language of ['es', 'en'] as const) {
      expect(['sala 10', 'sala 9', 'sala 2'].sort(compareText(language))).toEqual(['sala 2', 'sala 9', 'sala 10'])
      expect(['b', 'A', 'a', 'B'].sort(compareText(language))).toEqual(['a', 'A', 'b', 'B'])
    }
  })

  it('AC-2.6 plural rules come from the language locale', () => {
    expect(translate('es', 'mcp.tools', { count: 1 })).toBe('1 herramienta')
    expect(translate('en', 'mcp.tools', { count: 1 })).toBe('1 tool')
  })
})

describe('keys built at run time', () => {
  it('AC-2.4 isMessageKey tells a defined key from a made-up one, and ignores the prototype', () => {
    expect(isMessageKey('common.cancel')).toBe(true)
    expect(isMessageKey('common.noSuchKey')).toBe(false)
    expect(isMessageKey('toString')).toBe(false)
    expect(isMessageKey('')).toBe(false)
  })
})

describe('dictionaries', () => {
  it('AC-2.3 dictionaryDiff names the keys that only one side defines', () => {
    expect(dictionaryDiff({ a: 'x', b: 'y' }, { a: 'x', c: 'z' })).toEqual({ onlyInA: ['b'], onlyInB: ['c'] })
    expect(dictionaryDiff({ a: 'x' }, { a: { one: 'x', other: 'xs' } })).toEqual({ onlyInA: [], onlyInB: [] })
    expect(dictionaryDiff({}, { k: 'v' })).toEqual({ onlyInA: [], onlyInB: ['k'] })
  })

  it('AC-2.3 es and en define exactly the same keys', () => {
    expect(dictionaryDiff(es, en)).toEqual({ onlyInA: [], onlyInB: [] })
  })

  it('AC-3.4 the first shared keys resolve in both languages', () => {
    expect(translate('es', 'common.cancel')).toBe('Cancelar')
    expect(translate('en', 'common.cancel')).toBe('Cancel')
    expect(translate('es', 'common.save')).toBe('Guardar')
    expect(translate('en', 'common.close')).toBe('Close')
  })
})

describe('AC-2.3 the dictionary files', () => {
  it('AC-2.3 no key is defined in two area files of a language, where the spread in es.ts and en.ts would silently override it', () => {
    for (const language of ['es', 'en']) {
      const dir = join(__dirname, '..', 'src', 'shared', 'i18n', language)
      const owner = new Map<string, string>()
      const repeated: string[] = []
      for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts')).sort()) {
        for (const m of readFileSync(join(dir, file), 'utf8').matchAll(/^ {2}'([^']+)':/gm)) {
          if (owner.has(m[1])) repeated.push(`${language}/${file}: ${m[1]} (also in ${owner.get(m[1])})`)
          else owner.set(m[1], file)
        }
      }
      expect(repeated).toEqual([])
    }
  })
})
