# 019 — Plan

## 1. Approach
The window only captures and plays audio; everything else runs in the coordinator. The window streams 80 ms mono 16 kHz Int16
frames (an AudioWorklet) to a `VoiceAssistant`, which drives a state machine (`off → listening → recording → transcribing →
thinking → speaking → listening`). Decisions are pure functions and small classes in `speech.ts` (`Endpointer`, `BargeIn`,
`SentenceStream`, `parseYesNo`, `isGoodbye`, `isEcho`, `followUpMs`) so thresholds can be tuned under test. The heavy models (wake
word, Whisper, speaker embeddings, Kokoro) run on onnxruntime in one worker thread spawned lazily and downloaded on first use. The
agent answers in a dedicated `voice` thread, and the reply is spoken sentence by sentence as tokens stream in.

Rejected: a Python voice service. It would add an interpreter to install and package, a second process to supervise and a second
copy of the models; see [ADR 0008](../../../docs/adr/0008-voice-in-js-on-onnxruntime.md). Approval answers reuse the existing
approval flow rather than a voice-only path ([ADR 0012](../../../docs/adr/0012-approval-model.md)).

## 2. Layers touched
| Layer | Files (new / changed) | Why it lives there |
|---|---|---|
| shared | `src/shared/types.ts` (`VoiceSettings`, `VoiceState`, `VoiceStatus`, `VoicePlayback`, `voice.*` messages), `src/shared/defaults.ts` | Types cross the process boundary; defaults are the single source |
| coordinator | `src/coordinator/voice/assistant.ts`, `src/coordinator/voice/speech.ts`, `src/coordinator/voice/voice-worker.ts`, `src/coordinator/index.ts`, `src/coordinator/agent.ts` | Network, models, thread creation and the agent prompt; pure helpers in `speech.ts` |
| main | `src/main/index.ts` | Global shortcut and the microphone permission handler need Electron |
| preload | `src/preload/index.ts`, `src/shared/desktop-api.ts` (`sendAudio`) | Audio frames take a dedicated channel, not the request envelope |
| renderer | `src/renderer/src/voice/VoiceLayer.tsx`, `src/renderer/src/voice/audio.ts`, `src/renderer/src/voice/capture-worklet.js`, `src/renderer/src/components/SettingsDialog.tsx` (Voz tab), `src/renderer/src/components/Sidebar.tsx` | Microphone, playback, overlay, settings |

Resource: `resources/wakewords/hola_alma_v0.1.onnx`.

## 3. Contracts
- `VoiceSettings` (`enabled`, `wakeWord`, `wakeThreshold`, `hotkey`, `micDeviceId`, `verifySpeaker`, `speakerThreshold`, `stt`, `sttModel`,
  `tts`, `kokoroVoice`, `windowsVoice`, `elevenVoiceId`, `elevenModel`, `agentId`, `threadId`) with defaults in `src/shared/defaults.ts`;
  `VoiceState` = `off | loading | listening | recording | transcribing | thinking | speaking | error`; `VoiceStatus` = `{ state; transcript?; answer?; detail?; followUp? }`.
- `VoicePlayback` = `{ kind: 'pcm' } | { kind: 'encoded' } | { kind: 'system' }`.
- Requests: `voice.status`, `voice.trigger`, `voice.played`, `voice.enroll { samples }`, `voice.profile`, `voice.forgetProfile`,
  `voice.testSpeaker { sample }`, `voice.say { text }`, `voice.elevenVoices`; audio envelope `{ kind: 'audio', pcm }`.
  Events: `voice.status`, `voice.play { playback, last }`, `voice.stop`. Main → coordinator: `voice.trigger`.
- `class VoiceAssistant(deps: VoiceDeps)`: `sync()`, `audio(pcm)`, `trigger()`, `transcribe(audio)`, `transcribeFile(data, mime)`,
  `say(text)`, `played()`, `enroll(samples)`, `profileInfo()`, `forgetProfile()`, `testSpeaker(sample)`, `elevenVoices()`, `close()`.
- Pure helpers in `speech.ts`: `speakable`, `splitSentences`, `SentenceStream`, `parseYesNo`, `Endpointer`, `BargeIn`, `isEcho`,
  `followUpMs`, `isGoodbye`, `cosine`, `toWav`, `resample`.
