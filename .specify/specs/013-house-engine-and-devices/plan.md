# 013 — Plan

## 1. Approach
Home Assistant (HA) is the engine and the source of truth for devices; Alma adds a thin layer on top. The coordinator runs four cooperating parts: an engine (`HomeEngine`) that installs and supervises a hidden WSL2 distro `alma-home` running HA (or connects to an external HA by URL and token), a client (`HaClient`) for HA's WebSocket and REST APIs, a hub (`HomeHub`) that mirrors states and registries and emits live snapshots, and pure modules for the device model (`model.ts`) and the config-flow forms (`flow.ts`). Agents and the Casa window go through the same hub. Risk is by tool: everyday control is `home` (never asks), locks, alarms and gates go through a separate `publish` tool that asks on every call.
Rejected: installing HA Core with `pip` in a plain Ubuntu distro (slower, more fragile, and Python dependencies to maintain); the official container image exported with `crane` and imported as a distro is reproducible and needs no Docker. An external HA stays a supported mode. See [ADR 0007](../../../docs/adr/0007-home-assistant-in-hidden-wsl2.md).

## 2. Layers touched
| Layer | Files (new / changed) | Why it lives there |
|---|---|---|
| shared | `src/shared/home.ts` (`HomeSettings`, `HomeEngineStatus`, `HomeThing`, `HomeSnapshot`, `FlowStep`, `FlowField`, `DEVICE_DOMAINS`, `isSensitive`, `POPULAR_INTEGRATIONS`), `src/shared/types.ts` (`home.*` requests and events), `src/shared/defaults.ts` (default `home`) | Vocabulary used by the coordinator tools and the Casa window; `isSensitive` is pure |
| coordinator | `src/coordinator/home/engine.ts`, `ha.ts`, `hub.ts`, `flow.ts`, `model.ts`, `index.ts` (`HomeService`), `src/coordinator/tools/home.ts` (device tools), `src/coordinator/agent.ts` (tool registration, Casa guide), `src/coordinator/index.ts` (`createHome`, request routing) | The engine process, network clients and tools must not run in the window; the coordinator has no `electron` import |
| main | `src/main/settings.ts` (merge `home` over defaults), `src/main/index.ts` (`secret.seal` / `secret.open` host requests) | Main alone can reach the OS keychain; it settles the settings file |
| renderer | `src/renderer/src/home/HomeView.tsx`, `DevicePanel.tsx`, `AddDevice.tsx`, `HomeSettings.tsx`, `homeLib.ts`, `useHome.ts` | The Casa window: devices tab, panel, add dialog, engine card, live copy of the state |

The plan, cameras, scenes and rules (`plan.ts`, `triggers.ts`, `FloorPlan.tsx`, `RulesPanel.tsx`) belong to [014](../014-house-plan-cameras-and-rules/spec.md); they share the hub but are not planned here.

## 3. Contracts
- `HomeSettings = { enabled; mode: 'managed' | 'external'; externalUrl; mirrored; agentId; visionProvider; visionModel }`.
- `HomeEngineState = 'off' | 'missing' | 'installing' | 'starting' | 'ready' | 'error' | 'unsupported'`; `HomeEngineStatus = { state; mode; step?; progress?; error?; version?; url? }`.
- `HomeThing = { id; name; kind; areaId; entityId; state; on; available; attrs; sensors; integration?; manufacturer?; model?; deviceClass? }`; `HomeSnapshot = { things; areas; scenes; automations }`.
- `buildThings(states, areas, devices, entities): HomeThing[]`, `findThings(things, areas, query)`, `isSensitive(kind, deviceClass?)`.
- Flow: `FlowStep` (`kind: 'form' | 'menu' | 'progress' | 'external' | 'done' | 'abort'`), `FlowField`, `mapFields`, `nestData`, `listIntegrations`, `startFlow`, `stepFlow`, `abortFlow`.
- Engine: `HomeEngine` with `status`, `sync`, `start`, `install`, `stop`, `uninstall`, `connectExternalWith`, `ownerLogin`; `EngineDeps.seal` / `open` / `onStatus`.
- Requests (window → coordinator): `home.status|install|start|stop|uninstall|connectExternal|advanced|snapshot|control|thing.update|thing.remove|integrations|entries|flow.start|flow.step|flow.abort|entry.remove`. Events: `home.engine`, `home.snapshot`, `home.flow`.
- Host requests (coordinator → main): `secret.seal` and `secret.open`.
- Tools (all standalone): `home_overview` `read`, `home_find` `read`, `home_history` `read`, `home_control` `home`, `home_secure_control` `publish`, `home_call_service` `write`, `home_add_device` `write`, `home_edit_device` `write`, `home_remove_device` `write`.

