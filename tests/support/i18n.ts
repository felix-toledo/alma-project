// The ratchet behind AC-2.5 (spec 025, plan D4): user-visible text must come from the dictionaries, so every
// hardcoded literal is counted per file and the count may only go down. No AST (typescript 7 has no old compiler
// API), so this is a small lexer plus regexes: it is a heuristic and its false positives are part of the baseline.
//
//   R1  Spanish text in any string, template or JSX text under src/ (the es dictionary files and ALLOWLIST excepted)
//   R2  renderer .tsx: JSX text, user-visible attributes, template literals that build text (any language)
//   R3  main and coordinator: literals passed to the user-facing sinks (notifications, dialogs, tray, errors, labels)
//
// Model-only English is exempt by location (src/coordinator/prompts/**) and by not being a sink (ToolError, tool.* keys).

export type RuleId = 'R1' | 'R2' | 'R3'
export type Counts = Record<RuleId, number>
export interface Finding {
  file: string
  rule: RuleId
  text: string
}

/** Files that may hold Spanish on purpose, each with its reason. Empty entries are removed, not left as comments. */
export const ALLOWLIST: Record<string, string> = {
  'src/shared/i18n/vocab.ts': 'the Spanish half of the yes/no, closing and cancel words, understood whatever the app language is (spec 025 BR-20)',
  'src/shared/attachments.ts': 'LEGACY_HEADING is the Spanish heading of messages sent before it became English; the chat keeps folding them',
  'src/coordinator/knowledge/stopwords.ts': 'the Spanish words the vault search leaves out: vocabulary of the notes, never shown (spec 025 AC-2.5)',
  'src/coordinator/tools/htmlEntities.ts': 'decodes &aacute; and its kin to letters when a page is read: data, never shown',
  'src/shared/agentNames.ts': 'first names given to new agents: names, not text to translate',
  'src/main/instagram-labels.ts': "the Spanish words of Instagram's own page that the publisher looks for: matched against the page, never shown (spec 025 AC-3.8)",
  'src/shared/i18n/en/languages.ts': 'the language selector names each option in its own language, so «Español» sits in the en dictionary (spec 025 BR-3)'
}

const ES_DICTIONARY = /^src\/shared\/i18n\/es(\.ts$|\/)/
const MODEL_ONLY = /^src\/coordinator\/prompts\//

interface Literal {
  text: string
  kind: 'string' | 'template' | 'jsx'
}
interface Lexed {
  skeleton: string
  literals: Literal[]
  /** The comments that were stripped, each with where it starts (the comment-language ratchet reads them). */
  comments: { text: string; at: number }[]
}

const mark = (index: number): string => `\uE000${index}\uE001`
const MARKS = /\uE000(\d+)\uE001/g
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await'])

/** Strips comments, replaces strings, templates and regexes with markers and collects their text. */
export function lex(source: string): Lexed {
  const literals: Literal[] = []
  const comments: { text: string; at: number }[] = []
  let pos = 0

  const closingQuote = (quote: string): number => {
    for (let j = pos + 1; j < source.length; j++) {
      if (source[j] === '\\') j++
      else if (source[j] === quote) return j
      else if (source[j] === '\n') return -1
    }
    return -1
  }

  const regexEnd = (): number => {
    let inClass = false
    for (let j = pos + 1; j < source.length; j++) {
      const c = source[j]
      if (c === '\\') j++
      else if (c === '\n') return -1
      else if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) {
        while (/[a-z]/.test(source[j + 1] ?? '')) j++
        return j + 1
      }
    }
    return -1
  }

  const regexAllowed = (out: string): boolean => {
    if (source[pos + 1] === '>') return false
    const tail = out.trimEnd()
    if (!tail) return true
    const last = tail[tail.length - 1]
    if (last === '<' || last === '>') return false
    if (/[\w$]/.test(last)) return KEYWORDS_BEFORE_REGEX.has(/[\w$]+$/.exec(tail)?.[0] ?? '')
    return '(,=:[!&|?{};+-*%~^'.includes(last)
  }

  const template = (): string => {
    const index = literals.push({ text: '', kind: 'template' }) - 1
    let text = ''
    pos++
    while (pos < source.length && source[pos] !== '`') {
      if (source[pos] === '\\') {
        text += source.slice(pos, pos + 2)
        pos += 2
      } else if (source[pos] === '$' && source[pos + 1] === '{') {
        pos += 2
        code(true)
        pos++
        text += '{}'
      } else text += source[pos++]
    }
    pos++
    literals[index].text = text
    return mark(index)
  }

  function code(untilBrace: boolean): string {
    let out = ''
    let depth = 0
    while (pos < source.length) {
      const c = source[pos]
      const next = source[pos + 1]
      if (c === '/' && next === '/') {
        const start = pos
        while (pos < source.length && source[pos] !== '\n') pos++
        comments.push({ text: source.slice(start + 2, pos), at: start })
        continue
      }
      if (c === '/' && next === '*') {
        const end = source.indexOf('*/', pos + 2)
        const stop = end < 0 ? source.length : end + 2
        comments.push({ text: source.slice(pos + 2, end < 0 ? stop : end), at: pos })
        out += source.slice(pos, stop).replace(/[^\n]/g, ' ')
        pos = stop
        continue
      }
      // An apostrophe in JSX text has no closing quote on its line: it is a plain character, not a string.
      if (c === "'" || c === '"') {
        const end = closingQuote(c)
        if (end > 0) {
          out += mark(literals.push({ text: source.slice(pos + 1, end), kind: 'string' }) - 1)
          pos = end + 1
          continue
        }
      }
      if (c === '`') {
        out += template()
        continue
      }
      if (c === '/' && regexAllowed(out)) {
        const end = regexEnd()
        if (end > 0) {
          out += '/R/'
          pos = end
          continue
        }
      }
      if (untilBrace) {
        if (c === '{') depth++
        else if (c === '}') {
          if (depth === 0) return out
          depth--
        }
      }
      out += c
      pos++
    }
    return out
  }

  const skeleton = code(false)
  return { skeleton, literals, comments }
}

