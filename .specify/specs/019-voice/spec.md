---
status: implemented
---

# 019 — Voz

## 1. Summary
Alma can be talked to out loud, with no Python and no cloud requirement. While the assistant is on, the window streams the
microphone to the coordinator; a wake word ("Hey Alma", the same in both languages) or a global keyboard shortcut starts a turn; Alma checks (optionally)
that the voice is the owner's, records until the person pauses, transcribes (local Whisper, OpenAI or Meta), hands the text to an
agent in a dedicated voice conversation, and speaks the answer sentence by sentence (Kokoro, Windows voices or ElevenLabs). The
microphone stays open for a follow-up, the person can talk over Alma to interrupt her, and tool approvals raised in that
conversation are answered with "¿sí o no?". Models (wake word, Whisper, speaker model, Kokoro) run on onnxruntime in a worker
thread and are downloaded on first use. The same transcriber serves voice notes from Telegram and WhatsApp.

## 2. Problem and goal
Typing is slow when hands or eyes are busy. Done means: with voice on, a person can say the wake word or press a shortcut, talk
naturally, hear a short answer, follow up without repeating the wake word, interrupt, and approve or deny a tool call by voice,
with the heavy models local by default and the cloud engines opt-in.

## 3. Scope
**In:** wake word, global hotkey, speaker verification and enrollment, speech-to-text engines, text-to-speech engines, the
microphone path from the window, playback in the window, the voice conversation, voice approvals, model download behavior, the
voice settings tab, the overlay and sidebar button, the `voice.*` messages.
**Out (and why):**
- Telegram / WhatsApp voice notes as channels: they only reuse `transcribeFile`; the channels are [010](../010-telegram/spec.md) and [011](../011-whatsapp/spec.md) (folder names per the spec map).
- Approval policy itself (who asks and when): [004](../004-approvals/spec.md). This spec only covers answering by voice.
- Providers' API keys and the keys screen: [005](../005-providers/spec.md) / [006](../006-settings/spec.md).
- Chat/threads/agent run loop: [002](../002-chat/spec.md), [003](../003-agents/spec.md). Biometric data policy and erase/export: [022](../022-security-and-privacy/spec.md).
- Window shell, tray, hidden start: [023](../023-app-shell-and-ui/spec.md).

## 4. Users and stories
- **US-1** As a person, I want to start talking to Alma with a wake word or a shortcut, so that I don't need to touch the keyboard.
- **US-2** As the owner, I want Alma to answer only my voice when woken by the wake word, so that other people nearby can't use her.
- **US-3** As a person, I want my speech transcribed locally or through OpenAI/Meta, so that I choose privacy, speed or cost.
- **US-4** As a person, I want to hear answers right away in a voice I choose (Kokoro, Windows, ElevenLabs), so that the conversation feels live.
- **US-5** As a person, I want to keep talking without repeating the wake word and to interrupt Alma, so that it feels like a conversation.
- **US-6** As a person, I want to approve or deny a tool call by saying yes or no, so that I don't have to look at the screen.
- **US-7** As a person, I want to train, test and forget my voice print and tune every voice setting in Settings → Voz, so that I control the assistant.
- **US-8** As a person, I want clear feedback when a model is downloading, a key is missing or something fails, so that I know what to fix.
- **US-9** As the maintainer, I want the voice pipeline's decisions as pure, tested functions, so that tuning thresholds is safe.

## 5. Acceptance criteria

