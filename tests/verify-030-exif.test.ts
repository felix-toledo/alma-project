import { describe, expect, it } from 'vitest'
import { MalformedImageError, stripMetadata } from '../src/shared/attach/exif'
import { ascii, bytes, GIF, has, JPEG_PIXELS, jpegSegment, makeJpeg, makePng, makeWebp, MARKERS, pngChunk, riffChunk, same } from './support/verify-030'

// Independent verification of spec 030 AC-3.3 and AC-3.4: metadata stripping and refusal. Written from spec.md only.

const noMarkers = (data: Uint8Array) => MARKERS.filter((m) => has(data, m))

/** Every proper prefix of a valid file must be refused: a half-read picture is never stored. */
function expectEveryPrefixRefused(kind: 'jpeg' | 'png' | 'webp', file: Uint8Array) {
  const survivors: number[] = []
  for (let n = 0; n < file.length; n++) {
    try {
      stripMetadata(kind, file.subarray(0, n))
      survivors.push(n)
    } catch (error) {
      expect(error).toBeInstanceOf(MalformedImageError)
    }
  }
  expect(survivors, `${kind}: prefixes that were accepted`).toEqual([])
}

describe('AC-3.3 (030 verify) the fixtures themselves', () => {
  it('AC-3.3 (030 verify) each picture builder plants the markers the strip tests look for, so an unstripped copy would fail them', () => {
    expect(noMarkers(makeJpeg())).toEqual(['GPSMARK', 'CAMERAMARK', 'XMPMARK', 'COMMARK'])
    expect(noMarkers(makePng())).toEqual(['GPSMARK', 'CAMERAMARK', 'XMPMARK', 'TEXTMARK'])
    expect(noMarkers(makeWebp())).toEqual(['GPSMARK', 'CAMERAMARK', 'XMPMARK'])
    expect(noMarkers(GIF)).toEqual([])
    expect(noMarkers(makeJpeg({ exif: false }))).toEqual([])
  })
})