const hasLetter = (text: string): boolean => /\p{L}/u.test(text)

/** One word with a dot, slash, @, underscore or digit: an address, a handle or an identifier, not text to translate. */
const isToken = (text: string): boolean => !/\s/.test(text.trim()) && /[./@_+\d]/.test(text)

const SPANISH_WORDS = new Set(
  'de del la las los el que para con una por hay se su sus al lo como pero sin ya no mi tu te en esta este esto son fue ser'.split(' ')
)

export function isSpanish(text: string): boolean {
  const plain = text.replace(/\{\}/g, ' ')
  if (/[áéíóúñüÁÉÍÓÚÑÜ¿¡]/.test(plain)) return true
  const words = plain.toLowerCase().match(/\p{L}+/gu) ?? []
  return new Set(words.filter((w) => SPANISH_WORDS.has(w))).size >= 2
}

const USER_ATTRIBUTES = /\b(title|placeholder|aria-label|alt|label|hint|tooltip)\s*=\s*(\{[^{}]*\}|\uE000\d+\uE001)/g
const NON_TEXT_ATTRIBUTES = /^(className|key|id|htmlFor|href|src|style|type|name|viewBox|d|fill|stroke|transform|data-[\w-]+)$/

/** Template text that reads as a sentence: letters in words separated by spaces, or any non-ASCII letter. */
const reads = (text: string): boolean => /\p{L}+\s+\p{L}/u.test(text) || [...text].some((c) => /\p{L}/u.test(c) && /[^\p{ASCII}]/u.test(c))

const NOT_JSX_TEXT = /[=;]|&&|\|\||\uE000|\w\(|\b(return|const|let|var|function|import|export|else|case|break|if|type|interface|satisfies)\b/

function jsxTexts(skeleton: string): string[] {
  const found: string[] = []
  const markup = skeleton.replaceAll('=>', '=_')
  for (const match of markup.matchAll(/([>}])([^<>{}]*)(?=([<{]))/g)) {
    const [, left, text, right] = match
    if (left === '}' && right === '{') continue
    // what sits inside <code> is a command or an identifier, not text to translate
    if (/<code\b[^<>]*>$/.test(markup.slice(0, match.index + 1))) continue
    if (!hasLetter(text) || NOT_JSX_TEXT.test(text) || /^\s*\)|\)\s*:|\.\.\.|\w\s*:\s*\w+\s*[,)]|\w\?\s*:|^\s*:\s*\w+\s*$/.test(text)) continue
    if (isToken(text)) continue
    found.push(text.replace(/\s+/g, ' ').trim())
  }
  return found
}

function span(skeleton: string, open: number, closer: string, opener: string): string {
  let depth = 1
  for (let i = open; i < skeleton.length; i++) {
    if (skeleton[i] === opener) depth++
    else if (skeleton[i] === closer && --depth === 0) return skeleton.slice(open, i)
  }
  return skeleton.slice(open)
}