### Text prepared for speech (US-4)
- **AC-4.1** (US-4) Given a Markdown answer, when it is prepared to be spoken, then headings, bold/italic marks, emoji, table rows, list bullets, link targets and image syntax are removed, URLs become "un enlace", and a code block becomes "(te dejé el código en la pantalla)" (the `es` phrases; the `en` ones come from the dictionary and follow `language`, [gap]). Test: tests/voice.test.ts › "turns a markdown answer into something worth saying"
- **AC-4.2** (US-4) Given a long text, when it is split for synthesis, then it is cut at sentence ends, pieces whose combined length fits in 60 characters are merged, and pieces longer than 280 characters are cut at word boundaries. Test: tests/voice.test.ts › "splits into sentences, merging very short ones" (the merge rule; the 280-character cut is [gap])
- **AC-4.3** (US-4) Given the model streams text, when tokens arrive, then only complete sentences are handed out, never from inside an open code block, and `flush` hands out the remainder. Test: tests/voice.test.ts › "hands out finished sentences as tokens arrive, never inside code"
- **AC-4.4** (US-4) Given the agent starts thinking, when the answer has not started, then a random filler of the app language (the `es` ones are "Mmm…", "A ver…", "Mmm, dejame pensar.", "Esperá que pienso.", "Ya te contesto.") is spoken at once; if a tool starts before any answer text, one search filler ("Dame un segundo, que busco." / "Ya va, lo estoy buscando." / "Un momento, que me fijo.") is spoken once. [gap]
- **AC-4.5** (US-4) Given the provider does not stream, when the run ends with no streamed text, then the final answer of the thread is spoken instead. [gap]
- **AC-4.6** (US-4) Given the agent run throws, when the turn ends, then Alma says "No pude hacerlo: <error message>". [gap]

### Starting a turn (US-1, US-2)
- **AC-1.1** (US-1) Given voice is enabled and the wake word is "Hey Alma", when the detector's score reaches `wakeThreshold` while the state is `listening` and no turn is running, then a conversation starts; a score below the threshold, or any score in another state, is ignored. [gap]
- **AC-1.2** (US-1) Given voice is enabled, when the global shortcut is pressed (or the microphone button is pressed) while `listening`, then a turn starts without the wake word and without any speaker check. [gap]
- **AC-1.3** (US-1) Given Alma is speaking, when the shortcut or the button is pressed, then speech stops and the conversation ends (no follow-up window). [gap]
- **AC-1.4** (US-1) Given Alma is recording, when the shortcut or the button ("Listo, ya terminé") is pressed, then the recording is closed as heard and the turn goes on to transcription. [gap]
- **AC-1.5** (US-1) Given the wake word is "off", when voice is on, then no audio is sent to the wake-word detector and only the shortcut/button starts a turn. [gap]
- **AC-1.6** (US-1) Given voice is enabled and a shortcut is set, when settings change, then the previous shortcut is unregistered and the new one registered system-wide; with voice off or an empty shortcut none is registered; if another app owns it, or it is invalid, it is logged and not registered. [manual] Press the shortcut from another app; set a taken one and check the log.
- **AC-2.1** (US-2) Given an enrolled voice print and `verifySpeaker` on, when the wake word fires, then the last ~2 s of audio are compared with the print and the turn starts only if the cosine similarity is at least `speakerThreshold`; otherwise the overlay detail shows "Voz no reconocida (0.xx)" and Alma keeps listening. [gap]
- **AC-2.2** (US-2) Given no voice print is enrolled, or `verifySpeaker` is off, when the wake word fires, then no speaker check is done. [gap]
- **AC-2.3** (US-2) Given the speaker check itself throws, when the wake word fires, then the error is logged and the turn starts anyway. [gap]
- **AC-2.4** (US-2) Given a conversation is ongoing, when a follow-up is recorded, then no speaker check is applied to it. [gap]
- **AC-2.5** (US-2) Given similarity is computed, when two vectors are compared, then it is cosine similarity (1 for equal, 0 for orthogonal). Test: tests/voice.test.ts › "resamples, measures similarity and writes a valid WAV header"

