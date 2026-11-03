---
status: ready
---

# 025 — Internationalization (Spanish and English)

<!-- All Open Questions are answered (§8). Flipped to `ready` by the orchestrator on the human's explicit instruction "metele full" (see BR-27). -->

## 1. Summary
Alma gets one new setting, `language` (`es` or `en`), in the General tab of Configuración. Its default is the system language and a
change takes effect live, with no restart. It governs the renderer's text, the messages that main and the coordinator show (tray,
native dialogs, notifications, errors, voice overlay details), dates, numbers and sorting, the language parameters sent to outside
services, and the voice (speech-to-text and text-to-speech). Agents answer in the language the person speaks to them in; the
setting is only the fallback when there is no incoming message. Prompts the person saved are never rewritten; the prompts, tool
descriptions and tool results Alma itself writes for the model are English, and the person sees them translated. Spanish stays
rioplatense as today and English is US English. The wake phrase becomes "Hey Alma" in both languages. Names Alma creates on disk
follow the language for new files while existing ones always win. The project's own documentation (`README.md`, `CLAUDE.md`,
`docs/`, skills) moves to English, Spanish file names included. Text lives in two typed dictionaries (`es`, `en`) in
`src/shared/`, with gates that stop a missing key or a new hardcoded string.

## 2. Problem and goal
Today every user-visible string is written in place, in Spanish (rioplatense), across the renderer (JSX), `main`, the coordinator
(tool results, prompts, channel messages) and the voice stack (Whisper pinned to Spanish, `ef_dora`, `es-419`, "Hola Alma").
Someone who does not read Spanish cannot use Alma, and nothing stops new Spanish text from landing in the code. The project's
docs are mostly Spanish too, so contributors who do not read Spanish cannot follow the rules. The human wants all documentation
in English "porque es para presentar" (because it is for presenting).

Done means: with `language` = `en`, a person can use every screen, hear and speak English with the assistant and read English
messages from the app; with `es` nothing they know changes (same rioplatense copy). Agents answer in the language the person
writes in. Adding a string means adding it to both dictionaries, and the test suite fails otherwise. The docs a contributor
reads are in English.