const CALL_SINKS = /\b(?:notify|setToolTip|showMessageBox(?:Sync)?|showErrorBox)\s*\(|\bnew\s+(?:Notification|Error)\s*\(/g
const KEY_SINKS = /\b(?:label|detail)\s*:\s*\uE000(\d+)\uE001/g
const NOTIFY_OBJECT = /\btype\s*:\s*\uE000(\d+)\uE001/g

function sinkTexts(lexed: Lexed): string[] {
  const { skeleton, literals } = lexed
  const texts: string[] = []
  const take = (inside: string, skip = -1): void => {
    for (const m of inside.matchAll(MARKS)) {
      const index = Number(m[1])
      const text = literals[index].text
      // Not words for the person: a discriminant (`type: 'warning'`), a file name, an escape.
      // The key given to the translator is not the text: `new Error(mainError(language, 'cancelled'))`.
      const key = /\b(?:t|text|mainError|translate|workerText)\((?:[^()]|\([^()]*\))*$/.test(inside.slice(0, m.index))
      const technical = key || /\btype\s*:\s*$/.test(inside.slice(0, m.index)) || /^[\w./-]+\.\w{2,4}$/.test(text) || !hasLetter(text.replace(/\{\}/g, '').replace(/\\[nrt]/g, ''))
      if (index !== skip && !technical && hasLetter(text)) texts.push(text)
    }
  }
  for (const m of skeleton.matchAll(CALL_SINKS)) take(span(skeleton, m.index + m[0].length, ')', '('))
  for (const m of skeleton.matchAll(KEY_SINKS)) take(m[0].slice(m[0].indexOf('\uE000')))
  // { type: 'notify', title, body } messages from the coordinator to main
  for (const m of skeleton.matchAll(NOTIFY_OBJECT)) {
    const marker = Number(m[1])
    if (literals[marker].text === 'notify') take(span(skeleton, m.index + m[0].length, '}', '{'), marker)
  }
  return texts
}

export function scanFile(file: string, source: string): Finding[] {
  if (!/^src\/.+\.tsx?$/.test(file)) return []
  const lexed = lex(source)
  const found: Finding[] = []
  const add = (rule: RuleId, text: string): void => {
    found.push({ file, rule, text })
  }

  const jsx = file.endsWith('.tsx') ? jsxTexts(lexed.skeleton) : []
  const spanishAllowed = ES_DICTIONARY.test(file) || file in ALLOWLIST
  if (!spanishAllowed) {
    for (const literal of [...lexed.literals, ...jsx.map((text) => ({ text, kind: 'jsx' as const }))]) {
      if (isSpanish(literal.text)) add('R1', literal.text)
    }
  }

  if (file.startsWith('src/renderer/') && file.endsWith('.tsx')) {
    const counted = new Set<number>()
    for (const text of jsx) add('R2', text)
    for (const m of lexed.skeleton.matchAll(USER_ATTRIBUTES)) {
      for (const marker of m[2].matchAll(MARKS)) {
        const index = Number(marker[1])
        // `title={t('settings.title')}`: the key is not text, the dictionary holds the text
        if (/\bt\(\s*$/.test(m[2].slice(0, marker.index))) continue
        // `state === 'speaking' ? ...`: a value being compared is code, not text
        if (/[!=]==?\s*$/.test(m[2].slice(0, marker.index))) continue
        if (hasLetter(lexed.literals[index].text) && !isToken(lexed.literals[index].text)) {
          counted.add(index)
          add('R2', lexed.literals[index].text)
        }
      }
    }
    lexed.literals.forEach((literal, index) => {
      if (literal.kind !== 'template' || counted.has(index) || !reads(literal.text)) return
      const before = lexed.skeleton.slice(0, lexed.skeleton.indexOf(mark(index)))
      const attribute = /([\w-]+)\s*=\s*\{[^{}]*$/.exec(before.slice(-200))?.[1]
      if (!attribute || !NON_TEXT_ATTRIBUTES.test(attribute)) add('R2', literal.text)
    })
  }

  if ((file.startsWith('src/main/') || file.startsWith('src/coordinator/')) && !MODEL_ONLY.test(file)) {
    for (const text of sinkTexts(lexed)) add('R3', text)
  }
  return found
}

export function scan(files: Record<string, string>): Finding[] {
  return Object.entries(files).flatMap(([file, source]) => scanFile(file, source))
}

export function countByFile(findings: Finding[]): Record<string, Counts> {
  const counts: Record<string, Counts> = {}
  for (const { file, rule } of findings) (counts[file] ??= { R1: 0, R2: 0, R3: 0 })[rule]++
  return counts
}

/** One message per file and rule that is above the baseline (new text) or below it (lower the baseline). */
export function checkBaseline(actual: Record<string, Counts>, baseline: Record<string, Counts>): string[] {
  const problems: string[] = []
  for (const file of [...new Set([...Object.keys(actual), ...Object.keys(baseline)])].sort()) {
    for (const rule of ['R1', 'R2', 'R3'] as const) {
      const now = actual[file]?.[rule] ?? 0
      const recorded = baseline[file]?.[rule] ?? 0
      if (now > recorded) problems.push(`${file} ${rule}: ${now} hardcoded texts, baseline ${recorded}: move the new text into the dictionaries`)
      if (now < recorded) problems.push(`${file} ${rule}: ${now} hardcoded texts, baseline ${recorded}: lower the baseline to ${now}`)
    }
  }
  return problems
}

/** Today's counts, one line per file so parallel tasks edit different lines. Only ever lowered. */
export const BASELINE: Record<string, Counts> = {}
