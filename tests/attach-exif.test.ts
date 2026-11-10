import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { MalformedImageError, stripMetadata } from '../src/shared/attach/exif'
import { buildJpeg, buildPng, buildWebp, contains, join, MARKERS, PNG_SCANLINES, pngChunk, riff, VP8X_FLAGS, webpChunk } from './support/attach-fixtures'

describe('JPEG metadata strip', () => {
  it('AC-3.3 (030) strips metadata from JPEG', () => {
    const input = buildJpeg({ metadata: true })
    const before = new Uint8Array(input)
    for (const marker of [MARKERS.gps, MARKERS.xmp, MARKERS.iptc, MARKERS.mpf, MARKERS.comment, 'Exif']) {
      expect(contains(input, marker), `fixture has ${marker}`).toBe(true)
    }

    const out = stripMetadata('jpeg', input)

    for (const marker of [MARKERS.gps, MARKERS.xmp, MARKERS.iptc, MARKERS.mpf, MARKERS.comment, 'Exif', 'Photoshop']) {
      expect(contains(out, marker), `output has ${marker}`).toBe(false)
    }
    // everything else, SOF/DQT/DHT/SOS and the entropy data included, is byte for byte what the clean image has
    expect(Buffer.from(out).equals(Buffer.from(buildJpeg({ metadata: false })))).toBe(true)
    // the input array is not touched
    expect(Buffer.from(input).equals(Buffer.from(before))).toBe(true)
  })

  it('AC-3.3 (030) a JPEG strip is idempotent and keeps the ICC profile and the JFIF header', () => {
    const once = stripMetadata('jpeg', buildJpeg({ metadata: true }))
    expect(Buffer.from(stripMetadata('jpeg', once)).equals(Buffer.from(once))).toBe(true)
    expect(contains(once, 'ICC_PROFILE')).toBe(true)
    expect(contains(once, 'JFIF')).toBe(true)
  })

  it('AC-3.3 (030) bytes after the end of a JPEG are not carried over', () => {
    const out = stripMetadata('jpeg', buildJpeg({ metadata: false, tail: [...Buffer.from(MARKERS.gps)] }))
    expect(contains(out, MARKERS.gps)).toBe(false)
    expect(Buffer.from(out).equals(Buffer.from(buildJpeg({ metadata: false })))).toBe(true)
  })
})

const pngChunks = (b: Uint8Array) => {
  const out: { type: string; data: Buffer }[] = []
  const buf = Buffer.from(b)
  for (let i = 8; i < buf.length; ) {
    const len = buf.readUInt32BE(i)
    out.push({ type: buf.toString('latin1', i + 4, i + 8), data: buf.subarray(i + 8, i + 8 + len) })
    i += 12 + len
  }
  return out
}

describe('PNG metadata strip', () => {
  it('AC-3.3 (030) a private critical chunk is refused, not copied, while the same chunk as ancillary is dropped', () => {
    const png = buildPng({ metadata: false })
    const withChunk = (type: string) => join(png.subarray(0, 33), pngChunk(type, [...Buffer.from(MARKERS.gps)]), png.subarray(33))
    expect(() => stripMetadata('png', withChunk('PRIV'))).toThrow(MalformedImageError)
    expect(() => stripMetadata('png', withChunk('GPSx'))).toThrow(MalformedImageError)
    expect(contains(stripMetadata('png', withChunk('prIV')), MARKERS.gps)).toBe(false)
  })

  it('AC-3.3 (030) strips metadata from PNG', () => {
    const input = buildPng({ metadata: true })
    const before = new Uint8Array(input)
    const types = pngChunks(input).map((c) => c.type)
    for (const type of ['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME', 'prVt']) expect(types, type).toContain(type)

    const out = stripMetadata('png', input)

    const kept = pngChunks(out).map((c) => c.type)
    for (const type of ['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME', 'prVt']) expect(kept, type).not.toContain(type)
    for (const marker of [MARKERS.gps, MARKERS.xmp, MARKERS.text, MARKERS.comment]) expect(contains(out, marker), marker).toBe(false)
    // IHDR, PLTE, IDAT and IEND with their CRCs are exactly the clean image's
    expect(Buffer.from(out).equals(Buffer.from(buildPng({ metadata: false })))).toBe(true)
    expect(Buffer.from(input).equals(Buffer.from(before))).toBe(true)
  })

  it('AC-3.3 (030) the pixels of a stripped PNG still inflate to the same scanlines', () => {
    const out = stripMetadata('png', buildPng({ metadata: true }))
    const idat = Buffer.concat(pngChunks(out).filter((c) => c.type === 'IDAT').map((c) => c.data))
    expect([...inflateSync(idat)]).toEqual(PNG_SCANLINES)
  })

  it('AC-3.3 (030) a PNG strip is idempotent and drops what follows IEND', () => {
    const once = stripMetadata('png', buildPng({ metadata: true, tail: [...Buffer.from(MARKERS.gps)] }))
    expect(contains(once, MARKERS.gps)).toBe(false)
    expect(Buffer.from(stripMetadata('png', once)).equals(Buffer.from(once))).toBe(true)
  })
})

