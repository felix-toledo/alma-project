# Developer guide

How to set up, run, test and extend Alma on a Windows machine. For the rules behind the layers read [architecture.md](architecture.md); for how a change travels from idea to `main` read [pipeline.md](pipeline.md); for the vocabulary read [context.md](context.md). Decisions that look odd in the code are explained in [adr/](adr/README.md).

## 1. Requirements

| Need | Value | Where it comes from |
|---|---|---|
| OS | Windows 11 (Windows 10 also works for the app; the house engine needs WSL2) | CI `verify` job runs on `windows-latest`; [spec 013](../.specify/specs/013-house-engine-and-devices/spec.md) |
| Node | A current LTS. There is no `engines` field and no `.nvmrc`; CI uses `node-version: lts/*`. The dev machine this was checked on runs v24.22.1. | `.github/workflows/ci.yml` |
| pnpm | 12 | CI `pnpm/action-setup` with `version: 12`; `package.json` has no `packageManager` field |
| Git | Any recent; hooks are plain `sh` scripts run by Git for Windows | `.githooks/` |
| Electron | 44.x, comes with `pnpm install` (`electron ^44.7.2`). It brings its own Node (24.x), which the app uses for `node:sqlite`. | `package.json` |

Tests run in plain Node (Vitest), not inside Electron, so the Node on your PATH must also support `node:sqlite` (Node 24 does).

## 2. Install, run, build

```powershell
pnpm install          # also runs `prepare`, which sets git config core.hooksPath .githooks
pnpm run dev          # electron-vite dev: renderer hot reload
pnpm run build        # electron-vite build, output in out/
pnpm start            # electron-vite preview: runs what was built
```

- **Never use `npm install` or `npm audit fix`.** They rewrite `node_modules` with npm packages and break it ([ADR 0014](adr/0014-pnpm-as-package-manager.md)). `README.md` still shows `npm` commands: use the `pnpm` equivalents above.
- `pnpm run dev` hot-reloads the renderer only. After changing anything in `src/coordinator/` or `src/main/`, **restart the app**; check the process start time if someone reports old behavior.
- `electron.vite.config.ts` builds four entries for main: `index`, `coordinator`, `embedWorker` and `voiceWorker`. Excalidraw fonts are copied from `node_modules` into `src/renderer/public/excalidraw/` on build start (git-ignored).
- There is no installer yet: release packaging is [spec 001](../.specify/specs/001-release-packaging/spec.md), still a draft. Today a release is `pnpm run build` and a tag by hand ([pipeline.md](pipeline.md), stage 10).

## 3. Scripts

| Command | What it does |
|---|---|
| `pnpm run dev` / `build` / `start` | Develop / compile to `out/` / run the compiled app |
| `pnpm run typecheck` | `tsc --noEmit` for `tsconfig.node.json` (main, preload, coordinator, shared, tests, scripts) and `tsconfig.web.json` (renderer) |
| `pnpm run lint` | Biome, errors only (`--diagnostic-level=error`). This blocks. |
| `pnpm run lint:debt` | Biome warnings, first 50 (`--max-diagnostics=50`). Debt, not a gate ([ADR 0016](adr/0016-biome-lint-only-no-formatter.md)). |
| `pnpm run test` | Vitest run: behavior tests plus the architecture and spec checkers |
| `pnpm run test:coverage` | Same with v8 coverage; fails under the floor in `vitest.config.mts` (lines 53, statements 50, functions 48, branches 41). The floor only goes up. |
| `pnpm run check:tests` | `node scripts/require-tests.mts`: rejects a diff that changes logic in `src/{coordinator,shared,main}` without changing a test. Exception: `[no-tests: real reason]` in a commit message or PR body. |
| `pnpm run check:fast` | `lint` + `typecheck` + `test` (no coverage). What the stop hook runs. |
| `pnpm run check` | `lint` + `typecheck` + `test:coverage` + `check:tests`. The same gates as CI. |

Run one test file, or one test by name, with Vitest directly:

```powershell
pnpm exec vitest run tests/knowledge.test.ts
pnpm exec vitest run tests/tools.test.ts -t "rejects paths that escape the workspace"
```

Tests are named after the acceptance criteria they verify (`it('AC-2.1 …')`). Filesystem tests use a temp folder per test; network is mocked with `vi.mock`; providers use the fake `Provider` from `tests/agent.test.ts` ([architecture.md](architecture.md) section 5).

## 4. Git hooks

`.githooks/` is activated by `prepare` (`git config core.hooksPath .githooks`) on every `pnpm install`. `.gitattributes` forces LF on them so Git for Windows can run them.

| Hook | What it does |
|---|---|
| `pre-commit` | `biome lint --staged` (skipped silently if Biome is not installed in `node_modules`) |
| `commit-msg` | Message must match `type(scope): summary` with type `feat|fix|refactor|test|docs|chore|ci|perf|build`. Rejects a `Co-Authored-By` trailer naming Claude or Anthropic. Merge, revert, fixup and squash messages pass. |
| `pre-push` | `pnpm run check`. Skip once with `git push --no-verify`; CI still runs everything. The project rule is never to skip it ([CLAUDE.md](../CLAUDE.md)). |

Separate from Git, `.claude/settings.json` wires two agent hooks: after each edit, Biome runs on that file (`scripts/hooks/post-edit.mts`); when the agent stops, `check:fast` runs if code changed since the last green run (`scripts/hooks/stop-gate.mts`; after 3 reds in a row it stops blocking).

## 5. CI jobs and their local equivalents

`.github/workflows/ci.yml`, on pushes to `main` and on pull requests:

| Job | Runs on | Steps | Local equivalent |
|---|---|---|---|
| `quality` | ubuntu | `biome lint --diagnostic-level=error`; on PRs `require-tests.mts origin/<base>` | `pnpm run lint` and `pnpm run check:tests` |
| `verify` | windows | `typecheck`, `test:coverage` (includes `architecture.test.ts` and `specs.test.ts`), `build`; uploads `coverage/` | `pnpm run typecheck`, `pnpm run test:coverage`, `pnpm run build` |
| `audit` | ubuntu | `pnpm audit --audit-level=high`, `continue-on-error: true` | `pnpm audit --audit-level=high` (informational while R-01 is open) |

`pnpm run check` covers everything except `build` and `audit`.

## 6. Project layout

```
.claude/            agents (router, planner, implementer, tester, quality-checker), commands (/feature /fix /check), skills, hook wiring
.githooks/          git hooks (section 4)
.github/workflows/  ci.yml
.specify/           memory/constitution.md, specs/NNN-slug/spec.md (the contract), templates/
docs/               human documentation; adr/ decisions, modules/ per-module guides, references/ lookup tables, security/ controls and risks
resources/          icon.png, tray.png, wakewords/ (the shipped wake word model)
scripts/            require-tests.mts (tests-with-logic gate), hooks/ (agent hook scripts)
src/main/           Electron main: window, tray, settings (safeStorage), guard.ts (native confirmations), instagram.ts, render.ts (SVG to PNG)
src/preload/        the window.desktop bridge (contextIsolation, sandbox)
src/coordinator/    the utilityProcess: agent.ts (run loop), approval.ts, store.ts (threads), mcp.ts, routines.ts, privacy.ts, vision.ts, images.ts
  channels/         telegram.ts, whatsapp.ts
  company/          engine.ts (wake-ups, tasks, meetings, budgets), store.ts
  compose/          compose_image library and renderer of SVG compositions
  home/             Home Assistant: engine.ts (WSL install/run), ha.ts, hub.ts, flow.ts, model.ts, plan.ts, triggers.ts
  knowledge/        base.ts (index and search), db.ts, embedder.ts, embed-worker.ts, markdown.ts, tools.ts
  providers/        anthropic.ts, xai.ts (also DeepSeek, Vercel, Meta), index.ts, types.ts
  tools/            one file per tool family, index.ts (builtinTools), types.ts (ToolDefinition, ToolRisk), office/ (docx, xlsx, pptx, pdf)
  voice/            assistant.ts, speech.ts, voice-worker.ts
src/renderer/src/   React UI: components/ (chat, settings, sidebar), vault/, companies/, home/, voice/, umbra/ (console design system), lib/
src/shared/         types and pure logic used by 2+ layers: types.ts, defaults.ts, desktop-api.ts, audit.ts, company.ts, home.ts, schedule.ts…
tests/              Vitest; support/ holds arch.ts and specs.ts (the checker engines), fixtures/
out/, coverage/     generated, git-ignored
```

