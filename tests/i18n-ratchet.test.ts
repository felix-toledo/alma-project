import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSources } from './support/arch'
import { ALLOWLIST, BASELINE, checkBaseline, countByFile, isSpanish, scan, scanFile } from './support/i18n'

const root = join(__dirname, '..')
const rules = (file: string, source: string): string[] => scanFile(file, source).map((f) => f.rule)

describe('AC-2.5 the hardcoded-text ratchet: negative fixtures', () => {
  it('R1 flags Spanish text in a string, a template and JSX text, and nothing else', () => {
    expect(scanFile('src/coordinator/a.ts', "const a = 'No hay vigilancias activas.'").map((f) => f.rule)).toEqual(['R1'])
    expect(rules('src/shared/a.ts', 'const a = `Hola ${name}, ¿cómo estás?`')).toEqual(['R1'])
    expect(rules('src/renderer/src/A.tsx', 'const A = () => <p>Elegí una carpeta para el proyecto</p>')).toEqual(['R1', 'R2'])
    // English is not Spanish: only the renderer rule R2 cares about it
    expect(rules('src/shared/a.ts', "const a = 'Choose a folder for the project'")).toEqual([])
    expect(rules('src/coordinator/a.ts', "const lang = 'es'")).toEqual([])
  })

  it('R1 leaves the es dictionary, comments and regexes alone', () => {
    expect(rules('src/shared/i18n/es/common.ts', "export const common = { 'common.x': '¿Querés salir?' }")).toEqual([])
    expect(rules('src/shared/i18n/es.ts', "const a = 'Cerrá la ventana, por favor'")).toEqual([])
    expect(rules('src/shared/a.ts', "// ¿Qué hace esto? No hay que tocarlo\nconst re = /(sí|no) hay que/\nconst x = 1 /* qué */")).toEqual([])
    expect(rules('src/shared/a.ts', "const a = 'It\\'s fine' // año")).toEqual([])
  })

  it('R1 detects accents, inverted marks and pairs of Spanish words; one lone word is not enough', () => {
    for (const text of ['canción', '¿Listo?', 'No hay nada', 'el archivo de la casa']) expect(isSpanish(text), text).toBe(true)
    for (const text of ['no', 'Save', 'the file', 'es', 'de', 'hello world']) expect(isSpanish(text), text).toBe(false)
  })

  it('R2 flags JSX text and the user-visible attributes in the renderer, in any language', () => {
    const source = [
      'export function A() {',
      '  return (',
      '    <div className="box">',
      '      <button onClick={() => save(1)} title="Save it" aria-label={`Close ${name}`}>Save</button>',
      '      <input placeholder="Search" alt="" data-x="y" />',
      '      {count} items',
      '    </div>',
      '  )',
      '}'
    ].join('\n')
    const found = scanFile('src/renderer/src/A.tsx', source).filter((f) => f.rule === 'R2')
    expect(found.map((f) => f.text).sort()).toEqual(['Close {}', 'Save', 'Save it', 'Search', 'items'].sort())
  })

  it('R2 does not flag an attribute whose text comes from the dictionary', () => {
    expect(rules('src/renderer/src/A.tsx', "const A = () => <button title={t('chat.send')} aria-label={t('chat.send', { n })}>{t('chat.send')}</button>")).toEqual([])
    expect(rules('src/renderer/src/A.tsx', "const A = () => <button title={ok ? t('a.b') : 'Enviar'}>{t('a.c')}</button>")).toEqual(['R2'])
  })

  it('R2 does not flag a value compared inside an attribute, but flags its text branch', () => {
    expect(rules('src/renderer/src/A.tsx', "const A = () => <b title={state === 'speaking' ? t('a.b') : t('a.c')} />")).toEqual([])
    expect(rules('src/renderer/src/A.tsx', "const A = () => <b title={state === 'speaking' ? 'Stop' : t('a.c')} />")).toEqual(['R2'])
  })

  it('R2 skips what sits inside <code>, a command and not text', () => {
    expect(rules('src/renderer/src/A.tsx', 'const A = () => <p>Run <code>npx vercel setup</code></p>')).toEqual(['R2'])
    expect(scanFile('src/renderer/src/A.tsx', 'const A = () => <p>Run <code>npx vercel setup</code></p>')[0].text).toBe('Run')
  })

  it('R2 skips addresses, handles and identifiers but not a plain word', () => {
    expect(rules('src/renderer/src/A.tsx', 'const A = () => <p><b>@BotFather</b> <a href="x">myaccount.google.com/apppasswords</a></p>')).toEqual([])
    expect(rules('src/renderer/src/A.tsx', 'const A = () => <input placeholder="imap.gmail.com" title="tu_usuario" />')).toEqual([])
    expect(rules('src/renderer/src/A.tsx', 'const A = () => <input placeholder="Usuario" />')).toEqual(['R2'])
  })

  it('R2 flags a template literal that builds a sentence but not class names, keys or code', () => {
    const source = [
      'const a = () => {',
      '  const label = `${n} models selected`',
      '  const id = `row-${n}`',
      '  return <div className={`btn primary ${on ? "on" : ""}`} key={`item ${n}`}>{label}</div>',
      '}'
    ].join('\n')
    const found = scanFile('src/renderer/src/A.tsx', source).filter((f) => f.rule === 'R2')
    expect(found.map((f) => f.text)).toEqual(['{} models selected'])
  })

  it('R2 treats a separator such as the middle dot as punctuation, but an accented letter as text', () => {
    expect(rules('src/renderer/src/A.tsx', 'const a = `${provider} · ${model}`')).toEqual([])
    expect(rules('src/renderer/src/A.tsx', 'const a = `${n}ª`')).toEqual(['R2'])
  })

  it('R2 does not apply outside renderer .tsx files and ignores comparisons and arrows', () => {
    expect(rules('src/coordinator/a.ts', 'const a = <T,>(x: T) => x; const b = c > d && e < f')).toEqual([])
    expect(rules('src/renderer/src/lib.ts', 'export const a = `${n} models selected`')).toEqual([])
    expect(rules('src/renderer/src/A.tsx', 'const f = (a: number, b: number) => a > b && b < 3')).toEqual([])
    expect(rules('src/renderer/src/A.tsx', 'const [v, set] = useState<string | null>(null)\nconst x = 1')).toEqual([])
  })

  it('R3 flags literals passed to the user-facing sinks in main and the coordinator', () => {
    const sinks = [
      "notify('Recordatorio', `La rutina ${name} terminó`)",
      "new Notification({ title: 'Alma', body: 'Listo' })",
      "dialog.showMessageBoxSync(win, { message: 'Seguro?', buttons: ['Sí', 'No'] })",
      "tray.setToolTip('Alma')",
      "throw new Error('Cambio cancelado.')",
      "const item = { label: 'Salir', click }",
      "status({ detail: 'Descargando el modelo' })",
      "post({ type: 'notify', title: 'Post listo', body: `Revisá ${n}`, always: true })"
    ]
    for (const sink of sinks) expect(rules('src/main/a.ts', sink).includes('R3'), sink).toBe(true)
    expect(scanFile('src/main/a.ts', "notify('Recordatorio', `La rutina ${name} terminó`)").filter((f) => f.rule === 'R3')).toHaveLength(2)
    expect(scanFile('src/main/a.ts', "post({ type: 'notify', title: 'Post listo', body: `Revisá ${n}`, always: true })").filter((f) => f.rule === 'R3')).toHaveLength(2)
  })

  it('R3 does not flag the key handed to the translator, but flags a literal beside it', () => {
    expect(rules('src/main/a.ts', "throw new Error(mainError(settings.get().language, 'cancelled'))")).toEqual([])
    expect(rules('src/coordinator/a.ts', "throw new Error(this.text('voice.error.noRecordings'))")).toEqual([])
    expect(rules('src/main/a.ts', "notify(t('main.title'), 'Listo')")).toEqual(['R3'])
  })

  it('R3 does not flag model-only text: tool errors, prompts, plain strings, ids and calls without letters', () => {
    expect(rules('src/coordinator/tools/a.ts', "throw new ToolError('Path outside the workspace')")).toEqual([])
    expect(rules('src/coordinator/prompts/voice.ts', "export const voice = 'Keep answers short'\nnotify('Never shown')")).toEqual([])
    expect(rules('src/coordinator/a.ts', "const id = 'abc'; log('x'); notify(title, body)")).toEqual([])
    expect(rules('src/shared/a.ts', "notify('Hi there')")).toEqual([])
    expect(rules('src/coordinator/a.ts', "const a = { type: 'run.finished', error: 'x' }")).toEqual([])
    // inside a sink, a discriminant or a file name is not text for the person
    expect(rules('src/main/a.ts', "new Notification({ icon: join(dir, 'icon.png'), type: 'warning' })")).toEqual([])
  })

  it('R2 ignores generic return types that look like text between a brace and an angle bracket', () => {
    expect(rules('src/renderer/src/A.tsx', 'function f() {\n  return 1\n}\nasync function g(): Promise<void> {}\nconst h = ({ a }): Promise<void> => a')).toEqual([])
    expect(rules('src/renderer/src/A.tsx', 'export type T = <K extends Key>(key: K, ...params: Args<K>) => string')).toEqual([])
  })

  it('R1 skips an allowlisted file and only that file', () => {
    expect(rules('src/shared/i18n/en/languages.ts', "export const languages = { 'settings.language.es': 'Español' }")).toEqual([])
    expect(rules('src/shared/i18n/en/common.ts', "export const common = { 'common.x': 'Español' }")).toEqual(['R1'])
  })

  it('the lexer survives apostrophes in JSX text, regexes with quotes, division and nested templates', () => {
    const source = [
      "const re = /['\"`]/g",
      'const half = total / 2 / 3',
      'const A = () => <p>Don\'t panic</p>',
      "const t = `a ${b ? `deep ${'x'}` : 'y'} z`",
      "notify('after all that')"
    ].join('\n')
    const found = scanFile('src/main/a.tsx', source)
    expect(found.filter((f) => f.rule === 'R3').map((f) => f.text)).toEqual(['after all that'])
  })

  it('a file outside src/ or not TypeScript is never scanned', () => {
    expect(scanFile('tests/a.test.ts', "const a = 'Hola, ¿qué tal?'")).toEqual([])
    expect(scanFile('src/renderer/src/a.css', "a { content: 'Hola, ¿qué tal?' }")).toEqual([])
  })
})

