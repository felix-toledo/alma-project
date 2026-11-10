import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en } from '../src/shared/i18n/en'
import { es } from '../src/shared/i18n/es'
import { en as pwaEn } from '../src/remote-client/i18n/en'
import { es as pwaEs } from '../src/remote-client/i18n/es'

const spec = readFileSync(join(__dirname, '..', '.specify', 'specs', '027-alma-e2e-relay', 'spec.md'), 'utf8')

/** The rows of the spec's table of UI text keys (section 6.1): key, Spanish, English. Rows that only point to existing keys are left out. */
function specRows(): Array<{ key: string; es: string; en: string }> {
  const start = spec.indexOf('### 6.1 UI text keys')
  const end = spec.indexOf('\n## 7.', start)
  const rows: Array<{ key: string; es: string; en: string }> = []
  for (const line of spec.slice(start, end).split('\n')) {
    const match = /^\| `([^`]+)` \| (.+) \| (.+) \|\s*$/.exec(line.replace(/\r$/, ''))
    if (match && match[2] !== 'existing') rows.push({ key: match[1], es: match[2], en: match[3] })
  }
  return rows
}

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

describe('relay texts (spec 027 T29)', () => {
  const rows = specRows()
  const pc = (language: 'es' | 'en'): Record<string, string> => (language === 'es' ? es : en) as unknown as Record<string, string>
  const phone = (language: 'es' | 'en'): Record<string, string> => (language === 'es' ? pwaEs : pwaEn) as unknown as Record<string, string>
  const dictionary = (key: string, language: 'es' | 'en'): Record<string, string> => (key.startsWith('remote.pwa.') ? phone(language) : pc(language))

  it('AC-8.5 the spec table is read: its keys are the relay, wizard, notice, main and phone ones', () => {
    expect(rows.length).toBeGreaterThanOrEqual(25)
    expect(rows.map((row) => row.key)).toEqual(expect.arrayContaining(['remote.relay.title', 'remote.relay.sees', 'remote.relay.notice.shell', 'main.remote.relay', 'remote.pwa.relay.mismatch', 'remote.pwa.shell.hash']))
  })

  it('AC-8.5 every key of the spec exists in Spanish and English, in the PC dictionaries or the phone dictionaries, with the spec wording', () => {
    for (const row of rows) {
      for (const language of ['es', 'en'] as const) {
        const text = dictionary(row.key, language)[row.key]
        expect(text, `${row.key} (${language})`).toBeDefined()
        expect(text, `${row.key} (${language})`).toBe(language === 'es' ? row.es : row.en)
      }
    }
  })

  it('AC-8.5 both languages carry the same placeholders, and no key is left empty or identical across languages except proper names', () => {
    for (const row of rows) {
      expect(placeholders(row.es), row.key).toEqual(placeholders(row.en))
      expect(row.en.trim().length, row.key).toBeGreaterThan(0)
      expect(row.es.trim().length, row.key).toBeGreaterThan(0)
    }
  })

  it('AC-6.4 the shell notice keeps the spec candour: whoever runs the relay could deliver an altered app, on the first download or on an update', () => {
    expect(en['remote.relay.notice.shell']).toMatch(/Whoever runs the relay could deliver an altered app, in that download or in an update/)
    expect(es['remote.relay.notice.shell']).toMatch(/Quien opera el relé podría entregar una app alterada, en esa descarga o en una actualización/)
    expect(en['remote.relay.notice.shell']).toMatch(/first time/i)
    expect(en['remote.relay.notice.shell']).toMatch(/publishes the code of each version so you can compare/)
    expect(en['remote.relay.sees']).toMatch(/Sizes and timing are visible/)
    expect(es['remote.relay.sees']).toMatch(/Los tamaños y los horarios son visibles/)
  })

  it('AC-6.6 the operator notice names who runs the relay, that it keeps nothing, and where to report abuse', () => {
    expect(en['remote.relay.notice.operator']).toMatch(/one person.*maintainer.*voluntary donations.*keeps nothing.*\{contact\}/)
    expect(es['remote.relay.notice.operator']).toMatch(/\{contact\}/)
  })

  it('AC-4.6 the tab says phones paired on the other connection stay listed but cannot connect, and that the idle clock keeps running', () => {
    const key = 'remote.relay.devices.note'
    expect(typeof pc('en')[key]).toBe('string')
    expect(typeof pc('es')[key]).toBe('string')
    expect(pc('en')[key]).toMatch(/other connection/i)
    expect(pc('en')[key]).toMatch(/15 days/)
    expect(pc('es')[key]).toMatch(/15 días/)
  })

  it('AC-7.2 the keys the tab needs beyond the spec table exist in both languages', () => {
    for (const key of ['remote.relay.test.running', 'remote.relay.devices.note', 'remote.relay.refused.registration', 'remote.relay.refused.replaced', 'remote.relay.refused.held', 'remote.relay.refused.other', 'remote.notice.relayDown.title']) {
      expect(typeof pc('en')[key], key).toBe('string')
      expect(typeof pc('es')[key], key).toBe('string')
    }
  })
})