For per-feature detail see the module guides in [modules/](modules/): [chat](modules/chat.md), [agentes](modules/agentes.md), [aprobaciones](modules/aprobaciones.md), [providers](modules/providers.md), [configuraciones](modules/configuraciones.md), [empresas](modules/empresas.md), [vault-y-conocimiento](modules/vault-y-conocimiento.md), [telegram](modules/telegram.md), [whatsapp](modules/whatsapp.md), [instagram](modules/instagram.md), [voz](modules/voz.md), [casa](modules/casa.md), [mcp](modules/mcp.md), [archivos-y-comandos](modules/archivos-y-comandos.md), [web-y-correo](modules/web-y-correo.md), [imagenes](modules/imagenes.md), [office-y-dibujos](modules/office-y-dibujos.md), [rutinas](modules/rutinas.md), [seguridad](modules/seguridad.md), [app-shell](modules/app-shell.md). Lookup tables: [herramientas](references/herramientas.md), [ajustes](references/ajustes.md), [datos](references/datos.md), [mensajes-ipc](references/mensajes-ipc.md), [limites](references/limites.md). Backlog: [mejoras](mejoras.md).

## 7. How a feature travels

Start with `/feature <idea>` (or `/fix <bug>`); the `router` agent picks the path by size. A feature goes Specify, Clarify, Plan, Tasks, Implement, Verify, PR, CI. Humans approve the spec (`status: ready`) and the merge. Logic is written test-first; a spec with an unchecked Open Question cannot go past Clarify (`tests/specs.test.ts`). Chores (docs, deps, renames with no behavior change) go straight to a PR. Full detail, gates and definition of done: [pipeline.md](pipeline.md). Branches are `feat/…` or `fix/…`.

## 8. Adding things

The table of where each kind of change goes is [architecture.md](architecture.md) section 4. Practical details checked in the code:

| To add | Steps |
|---|---|
| **A tool** | Create `src/coordinator/tools/<name>.ts` exporting a `defineTool({...})` with name, `risk`, Zod input schema and `run`. Register it: file/command/image/Office tools go in `builtinTools` in `tools/index.ts`; tools every agent should get (like the house, mail or WhatsApp tools) are added where the app tools are assembled in `agent.ts`. Pick `risk` carefully; anything that acts outward in the person's name is `publish` and always asks. If the right risk is unclear, it is an Open Question, not `read`. Add a test and, if it opens a new data flow, a row in `docs/security/`. |
| **A channel** | `src/coordinator/channels/<name>.ts`, one implementation per channel (the way Telegram and WhatsApp are). Decide who may talk to it (owner only), how approvals are answered there, and add its settings and an entry in `docs/security/`. |
| **A provider** | Implement the `Provider` interface (`providers/types.ts`) in `src/coordinator/providers/` and wire it in `getProvider` (`providers/index.ts`); test with a fake provider like `tests/providers.test.ts`. Add its secret slot and env var (section 10). |
| **A setting** | Type in `src/shared/types.ts`, default in `src/shared/defaults.ts`, read/write and merge in `src/main/settings.ts`, a control in `SettingsDialog.tsx`. If the setting makes Alma run new code, route it through `src/main/guard.ts` for a native confirmation. A secret goes in a secret slot, never in plain settings. |
| **A screen** | `src/renderer/src/<area>/`, using the `console-ui` and `umbra-ui` skills; rules go to `shared/` with a test, since the renderer has no component tests. |