describe('AC-2.5 the baseline only tightens', () => {
  const counts = (R1: number, R2 = 0, R3 = 0) => ({ R1, R2, R3 })

  it('passes when the counts equal the baseline', () => {
    expect(checkBaseline({ 'src/a.ts': counts(2) }, { 'src/a.ts': counts(2) })).toEqual([])
    expect(checkBaseline({}, {})).toEqual([])
  })

  it('fails above the baseline, naming the file and the rule, and counts a new file from zero', () => {
    expect(checkBaseline({ 'src/a.ts': counts(3) }, { 'src/a.ts': counts(2) })).toEqual([expect.stringContaining('src/a.ts R1: 3 hardcoded texts, baseline 2')])
    expect(checkBaseline({ 'src/new.ts': counts(0, 0, 1) }, {})).toEqual([expect.stringContaining('src/new.ts R3: 1 hardcoded texts, baseline 0')])
  })

  it('fails below the baseline, asking to lower it, also when a file is gone', () => {
    expect(checkBaseline({ 'src/a.ts': counts(1) }, { 'src/a.ts': counts(2) })).toEqual([expect.stringContaining('lower the baseline to 1')])
    expect(checkBaseline({}, { 'src/gone.ts': counts(0, 4) })).toEqual([expect.stringContaining('src/gone.ts R2: 0 hardcoded texts, baseline 4: lower the baseline to 0')])
  })

  it('counts each rule on its own', () => {
    const findings = scan({ 'src/renderer/src/A.tsx': 'const A = () => <p>Elegí una carpeta para el proyecto</p>' })
    expect(countByFile(findings)).toEqual({ 'src/renderer/src/A.tsx': { R1: 1, R2: 1, R3: 0 } })
  })
})

describe('AC-2.5 the real source tree', () => {
  it('has exactly the recorded number of hardcoded texts per file and rule (lower the baseline, never raise it)', () => {
    expect(checkBaseline(countByFile(scan(readSources(root))), BASELINE)).toEqual([])
  })

  it('AC-2.5 leaves no hardcoded text in main or the coordinator, nor anywhere else under src', () => {
    expect(Object.keys(BASELINE)).toEqual([])
    expect(countByFile(scan(readSources(root)))).toEqual({})
  })

  it('AC-2.5 knows a call that is already translated is not hardcoded text', () => {
    const source = "export const f = (language: string) => { throw new Error(workerText(language, 'downloadFailed', { url: 'x' })) }"
    expect(countByFile(scan({ 'src/coordinator/voice/worker.ts': source }))).toEqual({})
  })
})

describe('AC-2.5 the allowlist', () => {
  it('AC-2.5 every allowlisted file exists and gives its reason', () => {
    for (const [file, reason] of Object.entries(ALLOWLIST)) {
      expect(existsSync(join(root, file)), file).toBe(true)
      expect(reason.length, file).toBeGreaterThan(10)
    }
  })
})