### Recording and end of speech (US-1, US-5)
- **AC-5.1** (US-5) Given a turn is recording, when the person speaks then pauses, then the recording ends after 750 ms of silence once they have spoken ≥ 2 s, or 1100 ms of silence if they spoke less than 2 s. Test: tests/voice.test.ts › "waits for speech and stops after a pause", "waits longer after a short start, since people pause after a quick question"
- **AC-5.2** (US-5) Given a turn is recording and nobody speaks, when 4 s pass (or the follow-up wait), then the recording times out and the turn ends. Test: tests/voice.test.ts › "times out when nobody speaks"
- **AC-5.3** (US-5) Given a recording runs, when 15 s elapse, then it ends: as heard if the person spoke, as timeout if not. [gap]
- **AC-5.4** (US-5) Given Alma answered, when the answer ends with a question mark, then the microphone stays open 10 s for a follow-up, otherwise 6 s. Test: tests/voice.test.ts › "keeps listening longer when Alma asked something"
- **AC-5.5** (US-5) Given a follow-up is recorded, when the text is a closing ("gracias", "listo, nada más", "chau Alma", "ok perfecto", "eso es todo") the conversation ends; a closing followed by a new request does not. Spanish and English closings are both accepted whatever `language` is (the English ones are [gap]). Test: tests/voice.test.ts › "tells a goodbye from a new request"
- **AC-5.6** (US-5) Given a follow-up wait elapses with no speech, or the person presses stop, when the loop checks, then the conversation ends and the state returns to `listening`. [gap]
- **AC-5.7** (US-5) Given Alma is speaking with a Kokoro or ElevenLabs voice, when the person talks clearly louder than Alma's echo for 5 consecutive 80 ms chunks (400 ms, RMS ≥ 0.035 and ≥ 3× the learned echo level), then Alma stops speaking, the agent run is cancelled and the next recording starts with the audio already captured. Test: tests/voice.test.ts › "barges in only after 400 ms of a voice clearly over the echo of Alma"
- **AC-5.8** (US-5) Given the TTS engine is Windows, when Alma speaks, then barge-in detection is off (the person must use the shortcut or button). [gap]
- **AC-5.9** (US-5) Given an interruption was transcribed, when at least 70% of its words (≥ 2 words of 3+ letters) were in what Alma had just said, then it is dropped as Alma hearing herself. Test: tests/voice.test.ts › "recognizes Alma hearing her own words"
- **AC-5.10** (US-5) Given a recording yields nothing or an empty transcript, when the turn ends, then no request is sent and the state returns to `listening`. [gap]

### Approvals by voice (US-6)
- **AC-6.1** (US-6) Given an approval is requested in the voice conversation, when it arrives, then Alma says "Necesito tu permiso para <tool name with spaces>" (adding ", y podría ser riesgoso" if flagged) and "¿Sí o no?", records, and allows or denies the approval accordingly. [gap]
- **AC-6.2** (US-6) Given the spoken answer is "Sí, dale" / "no, cancelá" / "mejor no", when parsed, then it is yes / no / no; an unrelated phrase, or one containing both yes and no words, is neither. Spanish and English yes/no words are both understood whatever `language` is (the English ones are [gap]). Test: tests/voice.test.ts › "understands spoken yes and no"
- **AC-6.3** (US-6) Given two answers in a row are unclear (or empty), when asked twice ("No te entendí. ¿Sí o no?" the second time), then the approval stays pending in the app and nothing is decided. [gap]
- **AC-6.4** (US-6) Given an approval belongs to another thread, when it is requested, then voice does not answer it. [gap]

