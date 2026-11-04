# Voz

> A hands-free voice assistant with no Python: wake word or global shortcut, optional owner-voice check, speech-to-text, an agent in a dedicated voice conversation, and spoken answers. Spec: [019 · Voz](../../.specify/specs/019-voice/spec.md). Test status: 13 criteria with a test, 11 manual-only, 41 without a test (65 in total).

## What it does

- **Start a turn** by saying the wake word «Ey Alma» or pressing a global keyboard shortcut (default `Control+Alt+Space`) or the microphone button.
- **Check it is you** (optional). Before a wake-word turn starts, Alma compares the last ~2 s of audio with a voice print the owner trained.
- **Listen until you pause**, transcribe (local Whisper, OpenAI or Meta), and give the text to an agent in a voice conversation.
- **Speak the answer sentence by sentence** with Kokoro (local), the Windows voices, or ElevenLabs.
- **Follow-ups without the wake word**, and **interruption**: talk over Alma and she stops.
- **Approve by voice**: when a tool call needs permission in the voice conversation, Alma asks «¿Sí o no?» and understands the answer.
- The same transcriber turns Telegram and WhatsApp voice notes into text.

The models run on onnxruntime in a worker thread and download on first use. Cloud engines are opt-in.

## How to use it

Everything is in «Configuración → Voz». Changes save at once.

1. Turn voice on. The state becomes `listening`. Windows may ask for the microphone; if it is denied, the overlay says «Windows no le da acceso al micrófono a Alma (Configuración de Windows → Privacidad → Micrófono).» (Windows does not give Alma access to the microphone).
2. Say «Ey Alma» or press the shortcut. A chime plays, and the overlay shows "Te escucho…" (listening), "Entendiendo…" (understanding), "Pensando…" (thinking), "Hablando" (speaking) with the transcript and the answer.
3. Keep talking for a follow-up, or say a closing like «gracias», «chau Alma», «listo, nada más».
4. Pressing the shortcut or button while Alma speaks stops her and ends the conversation. Pressing it while recording closes the recording («Listo, ya terminé»).
5. Sidebar button: "Hablar", "Callar", "Voz con error" or "Voz…" depending on state.

In the tab:

| Control | What it does |
|---|---|
| Wake word sensitivity slider | Slider 0.3–0.9; stored `wakeThreshold` is 1.2 minus the slider value. |
| "Entrenar mi voz" / "Volver a entrenar" | Read three phrases, 5.5 s each, with a live level meter. Warns if consistency is below 75%. |
| "Probar si me reconoce" | Records 3.5 s and shows similarity, threshold and verdict. |
| "Olvidar mi voz" | Drops the voice print. |
| "Probar la voz" | Alma says «Hola, soy Alma. ¿En qué te puedo ayudar hoy?» with the current engine, even if the assistant is off. |
| ElevenLabs "Ver voces" / "Elegir" | Lists the account's voices with samples; stores the chosen voice id. |

The tab quotes about 80 MB (Whisper base) and 250 MB (small). With no API key for the chosen cloud engine it says «Cargá una API key de OpenAI/Meta en Proveedores.» (load a key in Providers).

## How it works

| File | Role |
|---|---|
| `src/renderer/src/voice/*` (`capture-worklet.js`) | Microphone capture and playback in the window. |
| `src/preload/index.ts` | `sendAudio` (audio is copied, not transferred). |
| `src/main/index.ts` | Registers the global shortcut and the microphone permission. |
| `src/coordinator/voice/assistant.ts` | The state machine, speaker check, STT/TTS engines, approvals, fillers. |
| `src/coordinator/voice/speech.ts` | Pure decisions: endpointing, barge-in, follow-up window, goodbye, yes/no, text preparation. |
| `src/coordinator/voice/voice-worker.ts` | Worker thread (built as `voiceWorker.js`): wake word, Whisper, speaker model, Kokoro. |
| `src/coordinator/index.ts`, `agent.ts` | Voice conversation and the voice prompt. |
| `src/shared/types.ts` | `VoiceSettings`, `VoiceStatus`, `VoicePlayback`, `voice.*` messages. |

```
mic ─> AudioWorklet (80 ms Int16 16 kHz frames) ─> coordinator assistant
        wake word (worker) / hotkey ─> [speaker check] ─> record until pause (RMS)
        ─> STT (worker Whisper | OpenAI | Meta) ─> agent run (thread channel 'voice')
        ─> sentence stream ─> TTS (Kokoro | ElevenLabs | Windows) ─> voice.play chunks ─> window speaks
```

Non-obvious points:

- **Messages.** Renderer to coordinator: `voice.status`, `voice.trigger`, `voice.played`, `voice.enroll`, `voice.profile`, `voice.forgetProfile`, `voice.testSpeaker`, `voice.say`, `voice.elevenVoices`, plus the audio envelope `{kind:'audio', pcm}`. Coordinator to renderer: `voice.status`, `voice.play` (with `last`), `voice.stop`. Main to coordinator: `voice.trigger`. Worker requests: `config`, `listen`, `audio`, `transcribe`, `embed`, `tts`; replies: `wake`, `progress`, `result`, `tts-chunk`, `done`, `error`.
- **Frames** are dropped, not queued, while the coordinator reconnects or voice is off. The coordinator keeps the last 25 frames (2 s) for the speaker check and 8 more as pre-roll when interrupted.
- **Wake-word detection** runs only in `listening` and never while Alma speaks. The worker reports scores above 0.2; the coordinator acts at or above `wakeThreshold`. With wake word `off`, no audio goes to the detector.
- **Speaker check only on wake-word starts.** The shortcut, the button and follow-ups never verify. Design note: WavLM scored the owner 0.44–0.92 on short phrases, which silently dropped them, so the check was removed from follow-ups; on real humans the same speaker scored 0.91–0.96 and different people 0.67–0.79, hence the default threshold 0.86 (design note, `integrations-design` and `channels-voice-design`).
- **Why no Python.** Decided to run everything on onnxruntime-node, the same engine as the vault embeddings, with microphone capture in the renderer (design note, `channels-voice-design`). Messages with an `ArrayBuffer` in the transfer list are silently dropped on the renderer to utilityProcess port, so audio is copied.
- **Spanish Kokoro** uses the Kokoro ONNX with `ef_dora` style and espeak-ng (WASM, `es-419`), since kokoro-js alone is English-only (design note). A leading "Mmm" is hummed instead of spelled.
- **Fillers.** On thinking start, a random filler ("Mmm…", "A ver…", «Esperá que pienso.», …) is spoken at once; one search filler if a tool starts before any text. Fillers are cached; ElevenLabs fillers are kept on disk so credits are spent once. The 8 fillers are prepared in the background when voice is on with Kokoro or ElevenLabs.
- **Barge-in** only with Kokoro or ElevenLabs. With the Windows engine echo cancellation is bypassed, so barge-in is off and the person must use the shortcut or button. An interruption whose words were at least 70% in what Alma just said is dropped as Alma hearing herself.
- **Fallback.** If Kokoro or ElevenLabs synthesis fails, the overlay says «La voz elegida falló (<error>); usé la de Windows.» and the text is spoken with the Windows voice. A failed filler is skipped silently.
- **Voice conversation.** A thread with channel `voice`; a thread idle for more than 1 hour is replaced. The agent is `voice.agentId` (default agent if deleted), runs with low effort for the main agent, and is told: short answers, no Markdown/URLs/code, say what it will do before slow tools, no «¿algo más?».
- **Voice approvals** only for the voice thread; two unclear answers in a row leave the approval pending in the app.

## Tools for agents

The module exposes no agent tools. Voice approvals reuse the approval flow ([approvals](approvals.md)).

## Settings and data

| Setting | Default |
|---|---|
| `voice.enabled` | `false` |
| `voice.wakeWord` | `hola_alma` (or `off`) |
| `voice.wakeThreshold` | `0.5` |
| `voice.hotkey` | `Control+Alt+Space` |
| `voice.verifySpeaker` / `speakerThreshold` | `true` / `0.86` (slider 0.60–0.95) |
| `voice.stt` / `sttModel` | `local` / `whisper-base` (or `whisper-small`; `openai`, `meta`) |
| `voice.tts` / `kokoroVoice` | `kokoro` / `ef_dora` |
| `windowsVoice`, `elevenVoiceId` | empty (first Spanish Windows voice) |
| `elevenModel` | `eleven_multilingual_v2` |
| `voice.agentId` / `threadId` | `general` / `null`; mic = system default |

API keys come from Providers or the environment variables `OPENAI_API_KEY`, `META_API_KEY`, `ELEVENLABS_API_KEY`.

Data:

- Models under `<userData>/models`: `openwakeword/`, `kokoro/<voice>.bin`, and Hugging Face models (Whisper `onnx-community/whisper-base|small` q8, Kokoro `onnx-community/Kokoro-82M-v1.0-ONNX` q8, speaker `Xenova/wavlm-base-plus-sv` q8) in the transformers cache. Wake-word and voice-style downloads go to a `.part` file and are renamed.
- Voice print: `<userData>/voice-profile.json` with `{vector, enrolledAt, samples}`; local only. "Olvidar mi voz" overwrites it with `{}`.
- ElevenLabs filler audio: `<userData>/voice-cache/<sha1>.mp3`.
- Microphone audio is never written to disk.
- The shipped wake-word model is `resources/wakewords/hola_alma_v0.1.onnx` (Alma's own openWakeWord model); its melspectrogram and embedding models come from the openWakeWord v0.5.1 GitHub release.

## Limits and rules

| Value | Source |
|---|---|
| Frame 80 ms, 1280 samples, mono 16 kHz Int16 | worklet |
| Speech threshold RMS above max(0.012, min(2.5× noise floor, 0.05)) | `speech.ts` |
| Silence to end: 750 ms once spoken at least 2 s, else 1100 ms | `speech.ts` |
| Start timeout 4 s; maximum 15 s per recording | `speech.ts` |
| Follow-up window 10 s after an answer ending in "?", otherwise 6 s | `speech.ts` |
| Barge-in: 5 consecutive 80 ms chunks (400 ms) with RMS at least 0.035 and 3× the learned echo; first 6 chunks learn the echo | `speech.ts` |
| Sentence chunks: merge pieces fitting 60 characters, cut pieces over 280 at word boundaries | `speech.ts` |
| End-of-turn playback timeout 120 s | `assistant.ts` |
| Local transcription is always Spanish; OpenAI `gpt-4o-mini-transcribe` (`es`); Meta `muse-voice-transcribe-1.0` (USD 0,18 per hour of audio per the UI) | assistant / worker |
| Enrollment: 3 phrases × 5.5 s, consistency warning below 0.75 | `SettingsDialog.tsx` |

## Security and privacy

- The voice print is **biometric data**: local file, exported and erased with personal data ("Borrar mi historial" overwrites it). See `../security/PRIVACY.md` and [security](security.md).
- Audio leaves the machine only for OpenAI or Meta transcription (the whole recording as WAV). Text leaves for ElevenLabs. Hugging Face and GitHub see only the model downloads. Local Whisper and Kokoro send nothing.
- Chromium grants only audio-only `media` requests to the main window. The window is not throttled in the background, so voice works from the tray.
- The speaker check fails open: if it throws, the turn starts anyway, and with `verifySpeaker` on but no voice print anyone is answered. The shortcut and follow-ups skip the check by design.

## How it is tested

`tests/voice.test.ts` has 12 tests of the pure functions in `speech.ts`: text preparation, sentence splitting, streaming sentences, endpointing, timeouts, follow-up window, goodbye detection, barge-in, echo detection, yes/no, resampling, cosine similarity and the WAV header. Not covered: the state machine, the worker, engines, enrollment, approvals by voice, hotkey registration, fillers, fallbacks, and the 280-character cut. By hand: turn voice on and check the Windows microphone indicator, run one full turn, interrupt Alma, delete the models folder and enable voice to see "Descargando <name>…", press the shortcut from another app, and block the microphone in Windows.

## Known limits

1. **A failed model download is never retried** until restart or until the model setting changes (loaders cache their promise).
2. **After a worker crash the state stays `error`** until a voice setting changes.
3. **Speaker check fails open** and answers anyone if no print exists.
4. **README was stale (fixed in spec 025):** it listed wake words «Hey Jarvis», «Alexa»…, but the code ships only «Ey Alma» (`src/main/settings.ts:103-104` forces any other saved value to `hola_alma`). The tab still says «Otra palabra propia necesita entrenar un modelo aparte; por ahora usá una de estas.» with one option.
5. The `loading` state ("Preparando la voz…") exists but nothing sets it; downloads only show as overlay text.
6. "Probar la voz" and Telegram/WhatsApp voice-note transcription work with the assistant off, yet the replies tell the person to enable voice.
7. A first approval in a freshly created voice thread may not match the thread id read at event time.

## Cancel and end of conversation (spec 024)

- **Cancel**: the ✕ in the overlay (or Esc) drops the recording, the transcript waiting to go out or the run in progress, silences Alma and ends the conversation. After each transcript there is a pause (`voice.sendDelayMs`, 1 s by default) so a false activation can be cancelled before the model sees it.
- **The model closes the conversation**: in a voice thread the agent has `end_voice_conversation`; when it calls it, the microphone does not stay open for a follow-up. Without the call the old 6 s / 10 s window applies.

## See also

[Telegram](telegram.md) · [WhatsApp](whatsapp.md) (voice notes) · [Aprobaciones](approvals.md) · [Providers](providers.md) · [Configuraciones](settings.md) · [Chat](chat.md) · [App shell](app-shell.md) · [Seguridad](security.md) · [Ajustes](../references/settings.md) · [Architecture](../architecture.md)
