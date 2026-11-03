---
status: implemented
---

# 005 — Proveedores de modelos

## 1. Summary
Alma talks to language models through five providers: **Anthropic** (Claude, through the official SDK), **xAI** (Grok), **DeepSeek**,
the **Vercel AI Gateway** and **Meta** (Muse), the last four through the OpenAI-compatible chat API. Every agent profile names one
provider and one model; the coordinator builds a client for that provider with the person's API key (or an environment
variable), streams the answer, and returns text, thinking, tool calls and token usage in one provider-neutral shape. The same
clients answer the auto-review ("is this action dangerous?") calls, boss reviews in companies, vision questions and company
meeting turns. Configuración → Proveedores is where the person stores keys, tests the connection and sees the model list.

## 2. Problem and goal
Different vendors have different message formats, tool-calling styles, reasoning fields and error shapes. Goal: agents, approvals
and companies work the same whatever model runs underneath; a missing or rejected key is reported in plain Spanish with where
to fix it; and a person who leaves the model empty still gets a sensible, current model.

## 3. Scope
**In:**
- the `Provider` interface (`streamTurn`, `review`, `listModels`) and provider selection/caching (`src/coordinator/providers/`);
- the Anthropic client: streaming, adaptive thinking, prompt caching, refusal fallback, retries, error mapping;
- the OpenAI-compatible client for xAI, DeepSeek, Vercel AI Gateway and Meta: message conversion, reasoning, tool calls, usage,
  readable errors, default-model choice;
- API-key resolution (settings vs environment) for model providers; `models.list`;
- usage/token accounting as produced by providers; review verdict calls;
- the provider side of `vision.ts` (which provider/model looks at an image);
- what the person sees about providers in Configuración → Proveedores and in the agent editor's provider/model fields.

**Out (and why):**
- how keys are stored, encrypted and sent to the window; the dialog as a whole: `../006-settings/spec.md`;
- the agent loop and what the loop does with stop reasons and usage: `../003-agents/spec.md`;
- approval modes and what is done with a review verdict: `../004-approvals/spec.md`;
- image generation (xAI/OpenAI/Meta image models, their keys): `../020-images/spec.md`;
- budgets and prices per company: `../007-companies/spec.md`;
- speech-to-text / text-to-speech keys (ElevenLabs, Meta transcription): `../019-voice/spec.md`.

## 4. Users and stories
- **US-1** As a person, I want to store an API key per provider and test it, so that I know my agents can reach their model.
- **US-2** As a person, I want to use a key from my environment, so that I do not have to paste it.
- **US-3** As a person, I want each agent to use a provider and model of my choice, so that I can mix vendors.
- **US-4** As a person, I want an empty model to mean the newest suitable one, so that I do not track model names.
- **US-5** As a person, I want clear messages when a key is missing or rejected or a request fails, so that I can fix it.
- **US-6** As a person, I want an agent to keep working when its history came from another vendor, so that switching agents mid-conversation does not break the chat.
- **US-7** As the maintainer, I want one interface for all vendors, so that adding a provider is one class and a test with a fake.
- **US-8** As a person, I want the safety reviewer to be a model of my choice, so that auto-review runs on the provider I have a key for.

## 5. Acceptance criteria

### Keys and the providers tab (US-1, US-2)
- **AC-1.1** (US-1) [manual] Configuración → Proveedores shows one card per provider: Anthropic (Claude), xAI (Grok) · texto e imágenes, DeepSeek · solo texto, Vercel AI Gateway · solo texto, Meta (Muse) · texto, imágenes y transcripción, OpenAI · solo imágenes; each with a badge "Key guardada", "Usa <VARIABLE>" or "Sin configurar". Check by opening the tab with and without a key / variable.
- **AC-1.2** (US-1) [manual] Typing a key and pressing "Guardar" stores it and clears the field; "Borrar" (shown only when a key is stored) removes it; the field never shows the stored key (placeholder "•••••••• (escribí una nueva para reemplazarla)"). Check by saving and reopening.
- **AC-1.3** (US-1) [manual] "Probar conexión" lists the provider's models: success shows "Conectado · N modelos disponibles", failure shows the error text in red; the button reads "Probando…" meanwhile. Check with a valid key and with a wrong one.
- **AC-1.4** (US-1) [manual] The xAI card has a "URL base" field with "Guardar URL" (enabled only when changed); a blank value restores `https://api.x.ai/v1`. The other providers have no URL field. Check by editing and saving.
- **AC-1.5** (US-1) [manual] The Vercel card shows the hint to create a key with `npx vercel@latest ai-gateway setup`. Check by opening the card.
- **AC-2.1** (US-2) Given no key is stored for Anthropic and `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE` or a `~/.config/anthropic` folder exists, when the provider is created, then it uses that credential; given none of them, it fails with "Falta la API key de Anthropic. Cargala en Configuración → Proveedores o definí ANTHROPIC_API_KEY." [gap]
- **AC-2.2** (US-2) Given no key is stored for xAI / DeepSeek / Vercel / Meta and `XAI_API_KEY` / `DEEPSEEK_API_KEY` / `AI_GATEWAY_API_KEY` / `META_API_KEY` is set, when the provider is created, then it uses the variable; given neither, it fails with "Falta la API key de <proveedor>. Cargala en Configuración → Proveedores o definí <VARIABLE>." [gap]
- **AC-2.3** (US-2) Given a stored key and an environment variable, when the provider is created, then the stored key wins. [gap]
- **AC-2.4** (US-1) Given the key or the base URL changes in settings, when the next request asks for the provider, then a new client is built; with unchanged credentials the same client is reused. [gap]

