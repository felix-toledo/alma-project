# Providers

> How Alma talks to language models: five providers (Anthropic, xAI, DeepSeek, Vercel AI Gateway, Meta) behind one `Provider` interface, with key handling, default-model choice, readable errors and the reviewer/vision calls that reuse the same clients. Spec: [005 Providers](../../.specify/specs/005-providers/spec.md). Test status: 54 criteria, 9 with a test, 39 without a test (`[gap]`), 6 checked by hand (`[manual]`).

## What it does

- Every agent profile names one provider and one model; the coordinator builds a client for that provider and returns text, thinking, tool calls and token usage in one provider-neutral shape. Agents, approvals and companies behave the same whatever model runs underneath.
- The person stores one API key per provider (or uses an environment variable), tests the connection, and sees the provider's model list.
- An empty model means "the newest suitable one" for xAI, DeepSeek, Vercel and Meta. Anthropic has no automatic default.
- A missing or rejected key is reported in plain Spanish, with where to fix it.
- A conversation can switch agent (and so vendor) between turns without breaking.
- The same clients answer the auto-review and boss-review questions ([approvals](approvals.md)), vision questions, and company meeting turns.

## How to use it

«Configuración → Proveedores» shows one card per provider, each with a badge: «Key guardada» (key saved), «Usa <VARIABLE>» (uses the environment variable) or «Sin configurar» (not set up).

| Card | Used for |
|---|---|
| Anthropic (Claude) | text |
| xAI (Grok) | text and images |
| DeepSeek | text only |
| Vercel AI Gateway | text only |
| Meta (Muse) | text, images and transcription |
| OpenAI | images only (key slot, see [images](images.md)) |

1. Type the key and press **Guardar**. The field clears and never shows the stored key (placeholder «•••••••• (escribí una nueva para reemplazarla)», "type a new one to replace it"). **Borrar** (delete) appears only when a key is stored.
2. «Probar conexión» (test connection) lists the provider's models: "Conectado · N modelos disponibles" on success, the error in red on failure.
3. xAI only: a "URL base" field with **Guardar URL**; blank restores `https://api.x.ai/v1`.
4. Vercel only: the card hints to create a key with `npx vercel@latest ai-gateway setup`.
5. In «Configuración → Agentes» pick the provider and model per agent. The model field suggests the provider's models (Claude's built-in list for Anthropic until you press refresh) and accepts any text. Leave it empty for the automatic choice (not for Anthropic).
6. Alternatively set an environment variable before starting Alma: `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `AI_GATEWAY_API_KEY` or `META_API_KEY`.

## How it works

Files: `src/coordinator/providers/{types,index,anthropic,xai}.ts`, `src/coordinator/vision.ts`, `src/coordinator/approval.ts`, `models.list` in `src/coordinator/index.ts`, `src/main/settings.ts` (keys), `src/shared/{types,defaults,company}.ts`, renderer `SettingsDialog.tsx`.

```
agent.ts / approval.ts / vision.ts / company meetings
        │  getProvider(id, settings)   (providers/index.ts: one cached client per provider)
        ▼
   Provider { streamTurn(), review(), listModels() }
        ├── AnthropicProvider   (official SDK, beta messages API)
        └── XaiProvider(flavor) (OpenAI SDK; flavors: xai, deepseek, vercel, meta)
