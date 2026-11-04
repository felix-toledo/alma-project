# Alma

A desktop agent with subagents. It works with **Claude** (Anthropic) or
**Grok** (xAI), works on a folder of your computer, delegates to subagents that run in parallel and
uses **MCP** connectors.

## Usage

```bash
pnpm install
pnpm run dev        # development with hot reload
pnpm run build      # compiles to out/
pnpm start          # runs what was compiled
pnpm test           # tests (vitest)
pnpm run typecheck
pnpm run check      # lint + typecheck + tests with coverage (the same as CI)
```

In the app, open «Configuración → Proveedores» and load your Anthropic or xAI API key, or both.
You can also define `ANTHROPIC_API_KEY`, `XAI_API_KEY` or `DEEPSEEK_API_KEY` in the environment. Then create a conversation,
choose the working folder (📁) and write a task.

## What it does

| Feature | Detail |
|---|---|
| Providers | Claude through the official SDK (streaming, adaptive thinking, prompt caching, fallback on refusals), Grok through xAI's public API and DeepSeek through its OpenAI-compatible API. Chosen per agent. |
| Tools | `read_file`, `list_dir`, `search_files`, `write_file`, `edit_file`, `run_command` (PowerShell on Windows). All confined to the working folder. |
| Approvals | «Pedir aprobación», «Auto-review» (a reviewer model evaluates each action with your instructions), «Permitir todo», «Solo lectura», and «Siempre permitir» per tool. Reads never ask for approval. |
| Agents | Editable agent profiles (General, Researcher, Programmer, Reviewer, Grok, DeepSeek). The main agent delegates with `delegate_task`, and several delegations run in parallel. Subagents cannot delegate again. |
| MCP | Local (stdio) or remote (HTTPS) servers. Imports `mcp.json` in the standard format (`mcpServers`). Tools appear as `mcp__server__tool`. |
| Images | `generate_image` generates with xAI (default) or OpenAI and saves into `imagenes/`. If you give no model, it uses the newest one your account lists. |
| Image library | `compose_image` builds original images **without an image model** (it works with DeepSeek or with no xAI/OpenAI keys). See below. |
| Instagram | `instagram_publish` publishes with the session you open in «Configuración → Instagram»: you log in on Instagram's page inside the app. It **always** asks for approval and shows the image and text, even if the mode is «Permitir todo». **Test mode** (on by default) completes the post without touching «Compartir». |
| Routines and reminders | **Reminders** (they only notify: a Windows notification, an in-app notice that stays until you close it, and Telegram if connected) and **routines** (an agent does a task on its own, in a new conversation). They can be one-time, at a fixed time or every N minutes/hours. They are created in «Rutinas» or from the chat («haceme acordar…» — remind me…): agents have `create_reminder`, `create_routine` (asks for approval), `list_routines` and `delete_routine`, and receive the local date and time. It includes the «Post diario de Instagram» template. The app stays in the system tray. |
| Telegram | The bot runs inside Alma (long polling; no server). In «Configuración → Telegram» you load the @BotFather token, the allowed users and which agent answers. It only accepts private chats; the first allowed user is bound by chat id. Each chat is one more conversation in the sidebar (/nuevo starts another), approvals arrive with Permitir / Rechazar buttons, audio is transcribed and reminders arrive there. |
| Voice | A voice assistant like ALMA's, **without Python**: wake word (openWakeWord: «Ey Alma») or a global shortcut, verification that it is you (WavLM; in «Configuración → Voz» you read three phrases to train it), transcription with local Whisper or OpenAI, and a spoken answer with Kokoro (espeak-ng), the Windows voices or ElevenLabs (with a voice selector and samples). Everything runs on onnxruntime in a separate thread and the models are downloaded the first time. Approvals are answered by voice («¿sí o no?» — yes or no?). |
| Vault and knowledge | A «Conocimientos» view over a folder of `.md` files: several vaults, a folder tree (create, rename with F2, move by dragging, trash), tabs, an editor with live preview (CodeMirror 6), reading mode and images (`![[foto.png]]` included). Ctrl+O opens a note, Ctrl+N creates another, Ctrl+Shift+F searches and Ctrl+E toggles reading/editing. The index is SQLite (`node:sqlite`) with FTS5 and [sqlite-vec](https://github.com/asg017/sqlite-vec), and the embeddings are **bge-m3** int8 on CPU (about 570 MB, downloaded the first time into `%APPDATA%\Alma\models`). Search combines BM25 and vectors with RRF. With every message the agents receive `Alma/Recuerdos.md` and the most relevant fragments, and have `search_knowledge`, `read_note`, `save_knowledge`, `remember` and `forget`. What Alma saves stays in `Alma/` and is managed from «Lo que sabe Alma». |
| Home automation (Casa) | A **Casa** section: the map of your house and the devices (lights, plugs, cameras, speakers, blinds, climate…), which you handle from the app or by asking Alma through chat, voice, Telegram or WhatsApp. The engine is **Home Assistant**, which Alma installs and manages by itself inside a hidden Linux (WSL2, distro `alma-home`: downloads ~1.2 GB, takes ~3 GB) or connects to if you already have one (URL + token). Brands: Tuya/Smart Life (Moes), eWeLink/Sonoff (SonoffLAN, preinstalled), Tapo and ONVIF, Hue, Chromecast and everything Home Assistant supports: «Agregar dispositivo» draws each brand's forms (account, IP, QR) and the agents do the same with `home_add_device`. The **plan** is Alma's own (top-down 2D, lit lights light up their room): it is built from an Excalidraw drawing, a photo or sketch (vision) or by hand, and edited by dragging. Tools: `home_overview`, `home_find`, `home_control` (lights, plugs, blinds, speakers… without asking permission), `home_secure_control` (locks, alarms and gates: the user always approves), `home_call_service`, `home_add_device`, `home_edit_device`, `home_remove_device`, `home_plan`, `home_plan_edit`, `home_plan_from_drawing`, `home_plan_from_image`, `look_at_image`, `camera_look`, `camera_watch`, `home_scene`, `home_modes`, `home_rules` and `home_history`. Photos are pasted or dragged into the chat (they also arrive through Telegram). Rules: the simple ones (schedules, «si hay movimiento prendé la luz» — if there is motion turn on the light) are Home Assistant automations and spend no AI; the ones that need judgment wake Alma with the event («si la cámara del patio detecta movimiento de noche, mirá y avisame solo si es una persona» — if the patio camera detects motion at night, look and tell me only if it is a person). It is configured in «Configuración → Casa»; each person connects whatever they have. Details in [docs/HOME-AUTOMATION-PLAN.md](docs/HOME-AUTOMATION-PLAN.md). |
| Companies | Teams of agents: org chart, a task board that wakes the agents, meetings with preparation, budgets and approvals from the boss to the user. The «Empresas» section. |
| WhatsApp | Alma linked to your own number as one more device (Baileys, unofficial protocol): you talk to an agent in «Mensajes para mí» (Message yourself) and the agents can read and write to contacts with approval. |
| Web and mail | Internet search, a page reader that does not reach your local network and IMAP/SMTP mail (search, read, send). Sending **always** asks for approval. |
| Office and drawings | Agents read, create and edit real Word, Excel, PowerPoint and PDF files, and draw Excalidraw diagrams inside the vault. |
| Security and privacy | Encrypted secrets, native confirmation for risky settings, a hash-chained audit log, a locked-down window, blocking of private networks in the web tools and file confinement. |
| Persistence | Conversations in `%APPDATA%\Alma\threads`. Configuration goes in `settings.json`, with the API keys encrypted with `safeStorage`. `ALMA_USER_DATA` uses another profile. |

## Instagram bot in 4 steps

1. **«Configuración → Proveedores»:** load the Anthropic key (text) and the xAI key (images).
2. **«Configuración → Instagram»:** tap «Conectar Instagram» and log in. The window closes by itself.
3. In the working folder create a `marca.md` with the tone, the audience, the topics and what to avoid.
4. **«Rutinas → Plantilla: post diario de Instagram».** Choose the folder and the time. When the post is ready you get
   a notification; you review it and tap **Publicar** or **Rechazar**. With test mode on, look at the Instagram
   window and, if everything looks right (above all the line breaks of the text), turn it off.

> Instagram does not allow automating actions without its authorization. If it detects automated posts it may block
> actions or suspend the account. Post sparingly. If its page changes, publishing fails in a controlled way: the
> window stays open so you can finish by hand.

## Image library

`compose_image` combines pieces instead of asking a model for the image. The agent chooses and Alma draws an SVG that the
main process turns into a PNG offline. Both versions stay in `imagenes/`: the PNG to publish and the SVG
to edit.

| Piece | What it brings |
|---|---|
| Templates (12) | titular, cita, anuncio, promo, evento, lista, consejo, tarjeta, dividida, marco, abstracto, minimal |
| Palettes (16) | 4 per aesthetic: «minimalista», «vibrante», «elegante», «orgánico» |
| Fonts (7, offline) | moderna (Outfit), geometrica (Space Grotesk), impacto (Bebas Neue), pop (Pacifico), elegante (Playfair Display), organica (Fraunces), manuscrita (Caveat) |
| Backgrounds (10) | solid, gradient, radial, mesh, dots, grid, stripes, rays, waves, half, and optional grain |
| Shapes (22) | blob, circle, ring, waves, dots, sparkle, star, leaf, sun, confetti, heart, bolt, moon… |

The text fits the space by itself while contrast is taken care of, so it is always readable. With the same `seed` the same
image comes out; changing it gives another variant. The agent can also add its own SVG with `svg_overlay`.

**Your pieces.** Create `biblioteca/` (or `library/`) in the working folder:

```
biblioteca/
  logo.svg         # goes by itself in a corner (also .png/.jpg/.webp)
  flor.svg         # any SVG or image is used by name as an element ("flor"), or as a background with photo
  MiFuente.ttf     # .ttf/.otf/.woff/.woff2 fonts, by name ("mifuente")
  paletas.json     # {"marca": {"background": "#14213d", "background2": "#1f3a6e", "text": "#ffffff", "accents": ["#fca311"]}}
```

If there are palettes of your own and no other is asked for, those are used. If `marca.md` defines colors or a font, the agent passes them.

**Pieces that take color.** An SVG from `biblioteca/` is drawn inside the image, so it respects the element's `color` if it
uses `currentColor`, and `color2` if it uses `style="fill:var(--acento)"`. Your own pieces take priority
over the included shapes with the same name (for example, your own `check.svg` replaces the included check).

**Recipes.** `biblioteca/recetas.json` stores ready-made combos (template, palette, fonts, background and pieces). The agent
asks for `recipe: "promo"` and fills in only the texts; whatever else is passed changes the recipe, and its `elements` are added.
With `"decorations": false` the template's own shapes are not drawn.

```json
{ "promo": { "template": "promo", "palette": "marca", "font": "mifuente", "decorations": false,
             "elements": [{ "type": "flor", "x": 0.8, "y": 0.2, "size": 0.3, "color": "texto", "color2": "acento" }] } }
```

## What is in this repo

### Code (`src/`)

The renderer talks to the coordinator through a direct `MessagePort`, without going through the main process.

```
src/main/         main process: window, tray, notifications, encrypted settings, guards, Instagram browser
src/preload/      secure bridge (contextIsolation + sandbox): window.desktop
src/coordinator/  utilityProcess: what does the work
  agent.ts          agent loop (provider-neutral), subagents
  approval.ts       approval modes and auto-review
  providers/        Anthropic, xAI (and DeepSeek / OpenAI-compatible gateways)
  tools/            files, commands, web, mail, images, Office, routines, Telegram, WhatsApp, home, companies
  channels/         Telegram and WhatsApp
  knowledge/        SQLite index (FTS5 + sqlite-vec), bge-m3 embeddings, memory
  company/          companies engine and store
  home/             home automation: Home Assistant, 2D plan, cameras, rules
  voice/            voice assistant in JS (openWakeWord, STT, TTS) in a worker
  compose/          image library (compose_image)
  mcp.ts · routines.ts · images.ts · vision.ts · privacy.ts · store.ts
src/renderer/     React UI (console style)
  components/       chat, messages, tool cards, settings, routines, sidebar
  vault/            Markdown notes, CodeMirror editor, drawings, document preview
  companies/ · home/ · voice/ · umbra/ (design system) · lib/
src/shared/       types, protocol and pure logic used by 2 or more layers
```

Layer rules (`shared` ← `main`, `coordinator`, `renderer`; nobody imports sideways) and where each thing goes: [docs/architecture.md](docs/architecture.md). `tests/architecture.test.ts` enforces them.

The agent loop ([src/coordinator/agent.ts](src/coordinator/agent.ts)) is provider-neutral. The history is append-only and Claude's content is resent untouched (with its signed thinking blocks). Tool inputs are validated with Zod before running. If a turn is cut off by a token limit or a refusal, its tools are not run.

### Documentation (`docs/`)

| Where | What it is |
|---|---|
| [docs/context.md](docs/context.md) | Glossary of already-settled domain terms |
| [docs/architecture.md](docs/architecture.md) | Processes, layers and where each new thing goes |
| [docs/development.md](docs/development.md) | Guide to install, run, test and extend Alma on Windows |
| [docs/pipeline.md](docs/pipeline.md) | The route from an idea to production and which gate stops you at each stretch |
| [docs/modules/](docs/modules) | One document per module (chat, agents, approvals, providers, settings, companies, vault and knowledge, Telegram, WhatsApp, Instagram, MCP, routines, voice, images, Office, web and mail, home, security, app shell): what it does, how it is used, how it works |
| [docs/references/](docs/references) | Reference tables written by hand against the code: settings, data on disk, tools, limits, IPC messages |
| [docs/adr/](docs/adr) | Architecture decisions (ADR 0001 to 0019) |
| [docs/security/](docs/security) | Controls (SOC 2 / ISO 27001 / 27701), privacy and open risks |
| [docs/HOME-AUTOMATION-PLAN.md](docs/HOME-AUTOMATION-PLAN.md) | Plan and status of the home automation module |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability |

### Specifications (`.specify/`)

- `memory/constitution.md`: the project's constitution. If anything contradicts it, it wins.
- `specs/NNN-name/`: one folder per feature with `spec.md`, `plan.md` and `tasks.md` (001 packaging, 002 chat, 003 agents, 004 approvals, 005 providers, 006 settings, 007 companies, 008 vault, 009 knowledge and memory, 010 Telegram, 011 WhatsApp, 012 Instagram, 013 and 014 home, 015 files and commands, 016 web and mail, 017 MCP, 018 routines, 019 voice, 020 images, 021 Office and drawings, 022 security, 023 app shell and UI, 024 voice control, models and Meta, 025 language es/en). Each acceptance criterion cites the test that covers it, or is marked `[gap]` (the test is missing) or `[manual]` (checked by hand). Index in [.specify/specs/README.md](.specify/specs/README.md).
- `templates/`: templates for spec, plan, tasks and a guide to writing the documentation.

### Tests (`tests/`)

Vitest. They cover agent, tools, providers, MCP, Telegram, routines and schedules, knowledge, companies, home, voice, media, Office, web, audit and guards. `architecture.test.ts` checks the layers, `specs.test.ts` validates each spec and `require-tests.test.ts` the policy «if the logic changes, the tests change». `tests/fixtures/` has an echo MCP server and `tests/support/` the architecture and spec helpers.

### Gates, hooks and CI

- `pnpm run check` = lint (Biome) + typecheck + tests with coverage + test policy, the same as CI runs. `check:fast` is the same without coverage.
- `.githooks/` (activated by themselves with `pnpm install`): `pre-commit` (lint of what is staged), `commit-msg` (format `type(area): summary` and no AI co-authorship) and `pre-push` (`pnpm run check`).
- `.github/`: CI workflow (`quality`, `verify`, `audit`), Dependabot and a pull request template.
- `scripts/`: `require-tests.mts` (demands tests when logic changes) and `hooks/` (lint after each edit and a gate at the end, for the agent).

### AI agents for working in the repo (`.claude/` and `.agents/`)

- `agents/`: `router` (decides the size and the stage), `planner` (specs), `implementer` (code, one task at a time), `tester` (verifies against the spec) and `quality-checker` (technical quality).
- `commands/`: `/feature <idea>`, `/fix <bug>` and `/check`.
- `skills/`: domain modeling, interviews to clarify specs and the `umbra-ui` design system (a copy in `.agents/skills/`).
- `settings.json`: hooks that run the scripts above. Rules for agents: [CLAUDE.md](CLAUDE.md).

### Other

- `resources/`: app and tray icons, and the wake-word model (`wakewords/`).
- `package.json`, `pnpm-lock.yaml`, `electron.vite.config.ts`, `tsconfig*.json`, `biome.json`, `vitest.config.mts`: dependencies and configuration for build, types, lint and tests.

## Common problems

- **The app does not open and `Cannot read properties of undefined (reading 'whenReady')` appears**: the variable
  `ELECTRON_RUN_AS_NODE` is defined in your terminal (it happens in some extension terminals). Remove it
  before `pnpm run dev`.
- **«Falta la API key»** (the API key is missing): load it in «Configuración → Proveedores».
- **Grok model**: if the field is left empty, the newest Grok your account lists is used. With ↻ you can
  fetch the list of available models.
- **DeepSeek for images?** Its API does not generate images: use xAI or OpenAI, or the image library (`compose_image`), which needs none.
- **Testing the Instagram automation**: `ALMA_INSTAGRAM_URL` points the app at a local page that imitates
  Instagram, to test without touching a real account.
