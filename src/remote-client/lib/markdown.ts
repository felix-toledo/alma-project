import { resolveRelative } from '../../shared/vault/paths'

// The rules the desktop's reading mode (components/Markdown.tsx) applies, as pure functions: the screen only renders their output.

/** The `---` block at the very top of a note is metadata, not text (the desktop hides it in reading mode too). */
export function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '')
}

/** `![[foto.png]]` becomes a regular image reference so it goes the same way as `![](foto.png)`; `[[note]]` stays plain text. */
export function wikiEmbeds(text: string): string {
  return text.replace(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g, (_match, name: string) => `![${name}](<${name.trim()}>)`)
}

/** What the markdown renderer is given for a note's text. */
export function prepareNote(content: string): string {
  return wikiEmbeds(stripFrontmatter(content.replace(/^\uFEFF/, '')))
}

/** Any `scheme:` start, which also catches a drive path such as `C:\`. */
const SCHEME = /^[a-z][\w+.-]*:/i

export type LinkKind = { kind: 'note'; path: string } | { kind: 'external'; url: string } | { kind: 'blocked' }
const blocked = { kind: 'blocked' } as const

/**
 * What a tap on a link does (AC-2.15): a relative `.md` link opens that note, resolved against the note it is written in; an
 * `http(s)` link is external and the screen opens it only on a tap; everything else (`javascript:`, `mailto:`, `data:`, an
 * absolute or climbing path, a protocol-relative address, a file that is not a note) does nothing.
 */
export function classifyLink(href: string, notePath: string): LinkKind {
  const link = href.trim()
  if (/^https?:\/\//i.test(link)) {
    try {
      return { kind: 'external', url: new URL(link).href }
    } catch {
      return blocked
    }
  }
  if (!link || SCHEME.test(link) || /^[/\\#]/.test(link)) return blocked
  let target: string
  try {
    target = decodeURIComponent(link.replace(/[#?][\s\S]*$/, ''))
  } catch {
    return blocked
  }
  if (!/\.md$/i.test(target)) return blocked
  const resolved = resolveRelative(target, notePath)
  return resolved.escapes ? blocked : { kind: 'note', path: resolved.path }
}

export type ImageSource = { kind: 'vault'; target: string } | { kind: 'blocked' }

/**
 * Where an image in a note may come from (AC-2.12): only a vault reference, which the screen asks the PC for. An address
 * the author wrote (a tracking pixel, `data:`, another host) is never loaded, so a note cannot make the phone call out.
 */
export function imageTarget(src: string | undefined): ImageSource {
  if (!src || SCHEME.test(src) || /^[/\\]{2}/.test(src)) return blocked
  try {
    return { kind: 'vault', target: decodeURIComponent(src) }
  } catch {
    return blocked
  }
}