### Speech to text (US-3)
- **AC-3.1** (US-3) Given `stt` is `local`, when audio is transcribed, then the worker's Whisper (`whisper-base` or `whisper-small`, in the language of `language`, 8-bit quantized, CPU) is used. [gap]
- **AC-3.2** (US-3) Given `stt` is `openai`, when audio is transcribed, then a WAV is posted to OpenAI (`gpt-4o-mini-transcribe`, language taken from `language`) with the key from Providers or the `OPENAI_API_KEY` env var; with no key the error is "Para transcribir con OpenAI cargá una API key de OpenAI en Configuración → Proveedores."; a non-OK reply raises "OpenAI no pudo transcribir (<status>): <first 200 chars>". [gap]
- **AC-3.3** (US-3) Given `stt` is `meta`, when audio is transcribed, then a WAV is posted to the Meta Muse Voice Transcribe endpoint (`muse-voice-transcribe-1.0`, language bias taken from `language`) with the key from Providers or `META_API_KEY`; missing key and non-OK replies raise the analogous Spanish messages. [gap]
- **AC-3.4** (US-3) Given samples at some rate, when resampled to 16 kHz, then the length scales (48 000 → 16 000 samples for 1 s) by linear interpolation. Test: tests/voice.test.ts › "resamples, measures similarity and writes a valid WAV header"
- **AC-3.5** (US-3) Given a WAV is produced for the cloud engines, when written, then it is mono 16-bit at 16 kHz with a 44-byte RIFF header. Test: tests/voice.test.ts › "resamples, measures similarity and writes a valid WAV header"
- **AC-3.6** (US-3) Given a Telegram or WhatsApp voice note, when transcribed, then with `openai` the file goes as is; otherwise the Ogg/Opus audio is decoded and resampled to 16 kHz first and then transcribed with the configured engine. [gap]

### Text to speech and playback (US-4)
- **AC-4.7** (US-4) Given the engine is Kokoro, when text is spoken, then it is phonemized with espeak-ng (in the language of `language`; `es-419` for `es`), synthesized sentence by sentence with the chosen voice, and each chunk (24 kHz PCM) is sent to the window as soon as it exists; a leading "Mmm" is hummed instead of spelled. [gap]
- **AC-4.8** (US-4) Given the engine is ElevenLabs, when text is spoken, then MP3 (`mp3_44100_128`) is requested for the chosen voice and model; with no key or no chosen voice the error is "Falta la API key o la voz de ElevenLabs.". [gap]
- **AC-4.9** (US-4) Given the engine is Windows, when text is spoken, then the window speaks it with the chosen `SpeechSynthesis` voice, or the first one of the app language if none is chosen or it is not found. [manual] Choose a voice in Settings → Voz and press "Probar la voz".
- **AC-4.10** (US-4) Given an answer's synthesis fails (Kokoro or ElevenLabs), when it is not a filler, then the overlay detail says "La voz elegida falló (<error>); usé la de Windows." and the text is spoken with the Windows voice; a failed filler is silently skipped. [gap]
- **AC-4.11** (US-4) Given a filler was spoken once with an engine and voice, when it is needed again, then the cached audio is replayed; ElevenLabs fillers are also kept on disk so credits are spent once. [gap]
- **AC-4.12** (US-4) Given voice is enabled with Kokoro or ElevenLabs (with a voice chosen), when settings change, then the 8 fillers are prepared in the background one at a time without playing. [gap]
- **AC-4.13** (US-4) Given a spoken turn, when the person or the shortcut stops it, then pieces not yet played are dropped and the window stops playing. [manual] Press the stop button while Alma speaks.
- **AC-4.14** (US-4) Given a turn's last piece, when the window finishes playing everything, then it reports `voice.played` and the coordinator moves on; if no report arrives within 120 s it moves on anyway. [gap]
- **AC-4.15** (US-4) Given "Probar la voz", when pressed, then Alma says "Hola, soy Alma. ¿En qué te puedo ayudar hoy?" with the current engine (works even if the assistant is off). [manual]