```

- **Selection and cache** (`getProvider`): the cache key is `anthropic|<key>`, `xai|<key>|<baseUrl>`, `deepseek|<key>`, etc. A change in credentials builds a new client and drops the old one for that provider. The environment is read when a client is created.
- **Key resolution**: the key stored in settings wins; if empty, the environment. Anthropic accepts `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`, or a `~/.config/anthropic` folder (the SDK resolves it). With none: `ProviderConfigError` «Falta la API key de Anthropic. Cargala en Configuración → Proveedores o definí ANTHROPIC_API_KEY.» The other providers throw the same message with their name and variable.
- **Anthropic turn** (`anthropic.ts`): streaming; `max_tokens` 64 000; one text system block; tools with eager input streaming; automatic ephemeral prompt caching; for model ids matching `claude-(opus|sonnet|haiku|fable|mythos)-(5|4-6…4-9)`, adaptive thinking (`display: summarized`) with `output_config.effort`; for `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5`, the beta `server-side-fallback-2026-07-01` (refusal fallback) in its default form. Assistant messages from Claude are replayed with their raw content, so thinking signatures stay intact; another vendor's thinking is dropped.
- **Anthropic errors**: a 401 becomes «Anthropic rechazó la API key. Revisala en Configuración → Proveedores.»; other API errors go up as they are (the SDK has its own retries). A non-API failure (e.g. a tool input that is not valid JSON under eager streaming) re-issues the turn, three attempts in all, unless aborted.
- **OpenAI-compatible turn** (`xai.ts`, class `XaiProvider`): `stream: true` with usage included; tools sent as functions with the JSON Schema; no `tools` field when there are none. Tool results become `tool` messages (errors prefixed `ERROR: `). Images go as `image_url` data URLs in one user message after the tool results. Assistant messages with neither text nor tool calls are omitted. `reasoning_content` deltas become a `thinking` block. Tool-call fragments are joined by index; the tool is announced to the UI as soon as id and name are known; a missing id becomes `call_<uuid>`; arguments that are not valid JSON become `{ __invalid_json: <raw> }` so the loop returns an invalid-input error to the model.
- **DeepSeek specifics**: its own thinking is replayed as `reasoning_content` (its thinking mode with tools rejects later requests otherwise); the agent's effort is sent as `reasoning_effort`. For xAI, Vercel and Meta no effort is sent.
- **Readable errors**: `readableErrorsFetch` rewraps non-OK bodies so xAI's `{ code, message }` shape reaches the person as e.g. "400 Model grok-x only supports the Responses API (...)" instead of "no body" (`errorMessageOf` understands `{error:{message}}`, `{code,error}`, `{detail}`, `{code}` and plain text). A 401 becomes «<provider> rechazó la API key. Revisala en Configuración → Proveedores.»
- **Default model** (empty model, OpenAI-compatible flavors; looked up once per client and cached):

| Provider | Choice |
|---|---|
| xAI | highest-numbered `grok-N[.M]` chat model, plain id preferred among variants; ignores image, imagine, vision, video, embed, voice, tts, stt, realtime and multi-agent models |
| DeepSeek | `deepseek-v4-pro` if listed, else the first listed |
| Vercel | first id starting with `anthropic/claude-sonnet`, else the first listed |
| Meta | `muse-spark-1.3` if listed, else the first id starting with `muse-spark` |

  If nothing suits: «No se encontró un modelo disponible en tu cuenta de <proveedor>.»
- **Stop reasons**: Anthropic `end_turn`/`stop_sequence` → `end_turn`; `tool_use`, `max_tokens`, `refusal` keep their name; the rest `other` (a refusal carries the API's explanation or category). OpenAI finish reasons: `tool_calls` (or `stop` with tool calls) → `tool_use`; `stop` → `end_turn`; `length` → `max_tokens`; `content_filter` → `refusal` with detail «<proveedor> filtró la respuesta.»
- **Usage**: Anthropic `inputTokens` = input + cache-creation + cache-read, `cacheReadTokens` = cache-read. OpenAI-compatible: prompt/completion tokens and `cached_tokens` (or DeepSeek's `prompt_cache_hit_tokens`, else 0). No usage in the stream means no usage.
- **Review calls** (`review`): Anthropic asks for a structured `{verdict, reason}` (low effort on adaptive models, `max_tokens` 4096). xAI uses a strict JSON schema response format; DeepSeek uses plain JSON mode with the shape spelled out; Vercel and Meta only the spelled-out shape. The JSON between the first `{` and last `}` is parsed; anything invalid is `flag` («El revisor no devolvió un veredicto válido.»; Anthropic refusal: «El revisor no pudo evaluar esta acción.»). Call errors propagate to the approval policy.
- **Vision** (`vision.ts`): one low-effort turn, no tools, fixed Spanish system prompt. Model: the one chosen in «Configuración → Imágenes» (spec 038; a provider with a typed model, or a provider only once the person confirmed it, which makes Alma use the newest model of that provider its capability rule accepts); else the house agent's, else the default agent's, else any agent whose provider has a key, else the first agent. "Has a key" means a stored key or the main environment variable. Details and the capability table: [images](images.md).
- **Prices**: `PRICES` in `shared/company.ts` (USD per million tokens, one price per provider) turn usage into estimated money for company budgets only. A code comment says per-model prices are an upgrade if budgets must be exact; Vercel's price is a "Sonnet-class guess".

## Tools for agents

None. Providers are not exposed as tools. The only related request is `models.list` (window → coordinator), which returns the provider's model ids sorted alphabetically.

## Settings and data

| Setting | Default | Notes |
|---|---|---|
| `providers.<id>.apiKey` | empty | `anthropic`, `xai`, `deepseek`, `vercel`, `meta`; `openai`, `telegram`, `elevenlabs`, `email` are key slots for other features. Stored sealed by the OS (`safeStorage`) in `settings.json`; trimmed on save |
| `providers.xai.baseUrl` | `https://api.x.ai/v1` | the only editable URL |
| `autoReview` | Anthropic, `claude-opus-5-5` | reviewer provider/model/instructions |
| agent `provider`, `model`, `effort` | per profile | [agents](agents.md) |

