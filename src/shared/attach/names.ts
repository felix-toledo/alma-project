const MAX_NAME = 60
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/** The character step: letters, digits, `_`, `.` and `-` are kept, every other run becomes `_`, the last 60 characters stay. */
export function sanitizeFileName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').slice(-MAX_NAME)
}

/** The name a stored attachment gets on disk (BR-8): one safe path segment that Windows will not reinterpret. */
export function storedFileName(original: string): string {
  // a leading run of dots goes; one that holds a dash becomes `_` (a leading `-` would read as an option and the index
  // needs a word character first), which also keeps the extension of `-.txt`. This runs after the 60-character cut.
  const name =
    sanitizeFileName(original)
      .replace(/^[.-]+/, (run) => (run.includes('-') ? '_' : ''))
      .replace(/\.+$/, '') || 'attachment'
  // the prefix replaces the first character when the name is already at the limit, so it never grows past 60
  return RESERVED.test(name) ? `_${name.slice(-(MAX_NAME - 1))}` : name
}

/** The name of a picture that arrives without a useful one: `imagen-<timestamp>.<ext>`. */
export const pictureName = (now: number, ext: 'png' | 'jpg'): string => `imagen-${now}.${ext}`

/** A pasted picture often has no name, or the browser's `image.png` (002 AC-5.6). */
export function defaultPictureName(name: string, now: number): string {
  return name && name !== 'image.png' ? name : pictureName(now, 'png')
}
