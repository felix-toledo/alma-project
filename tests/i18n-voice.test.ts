import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceAssistant } from '../src/coordinator/voice/assistant'
import { phonemizerVoice, sttLanguage } from '../src/coordinator/voice/languages'
import { approvalQuestion, approvalRetry, FILLERS, fillers, SentenceStream, speakable } from '../src/coordinator/voice/speech'
import { workerText } from '../src/coordinator/voice/worker-text'
import { translate, translateText } from '../src/shared/i18n/messages'
import { en } from '../src/shared/i18n/en'
import { es } from '../src/shared/i18n/es'
import { migrateDefaults } from '../src/shared/migrate'
import { DEFAULT_VOICES, enrollmentPhrases, kokoroVoices, resolveKokoroVoice, windowsVoices } from '../src/shared/voices'
import { isSpanish } from './support/i18n'
import { isCancel, isGoodbye, parseYesNo } from '../src/shared/i18n/vocab'
import { defaultSettings } from '../src/shared/defaults'
import type { Language, LiveEvent, Settings, Thread } from '../src/shared/types'

let dir: string
let events: LiveEvent[]

function assistantIn(language: Language, tweak: (settings: Settings) => void = () => {}): VoiceAssistant {
  const settings: Settings = { ...defaultSettings(), language }
  tweak(settings)
  return new VoiceAssistant({
    settings: () => settings,
    dataDir: dir,
    conversation: () => ({ id: 'voz', messages: [] }) as unknown as Thread,
    ask: async () => {},
    stop: () => {},
    lastAnswer: () => '',
    conversationEnded: () => false,
    onEvent: () => () => {},
    respondApproval: () => {},
    emit: (event) => events.push(event)
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alma-voice-i18n-'))
  events = []
  vi.stubEnv('META_API_KEY', '')
  vi.stubEnv('OPENAI_API_KEY', '')
  vi.stubEnv('ELEVENLABS_API_KEY', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('the words a person says, in either language', () => {
  it('AC-3.10 yes and no are understood in Spanish, in English and mixed, whatever the app language', () => {
    for (const yes of ['Sí, dale', 'si', 'ok', 'de una', 'yes', 'Yeah, go ahead', 'yep', 'sure', 'of course', 'sí, go ahead', 'Yes please', 'allow it']) expect(parseYesNo(yes), yes).toBe('yes')
    for (const no of ['no, cancelá', 'mejor no', 'nunca', 'no', 'nope', 'no, cancel that', 'better not', 'stop', 'reject it', 'never', 'nah']) expect(parseYesNo(no), no).toBe('no')
  })

  it('AC-3.10 a phrase with both a yes and a no word, or with neither, is neither', () => {
    for (const unclear of ['yes, but no', 'sí pero no', 'ok, no', 'the dog barks', 'el perro ladra', '', '   ', '¿¿??']) expect(parseYesNo(unclear), unclear).toBeNull()
  })

  it('AC-6.6 a closing is understood in Spanish and in English', () => {
    for (const bye of ['Gracias.', 'listo, nada más', 'Chau Alma', 'No, gracias', 'Thanks.', 'thank you, that is all', "that's all", 'Bye Alma', 'No, thanks', 'ok, perfect', 'nothing else', 'gracias, thanks']) {
      expect(isGoodbye(bye), bye).toBe(true)
    }
  })

  it('AC-6.6 a closing followed by a request is not a closing', () => {
    for (const ask of ['thanks, will it rain tomorrow?', 'done, now send a message to John', 'nothing like that, look for something else', 'gracias, ¿y mañana llueve?', 'thanks and another thing', '']) {
      expect(isGoodbye(ask), ask).toBe(false)
    }
  })

  it('AC-6.6 a spoken cancel is understood in both languages and only when it is the whole phrase', () => {
    for (const cancel of ['cancel', 'Cancelá', 'cancelar', 'stop', 'Cancel, Alma', 'olvidalo', 'never mind', 'forget it']) expect(isCancel(cancel), cancel).toBe(true)
    for (const other of ['cancel my meeting tomorrow', 'cancelá la reunión de mañana', 'no', 'yes', '']) expect(isCancel(other), other).toBe(false)
  })
})

describe('what the voice overlay and the window read', () => {
  it('AC-3.2 voice detail: the errors of the voice profile follow the language', async () => {
    await expect(assistantIn('es').enroll([])).rejects.toThrow('No hay grabaciones.')
    await expect(assistantIn('en').enroll([])).rejects.toThrow('There are no recordings.')
    await expect(assistantIn('es').testSpeaker(new ArrayBuffer(0))).rejects.toThrow('Todavía no entrenaste tu voz.')
    await expect(assistantIn('en').testSpeaker(new ArrayBuffer(0))).rejects.toThrow('You have not trained your voice yet.')
  })

  it('AC-3.2 voice detail: a missing key for a transcription engine says what to do, in the language', async () => {
    const meta = (language: Language): Promise<string> => (assistantIn(language) as unknown as { transcribeWithMeta(wav: Uint8Array): Promise<string> }).transcribeWithMeta(new Uint8Array(4))
    await expect(meta('es')).rejects.toThrow('Para transcribir con Meta cargá una API key de Meta en Configuración → Proveedores.')
    await expect(meta('en')).rejects.toThrow('To transcribe with Meta, add a Meta API key in Settings → Providers.')
    const openai = (language: Language): Promise<string> => (assistantIn(language) as unknown as { transcribeWithOpenAI(file: Blob, name: string): Promise<string> }).transcribeWithOpenAI(new Blob(['x']), 'a.wav')
    await expect(openai('es')).rejects.toThrow('Para transcribir con OpenAI cargá una API key de OpenAI en Configuración → Proveedores.')
    await expect(openai('en')).rejects.toThrow('To transcribe with OpenAI, add an OpenAI API key in Settings → Providers.')
  })

  it('AC-3.2 voice detail: a transcription service that fails keeps its status and body, worded in the language', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    const meta = (language: Language): Promise<string> =>
      (assistantIn(language, (s) => (s.providers.meta.apiKey = 'k')) as unknown as { transcribeWithMeta(wav: Uint8Array): Promise<string> }).transcribeWithMeta(new Uint8Array(4))
    await expect(meta('es')).rejects.toThrow('Meta no pudo transcribir (500): boom')
    await expect(meta('en')).rejects.toThrow('Meta could not transcribe (500): boom')
  })

  it('AC-3.2 voice detail: ElevenLabs answers are explained in the language, the invalid key included', async () => {
    const voices = (language: Language, key = ''): Promise<unknown> => assistantIn(language, (s) => (s.providers.elevenlabs.apiKey = key)).elevenVoices()
    await expect(voices('es')).rejects.toThrow('Cargá primero tu API key de ElevenLabs.')
    await expect(voices('en')).rejects.toThrow('Add your ElevenLabs API key first.')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 401 })))
    await expect(voices('es', 'k')).rejects.toThrow('ElevenLabs respondió 401: la key no es válida.')
    await expect(voices('en', 'k')).rejects.toThrow('ElevenLabs answered 401: the key is not valid.')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 503 })))
    await expect(voices('es', 'k')).rejects.toThrow('ElevenLabs respondió 503.')
    await expect(voices('en', 'k')).rejects.toThrow('ElevenLabs answered 503.')
  })

  it('AC-3.2 voice detail: the window learns why the chosen voice was replaced, in the language', async () => {
    const speak = async (language: Language): Promise<string | undefined> => {
      const assistant = assistantIn(language, (s) => {
        s.voice = { ...s.voice, enabled: true, tts: 'elevenlabs', elevenVoiceId: '' }
      })
      ;(assistant as unknown as { status: unknown }).status = { state: 'speaking' }
      await (assistant as unknown as { synthesize(text: string, turn: { cancelled: boolean }, filler: boolean): Promise<void> }).synthesize('hola', { cancelled: false }, false)
      const status = events.filter((e) => e.type === 'voice.status').at(-1)
      return status && status.type === 'voice.status' ? status.status.detail : undefined
    }
    const es = await speak('es')
    events = []
    const en = await speak('en')
    expect(es).toBe('La voz elegida falló (Falta la API key o la voz de ElevenLabs.); usé la de Windows.')
    expect(en).toBe('The chosen voice failed (The ElevenLabs API key or voice is missing.); I used the Windows one.')
  })
})

