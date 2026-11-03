# 024 — Plan

## 1. Approach
Small pure helpers carry the rules (`conversationEnded`, `effectiveProfile`, `isChatModel`, `applyMetaDefault`, `compactHistory`); `VoiceAssistant` gains `cancel()` and a cancellable pause; one new tool; UI wiring and CSS. Rejected: a `[FIN]` text marker (leaks into speech and history) and model-summarized history (spends tokens to save tokens).

## 2. Layers touched
| Layer | Files | Why |
|---|---|---|
| shared | `defaults.ts` (Meta defaults, `applyMetaDefault`, `effectiveProfile`, `isChatModel`), `types.ts` (`Thread.model`, `voice.sendDelayMs`, `voice.cancel`, `metaDefaultApplied`) | pure rules |
| coordinator | `voice/assistant.ts`, `voice/speech.ts`, `tools/voice.ts`, `agent.ts`, `context.ts`, `images.ts`, `index.ts` | behavior |
| main | `settings.ts` | migration at load |
| renderer | `ChatView.tsx`, `VoiceLayer.tsx`, `SettingsDialog.tsx`, `plain-app.css` | UI |

## 3. Contracts
`conversationEnded(messages): boolean`; `effectiveProfile(profile, thread): AgentProfile`; `isChatModel(id): boolean`; `applyMetaDefault(settings, hasMetaKey): Settings`; `compactHistory(messages): ChatMessage[]`; tool `end_voice_conversation({reason?})`; request `voice.cancel`; `threads.update` accepts `model: {provider, model} | null`.

## 4. Data and persistence
`Thread.model?`, `Settings.voice.sendDelayMs` (default 1000; older saves get it by merge), `Settings.metaDefaultApplied`.

## 5. Dependency injection
`VoiceDeps.conversationEnded(threadId)`. Tests fake `fetch` (Meta STT), the Windows TTS path and `ask`.

## 6. Test strategy
Each AC with logic is named in `tests/voice-control.test.ts`, `tests/meta-defaults.test.ts`, `tests/context.test.ts`, `tests/agent.test.ts`, `tests/media.test.ts`.

## 7. Security and privacy impact
None new; STT default unchanged (local).

## 8. Rollout
Always on. `sendDelayMs = 0` removes the pause.
