import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en } from '../src/shared/i18n/en'
import { es } from '../src/shared/i18n/es'
import { translate, type Message, type MessageKey } from '../src/shared/i18n/messages'
import { dictionaryDiff } from './support/dictionaries'

// Independent verification of spec 038: texts (AC-5.1, AC-5.2, AC-1.5) and the amended-spec statements (section 3, Amends). Written from spec.md only.

const root = join(__dirname, '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
const esDict = es as Record<string, Message>
const enDict = en as Record<string, Message>
const textOf = (m: Message): string => (typeof m === 'string' ? m : `${m.one}\n${m.other}`)
const placeholders = (m: Message): string[] => [...new Set([...textOf(m).matchAll(/\{(\w+)\}/g)].map((x) => x[1]))].sort()

const NEW_PREFIXES = ['images.see.', 'tool.vision.', 'home.think.vision']
const newKeys = Object.keys(esDict).filter((k) => NEW_PREFIXES.some((p) => k.startsWith(p)))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

describe('AC-5.1 (038 verify) dictionary keys, es and en', () => {
  it('AC-5.1 (038 verify) the whole dictionaries have exactly the same keys', () => {
    expect(dictionaryDiff(esDict, enDict)).toEqual({ onlyInA: [], onlyInB: [] })
  })

  it('AC-5.1 (038 verify) the new texts exist: group labels, automatic lines, confirmation, errors', () => {
    const required = [
      'images.see.title',
      'images.see.about',
      'images.see.provider',
      'images.see.auto',
      'images.see.model',
      'images.see.fetchModels',
      'images.see.autoRule',
      'images.see.autoNone',
      'images.see.using',
      'images.see.held',
      'images.see.confirmNow',
      'images.see.confirm.title',
      'images.see.confirm.body',
      'images.see.confirm.accept',
      'tool.vision.noModel',
      'tool.vision.listFailed',
      'home.think.visionNote',
      'home.think.visionUsing',
      'home.think.visionOpen',
      // the create group keeps its keys (AC-1.5, AC-1.4, AC-1.3)
      'images.model',
      'images.isKey',
      'images.missingKey'
    ]
    for (const key of required) {
      expect(esDict[key], `es ${key}`).toBeDefined()
      expect(enDict[key], `en ${key}`).toBeDefined()
      expect(textOf(esDict[key]).trim(), `es ${key}`).not.toBe('')
      expect(textOf(enDict[key]).trim(), `en ${key}`).not.toBe('')
    }
  })

  it('AC-5.1 (038 verify) every new key has the same placeholders in es and en, and the two languages differ', () => {
    expect(newKeys.length).toBeGreaterThan(15)
    for (const key of newKeys) {
      expect(placeholders(enDict[key]), key).toEqual(placeholders(esDict[key]))
      if (!/^(images\.option|images\.see\.auto)$/.test(key)) expect(textOf(enDict[key]), key).not.toBe(textOf(esDict[key]))
    }
  })

  it('AC-5.1 (038 verify) the texts carry the names the spec needs: the provider in the confirmation and the "automatic" lines, the picture uses in the explanation', () => {
    for (const key of ['images.see.confirm.title', 'images.see.confirm.body', 'images.see.autoRule', 'images.see.autoNone', 'images.see.held', 'images.see.confirmNow', 'tool.vision.noModel', 'tool.vision.listFailed'] as const) {
      expect(placeholders(esDict[key]), key).toContain('provider')
      expect(placeholders(enDict[key]), key).toContain('provider')
    }
    expect(placeholders(esDict['images.see.held'])).toContain('using')
    expect(placeholders(esDict['tool.vision.listFailed'])).toContain('error')
    // AC-4.8: the confirmation says what is sent
    expect(enDict['images.see.confirm.body']).toMatch(/attach/i)
    expect(enDict['images.see.confirm.body']).toMatch(/camera/i)
    expect(enDict['images.see.confirm.body']).toMatch(/plan/i)
    expect(esDict['images.see.confirm.body']).toMatch(/adjunt/i)
    expect(esDict['images.see.confirm.body']).toMatch(/c[aá]mara/i)
    expect(esDict['images.see.confirm.body']).toMatch(/plano/i)
  })

  it('AC-5.1 (038 verify) translate() fills every placeholder of the new keys in both languages and leaves no brace', () => {
    for (const key of newKeys) {
      const params = Object.fromEntries(placeholders(esDict[key]).map((p) => [p, `<${p}>`]))
      for (const language of ['es', 'en'] as const) {
        const out = (translate as unknown as (l: string, k: MessageKey, p: Record<string, string>) => string)(language, key as MessageKey, params)
        expect(out, `${language} ${key}`).not.toMatch(/[{}]/)
        for (const p of Object.keys(params)) expect(out, `${language} ${key}`).toContain(`<${p}>`)
      }
    }
  })

  it('AC-5.1 (038 verify) the English texts of the new keys contain no Spanish letters or inverted marks', () => {
    for (const key of newKeys) expect(textOf(enDict[key]), key).not.toMatch(/[áéíóúñ¿¡]/i)
  })

  it('AC-5.1 (038 verify) the old Casa selector keys that became unused are gone, and no source still reads them', () => {
    for (const key of ['home.think.visionDefault', 'home.think.visionModel']) {
      expect(esDict[key], `es ${key}`).toBeUndefined()
      expect(enDict[key], `en ${key}`).toBeUndefined()
    }
    const sources = walk(join(root, 'src')).map((f) => readFileSync(f, 'utf8')).join('\n')
    expect(sources).not.toContain("'home.think.visionDefault'")
    expect(sources).not.toContain("'home.think.visionModel'")
  })

  it('AC-5.1 (038 verify) no home.think.vision* key and no images.see.* key is orphaned (every one is read somewhere in src outside the dictionaries)', () => {
    const sources = walk(join(root, 'src'))
      .filter((f) => !/i18n[\\/](es|en)/.test(f))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
    for (const key of newKeys.filter((k) => !k.startsWith('tool.vision.'))) expect(sources, key).toContain(`'${key}'`)
  })

  it('AC-1.5 (038 verify) the two automatic lines are dictionary keys named images.see.auto* in es and en', () => {
    const autos = Object.keys(esDict).filter((k) => k.startsWith('images.see.auto'))
    expect(autos).toEqual(expect.arrayContaining(['images.see.autoRule', 'images.see.autoNone']))
    for (const key of autos) expect(enDict[key], key).toBeDefined()
    // one says Alma will use the last model in name order that can see, the other that Alma has none and the person must type one
    expect(enDict['images.see.autoRule']).toMatch(/name order/i)
    expect(enDict['images.see.autoNone']).toMatch(/type/i)
  })

  it('AC-1.4 (038 verify) images.isKey is still the key-in-field message, in both languages', () => {
    expect(textOf(enDict['images.isKey'])).toMatch(/API key/)
    expect(textOf(esDict['images.isKey'])).toMatch(/API key/)
  })
})

describe('AC-5.2 (038 verify) tool errors are translated for the person and English for the model', () => {
  it('AC-5.2 (038 verify) tool.vision.noModel and listFailed read in each language and point to Images', () => {
    expect(enDict['tool.vision.noModel']).toMatch(/Settings → Images/)
    expect(esDict['tool.vision.noModel']).toMatch(/Configuración → Imágenes/)
    expect(enDict['tool.vision.listFailed']).not.toMatch(/[áéíóúñ]/)
  })
})

describe('Amends (038 verify) the amended statements are applied', () => {
  it('Amends (038 verify) the existing specs point to 038 where the spec listed them', () => {
    const specs: [string, string[]][] = [
      ['020-images', ['AC-5.5', 'BR-15']],
      ['005-providers', ['AC-9.1', 'BR-17']],
      ['014-house-plan-cameras-and-rules', ['AC-5.3', 'BR-7']],
      ['006-settings', ['AC-8.8']],
      ['030-chat-attachments', ['AC-3.1']],
      ['031-remote-chat-attachments', ['AC-1.4', 'AC-2.8']]
    ]
    for (const [dir, ids] of specs) {
      const text = read(`.specify/specs/${dir}/spec.md`)
      for (const id of ids) {
        const line = text.split(/\r?\n/).find((l) => l.includes(`**${id}**`))
        expect(line, `${dir} ${id}`).toBeDefined()
        expect(line, `${dir} ${id} is amended`).toMatch(/038/)
      }
    }
  })

  it('Amends (038 verify) docs/context.md: the Vision model term says Imágenes, not Casa, as where it is chosen', () => {
    const text = read('docs/context.md')
    const term = /\*\*Vision model\*\*:\s*\n([^\n]+)/.exec(text)?.[1] ?? ''
    expect(term).toMatch(/Configuración → Imágenes/)
    expect(term).not.toMatch(/chosen in «Configuración → Casa»/)
  })

  it('Amends (038 verify) docs/references/settings.md documents images.vision and the marker; the home keys are gone', () => {
    const text = read('docs/references/settings.md')
    expect(text).toMatch(/images\.vision/)
    expect(text).toMatch(/visionMigrated/)
    expect(text).toMatch(/no longer exist/)
  })

  it('Amends (038 verify) PRIVACY.md names the vision provider as chosen in Images and the gate; CONTROLS.md has the gate row', () => {
    const privacy = read('docs/security/PRIVACY.md')
    expect(privacy).toMatch(/vision provider/i)
    expect(privacy).toMatch(/Configuración → Imágenes/)
    expect(privacy).toMatch(/noticeAcknowledged/)
    const controls = read('docs/security/CONTROLS.md')
    expect(controls).toMatch(/resolveVision/)
  })

  it('Amends (038 verify) the module docs name the new place, and providers.md open item 7 is answered by BR-13', () => {
    for (const doc of ['images', 'providers', 'home', 'settings']) expect(read(`docs/modules/${doc}.md`), doc).toMatch(/Imágenes|Images/)
    const providers = read('docs/modules/providers.md')
    const item7 = providers.split(/\r?\n/).find((l) => /^7\./.test(l) && /vision/i.test(l)) ?? ''
    expect(item7).toMatch(/BR-13/)
  })

  it('AC-3.5 (038 verify) the Casa tab source no longer edits the vision provider/model (no select/input bound to them) and keeps the cost note', () => {
    const casa = read('src/renderer/src/home/HomeSettings.tsx')
    expect(casa).not.toMatch(/visionProvider|visionModel/)
    expect(casa).toContain("'home.think.visionNote'")
    expect(casa).toContain("'home.think.visionUsing'")
    const types = read('src/shared/home.ts') + read('src/shared/types.ts')
    expect(types).not.toMatch(/visionProvider\??:|visionModel\??:/)
  })

  it('BR-11 (038 verify) no new tool: look_at_image stays read, generate_image stays write', () => {
    const tools = read('docs/references/tools.md')
    expect(tools).toMatch(/look_at_image[^\n]*read/)
    expect(tools).toMatch(/generate_image[^\n]*write/)
  })
})