describe('AC-3.3 (030 verify) JPEG', () => {
  it('AC-3.3 (030 verify) removes Exif/GPS, XMP, comments and Photoshop blocks and keeps the pixels byte for byte', () => {
    const input = makeJpeg()
    const copy = Uint8Array.from(input)
    const out = stripMetadata('jpeg', input)
    expect(noMarkers(out)).toEqual([])
    expect(has(out, 'Exif')).toBe(false)
    expect(has(out, 'JFIF')).toBe(true)
    expect(has(out, 'ICC_PROFILE')).toBe(true)
    expect(Buffer.from(out).includes(Buffer.from(JPEG_PIXELS))).toBe(true)
    expect([...out.subarray(0, 2)]).toEqual([0xff, 0xd8])
    expect([...out.subarray(-2)]).toEqual([0xff, 0xd9])
    expect(same(input, copy), 'the input is not modified').toBe(true)
    expect(out.length).toBeLessThan(input.length)
  })

  it('AC-3.3 (030 verify) a JPEG with no metadata comes out identical', () => {
    const clean = makeJpeg({ exif: false })
    expect(same(stripMetadata('jpeg', clean), clean)).toBe(true)
  })

  it('AC-3.3 (030 verify) stripping twice changes nothing more', () => {
    const once = stripMetadata('jpeg', makeJpeg())
    expect(same(stripMetadata('jpeg', once), once)).toBe(true)
  })

  it('AC-3.3 (030 verify) bytes after the end of image (a hidden thumbnail or payload) are dropped', () => {
    const out = stripMetadata('jpeg', makeJpeg({ exif: false, trailing: [...ascii('GPSMARK trailing'), 0xff, 0xd8] }))
    expect(has(out, 'GPSMARK')).toBe(false)
    expect([...out.subarray(-2)]).toEqual([0xff, 0xd9])
  })

  it('AC-3.3 (030 verify) metadata placed between two scans (progressive) is removed too', () => {
    const out = stripMetadata('jpeg', makeJpeg({ progressive: true }))
    expect(has(out, 'GPSMARK')).toBe(false)
    expect(Buffer.from(out).includes(Buffer.from([0x9a, 0x9b]))).toBe(true)
  })

  it('AC-3.3 (030 verify) other APPn, JFXX and extended XMP segments are dropped, Adobe and ICC are kept', () => {
    const out = stripMetadata('jpeg', makeJpeg({ exif: false, extras: [jpegSegment(0xe0, ascii('JFXX\0GPSMARK')), jpegSegment(0xe2, ascii('MPF\0CAMERAMARK')), jpegSegment(0xe1, ascii('http://ns.adobe.com/xmp/extension/\0XMPMARK')), jpegSegment(0xe5, ascii('GPSMARK')), jpegSegment(0xef, ascii('GPSMARK')), jpegSegment(0xee, ascii('Adobe\0\x64\0\0\0\0\x01'))] }))
    expect(noMarkers(out)).toEqual([])
    expect(has(out, 'Adobe')).toBe(true)
    expect(has(out, 'ICC_PROFILE')).toBe(true)
  })

  it('AC-3.3 (030 verify) fill bytes before a marker, an empty APP segment and a restart marker are tolerated', () => {
    const out = stripMetadata('jpeg', makeJpeg({ exif: false, extras: [[0xff, 0xff, ...jpegSegment(0xe1, []).slice(1)], jpegSegment(0xe3, [])] }))
    expect(out.length).toBeGreaterThan(10)
    expect(Buffer.from(out).includes(Buffer.from(JPEG_PIXELS))).toBe(true)
  })

  it('AC-3.4 (030 verify) every truncation of a JPEG is refused, none yields a partial picture', () => {
    expectEveryPrefixRefused('jpeg', makeJpeg())
  })

  it.each([
    ['empty', new Uint8Array(0)],
    ['one byte', bytes(0xff)],
    ['SOI only', bytes(0xff, 0xd8)],
    ['SOI and EOI, no scan', bytes(0xff, 0xd8, 0xff, 0xd9)],
    ['not a JPEG', bytes(ascii('hello world, not a picture'))],
    ['PNG bytes', makePng()],
    ['segment of length 0', bytes(0xff, 0xd8, 0xff, 0xe1, 0, 0, 0xff, 0xd9)],
    ['segment of length 1', bytes(0xff, 0xd8, 0xff, 0xe1, 0, 1, 0xff, 0xd9)],
    ['segment longer than the file', bytes(0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1, 2, 3)],
    ['marker byte missing after FF', bytes(0xff, 0xd8, 0xff)],
    ['junk where a marker should be', bytes(0xff, 0xd8, 0x00, 0x01, 0x02, 0x03)],
    ['unknown marker F5', bytes(0xff, 0xd8, ...jpegSegment(0xf5, [1, 2]), 0xff, 0xd9)],
    ['stray restart marker outside a scan', bytes(0xff, 0xd8, 0xff, 0xd0, 0xff, 0xd9)],
    ['second SOI', bytes(0xff, 0xd8, 0xff, 0xd8, 0xff, 0xd9)],
    ['scan with no end of image', makeJpeg({ noEnd: true })],
  ])('AC-3.4 (030 verify) JPEG: %s is refused', (_label, data) => {
    expect(() => stripMetadata('jpeg', data)).toThrow(MalformedImageError)
  })

  it('AC-3.4 (030 verify) a metadata segment with a length that runs into the pixels is refused, not guessed', () => {
    const file = makeJpeg()
    const at = Buffer.from(file).indexOf(Buffer.from([0xff, 0xe1]))
    const lying = Uint8Array.from(file)
    lying[at + 2] = 0xff
    lying[at + 3] = 0xff
    expect(() => stripMetadata('jpeg', lying)).toThrow(MalformedImageError)
  })
})

