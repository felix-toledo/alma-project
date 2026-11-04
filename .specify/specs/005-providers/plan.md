# 005 — Plan

## 1. Approach
One provider-neutral interface (`Provider`: `streamTurn`, `review`, `listModels`) with two implementations: `AnthropicProvider` on the official SDK, and `XaiProvider` on the OpenAI SDK, parameterised by a small `Flavor` (xAI, DeepSeek, Vercel AI Gateway, Meta) that carries the base URL, env variable, effort and review quirks and the default-model rule. `getProvider` builds one client per provider and rebuilds it only when its credentials change. The agent loop, the auto-review and the vision question only ever see `Provider`, `TurnRequest` and `TurnResult`.

Rejected: one OpenAI-compatible client for everything, Claude included. Claude needs thinking signatures replayed unchanged, prompt caching, eager tool-input streaming and the refusal-fallback beta, none of which exist in the OpenAI shape. The coordinator-as-utility-process decision ([ADR 0001](../../../docs/adr/0001-coordinator-as-utility-process.md)) is why clients live there and keys reach them in memory; key storage is [ADR 0013](../../../docs/adr/0013-secrets-with-safestorage.md).

## 2. Layers touched
| Layer | Files | Why it lives there |
|---|---|---|
| shared | `src/shared/types.ts` (`ProviderId`, `Usage`, `ChatMessage`, `Block`, `Effort`, `models.list` request), `src/shared/defaults.ts` (base URLs, `PROVIDER_NAMES`, `CLAUDE_MODELS`, `DEFAULT_CLAUDE_MODEL`), `src/shared/company.ts` (`PRICES`, `costOf`) | names, URLs and prices are read by main, coordinator and renderer |
| coordinator | `src/coordinator/providers/types.ts`, `providers/anthropic.ts`, `providers/xai.ts`, `providers/index.ts`, `src/coordinator/vision.ts`, `src/coordinator/approval.ts` (review call), `src/coordinator/index.ts` (`models.list`) | network, SDKs and per-run state; the only layer that talks to vendors |
| main | `src/main/settings.ts` (key slots, `hasKey` / `fromEnv`), `src/main/index.ts` (`settings:setApiKey`) | keys are sealed and audited in main; the window never gets them |
| renderer | `src/renderer/src/components/SettingsDialog.tsx` (Proveedores tab, agent editor provider/model fields) | cards, "Probar conexión" through `models.list` |

No new arrow: coordinator imports shared only; the renderer reaches providers through the `window.desktop` request bridge.

## 3. Contracts
```ts
interface TurnRequest { model; effort: Effort; system; tools: ToolSpec[]; messages: ChatMessage[]; signal; onText(d); onThinking(d); onToolStart(id, name) }
interface TurnResult { content: Block[]; raw?: unknown; stopReason: 'end_turn'|'tool_use'|'max_tokens'|'refusal'|'other'; stopDetail?; usage?: Usage; model }
interface Provider { id: ProviderId; streamTurn(r: TurnRequest): Promise<TurnResult>; review(r): Promise<ReviewVerdict>; listModels(): Promise<string[]> }
class ProviderConfigError extends Error {}            // missing / rejected key, no model: Spanish text naming Configuración → Proveedores
getProvider(id: ProviderId, settings: Settings): Provider
toAnthropicMessages(messages): BetaMessageParam[]
toOpenAiMessages(system, messages, replayReasoning?: ProviderId): ChatParam[]
pickDefaultGrokModel(ids: string[]): string | undefined
errorMessageOf(body: string): string
visionModel(settings): { provider; model };  look(settings, pictures, question, signal)
```
IPC: request `{ method: 'models.list'; provider: ProviderId }` returns sorted ids. Window to main: `settings:setApiKey(provider, apiKey)`. No new tool is added, so no new `ToolRisk`.

## 4. Data and persistence
Nothing new on disk. Keys sit in `settings.json` sealed (`enc:`; spec 006); `providers.xai.baseUrl` is the only provider field the window may edit. The client cache is in memory, keyed by `provider|key[|baseUrl]`. Assistant messages in a thread are stamped with `provider` and `model`; `raw` (Claude content with signatures) is stored in the message and replayed only to Anthropic.

## 5. Dependency injection
The loop receives `getSettings()` and obtains clients through `getProvider`; tests replace provider selection with a scripted `Provider` fake (`tests/agent.test.ts`). `XaiProvider` takes `(apiKey, baseUrl, flavor)`, so `tests/providers.test.ts` points it at a local `http` server instead of a vendor. Conversion functions and `pickDefaultGrokModel` / `errorMessageOf` are pure and exported for direct tests. Environment variables are read through `process.env` at client creation.

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.1–1.5 | [manual] open Configuración → Proveedores with and without a key / variable, save, delete, test connection, edit the xAI URL | wrong key, blank URL |
| AC-2.1–2.4 | [gap] | env only, stored plus env, key change rebuilds the client |
| AC-3.1, 3.2, 3.7, 3.8 | [gap] | empty assistant message, images after tool results |
| AC-3.3 | [manual] agent editor model field | free text |
| AC-3.4 | `tests/providers.test.ts` → `drops foreign thinking and keeps tool blocks`; `maps tool calls and results to the OpenAI chat format` | history from another vendor |
| AC-3.5 | `tests/providers.test.ts` → `replays Claude content unchanged, including thinking signatures` | signatures untouched |
| AC-3.6 | `tests/providers.test.ts` → `maps tool calls and results to the OpenAI chat format` | error result |
| AC-3.10 | `tests/agent.test.ts` → `asks for approval, runs the tool and feeds the result back` | scripted fake provider |
| AC-4.1–4.8 | [gap] | 401, non-API stream error, abort during retry, refusal |
| AC-5.1 | `tests/providers.test.ts` → `replays DeepSeek` | other vendor's thinking never sent |
| AC-5.2–5.7, 5.10, 5.11 | [gap] | invalid JSON arguments, tool call without id, `content_filter` |
| AC-5.8 | `tests/providers.test.ts` → `reports the reason xAI gives` | `{ code, message }` body |
| AC-5.9 | `tests/providers.test.ts` → `finds the message in the common error shapes` | five body shapes, plain text |
| AC-6.1 | `tests/providers.test.ts` → `picks the newest general Grok model` | multi-agent, image, voice ids |
| AC-6.2–6.7 | [gap] | empty list, cached lookup |
| AC-7.1–7.5 | [gap] | refusal, prose around JSON, throwing reviewer |
| AC-7.6 | `tests/agent.test.ts` → `auto-review runs safe actions and asks about flagged ones` | flagged action |
| AC-8.1, 8.2, 9.1, 9.2 | [gap] | stream without usage, no agent with a key |

## 7. Security and privacy impact
No tool is added. Everything an agent reads in a turn goes to its provider; during auto-review the action and request (truncated to 4 000 / 8 000 characters) go to the reviewer's provider. Keys live in coordinator memory in clear and are never sent to the window; errors name the provider, never the key. The xAI base URL is free text, so that key is sent wherever the person points it. New third parties: Meta (`api.meta.ai`) and the Vercel gateway. `docs/security/PRIVACY.md` already lists provider data flows; no new file is affected.

## 8. Rollout
No flag. A new profile starts on the first Claude model; Grok, DeepSeek, Vercel and Meta agents ship with an empty model, so the provider picks the newest suitable one on first run. A missing key fails the run with a Spanish message pointing at Configuración → Proveedores; the review model defaults to Anthropic `claude-opus-5-5`.