describe('WebP metadata strip', () => {
  it('AC-3.3 (030) strips metadata from WebP', () => {
    const input = buildWebp({ metadata: true, vp8x: true })
    const before = new Uint8Array(input)
    expect(input[20]).toBe(VP8X_FLAGS.alpha | VP8X_FLAGS.exif | VP8X_FLAGS.xmp)

    const out = stripMetadata('webp', input)

    for (const marker of [MARKERS.exifWebp, MARKERS.xmpWebp, MARKERS.comment, 'EXIF', 'XMP ']) expect(contains(out, marker), marker).toBe(false)
    // VP8X flags cleared of Exif and XMP (alpha stays), RIFF size rewritten, VP8L and ICCP untouched
    expect(out[20]).toBe(VP8X_FLAGS.alpha)
    expect(Buffer.from(out).readUInt32LE(4)).toBe(out.length - 8)
    expect(Buffer.from(out).equals(Buffer.from(buildWebp({ metadata: false, vp8x: true })))).toBe(true)
    expect(Buffer.from(input).equals(Buffer.from(before))).toBe(true)
  })

  it('AC-3.3 (030) a plain lossy WebP loses its metadata chunks too, and a strip is idempotent', () => {
    const out = stripMetadata('webp', buildWebp({ metadata: true, vp8x: false }))
    expect(Buffer.from(out).equals(Buffer.from(buildWebp({ metadata: false, vp8x: false })))).toBe(true)
    expect(Buffer.from(stripMetadata('webp', out)).equals(Buffer.from(out))).toBe(true)
  })
})

const GIF = join([...Buffer.from('GIF89a')], [1, 0, 1, 0, 0x80, 0, 0], [0xff, 0xff, 0xff, 0, 0, 0], [0x21, 0xfe, 3, 65, 66, 67, 0], [0x3b])
const KINDS = ['jpeg', 'png', 'webp'] as const
const valid = () => ({ jpeg: buildJpeg({ metadata: true }), png: buildPng({ metadata: true }), webp: buildWebp({ metadata: true, vp8x: true }) })
const patched = (bytes: Uint8Array, at: number, ...values: number[]) => {
  const copy = new Uint8Array(bytes)
  copy.set(values, at)
  return copy
}
const refused = (kind: 'jpeg' | 'png' | 'webp' | 'gif', bytes: Uint8Array) => expect(() => stripMetadata(kind, bytes)).toThrow(MalformedImageError)