## 4. Data and persistence
- `<userData>/home/auth.json`: mode, URL and the token and owner password sealed with the OS keychain; settings never hold the token.
- `<userData>/home/engine.json`: the chosen port. `<userData>/home/crane.exe` and `vm/` (the distro's disk); `rootfs.tar` and `crane.tgz` are temporary. HA's own data lives inside the distro (`/config`).
- `settings.json`: `home` with `enabled: false`, `mode: 'managed'`, `externalUrl: ''`, `mirrored: false`; older files are merged over the defaults.
- Uninstall removes the distro, `vm/`, `auth.json` and `engine.json`; it keeps `crane.exe`, the plan and the rules.
- The Casa tab choice is a per-viewer convenience in the browser's local storage (`alma.home.tab`).

## 5. Dependency injection
- `HomeEngine` receives `EngineDeps` (`dataDir`, `settings`, `seal`, `open`, `onStatus`); `HomeService` receives `HomeDeps` (`host`, `emit`, `launchRule`, `notify`, `readVault`, `look`). Keychain access is the host seam.
- Tools read `ctx.home` (`hub`, `engine`, `rulesView`, `showFlow`) and `ctx.settings`; `tests/home.test.ts` hands them a small fake hub with a few things and checks the calls it receives.
- Pure functions (`buildThings`, `findThings`, `mapFields`, `nestData`, `managedConfig`, `decodeWsl`, `isSensitive`) are exported and tested directly; the real HA and WSL are exercised only by opt-in live tests (`ALMA_HA_URL`, `ALMA_HA_ONBOARD`, `ALMA_HOME_INSTALL`).

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.9 | `tests/home.test.ts` → `la configuración del motor incluye las reglas, los modos y el puerto` | |
| AC-1.10 | `tests/home.test.ts` → `decodeWsl entiende el UTF-16 de wsl.exe y el UTF-8 de Linux` | UTF-16 and UTF-8 output |
| AC-1.1–1.7, 2.1–2.4, 2.6–2.12, 3.1–3.5 | [gap] | no WSL, low disk, bad checksum, port busy, unknown owner account, boot timeout |
| AC-1.8, 10.5–10.7, 11.1, 11.2 | [manual] install on a clean machine and check each engine state in Casa and Settings | |
| AC-2.5, 13.3 | `tests/home-live.test.ts` → `instala, arranca, crea la cuenta, se apaga y vuelve a arrancar`, `crea la cuenta de Alma en una instalación nueva` (opt-in) | |
| AC-4.1–4.6 | `tests/home.test.ts` → `un dispositivo con una sola entidad es esa entidad, con sus sensores`, `uno con varias entidades las muestra por separado`, `incluye lo que tiene estado aunque no esté en el registro (YAML, demos)`, `oculta lo oculto, lo de diagnóstico y lo deshabilitado; incluye las entidades sueltas` | hidden, diagnostic, disabled, stateless |
| AC-4.8, 4.10 | `tests/home.test.ts` → `encuentra lo que dice la gente`, `lo sensible` | accents, filler words, plurals |
| AC-4.5b, 4.6b, 4.7, 4.9 | [gap] | |
| AC-5.1, 5.2 | `tests/home.test.ts` → `home_control prende lo que se pidió, sin preguntar`, `pide aclarar si hay varias y actúa sobre todas con all` | several matches without `all` |
| AC-5.7, 5.8 | `tests/home.test.ts` → `con la domótica apagada o sin conexión explica qué hacer` | feature off, engine not ready |
| AC-5.9 | `tests/home.test.ts` → `home_overview agrupa por habitación` | |
| AC-5.3–5.6, 5.10–5.16 | [gap] | unknown color, wrong kind, `temperature` as an unknown word |
| AC-6.1–6.3 | `tests/home.test.ts` → `no toca cerraduras con home_control y las deja a la herramienta que pide aprobación` | lock among other matches |
| AC-6.2b, 6.4–6.7 | [gap] | action that does not fit the domain, `home_call_service` on a lock |
| AC-6.8, 9.1–9.5, 9.7, 8.5, 7.4, 7.12–7.14, 7.19 | [manual] with the demo engine: open Casa, tap, use the panel, add a Tuya device | |
| AC-7.1, 7.2 | `tests/home.test.ts` → `traduce el esquema de un paso a campos`, `anida los campos de una sección` | sections, password fields, QR selector |
| AC-7.9, 7.10, 10.1, 13.4 | `tests/home-live.test.ts` → `arma cosas, controla una luz y lee escenas`, `habla por WebSocket y lista las áreas` (opt-in) | |
| AC-7.3–7.8, 7.11, 7.15–7.18, 7.20, 7.21, 8.1–8.4, 8.6, 9.6, 10.2–10.4, 10.8, 11.3–11.5, 12.1, 13.1, 13.2, 13.5 | [gap] | wrong token, dropped socket, 30 s timeout, shared config entry |

## 7. Security and privacy impact
- `home_control` (`home`) never asks, only the "blocked" mode refuses it; `home_secure_control` (`publish`) asks on every call; the other write tools follow the approval mode. Company agents get no `home_*` tools.
- `home_call_service` is a general back door: it refuses the lock, alarm and siren domains but nothing else.
- The HA token and the owner password are sealed with the OS keychain (`safeStorage`, [ADR 0013](../../../docs/adr/0013-secrets-with-safestorage.md)); the owner password is shown in clear only on "Abrir Home Assistant (avanzado)". Brand credentials go from the person to HA.
- HA listens on `0.0.0.0` inside WSL; crane and SonoffLAN come from GitHub, the image from `ghcr.io`, pinned by checksum or version.
- `docs/security/`: `RISKS.md` (R-02, R-07) and `PRIVACY.md` (house devices) must cover the engine, the downloads and the stored owner credentials.

## 8. Rollout
Off by default (`enabled: false`, `mode: 'managed'`). "Activar la domótica" in Casa or Settings shows the engine card with "Instalar el motor" (about 1.2 GB download, about 3 GB on disk, about 10 minutes; 6.5 GB must be free). Turning the feature off stops the engine. Other platforms, or Windows without WSL2, report `unsupported` and offer the external mode.