describe('AC-3.3 (030 verify) PNG', () => {
  it('AC-3.3 (030 verify) removes eXIf, tEXt, iTXt (XMP), zTXt and tIME and keeps the picture chunks byte for byte', () => {
    const input = makePng()
    const copy = Uint8Array.from(input)
    const out = stripMetadata('png', input)
    expect(noMarkers(out)).toEqual([])
    for (const type of ['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']) expect(has(out, type), type).toBe(false)
    for (const type of ['IHDR', 'sRGB', 'gAMA', 'IDAT', 'IEND']) expect(has(out, type), type).toBe(true)
    expect(same(out, makePng({ exif: false }))).toBe(true)
    expect(same(input, copy)).toBe(true)
  })

  it('AC-3.3 (030 verify) private and unknown ancillary chunks are dropped, transparency and colour chunks are kept', () => {
    const out = stripMetadata('png', makePng({ exif: false, extras: [pngChunk('prVt', ascii('GPSMARK')), pngChunk('tRNS', [1, 2]), pngChunk('pHYs', [0, 0, 0, 1, 0, 0, 0, 1, 1]), pngChunk('iCCP', ascii('p\0\0xx')), pngChunk('sPLT', ascii('GPSMARK')), pngChunk('dSIG', ascii('GPSMARK'))] }))
    expect(has(out, 'GPSMARK')).toBe(false)
    for (const type of ['tRNS', 'pHYs', 'iCCP']) expect(has(out, type), type).toBe(true)
  })

  it('AC-3.3 (030 verify) data after IEND is dropped', () => {
    const out = stripMetadata('png', makePng({ exif: false, trailing: ascii('GPSMARK trailing data') }))
    expect(has(out, 'GPSMARK')).toBe(false)
    expect(same(out, makePng({ exif: false }))).toBe(true)
  })

  it('AC-3.3 (030 verify) an animated PNG keeps its frame chunks', () => {
    const out = stripMetadata('png', makePng({ exif: false, extras: [pngChunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0]), pngChunk('fcTL', new Array(26).fill(0)), pngChunk('fdAT', [0, 0, 0, 1, 9, 9])] }))
    for (const type of ['acTL', 'fcTL', 'fdAT']) expect(has(out, type), type).toBe(true)
  })

  it('AC-3.3 (030 verify) a PNG of exactly 2 097 152 bytes passes through whole', () => {
    const big = makePng({ exif: false, size: 2_097_152 })
    expect(big.length).toBe(2_097_152)
    expect(same(stripMetadata('png', big), big)).toBe(true)
  })

  it('AC-3.4 (030 verify) every truncation of a PNG is refused', () => {
    expectEveryPrefixRefused('png', makePng())
  })

  it.each([
    ['empty', new Uint8Array(0)],
    ['signature only', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
    ['JPEG bytes', makeJpeg()],
    ['wrong signature', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b, ...pngChunk('IEND'))],
    ['IHDR not first', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pngChunk('sRGB', [0]), ...pngChunk('IEND'))],
    ['IHDR of the wrong length', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pngChunk('IHDR', [1, 2, 3]), ...pngChunk('IEND'))],
    ['no pixel data', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pngChunk('IHDR', new Array(13).fill(0)), ...pngChunk('IEND'))],
    ['no IEND', makePng({ noEnd: true })],
    ['chunk longer than the file', bytes(makePng({ exif: false }).subarray(0, 33), 0x7f, 0xff, 0xff, 0xff, ...ascii('IDAT'), 1, 2, 3)],
    ['chunk length 0xFFFFFFFF', bytes(makePng({ exif: false }).subarray(0, 33), 0xff, 0xff, 0xff, 0xff, ...ascii('IDAT'), 1, 2, 3, 4, 5, 6, 7, 8)],
    ['chunk type with a digit', bytes(makePng({ exif: false }).subarray(0, 33), ...pngChunk('ID4T', [1]), ...pngChunk('IEND'))],
  ])('AC-3.4 (030 verify) PNG: %s is refused', (_label, data) => {
    expect(() => stripMetadata('png', data)).toThrow(MalformedImageError)
  })

  it('AC-3.3 (030 verify) an unknown critical chunk carrying metadata is not stored (a decoder could not show such a file anyway)', () => {
    // Critical chunks (capital first letter) are copied without being looked at; "GPSx" is not a standard chunk.
    let out: Uint8Array | undefined
    try {
      out = stripMetadata('png', makePng({ exif: false, extras: [pngChunk('GPSx', ascii('GPSMARK CAMERAMARK'))] }))
    } catch (error) {
      expect(error).toBeInstanceOf(MalformedImageError)
    }
    if (out) expect(has(out, 'GPSMARK')).toBe(false)
  })
})

