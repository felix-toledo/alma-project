import { describe, expect, it } from 'vitest'
import { resample } from '../src/coordinator/voice/assistant'
import { BargeIn, cosine, Endpointer, followUpMs, isEcho, isGoodbye, parseYesNo, SentenceStream, speakable, splitSentences, toWav } from '../src/coordinator/voice/speech'

const tone = (amplitude: number): Float32Array => Float32Array.from({ length: 1280 }, (_, i) => amplitude * Math.sin(i / 3))

describe('voice text', () => {
  it('turns a markdown answer into something worth saying', () => {
    const said = speakable('## Listo ✅\n\n**El turno** es el *martes*. Ver [la nota](Diario/x.md) o https://example.com\n\n```ts\nconst a = 1\n```\n- uno\n- [x] dos')
    expect(said).toBe('Listo\nEl turno es el martes. Ver la nota o un enlace\n(te dejé el código en la pantalla)\nuno\ndos')
  })

  it('splits into sentences, merging very short ones', () => {
    expect(splitSentences('Hola. ¿Cómo estás? Hoy hace calor y mañana va a llover mucho en toda la ciudad.')).toEqual([
      'Hola. ¿Cómo estás?',
      'Hoy hace calor y mañana va a llover mucho en toda la ciudad.'
    ])
  })

  it('understands spoken yes and no', () => {
    expect(parseYesNo('Sí, dale')).toBe('yes')
    expect(parseYesNo('no, cancelá')).toBe('no')
    expect(parseYesNo('mejor no')).toBe('no')
    expect(parseYesNo('el perro ladra')).toBeNull()
  })
})

describe('SentenceStream', () => {
  it('hands out finished sentences as tokens arrive, never inside code', () => {
    const stream = new SentenceStream()
    expect(stream.push('Hola, ')).toEqual([])
    expect(stream.push('¿cómo andás? Te cuento')).toEqual(['Hola, ¿cómo andás?'])
    const fence = '`'.repeat(3)
    expect(stream.push(` algo.\n${fence}ts\nconst a = 1. b\n`)).toEqual(['Te cuento algo.'])
    // Short pieces are joined into one (a lone "Listo." sounds clipped).
    expect(stream.push(`${fence}\nListo. `)).toEqual(['(te dejé el código en la pantalla) Listo.'])
    expect(stream.push('Chau')).toEqual([])
    expect(stream.flush()).toEqual(['Chau'])
  })
})

describe('Endpointer', () => {
  it('waits for speech and stops after a pause', () => {
    const endpointer = new Endpointer()
    for (let i = 0; i < 5; i++) expect(endpointer.push(tone(0.002))).toBe('continue')
    for (let i = 0; i < 10; i++) expect(endpointer.push(tone(0.3))).toBe('continue')
    const results = Array.from({ length: 15 }, () => endpointer.push(tone(0.002)))
    expect(results.slice(0, 7).every((r) => r === 'continue')).toBe(true)
    expect(results).toContain('done')
  })

  it('waits longer after a short start, since people pause after a quick question', () => {
    const short = new Endpointer()
    for (let i = 0; i < 12; i++) short.push(tone(0.3)) // ~1 s of speech
    const afterShort = Array.from({ length: 12 }, () => short.push(tone(0.002)))
    expect(afterShort.slice(0, 13).filter((r) => r === 'done')).toHaveLength(0) // 12 × 80 ms < 1.1 s
    const long = new Endpointer()
    for (let i = 0; i < 40; i++) long.push(tone(0.3)) // ~3 s of speech
    const afterLong = Array.from({ length: 12 }, () => long.push(tone(0.002)))
    expect(afterLong.indexOf('done')).toBe(9) // 10 × 80 ms ≥ 0.75 s
  })

  it('times out when nobody speaks', () => {
    const endpointer = new Endpointer()
    const results = Array.from({ length: 60 }, () => endpointer.push(tone(0.002)))
    expect(results.at(-1)).toBe('timeout')
  })
})

describe('audio helpers', () => {
  it('resamples, measures similarity and writes a valid WAV header', () => {
    expect(resample(new Float32Array(48000), 48000, 16000)).toHaveLength(16000)
    expect(cosine([1, 0], [1, 0])).toBe(1)
    expect(cosine([1, 0], [0, 1])).toBe(0)
    const wav = toWav(new Float32Array(160))
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF')
    expect(wav.byteLength).toBe(44 + 320)
  })
})

describe('conversation', () => {
  it('keeps listening longer when Alma asked something', () => {
    expect(followUpMs('¿A qué hora querés que te avise?')).toBe(10_000)
    expect(followUpMs('Listo, te aviso a las ocho.')).toBe(6_000)
  })

  it('tells a goodbye from a new request', () => {
    for (const bye of ['Gracias.', 'listo, nada más', 'Chau Alma', 'No, gracias', 'Ok, perfecto', 'eso es todo']) expect(isGoodbye(bye)).toBe(true)
    for (const ask of ['gracias, ¿y mañana llueve?', 'listo, ahora mandale un mensaje a Juan', 'nada de eso, buscá otra cosa']) expect(isGoodbye(ask)).toBe(false)
  })

  it('barges in only after 400 ms of a voice clearly over the echo of Alma', () => {
    const barge = new BargeIn()
    const run = (amplitude: number, n: number): boolean[] => Array.from({ length: n }, () => barge.push(tone(amplitude)))
    run(0.03, 6) // learns the echo while Alma starts talking
    expect(run(0.06, 8).some(Boolean)).toBe(false) // her echo getting a bit louder isn't the user
    expect(run(0.3, 4)).toEqual([false, false, false, false])
    expect(run(0.01, 1)).toEqual([false]) // a dip resets the count
    expect(run(0.3, 5)).toEqual([false, false, false, false, true])
  })

  it('recognizes Alma hearing her own words', () => {
    const said = 'El último partido de River fue contra Sarmiento y empataron uno a uno.'
    expect(isEcho('contra Sarmiento y empataron', said)).toBe(true)
    expect(isEcho('pará, ¿y el próximo cuándo es?', said)).toBe(false)
  })
})