describe('AC-6.1 speech to text follows the language', () => {
  it('AC-6.1 sttLanguage: es keeps today’s values and en asks for English from every engine', () => {
    expect(sttLanguage('es')).toEqual({ whisper: 'spanish', openai: 'es', meta: 'Spanish' })
    expect(sttLanguage('en')).toEqual({ whisper: 'english', openai: 'en', meta: 'English' })
  })

  it('AC-6.1 OpenAI and Meta are asked for the app language', async () => {
    let sent: FormData | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: FormData }) => ((sent = init.body), Response.json({ text: 'x', transcript: 'x' }))))
    for (const [language, openai, meta] of [['es', 'es', 'Spanish'], ['en', 'en', 'English']] as const) {
      const assistant = assistantIn(language, (s) => {
        s.providers.openai.apiKey = 'k'
        s.providers.meta.apiKey = 'k'
      }) as unknown as { transcribeWithOpenAI(file: Blob, name: string): Promise<string>; transcribeWithMeta(wav: Uint8Array): Promise<string> }
      await assistant.transcribeWithOpenAI(new Blob(['x']), 'a.wav')
      expect(sent!.get('language')).toBe(openai)
      await assistant.transcribeWithMeta(new Uint8Array(4))
      expect(JSON.parse(await (sent!.get('request') as Blob).text()).languageBias).toEqual([meta])
    }
  })

  it('AC-6.1 the transcribe request to the local worker carries the language', async () => {
    for (const language of ['es', 'en'] as const) {
      const assistant = assistantIn(language)
      const call = vi.fn(async () => ({ type: 'result', id: 1, text: 'hola' }))
      ;(assistant as unknown as { call: unknown }).call = call
      expect(await assistant.transcribe(new Float32Array(2))).toBe('hola')
      expect(call).toHaveBeenCalledWith(expect.objectContaining({ type: 'transcribe', language }))
    }
  })
})