describe('AC-3.3 (030 verify) WebP', () => {
  it('AC-3.3 (030 verify) removes EXIF and XMP chunks, clears their flags, keeps the pixels and fixes the RIFF size', () => {
    const input = makeWebp()
    const copy = Uint8Array.from(input)
    const out = stripMetadata('webp', input)
    expect(noMarkers(out)).toEqual([])
    expect(has(out, 'EXIF')).toBe(false)
    expect(has(out, 'XMP ')).toBe(false)
    expect(has(out, 'VP8 ')).toBe(true)
    expect(has(out, 'ICCP')).toBe(true)
    // VP8X flags byte: the ICC (0x20) and alpha (0x10) bits stay, EXIF (0x08) and XMP (0x04) go
    const flagsAt = Buffer.from(out).indexOf(Buffer.from(ascii('VP8X'))) + 8
    expect(out[flagsAt]).toBe(0x30)
    expect(new DataView(out.buffer, out.byteOffset).getUint32(4, true)).toBe(out.length - 8)
    expect(same(out, makeWebp({ exif: false, flags: 0x30 }))).toBe(true)
    expect(same(input, copy)).toBe(true)
  })

  it('AC-3.3 (030 verify) unknown chunks are dropped, animation chunks kept', () => {
    const out = stripMetadata('webp', makeWebp({ exif: false, extras: [riffChunk('JUNK', ascii('GPSMARK')), riffChunk('ANIM', [0, 0, 0, 0, 0, 0]), riffChunk('ANMF', new Array(20).fill(1))] }))
    expect(has(out, 'GPSMARK')).toBe(false)
    expect(has(out, 'ANIM')).toBe(true)
    expect(has(out, 'ANMF')).toBe(true)
  })

  it('AC-3.4 (030 verify) every truncation of a WebP is refused', () => {
    expectEveryPrefixRefused('webp', makeWebp())
  })

  it.each([
    ['empty', new Uint8Array(0)],
    ['header only', bytes(ascii('RIFF'), 4, 0, 0, 0, ascii('WEBP'))],
    ['wrong form type', bytes(ascii('RIFF'), 4, 0, 0, 0, ascii('WAVE'))],
    ['RIFF size too big', makeWebp({ riffSize: 99_999 })],
    ['RIFF size too small', makeWebp({ riffSize: 10 })],
    ['trailing bytes after the RIFF size', Uint8Array.from([...makeWebp(), 1, 2, 3, 4])],
    ['PNG bytes', makePng()],
    ['VP8X of the wrong size', Uint8Array.from([...ascii('RIFF'), 24, 0, 0, 0, ...ascii('WEBP'), ...riffChunk('VP8X', [0, 0, 0]), ...riffChunk('VP8 ', [1, 2, 3, 4, 5, 0])])],
    ['no image chunk', Uint8Array.from([...ascii('RIFF'), 30, 0, 0, 0, ...ascii('WEBP'), ...riffChunk('VP8X', [0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0]), ...riffChunk('EXIF', ascii('GPSMARK'))])],
    ['a chunk that claims more than is left', Uint8Array.from([...ascii('RIFF'), 28, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8 '), 0xff, 0xff, 0, 0, 1, 2, 3, 4, 5, 6])],
    ['a dangling chunk header', Uint8Array.from([...ascii('RIFF'), 18, 0, 0, 0, ...ascii('WEBP'), ...riffChunk('VP8 ', [1, 2, 3, 4]), 1, 2])],
  ])('AC-3.4 (030 verify) WebP: %s is refused', (_label, data) => {
    expect(() => stripMetadata('webp', data)).toThrow(MalformedImageError)
  })

  it('AC-3.4 (030 verify) an EXIF chunk whose size runs past the end is refused, not skipped', () => {
    const file = makeWebp()
    const at = Buffer.from(file).indexOf(Buffer.from(ascii('EXIF')))
    const lying = Uint8Array.from(file)
    lying[at + 4] = 0xff
    lying[at + 5] = 0xff
    expect(() => stripMetadata('webp', lying)).toThrow(MalformedImageError)
  })
})

describe('AC-3.3 (030 verify) GIF', () => {
  it('AC-3.3 (030 verify) a GIF is stored as it is', () => {
    const out = stripMetadata('gif', GIF)
    expect(same(out, GIF)).toBe(true)
    expect(stripMetadata('gif', bytes(ascii('GIF87a'), 1, 2, 3)).length).toBe(9)
  })

  it('AC-3.4 (030 verify) something that is not a GIF is refused', () => {
    for (const data of [new Uint8Array(0), bytes(ascii('GIF')), bytes(ascii('GIF88a')), makePng(), makeJpeg()]) expect(() => stripMetadata('gif', data)).toThrow(MalformedImageError)
  })
})

describe('AC-3.4 (030 verify) fuzzing: a corrupted picture is either refused or comes out no bigger, and never throws anything else', () => {
  // a small deterministic generator so a failure can be replayed
  const rng = (seed: number) => () => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0
    return seed / 2 ** 32
  }
  it.each([
    ['jpeg', makeJpeg()],
    ['png', makePng()],
    ['webp', makeWebp()],
  ] as const)('AC-3.4 (030 verify) %s: 3000 single-byte corruptions', (kind, file) => {
    const next = rng(kind.length * 7919)
    let refused = 0
    for (let i = 0; i < 3000; i++) {
      const bent = Uint8Array.from(file)
      bent[Math.floor(next() * bent.length)] = Math.floor(next() * 256)
      try {
        const out = stripMetadata(kind, bent)
        expect(out.length).toBeLessThanOrEqual(bent.length)
      } catch (error) {
        refused++
        expect(error, `iteration ${i}`).toBeInstanceOf(MalformedImageError)
      }
    }
    expect(refused).toBeGreaterThan(0)
  })

  it('AC-3.3 (030 verify) a 2 MiB JPEG with a large scan is stripped in well under a second', () => {
    const scan = new Array(2 * 1024 * 1024).fill(0x55)
    const file = Uint8Array.from([...makeJpeg({ exif: true }).subarray(0, -2), ...scan, 0xff, 0xd9])
    const started = Date.now()
    const out = stripMetadata('jpeg', file)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(has(out, 'GPSMARK')).toBe(false)
  })
})
