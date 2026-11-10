import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en } from '../src/shared/i18n/en'
import { attach as enAttach } from '../src/shared/i18n/en/attach'
import { es } from '../src/shared/i18n/es'
import { attach as esAttach } from '../src/shared/i18n/es/attach'
import type { Message } from '../src/shared/i18n/messages'

// Spec 030 AC-7.3: every text of attaching is in both dictionaries. Where the attach code lives; the dictionaries
// themselves are not scanned (they define the keys, they do not use them).
const SCANNED = ['src/renderer', 'src/coordinator/attachments', 'src/coordinator/tools/home.ts', 'src/main']
const KEY = /['"`]((?:attach|tool\.attachment|main\.attach|error\.attachment)\.[\w.-]+|toolLabel\.read_attachment)['"`]/g
const DYNAMIC = /`(?:attach|tool\.attachment|main\.attach|error\.attachment)\.[^`]*\$\{/

function sources(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path).flatMap((name) => sources(join(path, name)))
}

const files = SCANNED.flatMap((path) => sources(join(__dirname, '..', path))).filter((file) => /\.tsx?$/.test(file))
const read = (file: string) => readFileSync(file, 'utf8')

const isAttachKey = (key: string) => /^(attach\.|tool\.attachment\.|main\.attach\.|error\.attachment\.|toolLabel\.read_attachment$)/.test(key)
const ownKeys = (dictionary: Record<string, Message>) => Object.keys(dictionary).filter(isAttachKey).sort()

const placeholders = (message: Message): string[] =>
  [...new Set(JSON.stringify(message).match(/\{\w+\}/g) ?? [])].sort()

// a text with no words of its own (`{name}: {reason}`) reads the same in both languages
const hasWords = (message: Message) => /[a-záéíóúñ]/i.test(JSON.stringify(message).replace(/\{\w+\}|"(?:one|other)"/g, ''))

describe('attach dictionaries (spec 030 AC-7.3)', () => {
  it('AC-7.3 (030) every attach key exists in es and en', () => {
    const spanish = ownKeys(es)
    const english = ownKeys(en)
    expect(spanish.length).toBeGreaterThan(40)
    expect(english).toEqual(spanish)
    // the attach.ts files are where the keys of this feature are meant to live
    expect(Object.keys(esAttach).sort()).toEqual(Object.keys(enAttach).sort())
  })

  it('AC-7.3 (030) a text keeps its placeholders in both languages and is not left in the other one', () => {
    for (const key of ownKeys(es)) {
      const spanish = (es as Record<string, Message>)[key]
      const english = (en as Record<string, Message>)[key]
      expect(placeholders(spanish), key).toEqual(placeholders(english))
      if (hasWords(spanish) && hasWords(english)) expect(JSON.stringify(spanish), `${key} is not translated`).not.toBe(JSON.stringify(english))
    }
  })

  it('AC-7.3 (030) every key used by attach code is defined', () => {
    const used = new Map<string, string>()
    for (const file of files) {
      const text = read(file)
      expect(DYNAMIC.test(text), `${file} builds an attach key at run time; the scan cannot see it`).toBe(false)
      for (const match of text.matchAll(KEY)) used.set(match[1], file)
    }
    // the scan finds the code it is meant to guard
    expect(used.size).toBeGreaterThan(30)
    const missing = [...used].filter(([key]) => !(key in es) || !(key in en)).map(([key, file]) => `${key} (${file})`)
    expect(missing).toEqual([])
  })

  it('AC-7.3 (030) the picker title main asks for is in both languages', () => {
    expect(used('src/main/messages.ts')).toContain('main.attach.pickTitle')
    expect(es['main.attach.pickTitle' as keyof typeof es]).toBeTruthy()
    expect(en['main.attach.pickTitle' as keyof typeof en]).toBeTruthy()
  })
})

function used(file: string): string[] {
  return [...read(join(__dirname, '..', file)).matchAll(KEY)].map((m) => m[1])
}
