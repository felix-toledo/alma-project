import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Byte builders for the spec 030 verification tests. They make small, structurally valid pictures that carry metadata
// markers, so a test can look for the marker in what was stored.

export const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))
export const bytes = (...parts: (number | number[] | Uint8Array)[]): Uint8Array => Uint8Array.from(parts.flatMap((p) => (typeof p === 'number' ? [p] : [...p])))
export const b64 = (data: Uint8Array): string => Buffer.from(data).toString('base64')
export const has = (data: Uint8Array, marker: string): boolean => Buffer.from(data).includes(Buffer.from(marker, 'latin1'))
export const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b))
export const tmp = (label: string): string => mkdtempSync(join(tmpdir(), `alma-030v-${label}-`))

/** Metadata markers every builder plants; none of them may survive a strip. */
export const MARKERS = ['GPSMARK', 'CAMERAMARK', 'XMPMARK', 'COMMARK', 'TEXTMARK']

// ---- JPEG ----

export const jpegSegment = (code: number, payload: number[] | Uint8Array): number[] => [0xff, code, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload]
/** Entropy-coded data with a stuffed FF00 and a restart marker, which the stripper must keep as is. */
export const JPEG_PIXELS = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0x78]

export interface JpegOptions {
  exif?: boolean
  extras?: number[][]
  trailing?: number[]
  /** A second scan after a metadata segment (progressive layout). */
  progressive?: boolean
  noEnd?: boolean
}

export function makeJpeg(o: JpegOptions = {}): Uint8Array {
  const exif = o.exif ?? true
  const parts: number[][] = [
    [0xff, 0xd8],
    jpegSegment(0xe0, [...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(exif
      ? [
          jpegSegment(0xe1, [...ascii('Exif\0\0'), ...ascii('GPSMARK CAMERAMARK')]),
          jpegSegment(0xe1, [...ascii('http://ns.adobe.com/xap/1.0/\0'), ...ascii('XMPMARK')]),
          jpegSegment(0xfe, ascii('COMMARK')),
          jpegSegment(0xed, ascii('Photoshop 3.0\0GPSMARK')),
        ]
      : []),
    jpegSegment(0xe2, [...ascii('ICC_PROFILE\0'), 1, 1, 9, 9]),
    jpegSegment(0xdb, new Array(65).fill(3)),
    jpegSegment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
    jpegSegment(0xc4, new Array(20).fill(1)),
    ...(o.extras ?? []),
    jpegSegment(0xda, [1, 1, 0, 0, 63, 0]),
    JPEG_PIXELS,
  ]
  if (o.progressive) parts.push(jpegSegment(0xe1, ascii('Exif\0\0GPSMARK-AFTER-SCAN')), jpegSegment(0xda, [1, 1, 0, 0, 63, 0]), [0x9a, 0x9b])
  if (!o.noEnd) parts.push([0xff, 0xd9])
  if (o.trailing) parts.push(o.trailing)
  return Uint8Array.from(parts.flat())
}

// ---- PNG ----

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
export const pngChunk = (type: string, data: number[] | Uint8Array = []): number[] => [(data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255, ...ascii(type), ...data, 0, 0, 0, 0]

export interface PngOptions {
  exif?: boolean
  extras?: number[][]
  trailing?: number[]
  /** Pads the IDAT so the whole file is exactly this long. */
  size?: number
  noEnd?: boolean
}

export function makePng(o: PngOptions = {}): Uint8Array {
  const head = [
    ...PNG_SIGNATURE,
    ...pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
    ...pngChunk('sRGB', [0]),
    ...pngChunk('gAMA', [0, 1, 0, 0]),
    ...(o.exif ?? true
      ? [...pngChunk('eXIf', ascii('GPSMARK CAMERAMARK')), ...pngChunk('tEXt', ascii('Comment\0TEXTMARK')), ...pngChunk('iTXt', ascii('XML:com.adobe.xmp\0\0\0\0\0XMPMARK')), ...pngChunk('zTXt', ascii('x\0\0TEXTMARK')), ...pngChunk('tIME', [7, 232, 1, 1, 0, 0, 0])]
      : []),
    ...(o.extras ?? []).flat(),
  ]
  const tail = [...pngChunk('IEND'), ...(o.trailing ?? [])]
  const idatBytes = o.size === undefined ? [1, 2, 3, 4, 5, 6, 7, 8] : new Array(o.size - head.length - tail.length - 12).fill(7)
  const out = [...head, ...pngChunk('IDAT', idatBytes), ...(o.noEnd ? [] : tail)]
  return Uint8Array.from(out)
}

// ---- WebP ----

const le32 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]
export const riffChunk = (type: string, data: number[]): number[] => [...ascii(type), ...le32(data.length), ...data, ...(data.length % 2 ? [0] : [])]

export interface WebpOptions {
  exif?: boolean
  flags?: number
  extras?: number[][]
  /** Skip fixing the RIFF size field up. */
  riffSize?: number
}

export function makeWebp(o: WebpOptions = {}): Uint8Array {
  const exif = o.exif ?? true
  const chunks = [
    riffChunk('VP8X', [o.flags ?? (exif ? 0x20 | 0x10 | 0x08 | 0x04 : 0x20), 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    riffChunk('ICCP', [9, 9, 9]),
    riffChunk('VP8 ', [1, 2, 3, 4, 5]),
    ...(exif ? [riffChunk('EXIF', ascii('GPSMARK CAMERAMARK')), riffChunk('XMP ', ascii('XMPMARK'))] : []),
    ...(o.extras ?? []),
  ].flat()
  return Uint8Array.from([...ascii('RIFF'), ...le32(o.riffSize ?? 4 + chunks.length), ...ascii('WEBP'), ...chunks])
}

export const GIF = Uint8Array.from([...ascii('GIF89a'), 1, 0, 1, 0, 0, 0, 0, 0x21, 0xfe, 4, ...ascii('GPSM'), 0, 0x3b])

/** A run of text bytes with a NUL at the position given (or none). */
export function textWithNul(length: number, nulAt?: number): Uint8Array {
  const data = new Uint8Array(length).fill(0x61)
  if (nulAt !== undefined) data[nulAt] = 0
  return data
}