describe('AC-6.2 and AC-6.3 what Alma says, and how it is pronounced', () => {
  it('AC-6.2 phonemizerVoice: Latin American Spanish under es and US English under en', () => {
    expect(phonemizerVoice('es')).toBe('es-419')
    expect(phonemizerVoice('en')).toBe('en-us')
  })

  it('AC-6.2 the preparation of links and code blocks is said in the language', () => {
    const markdown = 'Mirá https://example.com\n\n```ts\nconst a = 1\n```\nListo'
    expect(speakable(markdown)).toBe('Mirá un enlace\n(te dejé el código en la pantalla)\nListo')
    expect(speakable(markdown, 'es')).toBe(speakable(markdown))
    expect(speakable('See https://example.com\n\n```ts\nconst a = 1\n```\nDone', 'en')).toBe('See a link\n(I left the code on the screen)\nDone')
    const stream = new SentenceStream('en')
    expect(stream.push('```ts\nlet x = 1\n```\nDone. ')).toEqual(['(I left the code on the screen) Done.'])
  })

  it('AC-6.2 the fillers are today’s Spanish ones under es and English under en', () => {
    expect(fillers('es')).toEqual({
      thinking: ['Mmm…', 'A ver…', 'Mmm, dejame pensar.', 'Esperá que pienso.', 'Ya te contesto.'],
      searching: ['Dame un segundo, que busco.', 'Ya va, lo estoy buscando.', 'Un momento, que me fijo.']
    })
    expect(FILLERS).toEqual(fillers('es'))
    const en = fillers('en')
    expect(en.thinking).toHaveLength(5)
    expect(en.searching).toHaveLength(3)
    for (const phrase of [...en.thinking, ...en.searching]) expect(isSpanish(phrase), phrase).toBe(false)
  })

  it('AC-6.2 the approval question and its retry are spoken in the language', () => {
    expect(approvalQuestion('es', 'write_file', false)).toBe('Necesito tu permiso para write file. ¿Sí o no?')
    expect(approvalQuestion('es', 'run_command', true)).toBe('Necesito tu permiso para run command, y podría ser riesgoso. ¿Sí o no?')
    expect(approvalQuestion('en', 'run_command', true)).toBe('I need your permission to run command, and it could be risky. Yes or no?')
    expect(approvalRetry('es')).toBe('No te entendí. ¿Sí o no?')
    expect(approvalRetry('en')).toBe('I did not catch that. Yes or no?')
  })

  it('AC-6.2 the voice test sentence exists in both languages', () => {
    expect(translate('es', 'voice.testSentence')).toBe('Hola, soy Alma. ¿En qué te puedo ayudar hoy?')
    expect(translate('en', 'voice.testSentence')).toBe('Hi, I am Alma. How can I help you today?')
  })

  it('AC-6.3 the model download messages and the failure are worded in the language, so offline English shows in English', () => {
    expect(workerText('es', 'download', { name: 'Kokoro' })).toBe('Descargando Kokoro…')
    expect(workerText('en', 'download', { name: 'Kokoro' })).toBe('Downloading Kokoro…')
    expect(workerText('en', 'downloadPercent', { name: 'Whisper', percent: 42 })).toBe('Downloading Whisper… 42%')
    expect(workerText('es', 'downloadFailed', { url: 'https://x', status: 503 })).toBe('No se pudo descargar https://x (503)')
    expect(workerText('en', 'downloadFailed', { url: 'https://x', status: 503 })).toBe('Could not download https://x (503)')
    expect(workerText('en', 'wakeUnavailable', { error: 'boom' })).toBe('Wake word not available: boom')
    expect(workerText('es', 'speakerModel')).toBe('el modelo de tu voz')
    expect(workerText('en', 'speakerModel')).toBe('your voice model')
  })
})