Layer rules are enforced: if `pnpm run test` fails in `tests/architecture.test.ts`, you imported across a boundary.

## 9. Debugging

- **Coordinator output.** `main` forks it with `stdio: 'inherit'`, so `console.error('[coordinator] …')` lines appear in the terminal that runs `pnpm run dev`. The design notes report that output does not reach a redirected stdout on Windows: if you pipe it to a file and see nothing, use a plain terminal, UI events or the audit trail.
- **Audit trail.** `<userData>/audit/*.jsonl`, one file per month and process (`coordinator`, `main`), each line chained by SHA-256. It records tool authorizations and executions that are not reads (and who allowed them), settings changes, denials, publications, exports and erasures. It stores identifiers, not message content. The default `<userData>` is `%APPDATA%\Alma`.
- **A clean profile.** Start with `ALMA_USER_DATA` pointing to an empty folder to test without touching your real data. On first launch without `settings.json`, a previous `%APPDATA%\MultiAgente` profile is copied once (only when `ALMA_USER_DATA` is not set).
- **Driving the window.** The design notes verified the real UI with an isolated instance: `ALMA_USER_DATA=<dir>` plus `electron . --remote-debugging-port=9339`, and closing it only by the PID that listens on that port. Whether a DevTools shortcut is bound in the window was not verified.
- **Knowledge index.** It is disposable: delete `<userData>/knowledge/*.db` to force a full re-index. Models are in `<userData>/models`.
- **Instagram flows.** `ALMA_INSTAGRAM_URL` points the app at a local stand-in page so you never touch a real account.
- **Reading old behavior.** If a report contradicts the code, first confirm the app was restarted after the last coordinator change.

## 10. Environment variables

| Variable | Used for | Where |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude key when none is stored. `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_PROFILE` (or an `~/.config/anthropic` profile) also make the SDK work, though Settings may still say "Sin configurar" | `providers/anthropic.ts` |
| `XAI_API_KEY` | Grok key | `providers/xai.ts` |
| `DEEPSEEK_API_KEY` | DeepSeek key | `providers/xai.ts` |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway key | `providers/xai.ts` |
| `OPENAI_API_KEY`, `META_API_KEY`, `ELEVENLABS_API_KEY` | Image generation and cloud speech-to-text or text-to-speech | `voice/assistant.ts`, `images.ts`, `vision.ts` |
| `TELEGRAM_BOT_TOKEN` | Bot token when none is stored | `main/settings.ts` |
| `ALMA_USER_DATA` | Use another user-data folder (isolated profile) | `main/index.ts` |
| `ALMA_ALLOW_PLAINTEXT_SECRETS=1` | Allow storing secrets unencrypted when the OS has no secure store. Off by default. | `main/settings.ts` |
| `ALMA_INSTAGRAM_URL` | Replace `https://www.instagram.com` with a local stand-in for tests | `main/instagram.ts` |
| `ALMA_HOME_DISTRO` | Name of the WSL distro (default `alma-home`); tests use another one | `home/engine.ts` |
| `ALMA_HOME_DEMO` | Adds Home Assistant's `demo:` integration to its config, for trying the house without devices | `home/engine.ts` |
| `ALMA_HOME_INSTALL`, `ALMA_HA_URL`, `ALMA_HA_TOKEN`, `ALMA_HA_ONBOARD`, `ALMA_HA_TOKEN_FILE` | Switch on the real-Home-Assistant tests (section 11) | `tests/home-live.test.ts` |
| `ELECTRON_RENDERER_URL` | Set by electron-vite in dev so the window loads the dev server | `main/index.ts` |

Environment variables that hold provider keys are read but never written to settings, and `run_command` strips the known ones from the environment of commands the model runs (`commandEnv()` in `tools/shell.ts`). Secret values are never written in this repo; they live encrypted in `<userData>/settings.json` ([ADR 0013](adr/0013-secrets-with-safestorage.md)).

## 11. Known environment problems

