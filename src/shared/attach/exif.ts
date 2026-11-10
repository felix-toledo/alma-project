// Removes location, camera and author metadata from stored pictures by rewriting the container (spec 030 AC-3.3, AC-3.4).
// No decoder: the pixel-bearing segments are copied byte for byte and everything that is not on a keep list is dropped.
// A file that does not parse completely is refused, never half rewritten.
export class MalformedImageError extends Error {
  constructor(why: string) {
    super(`malformed image: ${why}`)
    this.name = 'MalformedImageError'
  }
}

const fail = (why: string): never => {
  throw new MalformedImageError(why)
}

const text = (b: Uint8Array, at: number, length: number) => String.fromCharCode(...b.subarray(at, at + length))

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// ---- JPEG ----

/** APPn and COM segments carry the metadata; only the ones a decoder needs to show the colors survive. */
function keepsJpegSegment(code: number, payload: Uint8Array): boolean {
  if (code === 0xe0) return text(payload, 0, 5) === 'JFIF\0'
  if (code === 0xe2) return text(payload, 0, 12) === 'ICC_PROFILE\0'
  if (code === 0xee) return text(payload, 0, 5) === 'Adobe'
  if ((code > 0xe0 && code <= 0xef) || code === 0xfe) return false
  // SOF, DHT, DAC, SOS, DQT, DNL, DRI, DHP, EXP: the frame itself
  if (code >= 0xc0 && code <= 0xdf) return true
  return fail('unknown marker')
}

function stripJpeg(b: Uint8Array): Uint8Array {
  if (b[0] !== 0xff || b[1] !== 0xd8) fail('not a JPEG')
  const out: Uint8Array[] = [b.subarray(0, 2)]
  let scans = 0
  let i = 2
  for (;;) {
    if (b[i] !== 0xff) fail('marker expected')
    while (b[i + 1] === 0xff) i++ // fill bytes before a marker
    const code = b[i + 1]
    if (code === undefined) fail('truncated')
    if (code === 0xd9) {
      if (!scans) fail('no scan')
      out.push(b.subarray(i, i + 2)) // whatever follows the end of image is dropped
      return concat(out)
    }
    if (code === 0x00 || code === 0x01 || code === 0xd8 || (code >= 0xd0 && code <= 0xd7)) fail('marker out of place')
    if (i + 4 > b.length) fail('truncated')
    const length = (b[i + 2] << 8) | b[i + 3]
    const end = i + 2 + length
    if (length < 2 || end > b.length) fail('segment length')
    if (keepsJpegSegment(code, b.subarray(i + 4, end))) out.push(b.subarray(i, end))
    i = end
    if (code !== 0xda) continue
    // entropy-coded data runs to the next marker; FF00 is a stuffed byte and FFD0..FFD7 restart the stream
    scans++
    const start = i
    while (!(b[i] === 0xff && b[i + 1] !== 0 && !(b[i + 1] >= 0xd0 && b[i + 1] <= 0xd7))) {
      if (i + 1 >= b.length) fail('truncated scan')
      i++
    }
    out.push(b.subarray(start, i))
  }
}

// ---- PNG ----

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
// The four standard critical chunks, then the ancillary ones that change how the pixels look. eXIf, tEXt, iTXt, zTXt,
// tIME and every unknown ancillary chunk are dropped. An unknown critical chunk (upper-case first letter) is refused:
// a decoder cannot skip it, so such a file could not be shown anyway, and copying it would carry whatever it holds.
const PNG_CRITICAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND'])
const PNG_RENDERING = new Set(['tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'hIST', 'cICP', 'mDCV', 'cLLI', 'acTL', 'fcTL', 'fdAT'])

function stripPng(b: Uint8Array): Uint8Array {
  if (!PNG_SIGNATURE.every((byte, k) => b[k] === byte)) fail('not a PNG')
  const out: Uint8Array[] = [b.subarray(0, 8)]
  let data = false
  let i = 8
  for (;;) {
    if (i + 12 > b.length) fail('truncated')
    const length = new DataView(b.buffer, b.byteOffset + i, 4).getUint32(0)
    const end = i + 12 + length
    if (end > b.length) fail('chunk length')
    const type = text(b, i + 4, 4)
    if (!/^[A-Za-z]{4}$/.test(type)) fail('chunk type')
    if (i === 8 && (type !== 'IHDR' || length !== 13)) fail('IHDR expected')
    if (type === 'IDAT') data = true
    if (PNG_CRITICAL.has(type) || PNG_RENDERING.has(type)) out.push(b.subarray(i, end))
    else if ((type.charCodeAt(0) & 0x20) === 0) fail('unknown critical chunk')
    i = end
    if (type === 'IEND') {
      if (!data) fail('no image data')
      return concat(out) // whatever follows IEND is dropped
    }
  }
}

// ---- WebP ----

// EXIF, 'XMP ' and every unknown chunk are dropped; these ones carry the picture or how to show it.
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ICCP', 'ALPH', 'ANIM', 'ANMF'])
const WEBP_IMAGE = new Set(['VP8 ', 'VP8L', 'ANMF'])
const VP8X_EXIF_AND_XMP = 0x08 | 0x04

function stripWebp(b: Uint8Array): Uint8Array {
  if (b.length < 12 || text(b, 0, 4) !== 'RIFF' || text(b, 8, 4) !== 'WEBP') fail('not a WebP')
  const view = new DataView(b.buffer, b.byteOffset, b.length)
  if (view.getUint32(4, true) + 8 !== b.length) fail('RIFF size')
  const chunks: Uint8Array[] = []
  let image = false
  let i = 12
  while (i < b.length) {
    if (i + 8 > b.length) fail('truncated')
    const type = text(b, i, 4)
    const size = view.getUint32(i + 4, true)
    const end = i + 8 + size + (size & 1) // chunks are padded to an even length
    if (end > b.length) fail('chunk length')
    if (type === 'VP8X' && size !== 10) fail('VP8X size')
    if (WEBP_IMAGE.has(type)) image = true
    if (WEBP_KEEP.has(type)) {
      const chunk = b.slice(i, end)
      if (type === 'VP8X') chunk[8] &= ~VP8X_EXIF_AND_XMP
      chunks.push(chunk)
    }
    i = end
  }
  if (!image) fail('no image data')
  const out = concat([b.subarray(0, 12), ...chunks])
  new DataView(out.buffer).setUint32(4, out.length - 8, true)
  return out
}

export function stripMetadata(kind: 'jpeg' | 'png' | 'webp' | 'gif', bytes: Uint8Array): Uint8Array {
  if (kind === 'jpeg') return stripJpeg(bytes)
  if (kind === 'png') return stripPng(bytes)
  if (kind === 'webp') return stripWebp(bytes)
  // GIF carries no camera metadata worth the risk of re-writing frames (AC-3.3): it is stored as is, once it is known to be a GIF
  if (!['GIF87a', 'GIF89a'].includes(text(bytes, 0, 6))) fail('not a GIF')
  return bytes
}
