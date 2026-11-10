# 038 — Plan

<!-- Spec 038 is `ready`. Contracts and signatures only; no logic. Read with spec.md (AC-x.y and BR-n below are the spec's). -->

## 1. Approach
Move the "model that sees" out of Casa into a new `settings.images.vision { provider, model }`, and put every decision about it in pure `shared` functions: the capability table (BR-13), the classification and pick (BR-4, BR-5), the acknowledgement gate (BR-14) and the one-time migration from `home.vision*`. The coordinator only lists models, caches the pick and raises tool errors; the renderer only shows and asks. `pickVisionModel` stays synchronous and network-free (BR-10) and returns the provider with an empty model when the person chose a provider only; `coordinator/vision.ts` completes it.

Rejected: (a) keep `home.vision*` as the store with Imágenes overriding it (two stores, Q1); (b) a native `dialog` for the confirmation of AC-4.8 (see §7: the same page can already write `attachments.noticeAcknowledged`, so a native dialog would add friction and no protection); (c) a probe with a test picture or an endpoint that exposes input types (unverified, Q3); (d) a new IPC request for the see-group suggestions (the existing `models.list` plus a shared filter is enough). No ADR: nothing here is hard to reverse (no dependency, no storage format; one settings field and one marker).

## 2. Layers touched
| Layer | Files (new / changed) | Why it lives there |
|---|---|---|
| shared | NEW `src/shared/images/models.ts` (capability table, classification, pick, candidates, provider lists); NEW `src/shared/images/vision.ts` (`resolveVision`, gate, `sanitizeImagesSettings`, `acceptImagesPatch`, `migrateLegacyVision`, `omitLegacyVision`); `src/shared/attach/readers.ts` (`pickVisionModel` and `threadReaders` rebuilt on `resolveVision`; NEW `planSeeProvider`); `src/shared/types.ts` (`VisionChoice`, `Settings['images'].vision`, `Settings.visionMigrated`); `src/shared/defaults.ts` (default, `applyMetaDefault` keeps `vision`); `src/shared/home.ts` (`HomeSettings` loses `visionProvider`/`visionModel`); `src/shared/i18n/{es,en}/{general,home,tools}.ts` | pure rules used by `main` (native dialog, load), `coordinator` (looks, notice) and `renderer` (lines, dialog). Rule: `vision.ts` takes `hasKey` as a predicate and never imports `readers.ts`; `readers.ts` imports `vision.ts` (one direction, no cycle). |
| coordinator | `src/coordinator/vision.ts` (`visionModel` becomes async, listing, per-process pick cache, `ToolError`s); `src/coordinator/images.ts` (classification and `pickImageModel` come from `shared`; `listImageModels` returns `createCandidates`) | I/O (listing, cache, errors). `images.models` keeps its request shape, so `coordinator/index.ts` is not edited. |
| main | `src/main/settings.ts` (load: sanitize `images`, migrate once, strip legacy keys; `update`: guard the `images` patch, strip legacy keys from a `home` patch); `src/main/index.ts` is NOT edited (it already calls `threadReaders`, whose signature does not change) | settings on disk and the shallow-merge trap |
| renderer | `src/renderer/src/components/SettingsDialog.tsx` (`ImagesTab`: create group patches the whole `images`; NEW see group component in the same file because it needs the file-local `useModels`; pass `onOpenImages` to Casa); `src/renderer/src/components/AttachDialogs.tsx` (NEW `SeeProviderDialog`, reusing the private `Frame`); `src/renderer/src/home/HomeSettings.tsx` (selector removed; read-only line and link) | display and asking only; every rule it shows comes from `shared` |

New arrows: `renderer → shared/images/*` and `shared/attach/readers` (allowed); `shared/images/models.ts → shared/defaults` (for `isChatModel`; `defaults.ts` must not import `shared/images`); `coordinator/vision.ts → shared/images/*` (allowed). `electron` stays in `main/` and `coordinator/index.ts`. No import between `main`, `coordinator` and `renderer`.

## 3. Contracts
Signatures only. Names are fixed here so tasks and tests agree.

```ts
// src/shared/types.ts
export interface VisionChoice { provider: ProviderId | ''; model: string }   // '' = not set
images: { provider: ImageProviderId; model: string; vision: VisionChoice }  // required, never optional
visionMigrated?: boolean                                                    // one-time marker, as metaDefaultApplied

// src/shared/home.ts: HomeSettings drops visionProvider and visionModel

// src/shared/images/models.ts
export type SeeRule = ((id: string) => boolean) | 'none'
export const SEE_RULES: Record<ProviderId, SeeRule>        // Record: a missing provider fails typecheck (AC-2.10)
export const CREATE_PROVIDERS: readonly ImageProviderId[]  // meta, xai, openai (BR-6)
export const SEE_PROVIDERS: readonly ProviderId[]          // the five chat providers, in the order of CHAT_PROVIDERS used by the agent selects
export function canCreate(provider: ImageProviderId, id: string): boolean   // today's patterns, and not /video|edit/
export function canSee(provider: ProviderId, id: string): boolean           // 'none' accepts nothing
export function hasSeeRule(provider: ProviderId): boolean
export function newestModel(ids: readonly string[]): string | undefined     // greatest id in numeric-aware order; fixed locale 'en', so the pick never depends on the OS language (AC-2.8)
export function pickImageModel(provider: ImageProviderId, ids: string[]): string | undefined   // moved from coordinator/images.ts, same results
export function pickSeeModel(provider: ProviderId, ids: string[]): string | undefined
export function createCandidates(provider: ImageProviderId, ids: string[]): string[]   // classified, alphabetical (AC-1.2)
export function seeCandidates(provider: ProviderId, ids: string[]): string[]            // rule ids; with no rule, ids passing isChatModel; alphabetical

// src/shared/images/vision.ts
export interface VisionInput {   // satisfied by Settings and by PublicSettings, so the renderer can call it
  agents: AgentProfile[]; defaultAgentId: string
  home: { agentId: string }
  images: { vision: VisionChoice }
  attachments: { noticeAcknowledged: ProviderId[] }
}
export interface VisionTarget {
  provider: ProviderId
  model: string                    // '' only when via === 'chosen' and the person typed no model
  via: 'chosen' | 'fallback'
  held?: ProviderId                // a chosen provider-only value the gate is holding back (AC-4.6, AC-4.9)
}
export function resolveVision(settings: VisionInput, hasKey: (provider: ProviderId) => boolean): VisionTarget
export function sanitizeImagesSettings(value: unknown, base: Settings['images']): { images: Settings['images']; wipedKey: boolean }
export function acceptImagesPatch(current: Settings['images'], patch: unknown): Settings['images']   // a patch without a valid `vision` keeps the current one
export function migrateLegacyVision(settings: Settings): { settings: Settings; changed: boolean }
export function omitLegacyVision<T extends object>(home: T): T

// src/shared/attach/readers.ts
export function pickVisionModel(settings: Settings, env: Env): { provider: ProviderId; model: string }   // same signature; a projection of resolveVision; model may be ''
export function threadReaders(...): ProviderId[]                                                          // same signature; names resolveVision's provider
export function planSeeProvider(settings: Pick<Settings, 'images' | 'attachments'>, provider: ProviderId | ''): { ask: boolean; patch: { images: Settings['images']; attachments?: Settings['attachments'] } }

// src/coordinator/vision.ts
export async function visionModel(settings: Settings): Promise<{ provider: ProviderId; model: string }>   // was sync
// look(settings, pictures, question, signal) keeps its signature
```

**Decisions the spec leaves to the plan** (each is plumbing, none is a business rule):
- **Structure that survives the shallow merge (AC-1.8).** `images.vision` is a nested object but is never patched alone. (1) The type makes `vision` required, so any `{ images: { provider, model } }` patch fails typecheck, including the old ImagesTab one. (2) Both groups always send `{ ...settings.images, <change> }`. (3) At runtime, `SettingsStore.update` runs the patch's `images` through `acceptImagesPatch`, so a patch from any other caller that omits or malforms `vision` keeps the current one (same pattern as `acceptDreamPatch`). (4) The loader replaces `{ ...base.images, ...stored.images }` with `sanitizeImagesSettings`, so a stored `images` without or with a malformed `vision` loads with it empty. A stored `vision` with an unknown provider id, a non-string model, or a model with no provider loads as not set; a model that looks like an API key is blanked (`looksLikeApiKey`) and the file rewritten (AC-1.4).
- **Model listing and cache.** One `Map<string, Promise<string>>` in `coordinator/vision.ts`, key `provider|baseUrl|apiKey` (the key resolved as the provider client resolves it: stored key, else environment variable; base URL: `settings.providers.xai.baseUrl` for xAI, the fixed constant of `defaults.ts` for the others). It stores picks only; a rejected promise is deleted so a failure is never cached (BR-12). Two looks at once share one listing. Creation keeps its own cache in `images.ts` unchanged (AC-2.7 keeps caching its fallback, as today).
- **Suggestions for the see group** use `models.list` (raw ids, already sorted) and `seeCandidates` in the renderer. The create group keeps `images.models`, now filtered through `createCandidates` (so `video`/`edit` ids stop being suggested; see gap G4). No IPC message is added or changed.
- **Where the text of the lines comes from.** The renderer calls `resolveVision(settings, hasKey)` with `hasKey = providers[p].hasKey || providers[p].fromEnv` from `PublicSettings`. No round trip. The line of AC-1.6, the held line of AC-4.9 and Casa's read-only line are the same call.
- **Migration marker:** `Settings.visionMigrated`, read and set only by `migrateLegacyVision`. It runs in the `SettingsStore` constructor next to `applyMetaDefault`. Legacy keys are removed from `home` on every load and from every `home` patch (`omitLegacyVision`), so nothing re-creates them (AC-3.4). It copies only when `images.vision` is still empty.
- **Confirmation dialog (AC-4.8):** renderer-side `SeeProviderDialog` in `AttachDialogs.tsx`, built on the existing `Frame` (`modal-backdrop` > `FocusScope trap` > `modal small-modal`, Cancel first in the DOM so it takes the focus, `ShieldAlert` icon), exactly like `ProviderNoticeDialog`. Its decision (ask or not, and the one-update patch) is `planSeeProvider`. The patch's `attachments` is built with `acknowledgeNotice`.
- **Casa link:** `HomeSettings` gets an optional callback prop `onOpenImages(): void` (it cannot import `Tab` from `SettingsDialog`: cycle). `SettingsDialog` passes `() => setTab('images')`.

**Dictionary keys** (es and en, same keys in both; Spanish stays rioplatense; proposed copy, the implementer keeps the meaning):

| Key | es | en |
|---|---|---|
| `images.see.title` | Visión de imágenes | Seeing images |
| `images.see.about` | La usan las cámaras y su vigilancia, el plano desde una foto, `look_at_image` y las imágenes que adjuntás en el chat. | Used by cameras and their watches, plan-from-photo, `look_at_image` and the pictures you attach in the chat. |
| `images.see.provider` | Proveedor | Provider |
| `images.see.auto` | Automático | Automatic |
| `images.see.model` | Modelo (vacío = el más nuevo que vea) | Model (empty = the newest one that can see) |
| `images.see.fetchModels` | Traer la lista de modelos que ven imágenes | Fetch the models that can see images |
| `images.see.autoRule` | Alma buscará el modelo más nuevo de {provider} que sepa ver imágenes. | Alma will look for the newest {provider} model that can see images. |
| `images.see.autoNone` | Alma no conoce un modelo de {provider} que sepa ver imágenes: escribí uno. | Alma knows no {provider} model that can see images: type one. |
| `images.see.using` | Ahora se usa: {provider} · {model} | In use now: {provider} · {model} |
| `images.see.held` | {provider} está elegido pero no lo confirmaste, así que se usa {using}. | {provider} is chosen but you have not confirmed it, so {using} is used. |
| `images.see.confirmNow` | Confirmar {provider} | Confirm {provider} |
| `images.see.confirm.title` | Tus imágenes saldrán hacia {provider} | Your pictures will go to {provider} |
| `images.see.confirm.body` | Las imágenes que adjuntás en el chat, las fotos de las cámaras y las fotos de planos se enviarán a {provider}. | The pictures you attach in the chat, camera stills and plan photos will be sent to {provider}. |
| `images.see.confirm.accept` | Confirmar | Confirm |
| `home.think.visionUsing` | Mira con: {provider} · {model}. Se elige en Configuración → Imágenes. | Looks with: {provider} · {model}. Chosen in Settings → Images. |
| `home.think.visionAuto` | el más nuevo que vea | the newest that can see |
| `home.think.visionOpen` | Ir a Imágenes | Go to Images |
| `tool.vision.noModel` | No hay un modelo de {provider} que pueda ver imágenes: elegí uno en Configuración → Imágenes. | There is no {provider} model able to see images: pick one in Settings → Images. |
| `tool.vision.listFailed` | No se pudo pedir la lista de modelos de {provider}: {error} | Could not list the {provider} models: {error} |

Reused unchanged: `images.title`, `images.about`, `images.service`, `images.model`, `images.fetchModels`, `images.missingKey`, `images.isKey`, `images.option.*`, `providers.option.*`, `home.think.vision` (Casa label), `home.think.visionNote` (BR-16, under the see group and in Casa), `common.cancel`, `common.save`. Removed (unused afterwards, AC-5.1): `home.think.visionDefault`, `home.think.visionModel`. `tool.vision.noModel` and `tool.vision.listFailed` are `ToolError` keys: English for the model, translated on the card (AC-5.2, 025 BR-17).

**Behavior table** for `resolveVision` (the gate, BR-14), `chosen` = `images.vision`:

| chosen.provider | chosen.model | provider in `noticeAcknowledged` | result |
|---|---|---|---|
| '' | any | any | fallback chain (BR-7), `via: 'fallback'` |
| set | typed | any | `{ provider, model }`, `via: 'chosen'` |
| set | '' | yes | `{ provider, model: '' }`, `via: 'chosen'`; the coordinator completes it |
| set | '' | no | fallback chain, `via: 'fallback'`, `held: provider` |

Fallback chain: house agent (`home.agentId`), else default agent, else any agent whose provider `hasKey`, else the first agent; no capability check (AC-2.9).

## 4. Data and persistence
- `settings.json` gains `images.vision` and `visionMigrated`; nothing else on disk, no new file, no new secret.
- **One-time migration** (`migrateLegacyVision`, run at load): if `visionMigrated` is not set, copy `home.visionProvider` / `home.visionModel` into `images.vision` when `images.vision` is empty and the legacy provider is a known `ProviderId`; a legacy model with no valid provider is dropped; a legacy model that looks like an API key is blanked; set `visionMigrated`. Always (flag set or not) remove the two keys from `home`. A change of content saves the file (as `movedToMeta` does, and only when `secretsProtected()` allows the rewrite).
- A pair copied over is a typed pair (works as before, BR-14); a provider-only value is held until acknowledged (AC-3.3).
- `applyMetaDefault` today replaces `images` with `{ provider: 'meta', model: '' }` and would drop `vision`; it must keep it (`{ ...images, provider: 'meta', model: '' }`). A test pins this.
- Older versions reading a newer file ignore `images.vision`; their `home.vision*` is empty after migration, so a downgrade falls back to the agent chain (no crash).
- Docs that describe the shape: `docs/references/settings.md` (rows `images`, `home.visionProvider`, `home.visionModel`, `metaDefaultApplied`, load/merge text), `docs/modules/settings.md` (merge text), `docs/references/data.md` if it lists the fields.

## 5. Dependency injection
- `resolveVision` takes `hasKey` as a predicate (the coordinator passes the env-aware `hasKey`; the renderer passes `PublicSettings` flags; tests pass a lambda). `pickVisionModel` keeps `env`.
- `visionModel` / `look` receive `settings`; the provider client comes from `getProvider` (tests `vi.mock('../src/coordinator/providers')` with a fake whose `listModels` and `streamTurn` are spies, as `tests/attach-agent.test.ts` does). The environment is read from `process.env` as today; tests set and restore it.
- No clock, no network, no random in any `shared` function (AC-2.8). Distinct fake keys per test keep the process-wide pick cache from leaking between tests (same technique as `images.ts` tests); no reset export is added.
- `SettingsStore` tests use the `vi.mock('electron')` + temp `userData` pattern of `tests/dream-settings.test.ts`.

## 6. Test strategy
Test titles start with the AC id and `(038)`, e.g. `AC-2.8 (038) …`, because the ids repeat across specs. Files (all new): `tests/images-models.test.ts` (pure classification and table), `tests/images-vision-rules.test.ts` (pure gate, sanitize, migration, plan), `tests/images-vision-look.test.ts` (coordinator `look`/`visionModel` with a fake provider), `tests/images-vision-store.test.ts` (`SettingsStore`), `tests/images-create-models.test.ts` (creation).

| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.1 | [manual] open the tab | both groups, titles, explanations |
| AC-1.2 | `images-models` → `AC-1.2 (038) candidates are the classified ids, alphabetical`; `images-create-models` → `AC-1.2 (038) images.models lists create candidates and a listing error is raised, not swallowed` | provider with no rule falls to `isChatModel`; empty list; ids with `video`/`edit`/`embed`; error leaves nothing changed |
| AC-1.3 | `images-vision-rules` → `AC-1.3 (038) changing a provider clears the model in the patch`; create-service half is spec 020 AC-2.6 (manual, unchanged) | same provider re-picked; '' provider |
| AC-1.4 | `images-vision-rules` → `AC-1.4 (038) a key in either model field is blanked on load`; `images-vision-store` → `AC-1.4 (038) the file is rewritten without it`; UI disabled-Save is [manual] | `xai-…` and `sk-…` shapes; key in `images.model` and in `images.vision.model`; both at once |
| AC-1.5 | `images-models` → `AC-1.5 (038) hasSeeRule is true for Anthropic, xAI, Meta and false for DeepSeek, Vercel` (decides which line); wording [manual] | each of the five providers |
| AC-1.6 | `images-vision-rules` → `AC-1.6 (038) empty see provider resolves to the fallback agent's pair`; display [manual] | no key anywhere (first agent); env key only |
| AC-1.7 | `images-models` → `AC-1.7 (038) provider lists are the ones with a client for the job`; dropdown marks [manual] | OpenAI absent from see; Anthropic/DeepSeek/Vercel absent from create |
| AC-1.8 | `images-vision-rules` → `AC-1.8 (038) any order of edits keeps the other group` (property-style loop over both groups' edits through `acceptImagesPatch`); `images-vision-store` → `AC-1.8 (038) load and update keep vision`; typecheck is the third guard | patch omitting `vision`; `vision` as string/array/null; stored `images` missing; `applyMetaDefault` keeps `vision` |
| AC-2.1 | `images-create-models` → `AC-2.1 (038) a typed create model is used with no listing call` | local xAI-shaped server (as `tests/media.test.ts`); assert zero `/models` requests |
| AC-2.2 | `images-create-models` → `AC-2.2 (038) provider only lists once and caches per service+URL+key` | second call no listing; changed key lists again |
| AC-2.3 | `images-vision-look` → `AC-2.3 (038) a typed see model is used with no listing call and no capability check` | model not matching the rule; provider with 'none' + typed model works |
| AC-2.4 | `images-vision-look` → `AC-2.4 (038) provider only, acknowledged, with a rule: newest accepted model, cached` | list order shuffled (same pick); second look no listing; changed key relists |
| AC-2.5 | `images-vision-look` → `AC-2.5 (038) no rule or no accepted id is a tool error naming the provider and sends nothing elsewhere` | DeepSeek and Vercel make no listing call; list with only non-matching ids; `streamTurn` of every provider never called |
| AC-2.6 | `images-vision-look` → `AC-2.6 (038) listing failure or missing key is a tool error and is not cached` | offline, rejected key, timeout (rejection), no key; next look relists |
| AC-2.7 | `images-create-models` → `AC-2.7 (038) listing failure or no image model uses the fallback id` | each of xAI/OpenAI/Meta fallbacks |
| AC-2.8 | `images-models` → `AC-2.8 (038) newestModel is deterministic, numeric-aware and locale-independent` | input order shuffled; `v2` vs `v10`; duplicates; empty list → undefined; run under a different default locale |
| AC-2.9 | `images-vision-rules` → `AC-2.9 (038) empty or held see provider uses house, default, any-with-key, first agent` | the four steps; env key; nothing has a key |
| AC-2.10 | `images-models` → `AC-2.10 (038) one rule per provider, none accepts nothing`; the missing-entry half is the `Record` typecheck | every `ProviderId` has an entry; DeepSeek/Vercel accept no id; each rule accepts/rejects sample ids (`claude-*`, `grok-*` chat vs `grok-*-image`, `muse-spark*` vs `muse-image*`) |
| AC-3.1 | `images-vision-rules` → `AC-3.1 (038) a legacy pair is copied and emptied`; `images-vision-store` → `AC-3.1 (038) load shows the pair in images.vision, home emptied, file rewritten` | provider and model both set; looks resolve to the same pair as before |
| AC-3.2 | `images-vision-rules` → `AC-3.2 (038) nothing set stays unset` | missing `home`, empty strings |
| AC-3.3 | `images-vision-rules` → `AC-3.3 (038) a legacy provider alone is copied with an empty model and is held`; store variant | resolves to `via: 'fallback'`, `held` set, until acknowledged |
| AC-3.4 | `images-vision-rules` → `AC-3.4 (038) the marker stops a second run and legacy keys never come back`; `images-vision-store` → `AC-3.4 (038) editing the old Casa keys by update() does not overwrite Imágenes` | flag set + stale legacy keys; a `home` patch carrying them; `images.vision` already set with flag unset |
| AC-3.5 | [manual] Casa shows the line, link and cost note, no fields | — |
| AC-4.1 | `images-vision-rules` → `AC-4.1 (038) threadReaders names the provider the looks would use after the gate, with no network`; `attach-agent` readers test (moved) | listing never called (no fetch in `shared`) |
| AC-4.2 | existing tests `AC-1.4 (031) …`, moved to `images.vision` (§6b), plus `AC-4.2 (038) empty see provider names the fallback agent's provider once` | same provider twice |
| AC-4.3 | `images-vision-rules` → `AC-4.3 (038) a newly chosen unacknowledged provider is owed by the notice`; `verify-031-put` (moved) keeps the `notice-needed` path | provider acknowledged later → no longer owed |
| AC-4.4 | `images-vision-look` → `AC-4.4 (038) notice and look name the same provider for every outcome` (build both from one settings object across: typed, ack'd provider-only, held, no rule, listing failure) | every failure path: `streamTurn` calls only on the named provider or none |
| AC-4.5 | `images-vision-look` → `AC-4.5 (038) the key never appears in errors, logs or tool results` | rejection text containing the exact key; `console.*` spied |
| AC-4.6 | `images-vision-rules` → `AC-4.6 (038) gate table`; `images-vision-look` → `AC-4.6 (038) held provider receives nothing, the fallback agent's provider does` | the four rows of the table; provider-only without ack never reaches `getProvider(chosen)` |
| AC-4.7 | `images-vision-look` → `AC-4.7 (038) the gate is read at each look` | same closure over mutable settings, as `coordinator/index.ts` passes `look(settings, …)` to the watch; ack between two looks |
| AC-4.8 | `images-vision-rules` → `AC-4.8 (038) planSeeProvider asks only for an unacknowledged provider and saves provider, empty model and acknowledgement in one patch`; dialog behavior [manual] | acknowledged provider (no ask); '' (never asks); Cancel = no patch is applied (UI) |
| AC-4.9 | `images-vision-rules` → `AC-4.9 (038) held is reported with the provider that is used instead`; button [manual] | acknowledged afterwards → `held` gone |
| AC-5.1 | `images-vision-rules` → `AC-5.1 (038) every new key exists in es and en`; reading both languages [manual]; existing parity and hardcoded-text tests | removed keys absent from both |
| AC-5.2 | `images-vision-look` → `AC-5.2 (038) the errors are ToolError keys, English for the model, translated for the person` | `translateText('es', …)` and `'en'` |

### 6b. Existing tests that must change (none weakened)
Cause for all but E9: `home.visionProvider`/`visionModel` stop existing (BR-1), so the same scenario is set up at `images.vision`; assertions are unchanged. The compiler finds each one (the old fields leave the type). Each moved test keeps its AC id.

| # | File and lines | Change | Why it is not a weakening |
|---|---|---|---|
| E1 | `tests/attach-agent.test.ts` 322-323, 332 | `settings.home.visionProvider/visionModel = …` becomes `settings.images.vision = { provider: 'xai', model: 'grok-vision' }`; 332 sets `images.vision.provider = 'deepseek'` (model stays typed) | typed pair is used without acknowledgement (BR-14), so the expected readers are identical |
| E2 | `tests/attach-phone-rules.test.ts` 226, 233, 260, 267, 273, 281 | same move; `base()` drops the two empty home fields | all use typed pairs; same expectations. Titles "behaves as visionModel did" stay (the behavior is the point) |
| E3 | `tests/attach-phone-service.test.ts` 28-29 | same move (typed pair) | same |
| E4 | `tests/verify-030-store.test.ts` 1064, 1067 | same move | same |
| E5 | `tests/verify-031-put.test.ts` 296 | `t.setSettings({ images: { ...t.settings().images, vision: { provider: vision, model: 'vision-x' } } })` | same |
| E6 | `tests/verify-031-switch.test.ts` 138 | `withVision` sets `images.vision` instead of `home` | same |
| E7 | `tests/media.test.ts` 6, 88-90 | import `pickImageModel` from `src/shared/images/models`; assertions untouched | the function moved (BR-4); same inputs and outputs |
| E8 | `tests/media.test.ts` 48; `tests/meta-defaults.test.ts` 24, 35, 40-43 | object literals gain `vision` (spread the default); line 43 `toEqual` includes `vision: { provider: '', model: '' }` | type shape only; new assertion added that `applyMetaDefault` keeps a non-empty `vision` (strengthens the gate that would let the trap through, Constitution II) |
| E9 | `tests/home-live.test.ts` 67 | remove the two empty vision fields from the literal | cosmetic (extra keys still compile); runs only with `ALMA_HOME_INSTALL=1` |

Unchanged on purpose: `tests/remote-attach-settings.test.ts`, `tests/support/verify-031.ts`, `tests/i18n-model.test.ts` (use defaults or spread `images`).

Pure logic extracted from UI: the lines of AC-1.5, AC-1.6, AC-3.5 and AC-4.9, and the ask/no-ask of AC-4.8, are `hasSeeRule`, `resolveVision` and `planSeeProvider`, tested above. The renderer has no component tests; the remaining display checks are `[manual]`.

## 7. Security and privacy impact
- **No new tool, no `ToolRisk` change** (BR-11): `look_at_image` stays `read` standalone, `generate_image` stays `write`.
- **Data flow:** unchanged in kind (a picture goes to the vision provider). What changes is who can be that provider: now also through a setting outside Casa that may be a provider only. The gate (BR-14) and the confirmation (AC-4.8) keep a picture or camera still from reaching a provider the person did not confirm by name; the notice keeps naming the real receiver from settings alone (AC-4.1 to AC-4.4).
- **Residual case, accepted by the spec:** a complete pair carried over from Casa and never acknowledged keeps receiving camera stills as it did before.
- **Confirmation is renderer-side by design.** Constitution V reserves native dialogs for starting new code or widening what agents may do. Here the page can already write `attachments.noticeAcknowledged` through `settings.update` (the chat notice does), so a native dialog would protect nothing more. To be written into `CONTROLS.md` so it is a recorded decision, not an omission.
- **Secrets:** no key in a log, audit entry, error or tool result (AC-4.5): the listing error text is passed through an exact-key replacement before it becomes the `error` param; audit for `settings.update` already lists key names only. Cache keys hold the key in memory only, as `images.ts` does. Looks themselves are not audited today; unchanged.
- **Listing models** sends the provider's key to that provider, as `models.list` does (005).
- **Docs to update in the same PR:** `docs/security/PRIVACY.md` (the vision-provider row of the provider table: the provider is the one chosen in Imágenes, subject to the gate; the notice paragraph: the gate and the confirmation; the omission that `look_at_image` is missing from the table can be closed in this edit); `docs/security/CONTROLS.md` (a control line for the acknowledgement gate and the renderer-side confirmation; the "PRIVACY.md omission" bullet if closed); `docs/modules/security.md` (rows at the vision-provider lines); `docs/security/RISKS.md` only if a risk row names Casa as where vision is chosen (check with grep; otherwise untouched).

## 8. Rollout
- No feature flag. First run after update: the marker is unset, so the migration runs once. A person with no vision value set sees "Automático" and nothing changes. A person with a complete pair sees it in Imágenes and nothing changes in behavior. A person with a provider only sees the held line (AC-4.9) and a "Confirm" button; looks keep using the agent chain until they confirm. A fresh install has the see provider empty.
- Turning it off: choose "Automático" (back to the agent chain).
- Do not ship a build that has the cut-over (`pickVisionModel` reading `images.vision`) without the migration and the Casa change: tasks T6 (migration), T8 (cut-over), T13 and T14 (store) and T19 (Casa) belong in one PR.
- Restart the app after the coordinator changes (the coordinator is a `utilityProcess`).

## 9. Gaps noted while planning (not decided here; for the owner)
None blocks a task; each has a default in the plan that the owner may overturn.
- **G1** AC-1.8 only requires the tab to send the whole `images` object. The plan adds a runtime guard (`acceptImagesPatch`) that keeps `vision` when a patch omits it, which departs from the literal "replaces top-level keys whole" of 006 AC-3.1 for this one key. Default: keep the guard.
- **G2** Legacy edge cases the spec does not state: a `home.visionProvider` that is not a known provider id, a legacy model with no provider, a legacy model that looks like a key. Default: treated as not set / dropped / blanked (AC-1.8 and AC-1.4 by analogy). Confirm.
- **G3** `isChatModel` excludes any id containing `vision`, so with BR-13 as written an xAI id such as `grok-…-vision…` is never auto-picked, and for DeepSeek and Vercel (no rule) such ids are not even suggested. A hand-typed id still works (BR-2). Owner should know before relying on xAI auto-pick.
- **G4** AC-1.2 says the create suggestions are the classified ids; today `images.models` filters by the provider pattern only and the `video|edit` exclusion exists only in the pick. After this spec `video`/`edit` ids are no longer suggested. Default: follow AC-1.2.
- **G5** Choosing DeepSeek or Vercel in the see group (no rule) and confirming leaves the provider acknowledged with an empty model, so every look, camera watches included, fails with the AC-2.5 error until a model is typed (nothing falls back, by design). The AC-1.5 line warns, the confirmation dialog does not. Default: as the spec says; owner may want the dialog to say it.
- **G6** BR-12 says a failed listing is never cached for seeing; creation (AC-2.7, unchanged) does cache its fallback for the process after a failed listing. Different on purpose; noted so the two are not unified by mistake.
- **G7** Order of the provider options is not specified. Default: create = Meta, xAI, OpenAI (as today); see = `CHAT_PROVIDERS` order (Meta, Anthropic, xAI, DeepSeek, Vercel).
- **G8** The cache key includes the language if keyed by the provider client; the plan keys by provider + URL + key explicitly to match BR-12.

## 10. Coordination (shared files)
Other sessions work in this repo (specs 033/034/035 and the 027 relay). This plan and `tasks.md` are the only files written now. The implementation will touch these shared files; whoever implements should re-read them right before editing and keep the diff to the lines named in the tasks:
- Source: `src/shared/types.ts`, `src/shared/defaults.ts`, `src/shared/home.ts`, `src/shared/attach/readers.ts`, `src/shared/i18n/{es,en}/{general,home,tools}.ts`, `src/main/settings.ts`, `src/coordinator/vision.ts`, `src/coordinator/images.ts`, `src/renderer/src/components/SettingsDialog.tsx`, `src/renderer/src/components/AttachDialogs.tsx`, `src/renderer/src/home/HomeSettings.tsx`. Highest conflict risk: `types.ts`, `defaults.ts`, `main/settings.ts` and `SettingsDialog.tsx` (the dream settings of 033 and the remote settings of 026/027 live there).
- Tests: the nine existing files of §6b.
- Docs (several already have uncommitted edits from other sessions in the working tree; edit in place, do not reformat): `docs/context.md`, `docs/references/{settings,ipc-messages,data}.md`, `docs/modules/{images,providers,home,settings}.md`, `docs/modules/security.md`, `docs/security/{PRIVACY,CONTROLS}.md`, `docs/HOME-AUTOMATION-PLAN.md`.
- Specs (dated italic notes only): 005, 006, 013, 014, 020, 025, 030, 031, and the 038 row of `.specify/specs/README.md` (it still says `draft`).
