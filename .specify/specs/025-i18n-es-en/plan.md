# 025 — Plan

<!-- Written only once spec.md is `ready`. Contracts and signatures, never logic. -->

## 1. Approach
One setting, `language` (`es` | `en`), resolved in `main` and carried to every layer; all user-visible text comes from two typed
dictionaries in `src/shared/i18n/` (split by area, aggregated as `es.ts` and `en.ts`), read through one pure `translate()` in
`shared`, a `useT()` hook in the renderer, and an explicit `language` argument in `main` and the coordinator (no singleton).
`es` holds today's rioplatense text verbatim, so Spanish users and the existing Spanish-asserting tests do not change (BR-22, BR-25);
`en` is US English. Text only the model reads is English and lives outside the dictionaries (`src/coordinator/prompts/`), except
Alma-written tool errors and results, which are dictionary keys (`tool.*`) so the model gets `en` and the person gets their language.
Rejected: i18next ([ADR 0018](../../../docs/adr/0018-typed-dictionaries-no-i18n-library.md)); migrating or renaming existing files on a
language change ([ADR 0019](../../../docs/adr/0019-names-follow-language-existing-wins.md)). Both ADRs stay `proposed` until the code lands.

### Plan-level decisions (the spec left these to the plan)
| # | Decision | Why / where to change it |
|---|---|---|
| D1 | Dictionary files per area (`src/shared/i18n/es/<area>.ts`, `en/<area>.ts`) aggregated by `es.ts` / `en.ts`; keys are `area.name`, `es.ts` defines the key type and `en` must match it | parallel tasks touch different files; the human's `es.ts`/`en.ts` shape is kept |
| D2 | System language = the first preferred language only (`app.getPreferredSystemLanguages()[0]`, `navigator.languages[0]` in the renderer before settings load) | simplest reading of BR-2; `resolveLanguage` in one place |
| D3 | `language` is written to `settings.json` only when the person chooses it; with no saved value `main` resolves the system language each start, so the default keeps following Windows. `Settings.language` is always the resolved value for every layer | matches "default: system language"; only `SettingsStore` knows if it was explicit |
| D4 | Ratchet = regex scanner in `tests/support/i18n.ts` (same style as `tests/support/arch.ts`), a per-file baseline map (one line per file, so parallel tasks do not conflict), fails above the baseline and also fails below it ("lower the baseline") so it only tightens. Counts: (R1) Spanish text anywhere in `src/` outside the `es` dictionary files and a reasoned allowlist; (R2) in renderer `.tsx`, JSX text and `title` / `placeholder` / `aria-label` / `alt` string attributes and template literals with letters; (R3) in `main` and the coordinator, string literals passed directly to the user-facing sinks (`notify`, `new Notification`, `dialog.show*`, tray tooltip and menu `label`, voice status `detail`, `throw new Error` reaching the window). Model-only English is exempt by location: `src/coordinator/prompts/**` and `tool.*` dictionary keys are never sinks | model English is not user text, and Spanish regressions are caught anywhere; `typescript` 7 may not expose the old compiler API, so no AST |
| D5 | Tool errors and Alma-written tool results are `ToolText = { key, params }`; the model receives `translate('en', …)`, the stored result block keeps `i18n` so a card renders in the current language (also after a live switch); old threads, with plain text, display as stored. External content (web pages, command output, mail) enters a message as a `{data}` param and is never translated | AC-4.3, AC-4.4, BR-18 |
| D6 | The reviewer's and boss's free-text reason is shown translated by one lazy, cached, low-effort translation call to the same provider that produced it, only when `language` is `es`, using one fixed English prompt; the card shows the English reason first and swaps when the translation arrives; on failure it stays English | the reason is free text, so it cannot be a key; no per-language reviewer prompt, so AC-4.3 holds |
| D7 | Default English Kokoro voice `af_heart`, the English picker also offers `am_adam`; the pair of defaults lives in one constant, `DEFAULT_VOICES` in `src/shared/defaults.ts`, and the per-language lists in `src/shared/voices.ts` | smallest reasonable default (Kokoro's own default voice); the human can change one line. The task verifies both voice files exist in the pinned Kokoro repo |
| D8 | English names for BR-23: `Alma/Memories.md`, `Alma/Knowledge/`, `Meetings/`, `library/`, `palettes.json`, `recipes.json`, new notes `Untitled`, drawings `Drawing`, welcome `Welcome.md`; the knowledge frontmatter siblings follow the same rule (`origin: ai`, `type: knowledge`, `created`, `updated`, `conversation`) | all are entries in `names.*`, changeable in one place. Extending BR-23 to the sibling frontmatter keys is a plan call, flagged in the report |
| D9 | Wake phrase id `hey_alma`; the worker asks a pure `wakeModelFile(wakeWord, exists)` which returns the new model file when it exists in `resources/wakewords/`, otherwise the previous `hola_alma_v0.1.onnx`, so voice never breaks before the asset arrives | AC-6.10; the asset is its own task flagged "needs human/asset" |
| D10 | Whisper keeps `whisper-base`/`small`; the task passes the language to the worker and first confirms the ids are the multilingual builds (they carry no `.en` suffix) | AC-6.1 |

## 2. Layers touched
| Layer | Files (new / changed) | Why it lives there |
|---|---|---|
| shared | new `src/shared/i18n/{language,messages,format,names,vocab,es,en}.ts`, `i18n/es/*.ts`, `i18n/en/*.ts`; new `src/shared/voices.ts`; changed `types.ts` (`Language`, `Settings.language`, `PublicSettings.language`, `WakeWord`, `ToolText`, tool-result `i18n`), `defaults.ts` (`defaultSettings(language)`, per-language agents, `DEFAULT_VOICES`), `company.ts` (templates per language), `schedule.ts` (date text) | pure data and functions used by renderer, main and coordinator; shared stays a leaf |
| renderer | new `src/renderer/src/i18n/{I18nProvider,useT}.tsx`; every component and `lib/format.ts`, `lib/attachments.ts`, `vault/vaultLib.ts`, `voice/audio.ts`; `index.html` | text and the hook; formats via shared helpers |
| main | new `src/main/messages.ts` (pure message builders, no electron import); changed `index.ts` (tray, dialogs, notifications, IPC errors, live apply), `settings.ts` (explicit language, system locale injected, wake-word and defaults migrations), `guard.ts` text, `instagram.ts` (label sets) | window-level text and settings store |
| coordinator | new `src/coordinator/prompts/*.ts` (English); changed `agent.ts`, `context.ts`, `vision.ts`, `approval.ts`, `index.ts`, `tools/**`, `channels/*`, `company/*`, `voice/*`, `knowledge/base.ts`, `compose/*`, `home/*` | everything that composes text for a run, a channel or the voice |
| tests / scripts | new `tests/i18n*.test.ts`, `tests/support/i18n.ts`; renamed-doc link checks | gates |
| docs, skills, config | renamed and translated `docs/**`, `README.md`, `CLAUDE.md`, `.claude/skills/{console-ui,umbra-ui}`, `.github/*`, constitution links only | BR-5, BR-6 |

No new arrow breaks `docs/architecture.md`: `main` and the coordinator import only `shared`; the renderer imports `shared` and never `main/messages.ts`.

## 3. Contracts
Signatures only.

```ts
// src/shared/i18n/language.ts
export type Language = 'es' | 'en'
export function parseLanguage(value: unknown): Language | undefined
export function resolveLanguage(explicit: unknown, systemLocales: readonly string[]): Language

// src/shared/i18n/messages.ts
export type Message = string | { one: string; other: string }
export type MessageKey = keyof typeof es            // es.ts is the source of keys; en must have exactly the same keys
export type ParamsOf<K extends MessageKey>           // names found as {name} in the es text
export function translate<K extends MessageKey>(language: Language, key: K, ...params: ParamsArg<K>): string
export function dictionaryDiff(a: Record<string, Message>, b: Record<string, Message>): { onlyInA: string[]; onlyInB: string[] }

// src/shared/i18n/format.ts
export const LOCALE: Record<Language, 'es-AR' | 'en-US'>
export function formatDateTime(language: Language, at: Date | number, style: 'short' | 'long' | 'time' | 'weekday'): string   // 24-hour
export function compareText(language: Language): (a: string, b: string) => number                                          // numeric-aware

// src/shared/i18n/names.ts   (BR-23)
export function resolveName(language: Language, names: Record<Language, string>, exists: (name: string) => boolean): string
export function isOwnNote(frontmatter: Record<string, string>): boolean                                                   // `origen: ia` or `origin: ai`

// src/shared/i18n/vocab.ts   (both languages accepted at once)
export function parseYesNo(text: string): 'yes' | 'no' | null
export function isGoodbye(text: string): boolean
export function isCancel(text: string): boolean

// src/shared/types.ts
export interface ToolText { key: MessageKey; params?: Record<string, string | number> }
// tool-result block gains: i18n?: ToolText
// Settings.language: Language (resolved) ; PublicSettings.language: Language ; WakeWord = 'hey_alma'

// src/coordinator/tools/types.ts
export class ToolError extends Error { constructor(key: MessageKey, params?: Record<string, string | number>) }   // message = translate('en', key, params)
export interface RunContext { language: Language /* snapshot at run start */ }

// src/main/messages.ts (pure, no electron)
export function trayMenu(language: Language): { open: string; quit: string; tooltip: string }
export function securityDialog(language: Language, kind: 'mcp' | 'always-allow', programs: string[]): { title: string; message: string; allow: string; cancel: string }

// src/coordinator/voice/voice-worker protocol: transcribe and tts requests gain `language: Language`
export function wakeModelFile(wakeWord: 'hey_alma', exists: (file: string) => boolean): string
export function sttLanguage(language: Language): { whisper: 'spanish' | 'english'; openai: 'es' | 'en'; meta: 'es' | 'en' }
export function phonemizerVoice(language: Language): 'es-419' | 'en-us'
export function reviewerReasonForDisplay(reason: string, language: Language, provider: Provider): Promise<string>   // D6
```

IPC: no new channel. `settings:update` accepts `language` (validated by Zod at the boundary, AC-1.3); the existing `settings` message already carries it to the coordinator.

## 4. Data and persistence
- `settings.json`: `language` only when chosen (D3); `voice.wakeWord` `hola_alma` becomes `hey_alma` on load (`off` stays); saved default agents, company templates and auto-review instructions identical to the shipped defaults of the other language are rewritten on a language change, edited ones untouched, and a deleted default stays deleted.
- Threads: unchanged files. New tool-result blocks carry `i18n`; old blocks have plain text and render as stored. The attachments heading is English for new messages; the renderer folds both the English heading and the legacy Spanish one.
- Vault and working-folder names: BR-23 and D8, read under either language's name first; nothing renamed.
- Generated text (routine thread titles, memories, knowledge notes, minutes, task logs) uses the language of the run that writes it.
- Docs: renamed files (rename map in task G1), no data.
- Models: English voice files download on first use; the new wake-word file is a repository asset.

## 5. Dependency injection
- `resolveLanguage` gets `systemLocales` from the caller; `SettingsStore` receives it in its constructor; tests pass arrays.
- `RunContext.language`, a `language` argument on prompt, message and notification builders; no module reads global language state.
- `resolveName` and `wakeModelFile` receive `exists`; tests fake the file system.
- `reviewerReasonForDisplay` receives the `Provider`; tests use the fake provider of `tests/agent.test.ts`.
- Dates: builders receive the instant; tests pass fixed dates.
- Tests fake: `electron` (`vi.mock`) for `SettingsStore`, the voice worker, `fetch`, `Host`.

## 6. Test strategy
New files: `tests/i18n.test.ts` (shared pure), `tests/i18n-ratchet.test.ts`, `tests/i18n-runtime.test.ts` (settings, run context, main and coordinator messages, channels, generated text), `tests/i18n-model.test.ts` (prompts, tool text, defaults, reply rule), `tests/i18n-voice.test.ts`, `tests/i18n-services.test.ts` (web, HA, Instagram labels, names), `tests/i18n-docs.test.ts` (links, docs language, Estilo lines). Existing tests keep their Spanish assertions except where BR-25 allows (English tool errors/results, old wake phrase).

| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.1 | `tests/i18n.test.ts` → `AC-1.1 …` | `es-MX`, `en-GB`, `fr`, `[]`, `''`, `zh-Hans`, first locale only |
| AC-1.2 | `tests/i18n.test.ts` → `AC-1.2 …` | saved `en` with Spanish system |
| AC-1.3 | `tests/i18n.test.ts` → `AC-1.3 …` | `'fr'`, `7`, `null`, `{}`, `undefined` |
| AC-1.4 | `tests/i18n-runtime.test.ts` → `AC-1.4 …` (`SettingsStore` with `vi.mock('electron')`, temp folder); falls back to `[gap]` if mocking is impractical | invalid value rejected at the boundary; audit lists the key name only |
| AC-1.5 | `tests/i18n-runtime.test.ts` → `AC-1.5 …` | restart with explicit and without explicit language |
| AC-1.6 | [manual] General tab shows «Español» and «English» in each language | |
| AC-1.7 | `tests/i18n-runtime.test.ts` → `AC-1.7 …` (coordinator applies a `settings` message to the language its next message uses) + [manual] window and tray switch with no restart | two changes in a row |
| AC-1.8 | `tests/i18n-runtime.test.ts` → `AC-1.8 …` | `settings` changes mid-run; the run keeps its snapshot |
| AC-1.9 | [manual] open a native dialog, switch language, dialog unchanged | |
| AC-1.10 | `tests/i18n-voice.test.ts` → `AC-1.10 …` (assistant turn keeps its language snapshot) | change during recording and during speaking |
| AC-2.1 | [manual] walk every screen in both languages | |
| AC-2.2 | [manual] inspect `<html lang>` | |
| AC-2.3 | `tests/i18n.test.ts` → `AC-2.3 …` | negative fixture with a one-sided key |
| AC-2.4 | `tests/i18n.test.ts` → `AC-2.4 …` (`@ts-expect-error`, covered by `typecheck`) | unknown key; missing param |
| AC-2.5 | `tests/i18n-ratchet.test.ts` → `AC-2.5 …` | negative fixtures per rule R1 to R3; baseline above and below |
| AC-2.6 | `tests/i18n.test.ts` → `AC-2.6 …` | 0, 1, 2, 21 items; param absent at runtime |
| AC-2.7 | [manual] read a sample of both dictionaries | |
| AC-3.1 | `tests/i18n-runtime.test.ts` → `AC-3.1 …` (`trayMenu`, `securityDialog`, notification builder) | each in both languages |
| AC-3.2 | `tests/i18n-runtime.test.ts` → `AC-3.2 …` (fake `Host.notify`, provider config error, voice detail) | |
| AC-3.3 | `tests/i18n-runtime.test.ts` → `AC-3.3 …` | rejected origin, cancelled change, unknown provider and company |
| AC-3.4 | `tests/i18n.test.ts` → `AC-3.4 …` (main and coordinator messages exist as keys; parity covers them) | |
| AC-3.5 | [manual] dialog, tray, notification, toast in English | |
| AC-3.6 | `tests/i18n.test.ts` → `AC-3.6 …` | 24-hour, `ñ` ordering, numeric names, month names |
| AC-3.7 | `tests/i18n-services.test.ts` → `AC-3.7 …` | region and `Accept-Language` per language, HA language, integration sort |
| AC-3.8 | `tests/i18n-services.test.ts` → `AC-3.8 …` | page in each of en/es/pt; app language first |
| AC-3.9 | `tests/i18n-runtime.test.ts` → `AC-3.9 …` | Telegram and WhatsApp fixed texts |
| AC-3.10 | `tests/i18n-voice.test.ts` → `AC-3.10 …` | "yes", "sí", "no", "nope", both words |
| AC-4.1 | `tests/i18n-model.test.ts` → `AC-4.1 …` | edited agent survives a switch; unedited migrates |
| AC-4.2 | `tests/i18n-model.test.ts` → `AC-4.2 …` (every registered tool description is English and equal under both languages) | Spanish marker scan |
| AC-4.3 | `tests/i18n-model.test.ts` → `AC-4.3 …` (prompts built under `es` and `en` are identical and have no Spanish) | every prompt builder |
| AC-4.4 | `tests/i18n-model.test.ts` → `AC-4.4 …` (`ToolError` model text vs displayed text; reviewer reason with fake provider) | translation fails; `en` makes no call; cache hit; `{data}` never translated |
| AC-5.1 | `tests/i18n-model.test.ts` → `AC-5.1 …` | same rule under both languages, no per-language directive |
| AC-5.2 | [manual] message in the other language on each channel | |
| AC-5.3 | `tests/i18n-model.test.ts` → `AC-5.3 …` | routine, task, reminder, meeting, house rule; a chat turn gets none |
| AC-6.1 | `tests/i18n-voice.test.ts` → `AC-6.1 …` | local, OpenAI, Meta |
| AC-6.2 | `tests/i18n-voice.test.ts` → `AC-6.2 …` | fillers, approval prompt, test sentence, errors, link and code phrases |
| AC-6.3 | `tests/i18n-voice.test.ts` → `AC-6.3 …` | download fails offline |
| AC-6.4 | [manual] end-to-end in English | |
| AC-6.5 | `tests/i18n-voice.test.ts` → `AC-6.5 …` (only `hey_alma` accepted) + [manual] once the asset exists | |
| AC-6.6 | `tests/i18n-voice.test.ts` → `AC-6.6 …` | mixed-language phrases, closing plus request |
| AC-6.7 | `tests/i18n-voice.test.ts` → `AC-6.7 …` | |
| AC-6.8 | `tests/i18n-voice.test.ts` → `AC-6.8 …` | chosen voice kept on switch; unknown voice |
| AC-6.9 | `tests/i18n-voice.test.ts` → `AC-6.9 …` | `hola_alma`, `off`, junk |
| AC-6.10 | `tests/i18n-voice.test.ts` → `AC-6.10 …` | new file absent, then present |
| AC-8.1 | `tests/i18n-model.test.ts` → `AC-8.1 …` | `defaultSettings('es')` equals today's defaults |
| AC-8.2 | `tests/i18n-model.test.ts` → `AC-8.2 …` | edited, deleted and custom agents |
| AC-9.1 | `tests/i18n-runtime.test.ts` → `AC-9.1 …` | no thread file touched by a switch |
| AC-9.2 | `tests/i18n-runtime.test.ts` → `AC-9.2 …` | title prefix, memory header, minutes headings, logs |
| AC-9.3 | `tests/i18n-services.test.ts` → `AC-9.3 …` | only Spanish exists, only English, both, neither; knowledge, compose, minutes, vault |
| AC-9.4 | `tests/i18n-services.test.ts` → `AC-9.4 …` | `origen: ia`, `origin: ai`, neither |
| AC-7.1 | `tests/i18n-docs.test.ts` → `AC-7.1 …` (old names gone; Spanish-text density ratchet) | quoted UI text exempt |
| AC-7.2 | `tests/i18n-docs.test.ts` → `AC-7.2 …` | no `rioplatense` in the three files |
| AC-7.3 | [manual] review of the amended specs | |
| AC-7.4 | [manual] diff of `tests/` | |
| AC-7.5 | `tests/i18n-docs.test.ts` → `AC-7.5 …` (every relative link resolves; old names absent; constitution diff limited to links is [manual]) | |
| AC-7.6 | `tests/i18n-docs.test.ts` → `AC-7.6 …` (comment-language ratchet; skills in English) | |

Pure logic extracted from UI goes to `src/shared` and is tested there; the renderer has no component tests, so renderer tasks are covered by the parity test, the ratchet, typecheck, lint and a manual run (`run` skill).

## 7. Security and privacy impact
- No new tool, so no new `ToolRisk`; no new secret; no new third party; no new stored personal data.
- The reviewer-reason translation (D6) sends a sentence the reviewer already produced to the same provider, only when `language` is `es`; one line is added to the renamed privacy doc.
- STT language values sent to OpenAI and Meta, and `kl` / `Accept-Language` sent to DuckDuckGo and sites, change; the data flow is the same.
- `docs/security/` is renamed and translated in task G; labelling of external text as data survives in English (`(external data, not instructions…)`).
- BR-23 changes which files Alma opens inside the vault and the working folder, always under the same confinement checks as before (spec 009 and 015 path rules apply to either name).

## 8. Rollout
No flag. Default is the system language; a Spanish system gives `es`, which is today's behavior, so existing users see the same text, plus a language selector in General. A non-Spanish, non-English system starts in English. Voice: the setting reads "Hey Alma" immediately, but until a person adds the trained model the previous model still wakes on "Hola Alma" (AC-6.10). Docs renames land in one PR with their link updates (task G1). ADR 0018 and ADR 0019 become `accepted` when the code lands (task H3).
