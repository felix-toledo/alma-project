import { deflateSync } from 'node:zlib'

// Hand-assembled pictures for the metadata strippers (spec 030 AC-3.3, AC-3.4). Each builder takes `metadata` and
// returns the same image with or without the segments the stripper must remove, so the expected output of a strip
// is simply the build without metadata.
export const MARKERS = {
  gps: 'GPS-LAT-48.8584N-LON-2.2945E',
  xmp: 'XMP-CREATOR-TOOL-MARKER',
  iptc: 'IPTC-BYLINE-MARKER',
  comment: 'COMMENT-MARKER',
  mpf: 'MPF-THUMBNAIL-MARKER',
  exifWebp: 'EXIF-WEBP-GPS-MARKER',
  xmpWebp: 'XMP-WEBP-MARKER',
  text: 'PNG-TEXT-MARKER',
}

const latin1 = (s: string): number[] => [...Buffer.from(s, 'latin1')]
export const join = (...parts: (number[] | Uint8Array)[]): Uint8Array => new Uint8Array(parts.flatMap((p) => [...p]))

export function contains(haystack: Uint8Array, needle: string): boolean {
  return Buffer.from(haystack).includes(Buffer.from(needle, 'latin1'))
}

// ---- JPEG ----

export const jpegSegment = (marker: number, payload: number[]): number[] => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload]

const EXIF_TIFF = [...latin1('Exif'), 0, 0, ...latin1('MM'), 0, 42, 0, 0, 0, 8, ...latin1(MARKERS.gps), 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0]

/** A 4x4 baseline-looking JPEG; the entropy data carries byte stuffing (FF00) and a restart marker (FFD0). */
export function buildJpeg({ metadata, tail = [] }: { metadata: boolean; tail?: number[] }): Uint8Array {
  const jfif = jpegSegment(0xe0, [...latin1('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])
  const icc = jpegSegment(0xe2, [...latin1('ICC_PROFILE'), 0, 1, 1, 9, 8, 7, 6])
  const extra = metadata
    ? [
        ...jpegSegment(0xe1, EXIF_TIFF),
        ...jpegSegment(0xe1, [...latin1('http://ns.adobe.com/xap/1.0/'), 0, ...latin1(MARKERS.xmp)]),
        ...jpegSegment(0xed, [...latin1('Photoshop 3.0'), 0, ...latin1('8BIM'), 4, 4, 0, 0, ...latin1(MARKERS.iptc)]),
        ...jpegSegment(0xe2, [...latin1('MPF'), 0, ...latin1(MARKERS.mpf)]),
        ...jpegSegment(0xfe, latin1(MARKERS.comment)),
      ]
    : []
  const dqt = jpegSegment(0xdb, [0, ...Array.from({ length: 64 }, (_, i) => 16 + (i % 7))])
  const sof = jpegSegment(0xc0, [8, 0, 4, 0, 4, 1, 1, 0x11, 0])
  const dht = jpegSegment(0xc4, [0x00, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6])
  const sos = jpegSegment(0xda, [1, 1, 0x00, 0, 63, 0])
  const scan = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0x00, 0x78]
  return new Uint8Array([0xff, 0xd8, ...jfif, ...extra, ...icc, ...dqt, ...sof, ...dht, ...sos, ...scan, 0xff, 0xd9, ...tail])
}

// ---- PNG ----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(bytes: number[]): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]

export const pngChunk = (type: string, data: number[]): number[] => [...u32be(data.length), ...latin1(type), ...data, ...u32be(crc32([...latin1(type), ...data]))]

/** The 2x2 RGB pixels of the PNG fixture, one filter byte (0) per row. */
export const PNG_SCANLINES = [0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]

export function buildPng({ metadata, tail = [] }: { metadata: boolean; tail?: number[] }): Uint8Array {
  const idat = [...deflateSync(Buffer.from(PNG_SCANLINES))]
  const extra = metadata
    ? [
        ...pngChunk('tEXt', [...latin1('Comment'), 0, ...latin1(MARKERS.text)]),
        ...pngChunk('iTXt', [...latin1('XML:com.adobe.xmp'), 0, 0, 0, 0, 0, ...latin1(MARKERS.xmp)]),
        ...pngChunk('zTXt', [...latin1('Note'), 0, 0, 0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]),
        ...pngChunk('eXIf', [...latin1('MM'), 0, 42, 0, 0, 0, 8, ...latin1(MARKERS.gps)]),
        ...pngChunk('tIME', [0x07, 0xe8, 11, 8, 12, 30, 5]),
        ...pngChunk('prVt', latin1(MARKERS.comment)),
      ]
    : []
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk('IHDR', [...u32be(2), ...u32be(2), 8, 2, 0, 0, 0]),
    ...extra, // before the palette
    ...pngChunk('PLTE', [255, 0, 0, 0, 255, 0]),
    ...pngChunk('gAMA', u32be(45455)),
    ...pngChunk('IDAT', idat),
    ...(metadata ? pngChunk('tIME', [0x07, 0xe8, 11, 8, 12, 30, 5]) : []), // after the data, where cameras and editors put it
    ...pngChunk('IEND', []),
    ...tail,
  ])
}

// ---- WebP ----

const u32le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]

/** A RIFF chunk: fourcc, little-endian size, data, one pad byte when the size is odd. */
export const webpChunk = (fourcc: string, data: number[]): number[] => [...latin1(fourcc), ...u32le(data.length), ...data, ...(data.length & 1 ? [0] : [])]
export const riff = (chunks: number[]): Uint8Array => new Uint8Array([...latin1('RIFF'), ...u32le(chunks.length + 4), ...latin1('WEBP'), ...chunks])

export const VP8X_FLAGS = { alpha: 0x10, exif: 0x08, xmp: 0x04 }

/** `vp8x` builds the extended layout (flags, ICC profile, lossless data); otherwise a plain lossy file. */
export function buildWebp({ metadata, vp8x }: { metadata: boolean; vp8x: boolean }): Uint8Array {
  const flags = VP8X_FLAGS.alpha | (metadata ? VP8X_FLAGS.exif | VP8X_FLAGS.xmp : 0)
  const head = vp8x
    ? [...webpChunk('VP8X', [flags, 0, 0, 0, 3, 0, 0, 3, 0, 0]), ...webpChunk('ICCP', [1, 2, 3, 4])]
    : []
  const image = vp8x ? webpChunk('VP8L', [0x2f, 9, 8, 7, 6]) : webpChunk('VP8 ', [0x30, 0x01, 0x00, 0x9d, 0x01])
  const extra = metadata
    ? [...webpChunk('EXIF', [...latin1('MM'), 0, 42, ...latin1(MARKERS.exifWebp)]), ...webpChunk('XMP ', latin1(MARKERS.xmpWebp)), ...webpChunk('junk', latin1(MARKERS.comment))]
    : []
  return riff([...head, ...image, ...extra])
}