describe('AC-6.8 each language has its own voice', () => {
  it('AC-6.8 DEFAULT_VOICES: Dora for es and Heart for en, and a fresh install gets the one of its language', () => {
    expect(DEFAULT_VOICES.es.kokoro).toBe('ef_dora')
    expect(DEFAULT_VOICES.en.kokoro).toBe('af_heart')
    expect(defaultSettings('es').voice.kokoroVoice).toBe('ef_dora')
    expect(defaultSettings('en').voice.kokoroVoice).toBe('af_heart')
    expect(defaultSettings().voice.kokoroVoice).toBe('ef_dora')
  })

  it('AC-6.8 the Kokoro list follows the language, and a voice chosen from the other list stays visible', () => {
    expect(kokoroVoices('es').map((v) => v.id)).toEqual(['ef_dora', 'em_alex', 'em_santa'])
    expect(kokoroVoices('en').map((v) => v.id)).toEqual(['af_heart', 'am_adam'])
    expect(kokoroVoices('en', 'ef_dora').map((v) => v.id)).toEqual(['af_heart', 'am_adam', 'ef_dora'])
    expect(kokoroVoices('en', 'am_adam').map((v) => v.id)).toEqual(['af_heart', 'am_adam'])
    for (const voice of [...kokoroVoices('es'), ...kokoroVoices('en')]) {
      expect(translateText('es', { key: voice.label }).length, voice.id).toBeGreaterThan(0)
      expect(translateText('en', { key: voice.label }).length, voice.id).toBeGreaterThan(0)
    }
  })

  it('AC-6.8 a voice already chosen is kept on a language change, and an unknown one falls back to the default of the language', () => {
    expect(resolveKokoroVoice('em_alex', 'en')).toBe('em_alex')
    expect(resolveKokoroVoice('af_heart', 'es')).toBe('af_heart')
    expect(resolveKokoroVoice('nope', 'en')).toBe('af_heart')
    expect(resolveKokoroVoice('', 'es')).toBe('ef_dora')
    const kept = migrateDefaults({ ...defaultSettings('es'), voice: { ...defaultSettings('es').voice, kokoroVoice: 'em_santa' } }, 'es', 'en')
    expect(kept.voice.kokoroVoice).toBe('em_santa')
  })

  it('AC-6.8 the Windows list shows the voices of the language, and none when the system has none', () => {
    const voices = [{ name: 'Helena', lang: 'es-ES' }, { name: 'Sabina', lang: 'es_MX' }, { name: 'Zira', lang: 'en-US' }, { name: 'David', lang: 'en_GB' }]
    expect(windowsVoices(voices, 'es').map((v) => v.name)).toEqual(['Helena', 'Sabina'])
    expect(windowsVoices(voices, 'en').map((v) => v.name)).toEqual(['Zira', 'David'])
    expect(windowsVoices([], 'en')).toEqual([])
    expect(DEFAULT_VOICES.es.windows).toBe('')
    expect(DEFAULT_VOICES.en.windows).toBe('')
  })
})

describe('AC-6.7 the training phrases', () => {
  it('AC-6.7 the three phrases the person reads come from the dictionary in the app language, and the first one says the wake phrase', () => {
    expect(enrollmentPhrases('es')).toEqual([
      'Ey Alma, hoy quiero organizar mis notas y revisar los pendientes de la semana.',
      'El viernes a la tarde tengo una reunión con el equipo para hablar del proyecto.',
      'Recordame comprar yerba, pan y frutas cuando salga del trabajo.'
    ])
    const en = enrollmentPhrases('en')
    expect(en).toHaveLength(3)
    expect(en[0]).toMatch(/^Ey Alma, /)
    for (const phrase of en) expect(isSpanish(phrase.replace('Ey Alma', '')), phrase).toBe(false)
  })
})

