---
status: accepted
---

# The voice assistant is JavaScript on onnxruntime, with no Python

Wake word, speech-to-text, speaker verification and text-to-speech all run in JavaScript on `onnxruntime-node`, in a worker thread of the coordinator (`src/coordinator/voice/voice-worker.ts`, emitted as `voiceWorker.js`). The microphone is captured in the renderer (`getUserMedia` + AudioWorklet), not with PyAudio. Models are downloaded on first use.

## Why

Design note "channels-voice-design": the ALMA monorepo has a Python voice assistant; the decision was to port it with **no Python**, using the same engine as bge-m3, because the user wants everything configurable in Settings, local-first, with no extra services to run. A spike proved an openWakeWord ONNX pipeline works in Node ("hey jarvis" scored 0.998, a Spanish phrase 0.000, about 5% of one core). Activation is the wake word plus a global hotkey. Speech-to-text is local Whisper (transformers.js) or the OpenAI/Meta API; text-to-speech is Kokoro, Windows voices or ElevenLabs, selectable.

## Considered options

The Python original (ALMA's voice-assistant) was the starting point and was rejected ("NO Python"). Other alternatives: not documented.

## Consequences

- Kokoro and the `phonemizer` npm are English-only. Spanish works with the Kokoro ONNX model, the `voices/ef_dora.bin` style and an `espeak-ng` WASM (`-v es-419 --ipa=3`) whose input must be Latin-1 encoded (design note).
- The only shipped wake word is "Hola Alma" (our own openWakeWord model in `resources/wakewords/`); old settings values are forced to it.
- Speaker verification (WavLM) is applied only on wake-word starts: it scored the owner's short phrases 0.44 to 0.92, so follow-ups and the shortcut never verify. It also fails open if the check throws. The voice print is biometric data, stored locally in `voice-profile.json`.
- Model loaders cache their promise, so a failed first download is not retried until restart.
- Windows SAPI voices bypass echo cancellation, so there is no barge-in with them.
- Audio leaves the machine only with OpenAI/Meta transcription; text leaves with ElevenLabs. Defaults are local (`stt: 'local'`, `tts: 'kokoro'`).
- Native `onnxruntime-node` and the worker must be unpacked when packaged ([spec 001](../../.specify/specs/001-release-packaging/spec.md)).
