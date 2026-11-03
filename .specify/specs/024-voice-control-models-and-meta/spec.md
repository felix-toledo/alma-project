---
status: implemented
---

# 024 — Control de voz, modelo por conversación, Meta por defecto y menos tokens

## 1. Summary
Voice gets a real "cancel" (before anything reaches the model) and the model itself decides when a spoken conversation is over.
The chat header picks the **model** that answers (per conversation) instead of the agent; the default agent is chosen in Settings.
Meta (Muse) is the default provider everywhere (agents, auto-review, images). Pop-ups lose their hidden scrollbars and get
proper padding. Long conversations cost fewer tokens because old tool output and pictures are no longer resent in full.

## 2. Problem and goal
- Voice sometimes starts by itself and there is no way to throw the recording away; and Alma keeps the microphone open
  waiting for a reply nobody will give.
- The header offers agents, but what the person wants to choose is who answers (which model).
- New installs and the default agents point at Anthropic; the person wants Meta first.
- Buttons grow and glow on hover; inside scrolling panels that grows a horizontal scrollbar nobody asked for.
- Every request resends the whole conversation, including multi-thousand-token tool results and base64 pictures.

## 3. Scope
**In:** voice cancel + pre-send pause, `end_voice_conversation` tool, per-thread model override and its header picker,
default-agent picker, Meta defaults and one-time migration, Meta image sizes, history compaction, pop-up/scroll CSS.
**Out (and why):** Meta text-to-speech (no known endpoint), changing the speech-to-text default (audio would leave the machine by
default: stays local, one click away), summarizing old turns with a model (costs tokens itself), changing company agents.

## 4. Users and stories
- **US-1** As a person using voice, I want to cancel a recording or a pending request, so that a false activation never reaches the model.
- **US-2** As a person using voice, I want Alma to close the conversation when there is nothing left to say, so that the microphone doesn't wait for nothing.
- **US-3** As a person, I want to pick which model answers from the chat header, so that I choose per conversation.
- **US-4** As a person, I want to choose my default agent in Settings.
- **US-5** As a person, I want Meta as the default for everything, so that I only need one key.
- **US-6** As a person, I want clean pop-ups with no phantom scrollbars.
- **US-7** As a person paying per token, I want long chats to resend less.

## 5. Acceptance criteria

### Voice (US-1, US-2)
- **AC-1.1** (US-1) Given Alma is recording, when `cancel` is called, then the audio is discarded, nothing is transcribed or sent to the agent, and the state returns to `listening`.
- **AC-1.2** (US-1) Given the person finished talking and was transcribed, when `cancel` is called during the pause before sending (`sendDelayMs`), then the agent is never asked and the state returns to `listening`.
- **AC-1.3** (US-1) Given `voice.sendDelayMs` is 0, when a turn is transcribed, then it is sent at once; the default is 1000 ms.
- **AC-1.4** (US-1) Given Alma is thinking or speaking, when `cancel` is called, then the run is aborted, speech stops and the conversation ends (no follow-up).
- **AC-1.5** (US-1) [manual] The overlay shows a cancel (✕) button while recording, transcribing, thinking and speaking, and Escape does the same; "Listo, ya terminé" stays for recording.
- **AC-2.1** (US-2) Given a voice conversation, when the agent runs, then it is offered `end_voice_conversation` (risk `read`); in any other channel or as a subagent it is not.
- **AC-2.2** (US-2) Given the model called `end_voice_conversation` during an answer, when Alma finishes speaking it, then the conversation ends instead of opening a follow-up window.
- **AC-2.3** (US-2) Given a thread, when checking whether its last answer ended the conversation, then only tool calls after the latest user message count.

### Model per conversation, default agent (US-3, US-4)
- **AC-3.1** (US-3) Given a thread with a model override, when a run starts, then the agent profile is used with that provider and model; with no override the profile is untouched.
- **AC-3.2** (US-3) Given a provider's model list, when choices are built for the header, then non-chat models (image, voice, transcribe, embeddings, SAM…) are left out.
- **AC-3.3** (US-3) [manual] The header shows a "Modelo" picker (default: "el del agente"); the agent picker moves to the composer bar.
- **AC-4.1** (US-4) [manual] Settings → Agentes has an "Agente por defecto" selector; new conversations use it.

### Meta by default (US-5)
- **AC-5.1** (US-5) Given fresh settings, then every default agent, the auto-review and the image service use Meta (Grok/DeepSeek/Vercel agents keep their own).
- **AC-5.2** (US-5) Given settings saved before this change and a Meta key, when loaded once, then default agents on Anthropic, an Anthropic auto-review and the default xAI image service move to Meta; agents the person edited to another provider, and everything when there is no Meta key, are left alone.
- **AC-5.3** (US-5) Given Meta images, when generating, then `size` is a `WxH` string matching the aspect ratio (1:1 1024x1024, 4:5 1024x1280, 9:16 1024x1792, 16:9 1792x1024).

### Tokens (US-7)
- **AC-7.1** (US-7) Given a conversation, when a request is built, then tool results and pictures from earlier user turns are shortened (head and tail kept, size noted) and in the current turn only results far behind the latest 10 messages are trimmed (more gently); the latest ones are untouched.
- **AC-7.2** (US-7) Given short results or no earlier turns, when compacting, then the same messages are returned and the stored thread is never modified.
- **AC-7.3** (US-7) Given a tool result, when it comes back, then it is capped at 24 000 characters.

### Pop-ups (US-6)
- **AC-6.1** (US-6) [manual] Hover or focus any button inside Settings, Rutinas, "Nueva tarea" or the thread list: no horizontal scrollbar appears, the glow is not cut off, and dialogs have even padding.

## 6. Business rules
- **BR-1** Cancel only discards or aborts; it never deletes the conversation or earlier messages.
- **BR-2** Without `end_voice_conversation` the old behavior holds (6 s follow-up, 10 s after a question).
- **BR-3** A thread's model override wins over the agent's provider and model, never over its tools or prompt.
- **BR-4** Compaction is applied only to the copy sent to the model; Anthropic's own replayed assistant blocks are never edited.
- **BR-5** The one-time Meta migration is flagged in settings (`metaDefaultApplied`) and only runs when a Meta key exists.

## 7. Constraints and risks
- Layers: shared (`defaults.ts`, `types.ts`), coordinator (`voice/`, `agent.ts`, `context.ts`, `tools/voice.ts`, `images.ts`, `index.ts`), main (`settings.ts`), renderer (header, Voz tab, CSS).
- Security / privacy: no new secrets or third parties. Speech-to-text stays local by default (spec 019).
- `end_voice_conversation` is `read`: it only flags the conversation.

## 8. Open Questions
(none: decided under the owner's delegation "sos el jefe por esta noche"; see §3 Out for what was deliberately not done.)