- **Windows locks `node_modules`.** `pnpm install` or `pnpm add` can fail with "Acceso denegado" ("Access denied") or on `pino` when files are in use. Close Alma (including its tray icon), any running Electron from this repo, and VS Code (the TypeScript server holds files) before installing.
- **Never `npm install` / `npm audit fix`.** They produce a mixed tree and a huge lockfile; `package-lock.json` is obsolete (R-10). If it already happened, reinstall with pnpm and everything closed.
- **A hand-patched `.bin`.** The design notes say `node_modules/.bin/vitest` and `biome` shortcuts were created by hand because `pnpm add` failed; a clean `pnpm install` with everything closed regenerates them.
- **`blockExoticSubdeps` and libsignal (R-01).** Re-resolving the dependency tree fails with `ERR_PNPM_EXOTIC_SUBDEP` because `baileys` pulls `libsignal` from git. Disabling the policy is a decision for the maintainer, not something to do to get unstuck; it also blocks the pending security upgrades (Electron, nodemailer). See [RIESGOS.md](security/RIESGOS.md) R-01 and [ADR 0014](adr/0014-pnpm-as-package-manager.md). To change dependencies without touching `node_modules`: `pnpm add … --lockfile-only`. Pin new dependencies to versions at least two weeks old.
- **PowerShell vs Git Bash.** Inline variables differ: bash `ALMA_USER_DATA=C:\tmp\x cmd` versus PowerShell `$env:ALMA_USER_DATA = 'C:\tmp\x'; cmd`. Git Bash rewrites arguments such as `/bin/sh` passed to `wsl.exe`: use PowerShell for anything that calls `wsl`. A GNU `tar` earlier in PATH reads `C:` as a remote host, which is why the engine calls `System32\tar.exe` explicitly. Never kill every `wsl.exe` process: you may have other distros running.
- **`ELECTRON_RUN_AS_NODE`.** If it is set in your terminal (some editor terminals do), Electron runs as plain Node and `pnpm run dev` fails with `Cannot read properties of undefined (reading 'whenReady')`. Unset it first.
- **JSON written by hand with a BOM.** PowerShell can write `settings.json` with a BOM; Alma then silently loads defaults. Write it without BOM.
- **CRLF vs LF.** `.gitattributes` forces LF only for `.githooks/*` and `*.sh`; a CRLF hook breaks under `sh`. Elsewhere Git's autocrlf applies. Tests that touch text must tolerate Windows paths and CRLF ([constitution](../.specify/memory/constitution.md), Clause III).
- **Real Home Assistant tests are skipped by default.** `tests/home-live.test.ts` has two blocks. The first runs only when `ALMA_HA_URL` is set (with `ALMA_HA_TOKEN`; `ALMA_HA_ONBOARD=1` on a fresh Home Assistant creates the account and writes the token to `ALMA_HA_TOKEN_FILE`, default `ha-token.txt`). The second does a real install, about 1.2 GB downloaded and a WSL import, and runs only when `ALMA_HOME_INSTALL` is set; use a test distro name, for example `ALMA_HOME_INSTALL=1 ALMA_HOME_DISTRO=alma-home-test pnpm exec vitest run tests/home-live.test.ts -t "motor"`. With neither set, both are reported as skipped and `pnpm run test` stays green.

## 12. What is missing or wrong

- `README.md` still documents `npm` and an older feature list; this guide is the source for commands ([ADR 0014](adr/0014-pnpm-as-package-manager.md)).
- No `engines` field, `.nvmrc` or `packageManager` field, so Node and pnpm versions are only pinned by CI (R-10 touches the same area).
- No formatter and about 548 Biome warnings of debt ([ADR 0016](adr/0016-biome-lint-only-no-formatter.md)).
- No installer, signing or auto-update: [spec 001](../.specify/specs/001-release-packaging/spec.md) and R-06.
- The renderer has no component tests; its behavior is verified by typecheck, lint and a manual run.
- Branch protection on `main` and the security contact in `SECURITY.md` are still pending ([pipeline.md](pipeline.md), "Pendientes que solo se hacen en GitHub").
