import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PHONE_ATTACH } from '../src/shared/attach/phone'
import { ALLOWED_EXTENSIONS } from '../src/shared/attach/rules'
import { REMOTE_LIMITS } from '../src/shared/remote/api'
import { importsOf, readSources, resolveSpecifier, violations } from './support/arch'

const root = join(__dirname, '..')
const sources = readSources(root)
const REMOTE_DIR = 'src/coordinator/channels/remote/'

/** What the remote module must not hold: a file-system API, a list of file types, the size rule, the name sanitiser, the store layout. */
function copiesOfTheRules(file: string, source: string): string[] {
  const found: string[] = []
  for (const specifier of importsOf(source)) if (/^(node:)?fs(\/promises)?$/.test(specifier)) found.push(`${file} imports ${specifier}`)
  const code = source.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*|import\b)/.test(line)).join('\n')
  const extensions = code.match(/['"]\.(png|jpe?g|webp|gif|pdf|txt|docx?|xlsx?|pptx?|md|csv)['"]/gi) ?? []
  if (extensions.length > 0) found.push(`${file} lists file types: ${extensions.join(' ')}`)
  if (/\b700[_ ]?000\b/.test(code)) found.push(`${file} holds the phone size limit`)
  if (/sanitize|storedFileName|\binbox\b/i.test(code)) found.push(`${file} holds the name sanitiser or the store layout`)
  return found
}

describe('the remote module holds no copy of the attachment rules (spec 031 T39)', () => {
  it('AC-9.3 (031) uploads.ts imports no file-system API and holds no copy of the rules', () => {
    const uploads = sources[`${REMOTE_DIR}uploads.ts`]
    expect(uploads).toBeDefined()
    expect(copiesOfTheRules('uploads.ts', uploads ?? '')).toEqual([])
    // it reaches the rules through the shared functions and the injected port, and says so in its imports
    expect(importsOf(uploads ?? '')).toEqual(expect.arrayContaining(['../../../shared/attach/phone']))
  })

  it('AC-9.3 (031) no file the phone upload touches in the remote module reads a file system or lists types', () => {
    for (const file of ['uploads.ts', 'chat.ts', 'threads.ts', 'thread-view.ts', 'audit.ts']) {
      expect(copiesOfTheRules(file, sources[`${REMOTE_DIR}${file}`] ?? ''), file).toEqual([])
    }
  })

  it('AC-9.3 (031) the scan catches a copy: a file with node:fs, a .png list, the limit and a sanitiser fails it', () => {
    const copy = [
      "import { writeFileSync } from 'node:fs'",
      "const types = ['.png', '.pdf']",
      'const limit = 700000',
      'const clean = (name: string) => sanitize(name)'
    ].join('\n')
    expect(copiesOfTheRules('copy.ts', copy)).toHaveLength(4)
    // imports of the shared rules are not copies
    expect(copiesOfTheRules('ok.ts', "import { PHONE_ATTACH } from '../../../shared/attach/phone'\nconst max = PHONE_ATTACH.maxFileBytes")).toEqual([])
  })

  it('AC-9.3 (031) the architecture rules still hold with the new files (remote-client imports no node:*)', () => {
    expect(violations(sources)).toEqual([])
    // the real reading sees a forbidden import in a phone file
    expect(violations({ 'src/remote-client/lib/attach.ts': "import { readFileSync } from 'node:fs'" })).not.toEqual([])
  })
})

describe('limits and the other channels are unchanged (spec 031 T39)', () => {
  it('AC-9.5 (031) REMOTE_LIMITS is byte-identical, the phone limit is its own constant, and the manifest pins limits.ts', () => {
    expect({ ...REMOTE_LIMITS }).toEqual({
      requestBytes: 1_048_576,
      photoBytes: 2_097_152,
      chatChars: 8000,
      requestsPerMinute: 60,
      connectionsPerDevice: 2,
      timeoutMs: 30_000,
      testWaitMs: 10_000,
      pairingPerMinute: 5,
      approvalInputChars: 1500,
      longPollMs: 25_000,
      firstLoadMessages: 30
    })
    expect(Object.keys(REMOTE_LIMITS)).not.toContain('maxFileBytes')
    expect(PHONE_ATTACH.maxFileBytes).toBe(700_000)
    const manifest = JSON.parse(readFileSync(join(root, 'tests/support/remote-protected.json'), 'utf8')) as Record<string, string>
    const source = readFileSync(join(root, 'src/shared/remote/limits.ts'), 'utf8').replaceAll('\r\n', '\n')
    expect(createHash('sha256').update(source).digest('hex')).toBe(manifest['src/shared/remote/limits.ts'])
  })

  it('AC-9.6 (031) Telegram, WhatsApp and voice import nothing of the phone upload', () => {
    const phone = /(^|\/)channels\/remote\/uploads$|(^|\/)attachments\/phone$|(^|\/)shared\/attach\/phone(-chips)?$/
    const others = Object.entries(sources).filter(([file]) => /^src\/coordinator\/(channels\/(?!remote\/)|voice\/)/.test(file))
    expect(others.map(([file]) => file)).toEqual(expect.arrayContaining(['src/coordinator/channels/telegram.ts', 'src/coordinator/channels/whatsapp.ts']))
    const reached = (file: string, source: string) => importsOf(source).map((specifier) => resolveSpecifier(file, specifier)).filter((target) => phone.test(target))
    for (const [file, source] of others) expect(reached(file, source), file).toEqual([])
    // the scan sees it when one does
    expect(reached('src/coordinator/channels/telegram.ts', "import { PhoneFiles } from '../attachments/phone'")).toEqual(['src/coordinator/attachments/phone'])
    expect(reached('src/coordinator/voice/assistant.ts', "import { UploadsFlow } from '../channels/remote/uploads'")).toEqual(['src/coordinator/channels/remote/uploads'])
    expect(reached('src/coordinator/channels/whatsapp.ts', "import { PHONE_ATTACH } from '../../shared/attach/phone'")).toEqual(['src/shared/attach/phone'])
  })

  it('AC-9.6 (031) the phone and the desktop share one type list (no second list in shared/attach/phone.ts)', () => {
    const source = readFileSync(join(root, 'src/shared/attach/phone.ts'), 'utf8')
    expect(source).not.toMatch(/['"]\.(png|jpe?g|pdf|txt)['"]/)
    expect(Object.keys(ALLOWED_EXTENSIONS)).toContain('.png')
  })
})