### Speaker enrollment (US-7)
- **AC-7.1** (US-7) Given the Voz tab, when "Entrenar mi voz" is pressed, then the person reads three phrases, 5.5 s each, with a live level meter, and the recordings are sent for enrollment. [manual] Run the flow and watch the three prompts.
- **AC-7.2** (US-7) Given recordings are sent, when enrolled, then each is embedded, the normalized vectors are averaged into one print saved to `voice-profile.json`, and the lowest similarity of a recording to the average is returned as consistency; below 75% the screen warns that the recordings were too different. [gap]
- **AC-7.3** (US-7) Given no recordings, when enrolling, then the error is "No hay grabaciones." [gap]
- **AC-7.4** (US-7) Given a voice print, when "Probar si me reconoce" is pressed, then 3.5 s are recorded and the screen shows the similarity, the threshold and whether Alma would recognize the person; without a print the error is "Todavía no entrenaste tu voz.". [gap]
- **AC-7.5** (US-7) Given a voice print, when "Olvidar mi voz" is pressed (or "Borrar mi historial" is used), then the print is dropped from memory and the file is overwritten with `{}`. [gap]
- **AC-7.6** (US-7) Given an app restart, when the coordinator starts, then the saved print is loaded; a missing or unreadable file means "not enrolled". [gap]

### Settings, states and failures (US-7, US-8)
- **AC-7.7** (US-7) Given the Voz tab, when a setting changes, then it is saved at once and the coordinator re-syncs: turning voice on starts listening (state `listening`), turning it off cancels any recording and the state becomes `off`. [gap]
- **AC-7.8** (US-7) Given the wake-word sensitivity slider, when moved, then `wakeThreshold` is stored as 1.2 minus the slider value (slider 0.3–0.9, so threshold 0.9–0.3). [manual] Move the slider and read the stored value in settings.
- **AC-7.9** (US-7) Given settings saved by an older version, when loaded, then any wake word other than "off" becomes "hey_alma" (a saved "hola_alma" is migrated) and missing voice keys take their defaults. [gap]
- **AC-8.1** (US-8) Given the window, when voice is on, then it requests the microphone (echo cancellation, noise suppression and auto gain on; a 16 kHz context) and streams 1280-sample Int16 mono chunks; the chosen device is used if set. [manual] Turn voice on and check the microphone indicator in Windows.
- **AC-8.2** (US-8) Given Windows denies the microphone, when voice is on, then the overlay shows "Windows no le da acceso al micrófono a Alma (Configuración de Windows → Privacidad → Micrófono)." [manual] Block the microphone in Windows and enable voice.
- **AC-8.3** (US-8) Given the voice states, when a turn runs, then the overlay shows "Te escucho…" (recording), "Entendiendo…", "Pensando…", "Hablando" with the transcript and the sentence-by-sentence answer; a chime plays when recording starts unless it is a follow-up; the sidebar button reads "Hablar", "Callar", "Voz con error" or "Voz…". [manual] Run one turn.
- **AC-8.4** (US-8) Given a model must be downloaded, when it downloads, then the overlay detail shows "Descargando <name>…" (with a percentage for Hugging Face models) while the state is unchanged. [manual] Delete the models folder and enable voice offline/online.
- **AC-8.5** (US-8) Given the wake-word models cannot be downloaded or loaded, when voice is on, then the detail shows "Palabra de activación no disponible: <reason>" and the shortcut still works. [gap]
- **AC-8.6** (US-8) Given the worker process dies or errors, when voice is on, then pending model calls fail and the state becomes `error` with the message; it stays there until the voice settings change. [gap]
- **AC-8.7** (US-8) Given a transcription or turn error, when it happens, then the error text appears as the overlay detail and the state returns to `listening`. [gap]
- **AC-8.8** (US-8) Given the missing-key case in Settings, when `stt` is `openai`/`meta` with no key (in Providers or environment), then the tab warns "Cargá una API key de OpenAI/Meta en Proveedores.". [manual] Select the engine with no key.
- **AC-8.9** (US-8) Given ElevenLabs, when "Ver voces" is pressed, then the account's voices are listed with name, labels and a sample to listen to, and "Elegir" stores the voice id; a missing key raises "Cargá primero tu API key de ElevenLabs."; HTTP 401 raises "ElevenLabs respondió 401: la key no es válida."; other failures "ElevenLabs respondió <status>.". [gap]
- **AC-8.10** (US-8) Given a closing app, when the coordinator shuts down, then the voice worker is terminated. [gap]

