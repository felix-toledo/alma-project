import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceAssistant, type VoiceDeps } from '../src/coordinator/voice/assistant'
import { conversationEnded, END_VOICE_TOOL } from '../src/coordinator/voice/speech'
import { defaultSettings } from '../src/shared/defaults'
import type { ChatMessage, LiveEvent, Settings, Thread } from '../src/shared/types'

const text = (t: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text: t }], ts: 0 })
const calls = (name: string): ChatMessage => ({ role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input: {} }], ts: 0 })
const answer = (t: string): ChatMessage => ({ role: 'assistant', content: [{ type: 'text', text: t }], ts: 0 })
const done: ChatMessage = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }], ts: 0 }

describe('conversationEnded', () => {
  it('AC-2.3 counts only tool calls after the latest user message', () => {
    expect(conversationEnded([text('chau'), calls(END_VOICE_TOOL), done, answer('Chau')])).toBe(true)
    expect(conversationEnded([text('chau'), calls(END_VOICE_TOOL), done, answer('Chau'), text('esperá, una más')])).toBe(false)
    expect(conversationEnded([text('hola'), calls('web_search'), done, answer('Hola')])).toBe(false)
    expect(conversationEnded([])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The assistant with no worker: Meta transcription (fetch stubbed), Windows voice, scripted agent.

const chunk = (amplitude: number): ArrayBuffer => new Int16Array(Array.from({ length: 1280 }, (_, i) => Math.round(amplitude * Math.sin(i / 3)))).buffer

let dir: string
let events: LiveEvent[]
let asked: string[]
let stopped: string[]
let ended: boolean
let release: (() => void) | undefined
let fetchSpy: ReturnType<typeof vi.fn>
let assistant: VoiceAssistant
const thread = { id: 'voz', messages: [] } as unknown as Thread

function build(sendDelayMs: number, ask?: VoiceDeps['ask']): void {
  const settings: Settings = defaultSettings()
  settings.voice = { ...settings.voice, enabled: true, stt: 'meta', tts: 'windows', sendDelayMs }
  settings.providers.meta.apiKey = 'k'
  assistant = new VoiceAssistant({
    settings: () => settings,
    dataDir: dir,
    conversation: () => thread,
    ask:
      ask ??
      (async (_id, said) => {
        asked.push(said)
      }),
    stop: (id) => {
      stopped.push(id)
      release?.()
    },
    lastAnswer: () => 'Listo.',
    conversationEnded: () => ended,
    onEvent: () => () => {},
    respondApproval: () => {},
    emit: (event) => {
      events.push(event)
      // The window plays the last piece of a turn and reports it.
      if (event.type === 'voice.play' && event.last) setTimeout(() => assistant.played(), 0)
    }
  })
  ;(assistant as unknown as { status: unknown }).status = { state: 'listening' }
}

const state = (): string | undefined => (assistant.currentStatus() as { state: string }).state

/** The person says something (0.8 s of voice) and stops (1.3 s of silence). */
function speak(): void {
  for (let i = 0; i < 10; i++) assistant.audio(chunk(8000))
  for (let i = 0; i < 17; i++) assistant.audio(chunk(0))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alma-voice-'))
  events = []
  asked = []
  stopped = []
  ended = false
  release = undefined
  fetchSpy = vi.fn(async () => new Response(JSON.stringify({ transcript: 'qué hora es' }), { status: 200 }))
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('cancelling a voice turn', () => {
  it('AC-1.1 discards a recording: nothing is sent and Alma goes back to listening', async () => {
    build(0)
    assistant.trigger()
    expect(state()).toBe('recording')
    for (let i = 0; i < 5; i++) assistant.audio(chunk(8000))
    assistant.cancel()
    await vi.waitFor(() => expect(state()).toBe('listening'))
    speak() // late audio of the cancelled turn goes nowhere
    await new Promise((r) => setTimeout(r, 50))
    expect(asked).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('AC-1.2 cancels during the pause before sending', async () => {
    build(400)
    assistant.trigger()
    speak()
    await vi.waitFor(() => expect(state()).toBe('thinking'))
    expect(asked).toEqual([])
    assistant.cancel()
    await new Promise((r) => setTimeout(r, 600))
    expect(asked).toEqual([])
    expect(state()).toBe('listening')
  })

  it('AC-1.3 with no pause the request goes out at once, and the default pause is one second', async () => {
    expect(defaultSettings().voice.sendDelayMs).toBe(1000)
    build(0)
    ended = true
    assistant.trigger()
    speak()
    await vi.waitFor(() => expect(asked).toEqual(['qué hora es']))
  })

  it('AC-1.4 cancelling while the agent works aborts the run and ends the conversation', async () => {
    const running = new Promise<void>((resolve) => (release = resolve))
    build(0, async (_id, said) => {
      asked.push(said)
      await running
    })
    assistant.trigger()
    speak()
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    assistant.cancel()
    await vi.waitFor(() => expect(state()).toBe('listening'))
    expect(stopped).toEqual(['voz'])
    expect(events.some((e) => e.type === 'voice.stop')).toBe(true)
  })
})

describe('ending a conversation', () => {
  it('AC-2.2 when the model ended it, no follow-up window opens', async () => {
    build(0)
    ended = true
    assistant.trigger()
    speak()
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    await vi.waitFor(() => expect(state()).toBe('listening'))
    expect(events.some((e) => e.type === 'voice.status' && e.status.followUp)).toBe(false)
  })

  it('AC-2.2 otherwise the microphone stays open for a follow-up', async () => {
    build(0)
    assistant.trigger()
    speak()
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    await vi.waitFor(() => expect(state()).toBe('recording'))
    assistant.cancel()
    await vi.waitFor(() => expect(state()).toBe('listening'))
  })
})