### Provider interface and choice (US-3, US-7)
- **AC-3.1** (US-3) Given an agent profile with provider P, when it runs, then the loop uses the client for P with the profile's model. [gap] (the agent tests replace provider selection with a scripted fake `Provider`, so the choice itself is untested)
- **AC-3.10** (US-7) Given any object implementing `Provider`, when the agent loop runs against it, then text, tool calls and stop reasons drive the loop with no vendor-specific code in the loop. Test: tests/agent.test.ts › "asks for approval, runs the tool and feeds the result back"
- **AC-3.2** (US-3) Given the `models.list` request for a provider, when it is handled, then the provider's model ids are returned sorted alphabetically; a missing key or an API error reaches the window as an error. [gap]
- **AC-3.3** (US-3) [manual] The agent editor's model field suggests the provider's models (Claude's built-in list for Anthropic until the refresh button is pressed) and accepts any text. Check in Agentes.
- **AC-3.4** (US-3) Given a conversation that switches agent (and so provider) between turns, when the history is converted, then each client sends only what it understands: Anthropic replays its own raw content unchanged and drops other vendors' thinking; the OpenAI-compatible client sends plain text, tool calls and tool results. Test: tests/providers.test.ts › "drops foreign thinking and keeps tool blocks"; tests/providers.test.ts › "maps tool calls and results to the OpenAI chat format"
- **AC-3.5** (US-3) Given an assistant message produced by Anthropic with its raw content, when the history is replayed to Anthropic, then the raw blocks (with thinking signatures) are sent unchanged. Test: tests/providers.test.ts › "replays Claude content unchanged, including thinking signatures"
- **AC-3.6** (US-7) Given a history with a tool call and an error result, when converted for an OpenAI-compatible API, then the assistant message carries `tool_calls`, the result becomes a `tool` message prefixed `ERROR: `, and a system message leads. Test: tests/providers.test.ts › "maps tool calls and results to the OpenAI chat format"
- **AC-3.7** (US-3) Given a user message with images, when converted for an OpenAI-compatible API, then the text and the images go out as one user message with `image_url` data URLs, after any tool results; Anthropic gets `image` base64 blocks. [gap]
- **AC-3.8** (US-3) Given an assistant message that has neither text nor tool calls, when converted for an OpenAI-compatible API, then it is omitted. [gap]

### Anthropic turn (US-3, US-5)
- **AC-4.1** (US-3) Given a Claude model of the 4.6+ or 5.x families, when a turn is requested, then adaptive thinking with summarized display and the agent's effort are sent; given any other Claude model, neither is sent. [gap]
- **AC-4.2** (US-3) Given any Claude turn, when it is requested, then it streams, asks for automatic prompt caching, sets `max_tokens` to 64 000, sends tools with eager input streaming, and forwards text, thinking and tool-start events as they arrive. [gap]
- **AC-4.3** (US-3) Given the model is one of `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5`, when a turn is requested, then the server-side refusal fallback beta (`server-side-fallback-2026-07-01`) is enabled in its default form. [gap]
- **AC-4.4** (US-5) Given Anthropic answers 401, when the turn fails, then it fails with "Anthropic rechazó la API key. Revisala en Configuración → Proveedores." [gap]
- **AC-4.5** (US-5) Given an API error other than authentication (rate limit, overload, bad request), when the turn fails, then the error is raised to the run without extra retries by Alma (the SDK applies its own). [gap]
- **AC-4.6** (US-5) Given the stream fails with a non-API error (for example a tool input that is not valid JSON), when the turn is attempted, then it is re-issued up to two more times (three attempts in all) unless the run was aborted; after the third failure the error is raised. [gap]
- **AC-4.7** (US-3) Given a response, when mapped, then `end_turn` and `stop_sequence` become `end_turn`, `tool_use`, `max_tokens` and `refusal` keep their name and anything else is `other`; a refusal carries the API's explanation or category as detail. [gap]
- **AC-4.8** (US-3) Given a response with thinking, text and tool-use blocks, when mapped, then Alma keeps the summarized thinking (if non-empty), text and tool calls as blocks, and the full content as `raw` for replay. [gap]

### OpenAI-compatible turn (US-3, US-5, US-6)
- **AC-5.1** (US-3) Given a DeepSeek agent that had thinking in an earlier turn, when the history is converted, then that provider's thinking is sent back as `reasoning_content` on the assistant message, and another provider's thinking is never sent. Test: tests/providers.test.ts › "replays DeepSeek"
- **AC-5.2** (US-3) Given a DeepSeek turn, when requested, then the agent's effort is sent as `reasoning_effort`; for xAI, Vercel and Meta no effort is sent. [gap]
- **AC-5.3** (US-3) Given a streamed response, when assembled, then `reasoning_content` deltas become a `thinking` block, content deltas the text, and tool-call fragments are joined by index into tool calls, announced to the UI as soon as id and name are known. [gap]
- **AC-5.4** (US-5) Given a tool call whose arguments are not valid JSON, when assembled, then its input is `{ "__invalid_json": <raw text> }` so the loop reports an invalid-input error to the model instead of failing the turn. [gap]
- **AC-5.5** (US-3) Given a tool call without an id, when assembled, then it gets `call_<uuid>`. [gap]
- **AC-5.6** (US-3) Given a finish reason, when mapped, then `tool_calls` (or `stop` with tool calls) is `tool_use`, `stop` is `end_turn`, `length` is `max_tokens`, `content_filter` is `refusal` with detail "<proveedor> filtró la respuesta.", and anything else is `other` (or `tool_use` if there are tool calls). [gap]
- **AC-5.7** (US-5) Given the API answers 401, when the turn fails, then it fails with "<proveedor> rechazó la API key. Revisala en Configuración → Proveedores." [gap]
- **AC-5.8** (US-5) Given an error body in xAI's shape (`{ code, message }`) instead of OpenAI's `{ error: { message } }`, when the turn fails, then the person sees the status and the reason, e.g. "400 Model grok-x only supports the Responses API (Client specified an invalid argument)", not "no body". Test: tests/providers.test.ts › "reports the reason xAI gives"
- **AC-5.9** (US-5) Given error bodies shaped `{error:{message}}`, `{code, error}`, `{detail}`, `{code}` or plain text, when a message is extracted, then the best text is returned, with the code appended in parentheses when the text does not already contain it. Test: tests/providers.test.ts › "finds the message in the common error shapes"
- **AC-5.10** (US-5) Given a network failure or timeout reaching an OpenAI-compatible provider, when the turn fails, then the error is raised to the run (the OpenAI SDK's own retry policy applies; Alma adds none). [gap]
- **AC-5.11** (US-3) Given a turn with no tools, when requested on an OpenAI-compatible API, then no `tools` field is sent. [gap]

### Default models (US-4)
- **AC-6.1** (US-4) Given an xAI agent with an empty model, when it first runs, then the provider lists the account's models and picks the highest-numbered `grok-N[.M]` chat model, preferring the plain id among variants, ignoring image, vision, video, embedding, voice, realtime and multi-agent models. Test: tests/providers.test.ts › "picks the newest general Grok model"
- **AC-6.2** (US-4) Given a DeepSeek agent with an empty model, when it first runs, then `deepseek-v4-pro` is used if listed, else the first listed model. [gap]
- **AC-6.3** (US-4) Given a Vercel AI Gateway agent with an empty model, when it first runs, then the first id starting with `anthropic/claude-sonnet` is used, else the first listed model. [gap]
- **AC-6.4** (US-4) Given a Meta agent with an empty model, when it first runs, then `muse-spark-1.3` is used if listed, else the first id starting with `muse-spark`. [gap]
- **AC-6.5** (US-4) Given the account lists no suitable model, when the default is resolved, then the run fails with "No se encontró un modelo disponible en tu cuenta de <proveedor>." [gap]
- **AC-6.6** (US-4) Given a default was resolved, when the same provider client is used again, then it is not looked up again (cached for the life of that client). [gap]
- **AC-6.7** (US-4) Given an Anthropic agent with an empty model, when it runs, then the empty model is sent as is (Anthropic has no automatic default; new agents start on the first Claude model). [gap]

### Review verdicts (US-8)
- **AC-7.1** (US-8) Given the Anthropic reviewer, when a review is requested, then the model is asked for a structured `{verdict: allow|flag, reason}` (low effort on adaptive-thinking models, `max_tokens` 4096) and the parsed verdict is returned. [gap]
- **AC-7.2** (US-8) Given the Anthropic reviewer refuses or returns nothing parseable, when the verdict is read, then the verdict is `flag` with "El revisor no pudo evaluar esta acción." [gap]
- **AC-7.3** (US-8) Given an OpenAI-compatible reviewer, when asked, then xAI gets a strict JSON-schema response format, DeepSeek gets plain JSON mode with the shape spelled out in the system prompt, and Vercel and Meta get no response format, only the spelled-out shape. [gap]
- **AC-7.4** (US-8) Given an OpenAI-compatible reviewer answers text that is not a valid verdict (even with prose around the JSON), when parsed, then the JSON between the first `{` and last `}` is used if valid; otherwise the verdict is `flag` with "El revisor no devolvió un veredicto válido." [gap]
- **AC-7.5** (US-8) Given the review call throws (no key, network), when the approval policy asks, then the error propagates to the policy, which asks the person ("Auto-review no disponible: …"). [gap]
- **AC-7.6** (US-8) Given auto-review is on, when a verdict arrives, then `allow` runs the tool with note "Auto-review: <razón>" and `flag` asks the person with the reason. Test: tests/agent.test.ts › "auto-review runs safe actions and asks about flagged ones"

### Usage (US-3)
- **AC-8.1** (US-3) Given an Anthropic response, when usage is mapped, then `inputTokens` is input plus cache-creation plus cache-read tokens, `outputTokens` the output tokens and `cacheReadTokens` the cache-read tokens. [gap]
- **AC-8.2** (US-3) Given an OpenAI-compatible stream, when its final chunk carries usage, then `inputTokens` is prompt tokens, `outputTokens` completion tokens, and `cacheReadTokens` the cached tokens (`prompt_tokens_details.cached_tokens`, or DeepSeek's `prompt_cache_hit_tokens`, else 0); a stream without usage yields no usage. [gap]

### Vision (US-3)
- **AC-9.1** (US-3) Given vision is set to a provider and model in the house settings, when an image is looked at, then that model is used; otherwise the model of the house agent, else the default agent, else any agent whose provider has a key (settings or its environment variable), else the first agent. [gap]
- **AC-9.2** (US-3) Given a picture question, when asked, then it is a single low-effort turn with no tools and a fixed English system prompt, and the answer text (or the streamed text if the final has none) and usage are returned. [gap]

## 6. Business rules
- **BR-1** Provider ids: `anthropic`, `xai`, `deepseek`, `vercel`, `meta` (model providers); `openai`, `telegram`, `elevenlabs`, `email` are only key slots for other features. Display names: Claude, Grok, DeepSeek, Vercel AI Gateway, Meta (Muse). (src/shared/types.ts, src/shared/defaults.ts)
- **BR-2** Base URLs: xAI `https://api.x.ai/v1` (editable in settings), DeepSeek `https://api.deepseek.com`, Vercel `https://ai-gateway.vercel.sh/v1`, Meta `https://api.meta.ai/v1` (fixed). OpenAI (`https://api.openai.com/v1`) is used for images only. (src/shared/defaults.ts)
- **BR-3** Key resolution for model providers: the key stored in settings first; if empty, the environment: `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`, or a `~/.config/anthropic` folder, which the SDK resolves itself), `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `AI_GATEWAY_API_KEY`, `META_API_KEY`. The environment is read when a client is created. (src/coordinator/providers/)
- **BR-4** One client per provider is kept while its credentials (key, and base URL for xAI) do not change; a change discards the old client of that provider. (src/coordinator/providers/index.ts)
- **BR-5** Anthropic turn parameters: `max_tokens` 64 000; streaming; one text system block; tools with eager input streaming; automatic ephemeral prompt caching; adaptive thinking (`display: summarized`) with `output_config.effort` for model ids matching `claude-(opus|sonnet|haiku|fable|mythos)-(5|4-6…4-9)`; refusal-fallback beta for five model ids (AC-4.3). Anthropic requests go through the SDK's beta messages API. (src/coordinator/providers/anthropic.ts)
- **BR-6** Anthropic retry: a failed stream that is not an API error, not an abort and not the third attempt is re-issued from scratch; API errors are never retried by Alma. (src/coordinator/providers/anthropic.ts)
- **BR-7** Provider-neutral turn: content blocks (`text`, `thinking`, `tool_use`), `stopReason` (`end_turn`, `tool_use`, `max_tokens`, `refusal`, `other`), optional `stopDetail`, optional `usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`), the model id the API reported (Anthropic) or requested (others), and provider-native `raw` for replay (Anthropic only). (src/coordinator/providers/types.ts)
- **BR-8** Assistant messages are stamped with the profile's provider and the response's model; reasoning replay and `raw` replay apply only to messages whose provider matches the target. (src/coordinator/agent.ts, providers)
- **BR-9** OpenAI-compatible requests stream with usage included; tool calls are sent as functions with the tool's JSON Schema; DeepSeek gets `reasoning_effort` equal to the agent's effort (`low`…`max`). (src/coordinator/providers/xai.ts)
- **BR-10** Error results from tools reach OpenAI-compatible APIs as `ERROR: <text>` tool messages; Anthropic gets `is_error`. (providers)
- **BR-11** Provider errors surface as plain `Error`s with the API's message, except configuration errors (`ProviderConfigError`: missing key, rejected key, no available model), whose text names Configuración → Proveedores and is shown in the app language (spec 025 AC-3.2). A failed run shows the error text on the conversation. (src/coordinator/providers/types.ts, src/coordinator/index.ts)
- **BR-12** Review calls use the provider and model of `settings.autoReview` (default Anthropic, `claude-opus-5-5`), or the boss agent's own provider and model for a company boss review. On any unparseable output the verdict is `flag` (fail safe). (src/coordinator/approval.ts, providers)
- **BR-13** Default-model heuristics (empty model): Grok newest `grok-N[.M]` chat model; DeepSeek `deepseek-v4-pro`; Vercel first `anthropic/claude-sonnet*`; Meta `muse-spark-1.3` then first `muse-spark*`. Anthropic: none (empty is sent as is); `DEFAULT_CLAUDE_MODEL` is `claude-opus-5-5` and `CLAUDE_MODELS` lists `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`, `claude-opus-5`. (src/shared/defaults.ts, providers)
- **BR-14** API keys are trimmed on save; `settings.update` never changes keys; only `setApiKey` does, and each set/clear is written to the audit trail without the value. (src/main/settings.ts, src/main/index.ts)
- **BR-15** What the renderer learns about a key is only `hasKey` and `fromEnv` (the latter true only for the main key variable: `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `AI_GATEWAY_API_KEY`, `META_API_KEY`). (src/main/settings.ts)
- **BR-16** Token usage is attached to each assistant message and sent to the run's usage callback; company runs convert it to money with a per-provider price table (USD per million tokens) for budgets. No token or cost figure is shown outside companies. (src/coordinator/agent.ts, src/shared/company.ts)
- **BR-17** Vision never keeps images in an agent's conversation: a one-shot question to the model chosen as in AC-9.1. (src/coordinator/vision.ts)
- **BR-18** Company meeting turns and summaries use the same clients through a tool-less low-effort turn. (src/coordinator/index.ts)

## 7. Constraints and risks
- **Layers touched:** `coordinator` (`providers/anthropic.ts`, `providers/xai.ts`, `providers/index.ts`, `providers/types.ts`, `vision.ts`, `approval.ts`, `index.ts` `models.list`), `main` (`settings.ts` keys), `shared` (`types.ts`, `defaults.ts`, `company.ts` prices), `renderer` (`SettingsDialog.tsx` provider cards and agent editor).
- **Security / privacy:** everything an agent reads in a turn (instructions, history, tool results, images, vault fragments) is sent to the agent's provider; the person's text goes to the reviewer's provider too during auto-review (action and request, truncated to 4 000 / 8 000 characters). Keys are stored sealed by the OS (spec 006) and live in the coordinator's memory in clear; they are never sent to the window. The xAI base URL is free text, so the xAI key is sent to whatever host the person types there. New third parties: Meta (`api.meta.ai`) and the Vercel gateway.
- **Messages:** `models.list` (window → coordinator) returns sorted ids; provider errors travel as the request error or as `run.finished.error`.
- **Platform:** the Anthropic SDK reads `~/.config/anthropic` (a home folder path on Windows) and environment variables of the coordinator process.