## 6. Business rules
- **BR-1** Audio frames are 80 ms of mono 16 kHz Int16 PCM (1280 samples), produced by an AudioWorklet in the window and copied (not transferred) to the coordinator; frames are dropped, not queued, while the coordinator is reconnecting or voice is off. (src/renderer/src/voice/capture-worklet.js, src/preload/index.ts, src/coordinator/voice/assistant.ts)
- **BR-2** The coordinator keeps the last 25 frames (2 s) to check the speaker on the wake phrase and 8 more as pre-roll when interrupting. (src/coordinator/voice/assistant.ts)
- **BR-3** Wake-word detection runs only while the state is `listening` and the wake word is not "off"; never while Alma speaks or a request is in progress. The worker reports any score above 0.2; the coordinator acts only at or above `wakeThreshold`. (assistant.ts, voice-worker.ts)
- **BR-4** Defaults: voice disabled; wake word `hey_alma`; `wakeThreshold` 0.5; hotkey `Control+Alt+Space`; mic = system default; `verifySpeaker` true; `speakerThreshold` 0.86 (slider 0.60–0.95); `stt` `local`; `sttModel` `whisper-base`; `tts` `kokoro`; `kokoroVoice` a default per language (`es`: `ef_dora`; `en`: chosen in the plan; a voice the person already chose is kept); `windowsVoice` ""; `elevenVoiceId` ""; `elevenModel` `eleven_multilingual_v2`; `agentId` `general`; `threadId` null. (src/shared/defaults.ts)
- **BR-5** The only wake word is "Hey Alma", the same in both languages (spec 025 BR-19). It needs our own new openWakeWord model, trained by a person (asset pending); until that file is in `resources/wakewords/`, the previous `hola_alma_v0.1.onnx` keeps loading so voice does not break. Its melspectrogram and embedding models are downloaded from the openWakeWord v0.5.1 GitHub release. (voice-worker.ts)
- **BR-6** Endpointing is energy-based (RMS): speech needs RMS above max(0.012, min(2.5× the noise floor, 0.05)); start timeout 4 s, short-speech boundary 2 s, silences 1100 ms (short) / 750 ms (long), maximum 15 s per recording. (src/coordinator/voice/speech.ts)
- **BR-7** Barge-in: 5 consecutive chunks louder than max(0.035, 3× learned echo); the first 6 chunks (~0.5 s) only learn the echo level. (speech.ts)
- **BR-8** Follow-up window: 10 s after an answer ending in "?", otherwise 6 s. A closing phrase ends the conversation only in a follow-up. (speech.ts, assistant.ts)
- **BR-9** The voice conversation is a thread with channel `voice`; a thread idle for more than 1 hour is replaced by a new one; the agent is `voice.agentId` (default agent if it no longer exists). Voice runs use low effort for the main agent. (src/coordinator/index.ts, src/coordinator/agent.ts)
- **BR-10** The agent is told it is a voice conversation: short answers, no Markdown/URLs/code, say what it will do before slow tools, no "¿algo más?". The prompt is written in English (spec 025 BR-17); the language of the answer follows the person's speech (BR-14 of spec 025). (src/coordinator/agent.ts)
- **BR-11** Speaker verification is applied only on wake-word starts. The shortcut/button and follow-ups never verify (WavLM scored the owner 0.44–0.92 on short phrases). (assistant.ts)
- **BR-12** Models live under `<userData>/models`: openWakeWord files in `openwakeword/`, Kokoro voice styles in `kokoro/<voice>.bin`, Hugging Face models (Whisper `onnx-community/whisper-base|small` 8-bit, Kokoro `onnx-community/Kokoro-82M-v1.0-ONNX` 8-bit, speaker `Xenova/wavlm-base-plus-sv` 8-bit) in the transformers cache. Downloads happen on first use; wake-word and voice-style files are written to a `.part` file and renamed. The Settings tab quotes ~80 MB (base) and ~250 MB (small) for Whisper. (voice-worker.ts, SettingsDialog.tsx)
- **BR-13** Voice print: `<userData>/voice-profile.json` with `{vector, enrolledAt, samples}`; local only. ElevenLabs filler audio: `<userData>/voice-cache/<sha1>.mp3`. (assistant.ts)
- **BR-14** Enrollment: three fixed phrases per language (the app language's), 5.5 s each; consistency warning below 0.75; test recording 3.5 s. (SettingsDialog.tsx)
- **BR-15** Cloud transcription models: OpenAI `gpt-4o-mini-transcribe` (language from `language`), Meta `muse-voice-transcribe-1.0` (mode PUSH_TO_TALK, language bias from `language`, USD 0,18 per hour of audio per the UI). Keys come from Providers or the `OPENAI_API_KEY` / `META_API_KEY` / `ELEVENLABS_API_KEY` env vars. (assistant.ts)
- **BR-16** Local transcription language follows `language` (spec 025 BR-20), no longer always Spanish. (voice-worker.ts)
- **BR-17** Playback end-of-turn timeout is 120 s. (assistant.ts)
- **BR-18** The global shortcut is registered by the main process only while voice is enabled and the field is non-empty; it posts `voice.trigger` to the coordinator. (src/main/index.ts)

## 7. Constraints and risks
- **Layers:** renderer (`src/renderer/src/voice/*`, Voz tab in `components/SettingsDialog.tsx`, sidebar button), preload (`sendAudio`), main (hotkey, microphone permission), coordinator (`voice/assistant.ts`, `voice/speech.ts`, `voice/voice-worker.ts` built as `voiceWorker.js`, `index.ts` wiring), shared (`VoiceSettings`, `VoiceStatus`, `VoicePlayback`, `voice.*` messages in `types.ts`).
- **Messages (renderer → coordinator):** `voice.status`, `voice.trigger`, `voice.played`, `voice.enroll`, `voice.profile`, `voice.forgetProfile`, `voice.testSpeaker`, `voice.say`, `voice.elevenVoices`; audio envelope `{kind:'audio', pcm}`. **Events (coordinator → renderer):** `voice.status`, `voice.play` (with `last`), `voice.stop`. **Main → coordinator:** `voice.trigger`.
- **Worker protocol:** `config`, `listen`, `audio`, `transcribe`, `embed`, `tts` requests; `wake`, `progress`, `result`, `tts-chunk`, `done`, `error` replies. Spawned lazily; ONNX runs on CPU.
- **Tools / ToolRisk:** voice exposes no agent tools. Voice approvals reuse the approval flow (spec 004).
- **Security / privacy:** the voice print is biometric data (`docs/security/PRIVACIDAD.md`); it is exported and erased with personal data. Microphone audio is never written to disk. Audio leaves the machine only for OpenAI/Meta transcription; text leaves for ElevenLabs; Hugging Face/GitHub see only the model downloads. Chromium may grant only audio-only `media` requests to the main window. The window is not throttled in the background so voice works from the tray.
- **Platform:** Windows voices need the OS `SpeechSynthesis`; Windows TTS bypasses echo cancellation (no barge-in). Native `onnxruntime-node`, `espeak-ng` (WASM) and `ogg-opus-decoder` are dependencies; `voiceWorker` must be unpacked from any archive (see [001](../001-release-packaging/spec.md)).
- **Offline:** with no network and no cached models, the wake word, Whisper, speaker model and Kokoro each fail with a message in the overlay; the Windows voice and the shortcut do not need downloads.