## 3. Scope
**In:**
- The `language` setting: type, default (system language), validation, persistence, IPC, live change, the selector in the General tab.
- Dictionaries (`es`, `en`), the resolver, the renderer hook, and the key-parity and hardcoded-text gates (the latter reaching zero).
- Every user-visible renderer text, including third-party UI that Alma configures (the drawing editor's `langCode`, `<html lang>`).
- User-facing messages produced by `main` and by the coordinator, including fixed strings on Telegram and WhatsApp.
- Dates, numbers and sorting; the language parameters sent to outside services (DuckDuckGo, `fetch_url`, Home Assistant, Instagram matching).
- The general reply-language rule; STT and TTS language, voices, vocabulary, enrollment phrases; the "Hey Alma" wake phrase and the migration of existing users.
- Shipped defaults per language on a new install, and their migration when `language` changes (only if unedited).
- English model-facing prompts, tool descriptions and tool results, shown translated to the person.
- Names Alma writes to disk following the language (new files only).
- Docs, skills, code comments and commit messages to English, with the file renames; amending the specs that pin these decisions (§7.2).

**Out (and why):**
- Languages other than `es` and `en` ("español o inglés, nada más").
- Third-party/provider/model text Alma does not author (API error bodies, Home Assistant's own UI).
- Machine translation of anything the person wrote (threads, notes, memories) and rewriting stored messages.
- Training the "Hey Alma" wake-word model: it is an asset a person has to produce (BR-19); nothing else depends on it.
- A new language clause in the constitution (decided: none; BR-6).

## 4. Users and stories
- **US-1** As a person, I want to choose Spanish or English in Configuración, so that Alma speaks my language.
- **US-2** As a person opening Alma for the first time, I want it to start in my computer's language, so that I need no setup.
- **US-3** As an English speaker, I want every screen, label, button, hint and error in English, so that I can use Alma without Spanish.
- **US-4** As a person, I want what the app itself tells me outside the window (tray, native dialogs, notifications, error messages) in my language.
- **US-5** As a person, I want my agents to answer in the language I write or speak in, on the app, Telegram, WhatsApp and mail.
- **US-6** As a person using voice, I want Alma to understand and speak my language and to wake on "Hey Alma".
- **US-7** As a person who wrote my own agent instructions, I want them left exactly as I wrote them when I change language.
- **US-8** As the maintainer, I want the docs in English and a gate that fails on a missing translation or a new hardcoded string, so that the app stays fully bilingual.
- **US-9** As a contributor, I want one obvious place to add a user-visible string, with the type checker and tests telling me when I forget a language.
- **US-10** As a person, I want to change language while Alma is running and see it change at once, without losing my memories or notes.

## 5. Acceptance criteria
Tests name the id: `it('AC-1.1 …')`. Text in specs is cited by dictionary key from now on (BR-25).

### The setting (US-1, US-2, US-10)
- **AC-1.1** (US-2) Given no `language` saved, when Alma starts, then `language` is `es` if the system language is Spanish (including regional codes such as `es-MX`), `en` if it is English (including `en-GB`), and `en` for any other system language or when it cannot be read.
- **AC-1.2** (US-1, US-2) Given a saved `language` of `es` or `en`, when Alma starts, then it is used whatever the system language is.
- **AC-1.3** (US-1) Given a `settings.json` whose `language` is not `es` or `en` (another string, a number, `null`), when the store loads it, then it does not throw and treats the value as if no language had been saved (AC-1.1 applies).
- **AC-1.4** (US-1) When the person picks a language in Configuración, then `language` is saved through `settings:update`, pushed to the coordinator like any other setting, carried by the public settings the window reads, and the change is audited by the existing `settings.update` entry (key name only).
- **AC-1.5** (US-1) Given a saved language, when Alma restarts, then the window, the tray and the coordinator all start in it.
- **AC-1.6** (US-1) [manual] The General tab of Configuración has a language selector showing the current value and two options labelled in their own language, «Español» and «English», whatever the current language is. Open it, switch, and read the options.
- **AC-1.7** (US-10) Given Alma is running, when the person changes `language`, then the open window, the tray menu and the texts the coordinator composes from then on use the new language with no restart.
- **AC-1.8** (US-10) Given an agent run in progress, when `language` changes, then that run finishes using the language that was in effect when it started and the next run uses the new one.
- **AC-1.9** (US-10) Given a native dialog or a Windows notification already shown, when `language` changes, then it is left as it is.
- **AC-1.10** (US-10) Given a voice turn in progress, when `language` changes, then the turn finishes as it began and the change applies from the next turn.

### Renderer text (US-3)
- **AC-2.1** (US-3) [manual] Given `en`, when every screen, dialog and tab is visited, then all visible text (labels, buttons, placeholders, titles, tooltips, aria labels, empty states, confirmations, error text, texts inside the drawing editor) is English and none is Spanish; given `es`, all of it is Spanish. Walk Chat, Vault, Empresas, Casa, Configuración (all tabs), Rutinas, voice overlay and reminder toasts in both languages.
- **AC-2.2** (US-3) [manual] Given `en` (resp. `es`), then `document.documentElement.lang` is `en` (resp. `es`). Inspect the page.
- **AC-2.3** (US-8, US-9) Given a key defined in one dictionary and missing from the other, when `pnpm run test` runs, then it fails naming the key. A negative fixture proves the check can fail.
- **AC-2.4** (US-9) Given code that asks for a key no dictionary defines, when `pnpm run typecheck` runs, then it fails.
- **AC-2.5** (US-8) Given a user-visible literal in renderer JSX text, a user-visible attribute (`title`, `placeholder`, `aria-label`…), a template literal that builds user text, or a user-facing string in `main` or the coordinator, beyond the recorded count, when `pnpm run test` runs, then it fails; the recorded count may be lowered, never raised, and reaches zero before this spec is `implemented`. English text that only the model reads is not user-visible text (BR-17). A negative fixture proves the check can fail.
- **AC-2.6** (US-3) Given a text with parameters (names, counts), when it is shown, then the values are inserted in both languages and singular and plural wording is right in both (for example "1 modelo" / "2 modelos", "1 model" / "2 models").
- **AC-2.7** (US-3) [manual] Given `en`, then the English text is US English (for example "color", "organize"); given `es`, the Spanish copy is the rioplatense it is today. Read a sample of each dictionary.

### Messages, formats and outside services (US-4)
- **AC-3.1** (US-4) Given `en`, when main shows the tray menu and tooltip, a native confirmation dialog or an OS notification it creates, then the text is English; given `es`, Spanish.
- **AC-3.2** (US-4) Given `en`, when the coordinator composes text for the person (an error shown on a conversation, a provider configuration error, a notification title or body, a voice overlay detail, an approval-card note), then it is English; given `es`, Spanish.
- **AC-3.3** (US-4) Given an IPC rejection or a main-side error that reaches the window (for example the rejected-origin error, the cancelled security change, an unknown provider), then its text is in the app language.
- **AC-3.4** (US-8) Given main and the coordinator, then they take user-visible text from the same `es`/`en` dictionaries as the renderer, so AC-2.3 covers them too.
- **AC-3.5** (US-4) [manual] Given `en`, when a native dialog, a tray menu, a Windows notification and a reminder toast are triggered, then each is in English. Trigger each once.
- **AC-3.6** (US-3, US-4) Given `es` (resp. `en`), when dates, times and numbers are shown and when lists are sorted (vault tree, house things and areas, integration names, file listings), then they use the `es-AR` (resp. `en-US`) formats and collation, with 24-hour time in both.
- **AC-3.7** (US-4) Given `en` (resp. `es`), then the language parameters sent to outside services follow it: the DuckDuckGo region (`kl`), the `Accept-Language` of `fetch_url`, the language of the Home Assistant user Alma creates, the language of the Home Assistant config-flow translations Alma requests and the sort of integration names.
- **AC-3.8** (US-4) Given Instagram's page in English, Spanish or Portuguese, when `instagram_publish` looks for its buttons, then it still finds them, and the labels of the app language are always among those tried.
- **AC-3.9** (US-4) Given the code sends a fixed text on Telegram or WhatsApp ("Listo.", the approval prompt, the approval buttons, the bot-command descriptions), when it is sent, then it is in the app language.
- **AC-3.10** (US-4) Given a pending approval on Telegram or WhatsApp, when the person answers yes or no in Spanish or in English, then it is understood whatever `language` is.

### What the model reads, and what the person sees of it (US-7)
- **AC-4.1** (US-7) Given agent instructions the person saved (agent profiles, auto-review instructions, company member instructions), when `language` changes, then they are unchanged in `settings.json` and unchanged in what the model receives, except the migration of AC-8.2 for copies that were never edited.
- **AC-4.2** (US-7) Given any tool, then its description (what the model reads) is English and identical whatever `language` is.
- **AC-4.3** (US-8) Given the prompts Alma writes for the model (voice-mode prompt, context and knowledge blocks added to the system prompt, the attachments block heading, vision prompt, reviewer and boss-review prompts, company and meeting prompts) and the text of `ToolError` and tool results Alma writes, when they are produced under `es` or under `en`, then they are English and identical in both.
- **AC-4.4** (US-4) Given a tool result, a `ToolError` or a reviewer's reason that the person reads (tool card, approval card), when it is shown under `es` (resp. `en`), then it is displayed in Spanish (resp. English) while the model keeps receiving the English text.

### Agent reply language (US-5)
- **AC-5.1** (US-5) Given any agent run (chat turn, routine, company task or meeting, voice turn, channel message), when its request is built, then it carries the same general reply-language rule, "answer in the language the person speaks to you in", whether `language` is `es` or `en`, and no per-language reply directive is added.
- **AC-5.2** (US-5) [manual] Given a message that arrives in English (resp. Spanish) in the app, on Telegram, on WhatsApp or by mail while `language` is the other one, when the agent answers, then the answer is in the language of the message. Send one message in each language on each channel.
- **AC-5.3** (US-5) Given a run with no incoming message from the person (routine, company task, reminder, meeting, house rule), when its request is built, then it tells the model to answer in the app `language`.

### Voice (US-6)
- **AC-6.1** (US-6) Given `en` (resp. `es`), when audio is transcribed with any engine (local Whisper, OpenAI, Meta), then it is transcribed as English (resp. Spanish).
- **AC-6.2** (US-6) Given `en` (resp. `es`), when Alma speaks with any engine (Kokoro, Windows, ElevenLabs), then the fixed phrases she says (fillers, the approval prompt, the voice test sentence, errors, the preparation of links and code blocks) and the pronunciation of the answer (phonemizer language) are English (resp. Spanish).
- **AC-6.3** (US-6) Given `en`, the English models are not on disk and there is no network, when voice is turned on or a turn runs, then the download or failure message shows in the overlay in English, the state follows the offline behavior of spec 019 §7, and the shortcut and the Windows voice still work.
- **AC-6.4** (US-6) [manual] Given `en` with voice on, say a request in English and approve a tool call by voice; then the request is understood, the answer is spoken in English and the approval is read in English.
- **AC-6.5** (US-6) Given `es` or `en`, then the wake phrase that starts a voice turn is "Hey Alma" in both, and "Hola Alma" is no longer a wake phrase.
- **AC-6.6** (US-6) Given a spoken cancel, closing or yes/no in Spanish or in English, when it is parsed, then it is understood whatever `language` is.
- **AC-6.7** (US-6) Given the voice training screen, then the three phrases the person reads are in the app language.
- **AC-6.8** (US-6) Given each language, then it has its own default voice (Kokoro and Windows); given a voice the person already chose, when `language` changes, then that voice is kept.
- **AC-6.9** (US-6) Given a settings file whose wake word is `hola_alma`, when loaded, then it becomes `hey_alma`; `off` stays `off`.
- **AC-6.10** (US-6) Given the "Hey Alma" model file is not in `resources/wakewords/`, when voice is on, then voice keeps working with the previous model, no error is shown, and as soon as the file is present the new model is the one loaded.

### Defaults and stored data (US-5, US-10)
- **AC-8.1** (US-3) Given no `settings.json` and a language in effect at first load, when the defaults are created, then the names, descriptions and system prompts of the default agent profiles, the company templates, the default auto-review instructions and the name given to a new agent are in that language.
- **AC-8.2** (US-3) Given saved default agents, company templates or auto-review instructions that are identical to the shipped defaults, when `language` changes, then they are migrated to the new language; any the person edited are left alone.
- **AC-9.1** (US-10) Given stored threads and messages, when `language` changes, then none is rewritten.
- **AC-9.2** (US-10) Given text Alma generates and stores after a change (routine thread titles, memories, knowledge notes, meeting minutes, company task logs), then it is written in the language in effect when it is generated; what was already written stays as it was.
- **AC-9.3** (US-10) Given a file or folder Alma reads or writes by name (`Alma/Recuerdos.md`, `Alma/Conocimientos/`, `Reuniones/…`, `biblioteca/`, `paletas.json`, `recetas.json`, and the English names in the dictionary), when one exists under either language's name, then that one is used and nothing is renamed or duplicated; when both exist, the one under the current language's name is used and the other is left untouched; when neither exists, it is created under the current language's name.
- **AC-9.4** (US-10) Given a knowledge note marked `origen: ia` or with the English key of the dictionary, then Alma recognizes it as its own whichever language is in effect.

### Docs and gates (US-8)
- **AC-7.1** (US-8) [manual] Given the files in BR-5, when this feature is done, then their prose is English and Spanish file names are English names; quoted UI text may remain in the language of its screen. Check with a search for accented letters and Spanish stop-words outside quotation marks, and a listing of `docs/`.
- **AC-7.2** (US-8) [manual] Given `CLAUDE.md`, `docs/architecture.md` §3 and `.claude/agents/implementer.md`, then none still says user-facing text is Spanish rioplatense; each says text goes through the dictionaries. Read the three lines.
- **AC-7.3** (US-8) [manual] Given the specs amended by this feature (§7.2), then none still states a Spanish literal as the only text of the app; from now on specs cite UI text by dictionary key.
- **AC-7.4** (US-8) [manual] Given the existing test suite, when this feature lands, then it still runs under `es`, none of its assertions was edited except those that assert English tool errors or tool-result text (BR-17) or the old wake phrase (BR-19), and nothing was deleted, skipped or loosened (Constitution II). English cases are added as new tests. Review the diff of `tests/`.
- **AC-7.5** (US-8) [manual] Given a renamed doc, then every reference to its old name (README, specs, ADRs, `.github/pull_request_template.md`, `.github/workflows/ci.yml`, `.claude/agents/quality-checker.md`, the constitution's links) points to the new name, and the constitution is edited only for those links. Search the repo for each old name.
- **AC-7.6** (US-8) [manual] Given the `console-ui` and `umbra-ui` skills, then their text is English; given code comments in `src/` and `tests/`, then they are English (test titles and Spanish assertions stay). Search for accented letters in comments.

## 6. Business rules
- **BR-1** One setting drives language: `language` is `es` or `en`, and the same value governs the renderer's text, the user-facing messages of main and the coordinator, formats and sorting (BR-21), the language parameters sent to outside services (BR-24) and the voice (BR-20). Agents are the exception: they follow BR-14. *(Decided by the human; BR-14 is the human's later answer.)*
- **BR-2** With no saved `language`, the default is the system language; a regional code of Spanish or English counts as that language (`es-MX` is `es`, `en-GB` is `en`); any other or unreadable system language gives `en`. *(Human: "español o inglés, nada más", then "ok" to the proposal.)*
- **BR-3** The setting is edited in the General tab of Configuración, stored in `settings.json`, is not a secret and is part of the public settings; its options are labelled in their own language, «Español» and «English». *(Human: "language" read as the setting, then "ok" to the proposal.)*
- **BR-4** Never rewritten by the app language: prompts the person saved. The tool descriptions the model reads are rewritten once into English and then never change with `language`. *(Human: not translated; "ok" to rewriting descriptions once in English.)*
- **BR-5** All documentation is English: `docs/*.md`, `docs/modules`, `docs/security`, `docs/adr`, `README.md`, `CLAUDE.md`, `docs/pipeline.md`, templates, specs, and the `console-ui` and `umbra-ui` skills; code comments and commit messages too. Spanish file names (`docs/modules/*.md` such as `rutinas.md`, `docs/security/CONTROLES.md`, `RIESGOS.md`, `PRIVACIDAD.md`, `docs/DOMOTICA-PLAN.md`, `docs/desarrollo.md`, `docs/references/*.md`) are renamed to English names; `docs/pipeline.md` already has an English name and keeps it. The constitution links `docs/security/CONTROLES.md`, `RIESGOS.md` and `PRIVACIDAD.md` (Clauses V and III), so those links change. Reason given by the human: "es para presentar". *(Human: "sí porfa toda documentación en inglés"; "ok" to skills, comments and commit messages.)*
- **BR-6** `CLAUDE.md` is updated so it no longer says user-facing text is Spanish rioplatense. The constitution gets no new language clause; it may be edited only to update its links to the renamed files (BR-5). *(Human: "ok" to both proposals.)*
- **BR-7** Design as proposed by the human: typed dictionaries `es.ts` and `en.ts` in `src/shared/`, a `useT()` hook in the renderer, no i18next, a key-parity test, and a ratchet against hardcoded text. See [ADR 0018](../../../docs/adr/0018-typed-dictionaries-no-i18n-library.md).
- **BR-8** The parity test and the hardcoded-text ratchet are gates in `pnpm run test`; the ratchet only ever tightens (Constitution II) and must reach zero. It covers JSX text, attributes, template literals, and user-facing strings in `main` and the coordinator. *(Human: "ok" to the proposal.)*
- **BR-9** Layer rules do not change (Constitution IV): the dictionaries and the resolver are pure data and functions in `shared`, which `renderer`, `main` and `coordinator` may all import; no layer imports another to get a string.
- **BR-10** Resolving a key and filling parameters and plurals is a pure function in `shared` with its own tests, not logic inside components (Constitution III).
- **BR-11** Code identifiers stay in English (unchanged style rule).
- **BR-12** Only `es` and `en` are supported. *(Human: "español o inglés, nada más".)*
- **BR-13** A change of `language` takes effect live, with no restart. A run in progress finishes in the language it started in; dialogs and notifications already shown are untouched; a voice turn in progress finishes and the change applies from the next one. *(Human: "en vivo", then "ok" to the in-flight proposal.)*
- **BR-14** Agents answer in the language the person speaks to them in: a general rule in the request, with no per-language directive injected. The only fallback is a run with no incoming message from the person (routine, company task, reminder, meeting, house rule): then the app `language`. *(Human: "el tiene que responder dependiendo de como le habla el usuario".)*
- **BR-15** What an agent writes on Telegram, WhatsApp and in mail follows the language of the incoming message, through BR-14. The fixed texts the code itself sends on channels follow the app language, and yes/no replies are understood in both languages. *(Human: "del mensaje entrante…" and "ok".)*
- **BR-16** On a new install, the shipped defaults (names, descriptions and system prompts of the default agents, company templates, default auto-review instructions, the name of a new agent) are written in the language in effect at first load. Saved copies are migrated to a new language only if the person never edited them (identical to the shipped default). *(Human: "sí", then "ok" to the proposal. Shipped profiles are user-editable content and follow BR-16; hardcoded scaffolding follows BR-17.)*
- **BR-17** The prompts Alma writes for the model (voice-mode prompt, context and knowledge blocks, attachments block heading, vision prompt, reviewer and boss-review prompts, company and meeting prompts) and the text of `ToolError` and other tool results are English, whatever `language` is. *(Human: "todo en inglés los prompts internos".)*
- **BR-18** Tool results, `ToolError` text and the reviewer's reason that the person reads on cards are shown translated for display, while the model keeps receiving English. *(Human: "ok" to the proposal.)*
- **BR-19** There is one wake phrase, "Hey Alma", the same in both languages; it replaces "Hola Alma", and existing users are migrated. The model for it is a new asset a person must train; the rest of the feature does not depend on it, and until it exists the previous model keeps loading. *(Human: "la activación siempre ey alma, no otra", then "Hey Alma replaces Hola Alma".)*
- **BR-20** Voice follows `language`: STT language for local Whisper, OpenAI and Meta, the phonemizer language, the fixed spoken phrases and the enrollment phrases; cancel, closing and yes/no words are accepted in both languages at once; each language has its own default voice and a voice already chosen is respected. *(Human: "ok" to the proposal.)*
- **BR-21** Dates, times, numbers and list sorting follow `language` with `es-AR` and `en-US` formats and 24-hour time in both. *(Human: "sí porfa", then "ok" to the locales.)*
- **BR-22** Spanish stays rioplatense (voseo) exactly as today; English is US English. *(Human, reversing the earlier "neutro": "dejemos como esta en rioplatense no neutro".)*
- **BR-23** The names Alma writes to disk (`Alma/Recuerdos.md`, `Alma/Conocimientos/`, the frontmatter key `origen: ia`, `Reuniones/<date> <topic>.md`, `biblioteca/`, `paletas.json`, `recetas.json`, and the names of new notes, drawings and the welcome note) follow `language` for new files. When reading or writing, if a file or folder exists under either language's name, that one is used, never renamed or duplicated (if both exist, the current language's); only when none exists is it created under the current language's name. The key `origen: ia` is recognized in both languages. Text inside prompts (the attachments heading, the knowledge block heading) is not a name: it is English per BR-17. *(Human: "sigue el idioma porfa", and the rule was delegated to us: "fijate entonces que conviene en esto". Reason: a language change must never hide existing memories. The "both exist" tie-break is part of the delegated choice.)*
- **BR-24** These follow `language`: the DuckDuckGo region (`kl`), the `Accept-Language` of `fetch_url`, the language of the Home Assistant user, of the config-flow translations and of the integration-name sort. Instagram label matching keeps the English, Spanish and Portuguese list and always includes the app language. *(Human: "siguen el idioma", then "ok" to the Instagram proposal.)*
- **BR-25** Existing tests keep asserting Spanish and run under `es`; they change only where they assert English tool errors or tool-result text (BR-17) or the old wake phrase (BR-19); the voseo stays, so nothing else changes. English behavior is tested with new tests. From now on specs cite UI text by dictionary key. *(Human: "mejor que los tests en español así no tocamos", then "ok".)*
- **BR-26** Stored threads and messages are never rewritten by a language change; text Alma generates afterwards uses the language in effect when it is generated. *(Human: "dependiendo del idioma", then "ok" to the proposal.)*
- **BR-27** Process record: the human answered the questions and said "metele full" (and earlier "hacerlo completo en una pasada, sin parar a preguntar"); the orchestrator took that as the approval and set `status: ready`.

## 7. Constraints and risks
- **Layers touched** (`docs/architecture.md`): `shared` (dictionaries, `Language`, resolver, settings type/default/Zod), `renderer` (hook, every component, `index.html` `lang`, drawing editor `langCode`), `main` (tray, dialogs, notifications, system language, `settings.ts`), `coordinator` (messages, voice stack, prompts, channels, vault/knowledge file names), `preload` (no new channel expected beyond the existing settings ones). Where the system language is read is a plan decision. Live change (BR-13) means the renderer hook re-renders on change and the coordinator applies a changed `language` without restarting; it already receives the full settings on every change (spec 006 AC-3.1).
- **Security / privacy:** no tool, so no `ToolRisk`; no new secret, third party or stored personal data. The language values sent to OpenAI/Meta/DuckDuckGo/Home Assistant change but no new data flow is created. Expected: no change to `docs/security/` beyond translating and renaming it; confirm in the plan. Labelling external text as data must survive the move to English (BR-17).
- **Performance / platform:** both dictionaries ship in the bundle (offline works). English voice models download on first use (spec 019 §7 offline behavior applies). Windows is the only platform.
- **Blocked on a person:** the "Hey Alma" wake-word model (BR-19) is a trained `.onnx` asset an agent cannot produce; until it is in `resources/wakewords/`, AC-6.10 keeps the old model loading, so users say "Hola Alma" in practice while the setting reads `hey_alma`. The default English Kokoro voice (AC-6.8) is a product choice the plan proposes and the human confirms.
- **Free-text translation:** the reviewer's reason (BR-18) is free text from a model, so it cannot be a dictionary entry; the plan must decide how it is shown translated, and whether that costs a model call.
- **Ratchet and English model text:** the hardcoded-text check must tell user-visible text from English text only the model reads (BR-17, AC-2.5); the plan decides how (for example by location or annotation).
- **Tests that pin text today:** `tests/voice.test.ts` (closings, yes/no, spoken-text preparation), `tests/home.test.ts › "rechaza lo inválido con mensajes claros"`, `tests/agent.test.ts` ("Rechazado por vos…", "Bloqueado por el modo de aprobación"), `tests/tools.test.ts`. BR-25 lists which may be edited: those asserting English tool errors/results (now English) or the old wake phrase.
- **Tool input vocabulary not decided:** `home_control` accepts Spanish color names (rojo, verde…) and `calida/neutra/fria` (013 AC-5.4). BR-17 covers descriptions and results, not accepted input values, so they stay as they are.
- **Spec/code mismatch fixed in spec 016 (AC-2.9):** `fetch_url` sends a fixed `Accept-Language: es-AR,es;q=0.9,en;q=0.6` (`src/coordinator/tools/web.ts`) that 016 did not document.
- **Renames reach outside `docs/`:** `.github/workflows/ci.yml` (line 67, `docs/security` and `RIESGOS`), `.github/pull_request_template.md` (line 13), `.claude/agents/quality-checker.md` (line 19) and the constitution (Clause V). `tests/specs.test.ts`, `tests/require-tests.test.ts`, `.claude/agents/router.md` and `.claude/commands/feature.md` mention only `docs/pipeline`, which keeps its name.
- **Hard-to-reverse storage rule:** BR-23 changes what Alma looks for on disk; recorded as [ADR 0019](../../../docs/adr/0019-names-follow-language-existing-wins.md) (proposed).

### 7.1 Flagged discrepancy: the constitution has no language clause
The human's request said the constitution contains "textos al usuario en español rioplatense". `.specify/memory/constitution.md` was read in full:
it has no sentence about language, and a search for `español`, `rioplatense`, `idioma`, `language`, `castellano` and `Spanish` finds nothing.
The rule lived in `CLAUDE.md` line 38 ("Estilo"), `docs/architecture.md` §3 "Estilo", `.claude/agents/implementer.md` line 36,
`README.md` line 37, and specs 023 BR-17, 015 US-6 / BR-9 / BR-13. The human then decided no clause is added to the constitution (BR-6); it is edited only to update the links to renamed files.

### 7.2 Specs amended by this change
Amended with the human's decisions; Spanish text still quoted in older specs is the `es` value of a dictionary key (see `.specify/specs/README.md`). Changed ACs that are not yet covered carry `[gap]`; tests change with their tasks.

| Spec | What changed |
|---|---|
| 006 settings | AC-1.1 and BR-8 (`language` default), AC-1.8, AC-8.5, BR-8 and BR-11 (wake word `hey_alma`, `hola_alma` migrated), BR-9 (defaults per language), new AC-1.17 (migrate unedited defaults), new AC-9.6 (General tab selector), new BR-15 (`language` owned by 025) |
| 023 app shell | BR-17 rewritten (text from dictionaries, live, rioplatense and US English), AC-1.4 and BR-3 (tray follows `language`) |
| 015 file and command tools | US-6, BR-9 (tool messages English, shown translated), BR-13 (descriptions English), AC-1.4, 1.11, 1.19, 1.21, 3.1, 4.2, 4.3, 7.2, 7.4, 7.5, 7.9 (English texts), AC-7.14 (labels follow `language`) |
| 019 voice | wake word "Hey Alma" (§1, AC-1.1, AC-7.9, BR-4, BR-5 with the asset note), AC-3.1 to AC-3.3, AC-4.7, AC-4.9, BR-15, BR-16 (STT and phonemizer follow `language`), AC-4.1, AC-4.4 (per language), AC-5.5, AC-6.2 (both languages), BR-4 (voice default per language), BR-10 (English prompt), BR-14 (phrases per language) |
| 016 web and mail | AC-1.2 (`kl` and header), new AC-2.9 (`Accept-Language`), BR-3 (English prefix), BR-6 (region from `language`), BR-13 (labels follow `language`), new BR-14 (tool results English; Spanish quotes are the previous wording) |
| 008 vault | AC-2.2, AC-2.3 (collation), BR-10 (new-note names), BR-15 (Alma file names) |
| 009 knowledge and memory | BR-1 (names follow language, existing wins, English prompts and results) |
| 002 chat | AC-4.11, AC-5.1 (English attachments heading; legacy heading still folded) |
| 004, 005, 012, 013, 014, 020, 021, 022 | 004 BR-8 (English reviewer prompt, reason shown translated); 005 AC-9.2 and BR-11; 012 BR-9 (app language labels always tried); 013 AC-1.9, AC-4.7, AC-7.3, AC-7.9, AC-7.15, BR-5 (HA language, collation); 014 AC-3.2, AC-5.4; 020 AC-5.6; 021 AC-6.6, BR-5; 022 AC-5.5 |
| 007, 018, 020 | file and title names: 007 BR-12 (`Reuniones`), 018 BR-12 (`Rutina ·` titles), 020 BR-9 (`biblioteca/`, `paletas.json`, `recetas.json`) |
| 010, 011 | fixed channel texts follow `language`, replies follow the incoming message, yes/no in both languages (010 BR-5, 011 BR-2) |
| 024 voice control, model, Meta | no change needed: its quoted texts are `es` values and its rules do not touch language |
| 003, 017 | no change needed |

`tests/specs.test.ts` only checks ids and test citations, so none of these edits can silently break it.

### 7.3 Facts found by reading the code (inputs for the plan, not decisions)
- `toLocaleString('es', …)` or `localeCompare(…, 'es')` appear in about 25 places across renderer, coordinator and `shared/schedule.ts`; `agent.ts` builds the current date with `hour12: false`.
- Defaults say "Respondé en el idioma del usuario." (`src/shared/defaults.ts`); the voice prompt says "en español rioplatense natural" (`src/coordinator/agent.ts`); the vision prompt and reviewer prompts say "en español".
- Voice: `voice-worker.ts` forces Whisper language Spanish and espeak `es-419`; `assistant.ts` sends `language: 'es'` to OpenAI; the Windows voice list is filtered to voices starting `es`; the closings and yes/no vocabulary are Spanish regexes in `speech.ts`; the only wake word model is `hola_alma_v0.1.onnx`. The Whisper ids (`onnx-community/whisper-base|small`) carry no `.en` suffix; confirming they are multilingual is a plan task.
- Instagram label matching already includes English, Spanish and Portuguese (`src/main/instagram.ts`).
- `src/renderer/index.html` has `<html lang="es">`; `DrawingEditor.tsx` passes `langCode="es-ES"`.
- The nine default agents and their prompts are written into `settings.json` on first load, so existing installs hold Spanish copies (006 AC-1.1, AC-1.7, BR-9).

## 8. Open Questions
All answered; nothing unchecked. Answers are the human's words in Spanish (the first round and the second, relayed), applied as written in §5/§6.

- [x] Q1 Fallback language. "español o inglés, nada más"; "ok" to: regional codes map to es/en, anything else or unreadable gives English. (AC-1.1, BR-2, BR-12.)
- [x] Q2 Live or restart. "en vivo"; "ok" to: a run in progress finishes in the old language, open dialogs untouched, a voice turn finishes first. (AC-1.7 to AC-1.10, BR-13.)
- [x] Q3 Channel replies and mail. "del mensaje entrante pero eso supongo el agente lo maneja"; "ok": fixed channel strings follow the app language, yes/no in both languages. (AC-3.9, AC-3.10, AC-5.2, BR-15.)
- [x] Q4 Stored data. "dependiendo del idioma"; "ok": stored messages are never rewritten, text generated afterwards uses the language in effect then. (AC-9.1, AC-9.2, BR-26.)
- [x] Q5 Shipped defaults. "sí"; "ok": saved copies migrated only if unedited. (AC-8.1, AC-8.2, BR-16.)
- [x] Q6 Reply language. First "regla general mejor", then "el tiene que responder dependiendo de como le habla el usuario"; fallback to the app language when there is no incoming message. (AC-5.1, AC-5.3, BR-14.)
- [x] Q7 Built-in prompts and tool results. "todo en inglés los prompts internos"; the reading that shipped profiles follow Q5 and hardcoded scaffolding follows Q7 was confirmed. (AC-4.3, BR-17.)
- [x] Q8 Voice. "la activación siempre ey alma, no otra", confirmed as "Hey Alma" replacing "Hola Alma", with a new model and migration; "ok" to: both-language vocabulary, enrollment phrases and STT language follow `language`, default voice per language and a chosen voice kept, phonemizer follows. (AC-6.1 to AC-6.10, BR-19, BR-20.)
- [x] Q9 Formats and sorting. "sí porfa"; "ok": `es-AR` and `en-US`, 24-hour in both. (AC-3.6, BR-21.)
- [x] Q10 Variants. First "neutro", reversed to "dejemos como esta en rioplatense no neutro"; English is US English. (AC-2.7, BR-22.)
- [x] Q11 Names on disk. "sigue el idioma porfa"; existing files delegated to us ("fijate entonces que conviene en esto"): existing under either name wins. (AC-9.3, AC-9.4, BR-23, ADR 0019.)
- [x] Q12 Outside services. "siguen el idioma". (AC-3.7, BR-24.)
- [x] Q13 Tests and spec citations. "mejor que los tests en español así no tocamos"; "ok": tests run under `es`, edited only for English tool text and the old wake phrase; specs cite UI text by key. (AC-7.3, AC-7.4, BR-25.)
- [x] Q14 Docs scope. "sí pórfa toda documentación en inglés porque es para presentar"; "ok": skills, code comments and commit messages too. (AC-7.1, AC-7.5, AC-7.6, BR-5.)
- [x] Q15 Constitution. "ok": no new language clause; it may be edited only to update links to renamed files. (BR-6, AC-7.5.)
- [x] Q16 Ratchet. Left blank in the first round; "ok" to: it must reach zero and covers JSX text, attributes, template literals, `main` and the coordinator. (AC-2.5, BR-8.)
- [x] Q17 Selector. "language" read as the setting; "ok": General tab, options labelled in their own language. (AC-1.6, BR-3.)
- [x] Q18 What the person sees of English model text. "ok": results, errors and the reviewer's reason shown translated, tool descriptions rewritten once in English. (AC-4.2, AC-4.4, BR-4, BR-18.)
- [x] Q19 Instagram matching. "ok": keeps the en/es/pt list and includes the app language. (AC-3.8, BR-24.)