describe('malformed pictures', () => {
  it('AC-3.4 (030) malformed pictures are refused', () => {
    const { jpeg, png, webp } = valid()
    // JPEG: the first APP1 segment starts at byte 20
    refused('jpeg', jpeg.slice(0, 30)) // truncated segment
    refused('jpeg', patched(jpeg, 22, 0xff, 0xff)) // segment length past the end
    refused('jpeg', patched(jpeg, 22, 0, 1)) // segment length under its own two bytes
    refused('jpeg', jpeg.slice(0, -2)) // scan never ends
    refused('jpeg', join([0xff, 0xd8, 0xff, 0xd9])) // no scan
    refused('jpeg', patched(jpeg, 20, 0x00)) // no marker where one is due
    refused('jpeg', patched(jpeg, 21, 0xf3)) // reserved marker
    refused('jpeg', new Uint8Array())
    refused('jpeg', join([...Buffer.from('not a picture at all')]))
    // PNG
    refused('png', png.slice(0, -12)) // no IEND
    refused('png', patched(png, 8, 0xff, 0xff, 0xff, 0xf0)) // chunk length past the end
    refused('png', patched(png, 8, 0, 0, 0, 14)) // IHDR of the wrong size
    refused('png', patched(png, 12, 0x31, 0x32, 0x33, 0x34)) // a chunk type that is not letters
    refused('png', join(png.subarray(0, 8), png.subarray(png.length - 12))) // IEND without IHDR
    refused('png', join(png.subarray(0, 33), png.subarray(png.length - 12))) // IHDR and IEND, no pixels
    refused('png', new Uint8Array())
    // WebP
    refused('webp', patched(webp, 4, ...[...webp.subarray(4, 8)].map((n, k) => (k === 0 ? n + 2 : n)))) // RIFF size larger than the file
    refused('webp', patched(webp, 4, ...[...webp.subarray(4, 8)].map((n, k) => (k === 0 ? n - 2 : n)))) // smaller than the file
    refused('webp', join(webp, [0])) // RIFF size does not count a stray byte
    refused('webp', riff(webpChunk('VP8L', [1, 2, 3, 4, 5, 6]).slice(0, 10))) // chunk longer than the file
    refused('webp', riff(webpChunk('ICCP', [1, 2, 3, 4]))) // no image chunk
    refused('webp', patched(webp, 8, 0x41)) // not WEBP
    refused('webp', new Uint8Array())
  })

  it('AC-3.4 (030) the bytes must be the kind that was asked for', () => {
    const files = { ...valid(), gif: GIF }
    for (const kind of [...KINDS, 'gif'] as const) {
      for (const [name, bytes] of Object.entries(files)) {
        if (name !== kind) refused(kind, bytes)
      }
    }
  })

  it('AC-3.4 (030) no truncation of a picture is accepted', () => {
    for (const [kind, bytes] of Object.entries(valid()) as [(typeof KINDS)[number], Uint8Array][]) {
      expect(stripMetadata(kind, bytes).length).toBeGreaterThan(0)
      for (let n = 0; n < bytes.length; n++) refused(kind, bytes.slice(0, n))
    }
  })

  it('AC-3.4 (030) corrupt bytes are refused or rewritten whole, and nothing else is thrown', () => {
    let seed = 12345
    const next = (to: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff
      return seed % to
    }
    for (const [kind, bytes] of Object.entries(valid()) as [(typeof KINDS)[number], Uint8Array][]) {
      for (let round = 0; round < 400; round++) {
        const damaged = new Uint8Array(bytes)
        for (let flips = 1 + next(3); flips > 0; flips--) damaged[next(damaged.length)] = next(256)
        let out: Uint8Array | undefined
        try {
          out = stripMetadata(kind, damaged)
        } catch (error) {
          expect(error, kind).toBeInstanceOf(MalformedImageError)
        }
        if (out) expect(Buffer.from(stripMetadata(kind, out)).equals(Buffer.from(out)), kind).toBe(true)
      }
    }
  })

  it('AC-3.3 (030) a GIF is returned as is', () => {
    const before = new Uint8Array(GIF)
    const out = stripMetadata('gif', GIF)
    expect(Buffer.from(out).equals(Buffer.from(before))).toBe(true)
    const small = join([...Buffer.from('GIF87a')], [1, 0])
    expect([...stripMetadata('gif', small)]).toEqual([...small])
  })
})