Fixed base URLs: DeepSeek `https://api.deepseek.com`, Vercel `https://ai-gateway.vercel.sh/v1`, Meta `https://api.meta.ai/v1`; OpenAI `https://api.openai.com/v1` (images only). Display names: Claude, Grok, DeepSeek, Vercel AI Gateway, Meta (Muse). Claude suggestions (`CLAUDE_MODELS`): `claude-opus-5-5` (default, `DEFAULT_CLAUDE_MODEL`), `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`, `claude-opus-5`.

Only `setApiKey` changes keys (`settings.update` never does); each set/clear is audited without the value. The window learns only `hasKey` and `fromEnv` (true only for the main variable of each provider). No other data is written by this module. See [settings](settings.md) and [references/settings.md](../references/settings.md).

## Limits and rules

| Rule | Value |
|---|---|
| Anthropic `max_tokens` per turn | 64 000 |
| Anthropic extra attempts on non-API stream failure | 2 (3 in all) |
| Reviewer `max_tokens` (Anthropic) | 4096 |
| Provider request timeout | none of Alma's own; the run's abort signal and the SDK defaults apply |
| Retries on OpenAI-compatible providers | none by Alma (SDK policy only) |
| Default-model lookup | once per client, cached (including a failure, see below) |

## Security and privacy

- Everything an agent reads in a turn (instructions, history, tool results, images, vault fragments, memories) is sent to that agent's provider. During auto-review the action and the person's request (cut to 8000 / 4000 chars) go to the reviewer's provider too.
- Third parties: Anthropic, xAI, DeepSeek, Vercel (gateway), Meta (`api.meta.ai`).
- Keys are never sent to the window; they live in the coordinator's memory in clear. The xAI base URL is free text, so the xAI key is sent to whatever host is typed there, with no confirmation.
- Error text from the provider is shown to the person as is (it may include the provider's reason).

## How it is tested

- With a test (`tests/providers.test.ts`): OpenAI message mapping with tool calls and errors; DeepSeek reasoning replay; newest-Grok choice; dropping foreign thinking and keeping tool blocks; replaying Claude content with signatures; xAI error reasons and the error-shape extractor. `tests/agent.test.ts` drives the loop with a scripted fake `Provider` (also the auto-review verdict flow), which is why the provider choice itself is untested.
- Not covered: key resolution and client caching, Anthropic request parameters and retry, stop-reason and usage mapping, DeepSeek/Vercel/Meta default models, review request shapes and parsing, `models.list`. The vision model choice has tests since spec 038 (`tests/images-vision-*.test.ts`, see [images](images.md)).
- By hand: the provider cards (save, delete, test connection with a good and a wrong key, xAI URL, Vercel hint) and the model field suggestions.

## Known limits

1. `XaiProvider.resolveModel` caches the promise including a rejection: if listing models fails once (offline, bad key), every later request through that client fails the same way until key or URL changes. Probable bug.
2. Anthropic retries a failed stream up to twice, but text and thinking already forwarded to the window are not retracted, so a retry can duplicate streamed text.
3. The xAI "URL base" accepts any text and sends the key there without confirmation; it is also the only way to reach another OpenAI-compatible endpoint, under the name "Grok".
4. `fromEnv` and vision's key check look only at the main variable, so someone using `ANTHROPIC_AUTH_TOKEN` or an `ant auth login` profile works but sees «Sin configurar» and may be skipped by vision.
5. Invalid tool JSON becomes `{__invalid_json}`, which MCP tools (not schema-validated) would receive as input.
6. Cache-creation tokens are priced as normal input and Vercel's price is a guess, so company budgets are approximate.
7. Card labels say DeepSeek and Vercel are "solo texto", yet the code comment says `deepseek-flash` takes images and images are sent for every flavor. Which is true for vision? Answered for the automatic pick by spec 038 BR-13: DeepSeek and Vercel have no known seeing model, so Alma never picks one for them (the person types a model, and a typed model is sent as is); the claim that a given DeepSeek model takes images stays unverified against the real service.
8. No provider timeout beyond the abort signal.


## See also

[agents](agents.md) · [approvals](approvals.md) · [chat](chat.md) · [settings](settings.md) · [companies](companies.md) · [images](images.md) · [voice](voice.md) · [home](home.md) · [security](security.md) · [references/settings.md](../references/settings.md) · [references/limits.md](../references/limits.md)
