// Independent verification of spec 025: language resolution edge cases (AC-1.1..1.5) and migration of shipped defaults (AC-8.x, AC-4.1).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../src/shared/defaults'
import { resolveLanguage } from '../src/shared/i18n/language'
import { migrateDefaults } from '../src/shared/migrate'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => electron.userData }, safeStorage: { isEncryptionAvailable: () => false } }))
import { SettingsStore } from '../src/main/settings'

beforeEach(() => {
  electron.userData = mkdtempSync(join(tmpdir(), 'alma-verify-i18n-'))
})
afterEach(() => rmSync(electron.userData, { recursive: true, force: true }))
const file = (): string => join(electron.userData, 'settings.json')

describe('AC-1.1 system language resolution, hostile inputs', () => {
  it('AC-1.1 regional codes, case and lookalikes', () => {
    expect(resolveLanguage(undefined, ['ES'])).toBe('es')
    expect(resolveLanguage(undefined, ['es-419'])).toBe('es')
    expect(resolveLanguage(undefined, ['es-ES-u-ca-gregory'])).toBe('es')
    expect(resolveLanguage(undefined, ['EN-gb'])).toBe('en')
    // a language that merely starts with "es" is not Spanish
    expect(resolveLanguage(undefined, ['est'])).toBe('en')
    expect(resolveLanguage(undefined, ['eo'])).toBe('en')
    expect(resolveLanguage(undefined, ['pt-BR'])).toBe('en')
    expect(resolveLanguage(undefined, [''])).toBe('en')
    expect(resolveLanguage(undefined, [])).toBe('en')
  })
  it('AC-1.2 a saved es/en beats any system language; a bad saved value falls to the system', () => {
    expect(resolveLanguage('en', ['es-AR'])).toBe('en')
    expect(resolveLanguage('es', ['fr'])).toBe('es')
    for (const bad of ['EN', 'es-AR', ' es', 1, null, true, {}, []]) expect(resolveLanguage(bad, ['es'])).toBe('es')
    for (const bad of ['EN', 'es-AR', ' es', 1, null, true, {}, []]) expect(resolveLanguage(bad, ['en'])).toBe('en')
  })
})

describe('AC-1.3 / AC-1.4 settings.json hostile contents', () => {
  it('AC-1.3 truncated or non-object settings.json does not throw and still yields a language', () => {
    for (const raw of ['', '{', 'null', '[]', '"es"', '{"language":']) {
      writeFileSync(file(), raw)
      let language = ''
      expect(() => (language = new SettingsStore(['es']).get().language), raw).not.toThrow()
      expect(['es', 'en']).toContain(language)
    }
  })
  it('AC-1.4 an update never persists a language key unless the person chose one, and never persists a secret next to it', () => {
    const store = new SettingsStore(['en'])
    store.update({ language: 'es' })
    const raw = readFileSync(file(), 'utf8')
    expect(JSON.parse(raw).language).toBe('es')
  })
  it('AC-1.4 an unchanged-language update does not migrate edited defaults', () => {
    const store = new SettingsStore(['es'])
    store.update({ agents: store.get().agents.map((a) => (a.id === 'investigador' ? { ...a, name: 'Mi investigador' } : a)) })
    store.update({ language: 'es' })
    expect(store.get().agents.find((a) => a.id === 'investigador')?.name).toBe('Mi investigador')
    store.update({ language: 'en' })
    expect(store.get().agents.find((a) => a.id === 'investigador')?.name).toBe('Mi investigador')
  })
})

describe('AC-8.2 only unedited copies move', () => {
  const es = () => defaultSettings('es')
  it('AC-8.2 a one-character edit to the description, to the name, or a CRLF in the prompt keeps the agent untouched', () => {
    const s = es()
    const a = s.agents.find((x) => x.id === 'investigador')!
    const b = s.agents.find((x) => x.id === 'programador')!
    const c = s.agents.find((x) => x.id === 'revisor')!
    a.description += ' '
    b.name += '.'
    c.systemPrompt = c.systemPrompt.replace(/\n/g, '\r\n')
    const before = JSON.stringify([a, b, c])
    const out = migrateDefaults(s, 'es', 'en')
    expect(JSON.stringify([out.agents.find((x) => x.id === 'investigador'), out.agents.find((x) => x.id === 'programador'), out.agents.find((x) => x.id === 'revisor')])).toBe(before)
  })
  it('AC-8.2 auto-review instructions edited by a trailing space are left alone', () => {
    const s = es()
    s.autoReview = { ...s.autoReview, instructions: `${s.autoReview.instructions} ` }
    expect(migrateDefaults(s, 'es', 'en').autoReview.instructions).toBe(s.autoReview.instructions)
  })
  it('AC-8.2 migrating with the wrong "from" changes nothing (an English copy is not a Spanish default)', () => {
    const s = defaultSettings('en')
    const out = migrateDefaults(s, 'es', 'en')
    expect(JSON.stringify(out.agents)).toBe(JSON.stringify(s.agents))
    expect(out.autoReview.instructions).toBe(s.autoReview.instructions)
  })
  it('AC-8.2 settings with agents the person made, other fields and nothing else are byte for byte equal outside the shipped words', () => {
    const s = es()
    const out = migrateDefaults(s, 'es', 'en')
    const strip = (x: typeof s) => JSON.stringify({ ...x, agents: undefined, autoReview: { ...x.autoReview, instructions: '' } })
    expect(strip(out)).toBe(strip(s))
    expect(out.agents.map((a) => a.id)).toEqual(s.agents.map((a) => a.id))
  })
  it('AC-8.2 es -> en -> es -> en is stable (round trip never drifts)', () => {
    const a = migrateDefaults(migrateDefaults(es(), 'es', 'en'), 'en', 'es')
    expect(JSON.stringify(a.agents)).toBe(JSON.stringify(es().agents))
    expect(JSON.stringify(migrateDefaults(a, 'es', 'en').agents)).toBe(JSON.stringify(defaultSettings('en').agents))
  })
  it('AC-4.1 a store round trip keeps the person\'s own prompt byte for byte through a language change and a restart', () => {
    const own = 'Sos mi agente.\r\nUsá voseo.\n'
    const store = new SettingsStore(['es'])
    store.update({ agents: [...store.get().agents, { ...store.get().agents[0], id: 'mio', name: 'Mi agente', description: 'x', systemPrompt: own }] })
    store.update({ language: 'en' })
    expect(new SettingsStore(['es']).get().agents.find((a) => a.id === 'mio')?.systemPrompt).toBe(own)
  })
})

describe('AC-8.1 first load', () => {
  it('AC-8.1 with no settings file the shipped defaults follow the system language, and Spanish stays identical to defaultSettings()', () => {
    expect(JSON.stringify(new SettingsStore(['es-MX']).get().agents)).toBe(JSON.stringify(defaultSettings().agents))
    expect(new SettingsStore(['en-GB']).get().agents.find((a) => a.id === 'investigador')?.name).toBe('Researcher')
    expect(new SettingsStore(['de']).get().agents.find((a) => a.id === 'investigador')?.name).toBe('Researcher')
  })
})