- Worker protocol: requests `config`, `listen`, `audio`, `transcribe`, `embed`, `tts`; replies `wake`, `progress`, `result`, `tts-chunk`, `done`, `error`.
- No agent tools: voice declares no `ToolRisk`.

## 4. Data and persistence
Voice settings live in `settings.json`. The voice print is `<userData>/voice-profile.json` (`{ vector, enrolledAt, samples }`, local
only). Models live under `<userData>/models` (wake-word files in `openwakeword/`, Kokoro styles in `kokoro/<voice>.bin`, Hugging Face
models in the transformers cache); wake-word and style files are written to a `.part` file and renamed. ElevenLabs filler audio is cached
in `<userData>/voice-cache/<sha1>.mp3`. Microphone audio is never written to disk. Settings from an older version are normalized on load
(any wake word other than "off" becomes `hola_alma`).

## 5. Dependency injection
`VoiceAssistant` receives `VoiceDeps` (`settings`, `dataDir`, `conversation`, `ask`, `stop`, `lastAnswer`, `onEvent`, `respondApproval`, `emit`)
built in `src/coordinator/index.ts`, so it never imports the agent loop. Telegram and WhatsApp receive `transcribe: voice.transcribeFile`.
Tests exercise only the pure helpers in `speech.ts` with synthetic `Float32Array` chunks; the worker, the network engines and the
state machine are not faked yet.

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-4.1 | `tests/voice.test.ts` → `turns a markdown answer into something worth saying` | code block, URL, table row, emoji |
| AC-4.2 | `tests/voice.test.ts` → `splits into sentences, merging very short ones` | the 280-character cut is [gap] |
| AC-4.3 | `tests/voice.test.ts` → `hands out finished sentences as tokens arrive, never inside code` | open code block, `flush` |
| AC-5.1 | `tests/voice.test.ts` → `waits for speech and stops after a pause`, `waits longer after a short start, since people pause after a quick question` | |
| AC-5.2 | `tests/voice.test.ts` → `times out when nobody speaks` | |
| AC-5.4 | `tests/voice.test.ts` → `keeps listening longer when Alma asked something` | |
| AC-5.5 | `tests/voice.test.ts` → `tells a goodbye from a new request` | closing followed by a new request |
| AC-5.7 | `tests/voice.test.ts` → `barges in only after 400 ms of a voice clearly over the echo of Alma` | loud echo, short burst |
| AC-5.9 | `tests/voice.test.ts` → `recognizes Alma hearing her own words` | |
| AC-6.2 | `tests/voice.test.ts` → `understands spoken yes and no` | both words, unrelated phrase |
| AC-2.5, 3.4, 3.5 | `tests/voice.test.ts` → `resamples, measures similarity and writes a valid WAV header` | |
| AC-4.4–4.6, 1.1–1.5, 2.1–2.4, 5.3, 5.6, 5.8, 5.10, 6.1, 6.3, 6.4, 3.1–3.3, 3.6, 4.7, 4.8, 4.10–4.12, 4.14, 7.2–7.7, 7.9, 8.5–8.7, 8.9, 8.10 | [gap] | offline model download, worker crash, missing key, unclear approval answers |
| AC-1.6, 4.9, 4.13, 4.15, 7.1, 7.8, 8.1–8.4, 8.8 | [manual] — Settings → Voz: press the shortcut from another app, "Probar la voz", "Entrenar mi voz", block the microphone in Windows | |

## 7. Security and privacy impact
- No agent tools, so no new `ToolRisk`. Approvals raised in the voice thread are answered by voice only for that thread and only on a clear yes or no.
- The voice print is biometric data, local, exported and erased with personal data (`docs/security/PRIVACIDAD.md` already lists it).
- Audio leaves the machine only for OpenAI or Meta transcription; text leaves for ElevenLabs; Hugging Face and GitHub see model downloads only.
- Provider keys come from the encrypted store or environment variables; they are not logged. The main process grants Chromium only audio `media` requests to the main window.
- Docs: no change to `docs/security/` (voice print and third parties are already recorded).

## 8. Rollout
`voice.enabled` defaults to false, so no microphone is opened and no model is downloaded until the person turns the assistant on in
Settings → Voz. Defaults once on: wake word "Hola Alma", shortcut `Control+Alt+Space`, local Whisper, Kokoro voice, speaker check on (inactive until a voice
is trained). Models download on first use with progress in the overlay; the shortcut works without any download when the Windows voice is chosen.
