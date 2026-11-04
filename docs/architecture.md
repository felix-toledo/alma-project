# Alma's architecture

What the pieces are, what can talk to what, and where each new thing goes. The rules in section 2 are not a guideline: `tests/architecture.test.ts` enforces them on every `pnpm test`.

## 1. Processes and layers

```
┌──────────── renderer (React) ─────────────┐        src/renderer
│  UI. No disk, no network, no node.        │
└───────────────┬───────────────────────────┘
        window.desktop (preload, typed in shared/desktop-api.ts)
┌───────────────▼───────────────────────────┐
│  main (Electron)                          │        src/main + src/preload
│  windows, tray, settings, native          │
│  dialogs, Instagram session               │
└───────────────┬───────────────────────────┘
        MessagePort: RequestEnvelope / CoordinatorMessage (typed in shared/types)
┌───────────────▼───────────────────────────┐
│  coordinator (utilityProcess)             │        src/coordinator
│  agents, tools, providers, channels,      │
│  knowledge, home automation, voice        │
└───────────────────────────────────────────┘
   shared (src/shared): types, schemas and pure functions used by 2+ layers
```

| Layer | Owns | Never |
|---|---|---|
| `shared` | types, defaults, shared pure logic | import another layer |
| `renderer` | pantallas y estado de UI | importar `main`/`coordinator`, `electron`, `node:*`, `shared/audit` |
| `main` | windows, settings on disk, native dialogs, secrets (`safeStorage`) | import `coordinator`/`renderer` |
| `coordinator` | everything that thinks or does I/O for an agent | import `main`/`renderer`; touch `electron` outside `index.ts` |

Only typed messages travel between layers. If two layers need the same thing, it goes to `shared` (if it is pure) or a message is sent (if not).

## 2. Rules that check themselves

They are in `tests/support/arch.ts` (`RULES`), each with a negative case in `tests/architecture.test.ts` so they do not pass empty. Biome also rejects import cycles (`noImportCycles`).

To add a rule: a new entry in `RULES` + a fixture in the test that breaks it. To loosen one: talk about it first (Constitution II).

## 3. How the code is written

**Functional core, imperative shell.** The decision lives in a pure function, exported and tested; the I/O is a thin shell around it. Examples: `src/main/guard.ts` (`newCommands`), `src/coordinator/tools/web.ts` (`isPrivateHost`, `htmlToText`, `parseDuckDuckGo`).

**Dependency injection.** A tool receives what it needs through `ToolContext` / `Host` (working folder, settings, `signal`, vault, Telegram, WhatsApp, the house). It does not import singletons or read global state. That is what lets the test hand it a double.

**Validate at the edge, trust inside.** Zod for: tool inputs, IPC messages, settings read from disk, everything that comes from the network.

**Variation by strategy.** Providers (`providers/`), channels (`channels/`): one interface and one implementation per case, not a growing `if` in the caller.

**Style.** Match the code next to it: no semicolons, single quotes, identifiers in English, user-facing text through the dictionaries in `src/shared/i18n` (Spanish and English), comments only for the non-obvious *why*; docs, skills, code comments and commit messages are English. Biome flags the obvious; there is no automatic formatter yet (see the debt in `docs/pipeline.md`).

## 4. Where new things go

| I want to add… | It goes in | And also |
|---|---|---|
| A tool for agents | `src/coordinator/tools/<name>.ts` exporting `ToolDefinition` (name, `risk`, Zod schema, `run`) | register it where its siblings are registered (`tools/index.ts` or `agent.ts`); choose `risk` carefully (`publish` if it acts outward on the user's behalf); a test in `tests/` |
| A channel (like Telegram) | `src/coordinator/channels/` | approvals and allowed-user limits; an entry in `docs/security/` |
| A model provider | `src/coordinator/providers/` implementing `Provider` | a test with a fake provider, like `tests/providers.test.ts` |
| A setting | type and default in `shared/types` and `shared/defaults`; read/write in `main/settings.ts`; screen in `SettingsDialog` | if it runs new code, a native confirmation (`main/guard.ts`) |
| A screen | `src/renderer/src/<area>/`, with the `console-ui` and `umbra-ui` skills | logic with rules goes to `shared/` + a test |
| A business rule | pure function in `shared/` (or next to the tool) | spec first (Constitution I) |

## 5. Tests

- They live in `tests/<area>.test.ts`; shared doubles and utilities in `tests/support/`.
- They name the criterion they verify: `it('AC-2.1 rejects private hosts', …)`. That way `tests/specs.test.ts` can check that every AC of an `implemented` spec has a test.
- File system: a temp folder per test (`mkdtempSync`) and cleanup in `afterEach`. Network: `vi.mock` of the module, never the real internet. Providers: the fake `Provider` of `tests/agent.test.ts`.
- A new test is seen to fail first (Constitution III).
- The renderer has no component tests: typecheck, lint and a manual run cover it. That is why its logic is pulled out into `shared/`.