describe('AC-6.5 the wake phrase', () => {
  it('AC-6.5 the phrase the person reads is "Ey Alma" in both languages, and nothing says "Hola Alma"', () => {
    expect(translate('es', 'voice.wakePhrase')).toBe('Ey Alma')
    expect(translate('en', 'voice.wakePhrase')).toBe('Ey Alma')
    for (const dictionary of [es, en]) {
      for (const [key, text] of Object.entries(dictionary)) {
        const all = typeof text === 'string' ? text : `${text.one} ${text.other}`
        expect(all, key).not.toMatch(/hola,? alma/i)
      }
    }
  })

  it('AC-6.5 the setting keeps its internal id, so saved settings and the model file need no migration', () => {
    expect(defaultSettings().voice.wakeWord).toBe('hola_alma')
    expect(defaultSettings('en').voice.wakeWord).toBe('hola_alma')
  })
})

describe('AC-1.10 a voice turn keeps the language it began with', () => {
  type Inside = { beginTurn(): void; endTurn(): void; text(key: 'voice.error.noRecordings'): string; status: unknown; transcribeWithOpenAI(file: Blob, name: string): Promise<string>; synthesize(text: string, turn: { cancelled: boolean }, filler: boolean): Promise<void> }
  function live(): { settings: Settings; assistant: Inside } {
    const settings: Settings = { ...defaultSettings(), language: 'es' }
    settings.providers.openai.apiKey = 'k'
    settings.voice = { ...settings.voice, enabled: true, tts: 'windows' }
    const assistant = new VoiceAssistant({
      settings: () => settings,
      dataDir: dir,
      conversation: () => ({ id: 'voz', messages: [] }) as unknown as Thread,
      ask: async () => {},
      stop: () => {},
      lastAnswer: () => '',
      conversationEnded: () => false,
      onEvent: () => () => {},
      respondApproval: () => {},
      emit: (event) => events.push(event)
    })
    return { settings, assistant: assistant as unknown as Inside }
  }

  it('AC-1.10 a change during recording does not reach the transcription of that turn, and the next turn gets it', async () => {
    let language = ''
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: FormData }) => ((language = String(init.body.get('language'))), Response.json({ text: 'x' }))))
    const { settings, assistant } = live()
    assistant.beginTurn()
    settings.language = 'en'
    await assistant.transcribeWithOpenAI(new Blob(['x']), 'a.wav')
    expect(language).toBe('es')
    expect(assistant.text('voice.error.noRecordings')).toBe('No hay grabaciones.')
    assistant.endTurn()
    assistant.beginTurn()
    await assistant.transcribeWithOpenAI(new Blob(['x']), 'a.wav')
    expect(language).toBe('en')
    expect(assistant.text('voice.error.noRecordings')).toBe('There are no recordings.')
  })

  it('AC-1.10 a change while Alma is speaking does not change what she is saying or the voice that says it', async () => {
    const { settings, assistant } = live()
    assistant.status = { state: 'speaking' }
    assistant.beginTurn()
    settings.language = 'en'
    await assistant.synthesize('hola', { cancelled: false }, false)
    const play = events.find((e) => e.type === 'voice.play')
    expect(play && play.type === 'voice.play' && play.playback.kind === 'system' ? play.playback.language : undefined).toBe('es')
    assistant.endTurn()
    events = []
    await assistant.synthesize('hello', { cancelled: false }, false)
    const next = events.find((e) => e.type === 'voice.play')
    expect(next && next.type === 'voice.play' && next.playback.kind === 'system' ? next.playback.language : undefined).toBe('en')
  })
})

describe('AC-3.10 an approval is never granted by a negated phrase', () => {
  it('AC-3.10 a negated English phrase is never yes', () => {
    for (const phrase of ["don't do it", 'do not do it', 'please do not', "I don't accept", 'of course not', 'sure not', 'not sure', "can't", 'cannot do that', 'never allow it', "I won't allow it", "it isn't ok", 'dont do it']) {
      expect(parseYesNo(phrase), phrase).not.toBe('yes')
    }
  })

  it('AC-3.10 Spanish refusals are still no', () => {
    expect(parseYesNo('no lo hagas')).toBe('no')
    expect(parseYesNo('mejor no')).toBe('no')
    expect(parseYesNo('no, cancelá')).toBe('no')
  })

  it('AC-3.10 a plain yes still is yes', () => {
    for (const phrase of ['sí, dale', 'yeah, go ahead', 'yes', 'of course', 'please do', 'sure']) expect(parseYesNo(phrase), phrase).toBe('yes')
  })
})
