# Casa (home automation)

> Alma's home automation: it runs (or connects to) a Home Assistant engine, shows the house's devices and its own 2D floor plan, looks through cameras, and runs simple and judgment-based rules. Specs: [013 · engine and devices](../../.specify/specs/013-house-engine-and-devices/spec.md), [014 · plan, cameras and rules](../../.specify/specs/014-house-plan-cameras-and-rules/spec.md). Test status: 199 criteria, 44 with a test, 155 without (35 of those are marked manual, interface only).

The document has two halves inside the standard sections: **Part A, engine and devices** (spec 013) and **Part B, plan, cameras and rules** (spec 014).

## What it does

**Part A, engine and devices**

- Alma installs and manages a Home Assistant (HA) engine by itself inside a hidden WSL2 distro called `alma-home`, or connects to an HA the person already runs (URL + token). The person never has to see HA.
- The Casa window lists the house's devices (lights, plugs, covers, fans, climate, speakers, cameras, locks, alarms) grouped by room, with live state.
- The person adds a device of any brand HA knows through step-by-step forms (account, IP, QR code, external link). An agent can do the same with `home_add_device`.
- The person or an agent can rename a device, move it to another room, or remove it.
- Lights, plugs, fans, covers, climate and speakers are controlled by name, room or kind with no permission prompt. Locks, alarms, sirens and garage/gate/door covers always ask the person first, whatever the approval mode.
- Control works from the Casa window and from any agent surface: chat, voice, Telegram, WhatsApp. Telegram also has a button panel (`/home`, [Telegram](telegram.md)): rooms, scenes and cameras without asking the agent.

**Part B, plan, cameras and rules**

- A 2D top-down floor plan that belongs to Alma (not HA): floors, rooms, doors, devices placed on it. A light that is on bathes its room in its own color.
- The plan is built from an Excalidraw drawing, from a photo or sketch read by a vision model, or by hand, and corrected by dragging or by asking an agent.
- Cameras: ask what a camera sees, have a still sent to Telegram, or watch a camera for a bounded time looking for a stated condition.
- Modes (HA scenes), created by chat and activated by button or by asking.
- Rules of two kinds. Simple rules become HA automations and cost no AI. Judgment rules wake an agent with the event so it can look and decide.
- Any agent can read a picture with `look_at_image`.

## How to use it

**Turn it on.** Settings → Casa: tick «Activar la domótica» ("Turn on home automation", default off). Then choose the mode: «Que Alma lo instale y lo maneje (recomendado)» (Alma installs and manages it) or "Ya tengo un Home Assistant" (I already have one).

**Install the engine (managed mode).** In Casa (or Settings → Casa) press "Instalar el motor" ("Install the engine"). It downloads about 1.2 GB, needs about 7 GB free, takes about 10 minutes, and you can keep using Alma meanwhile. The card shows the step and a progress bar. Windows needs WSL2; if it is missing the state is `unsupported` with the text «Abrí PowerShell como administrador, corré wsl --install, reiniciá y probá de nuevo.» (open PowerShell as administrator, run `wsl --install`, reboot, retry).

**Use an existing HA.** Settings → Casa → "Ya tengo un Home Assistant", enter URL (must start with `http://` or `https://`) and a long-lived token, press "Conectar" ("Connect").

**Casa tabs.** Plano (plan), Dispositivos (devices), Reglas (rules). The last tab is remembered in browser local storage (`alma.home.tab`). The sidebar in Casa mode shows "Casa conectada" with device and lit-light counts, the modes as buttons, and an "Agregar dispositivo" shortcut.

**Operate a device.** On Dispositivos, tap the switch of a light, plug, fan or cover. On the plan, tap the icon. Right-click or select it to open the device panel: editable name, brightness slider, warm/neutral/cool buttons (2700/4000/6000 K), 8 color swatches, volume, cover position, fan speed, climate setpoint, room selector, sensors, "Quitar dispositivo" (remove). Locks and alarm panels have buttons in the panel only, each behind a native `confirm` («¿Abrir x?»). Unavailable devices show no controls.

**Ask Alma.** Example phrases:

- «prendeme la luz de la cocina» (turn on the kitchen light)
- «poné la luz del living al 30 % y cálida» (living-room light at 30%, warm)
- «¿qué luces quedaron prendidas?» (which lights are still on?)
- «agregá el foco Moes» (add the Moes bulb; Alma guides you with `home_add_device`)
- «armá el plano de mi casa con esta imagen» (build the plan from this picture; paste the picture in chat first)
- «¿qué se ve en la cámara del living?» (what does the living-room camera see?)
- «vigilá la puerta la próxima hora y avisame si llega un paquete» (watch the door for an hour, tell me if a package arrives)
- "armame un modo Noche…" (make me a Night mode) and «a las 23 apagá todo» (at 23:00 turn everything off)

### How to add a device (by brand family)

Open Casa → "Agregar dispositivo". The dialog shows a search box ("Buscar marca…"), the popular brands (list in `POPULAR_INTEGRATIONS`, `src/shared/home.ts`), or search results (by name or domain, at most 40). "Siguiente" stays disabled while a required field is empty ("Falta: …"). Closing the dialog or going back aborts the pending flow in HA. By chat, say the brand: the agent calls `home_add_device` with `brand`, then continues with `flow_id` + `data` until the answer says "Agregado".

The forms are not hand-coded per brand: `flow.ts` turns any HA config-flow step into a neutral form (fields, menu, QR, external link, progress). So the walkthroughs below are what the code and plan describe for the brands the project tested or lists first, not brand-specific code.

| Brand family | Domain | What to do |
|---|---|---|
| **Tuya / Smart Life** (Moes and others) | `tuya` | The device must already be in the Smart Life or Tuya Smart app (not only the Moes app). Pick the brand, type the user code (in the app: «Yo → Configuración → Cuenta y seguridad → Código de usuario»), press «Siguiente». The dialog draws a QR: scan it with the phone app («Abrí la app del fabricante en el celular y escaneá este código. Después tocá Siguiente.») and press «Siguiente». |
| **Sonoff / eWeLink** | `sonoff` | Uses the SonoffLAN custom component that Alma copies into `/config/custom_components/sonoff` at install (v3.13.1). Pick the brand, enter eWeLink user and password. The brand hint recommends a second eWeLink account with the devices shared to it, because using one account in several systems logs you out elsewhere. If SonoffLAN failed to download at install time, eWeLink is simply not offered (install still succeeds; see below). |
| **Tapo / ONVIF cameras** | `onvif` (or `tplink`) | Create the "camera account" in the Tapo app (camera → Ajustes → Avanzado) and give the camera a fixed IP in the router. Pick «Cámara ONVIF», enter the IP, port 2020 and that account. TP-Link/Kasa/Tapo plugs and bulbs (`tplink`) ask for the TP-Link account. The plan document says the official TP-Link integration may not support the C200C; no Tapo Control custom component is installed. |
| **Hue** | `hue` | Press the bridge button when the form asks. |
| **Chromecast / Nest, WiZ, Shelly** | `cast`, `wiz`, `shelly` | Hints say «se descubren solos en la red» (discovered automatically). Under WSL's NAT, mDNS/SSDP discovery does not work, so expect to supply an IP or an account instead. |
| **ESPHome, Xiaomi Miio, Zigbee (ZHA)** | `esphome`, `xiaomi_miio`, `zha` | ESPHome: device IP. Xiaomi: Xiaomi account, or IP and token. ZHA: needs a USB Zigbee adapter. |
| **Anything else HA supports** | any | Search by name or domain. Every HA integration with a config flow is listed, plus custom ones that expose one. |

After «Listo, se agregó <title>» ("Done, <title> added") the device appears under its room, or under «Sin habitación» (no room). Move it with the room selector or with `home_edit_device`. When a flow ends, devices the person had hidden earlier for that integration are re-enabled.

## How it works

### Part A: engine and devices

Everything runs in the coordinator process. Main only seals and opens secrets (`secret.seal` / `secret.open`).

```
 renderer (src/renderer/src/home)        coordinator (src/coordinator/home)                    WSL2 distro "alma-home"
 HomeView / DevicePanel / AddDevice      index.ts  HomeService (the one entry point)           ┌───────────────────────┐
 HomeSettings / useHome / homeLib   <──> engine.ts  install, start, stop, uninstall, recover ─>│ Home Assistant 2026.10.1 │
        ▲ home.engine / home.snapshot    hub.ts     HA client: WebSocket + REST, mirrored      │ + SonoffLAN, go2rtc,   │
        │ home.flow / home.plan / rules             states and registries, services            │   ffmpeg wrapper       │
        │                                  ha.ts     HaClient (low-level)  <─ http :8123/18123 └───────────────────────┘
        │                                  model.ts  HA entities -> "things"
        │                                  flow.ts   config flow step -> FlowStep
        └── tools: src/coordinator/tools/home.ts (home_*, camera_*, look_at_image)
```

Pieces:

| File | Role |
|---|---|
| `src/coordinator/home/engine.ts` | Managed engine lifecycle and the status it reports (`off`, `missing`, `installing`, `starting`, `ready`, `error`, `unsupported`). Also the external mode (`connectExternalWith`). |
| `src/coordinator/home/ha.ts` | `HaClient`: WebSocket commands, REST, onboarding of the owner account, long-lived token. |
| `src/coordinator/home/hub.ts` | Connection to HA, mirrored states and registries, snapshot, service calls, rename/move/remove, integrations, config entries, history, scenes, automations, camera stills. |
| `src/coordinator/home/model.ts` | Turns HA devices and entities into "things" (`HomeThing`), kind, on/off, name search. |
| `src/coordinator/home/flow.ts` | Config flows: HA step to `FlowStep`, QR as PNG data URL, polling of `progress` steps. |
| `src/coordinator/home/index.ts` | `HomeService`: ties engine, hub, plan, triggers; emits events; `savePlan`, `saveStill`. |
| `src/shared/home.ts` | Types, `DEVICE_DOMAINS`, `isSensitive`, `POPULAR_INTEGRATIONS`, flow types, plan geometry (Part B). |
| `src/coordinator/tools/home.ts` | The agent tools. |

**Install.** `engine.ts` checks WSL (`wsl --status`) and free disk (`NEEDED_BYTES` = 6.5 GB), downloads `crane` v0.22.1 and verifies its pinned SHA-256, unpacks it with Windows' own `System32\tar.exe`, exports the official image `ghcr.io/home-assistant/home-assistant:2026.10.1` (linux/amd64, no Docker) as a tar, runs `wsl --import alma-home <vm folder> <tar> --version 2`, copies SonoffLAN, and writes the config. Heavy operations are serialized: a second request returns the running one.

**Start.** HA runs as a child process `wsl.exe -d alma-home --exec /bin/sh /usr/local/bin/alma-ha.sh` with a clean environment. `configuration.yaml` is rewritten on every start (name Casa, metric, language `es`, host time zone, http on all interfaces, recorder purge 7 days, logger warning, includes for `automations.yaml`, `scenes.yaml`, `scripts.yaml`, created as `[]` if missing). RTSP cameras go through an ffmpeg wrapper that forces TCP, because WSL's NAT drops UDP. Boot waits up to 8 minutes. On the first start Alma runs onboarding: owner `alma` with a random password, closes the wizard steps, mints a long-lived token (3650 days), and stores both sealed.

**Ports and adoption.** Port 8123; if busy, 18123 (saved in `engine.json`); if that is busy too, `error`. If 8123 is busy and Alma holds credentials for `http://127.0.0.1:<port>` and HA answers `/api/config`, Alma adopts that running engine instead of starting a second one (this is how an engine left running by a previous Alma is picked up).

**Recovery and stop.** If the HA process exits unexpectedly, Alma restarts it, at most 3 times in 10 minutes; the next exit puts the engine in `error` with the last log lines. On quit Alma asks HA to stop through `homeassistant.stop`, waits up to 20 s (8 s fixed for an adopted engine), then terminates the process. Stopping or turning the feature off aborts a running install.

**Hub.** When the engine state becomes `ready`, the hub connects, loads states and registries (it must not report ready before registries load), then follows `state_changed` events. A state change updates the stored state at once and emits `home.snapshot` after a 300 ms debounce; a registry change reloads after 500 ms. If the socket drops, the hub reconnects with backoff 1 s doubling up to 30 s. Change listeners (used by rules) receive entity, from, to, attributes.

**Things.** A device with exactly one controllable entity is one thing (id = device id, user name first). A device with several controllable entities (a two-gang plug) becomes one thing per entity. Controllable domains (`DEVICE_DOMAINS`): light, switch, input_boolean, camera, media_player, cover, fan, climate, humidifier, water_heater, lock, alarm_control_panel, siren, valve, vacuum, lawn_mower; other entities (sensor, binary_sensor...) attach to their device as sensors. Hidden, disabled, diagnostic and stateless entities never show; entities with state but no registry entry (YAML, demo) do. Name search ignores accents and case, drops filler words, tolerates plural "s", and needs every remaining word to match name, room or kind.

**Sensitivity.** `isSensitive`: locks, alarms (incl. sirens), and covers whose device class is garage, gate or door. Those go only through `home_secure_control`.

**Config flows.** `startFlow` POSTs the handler with `show_advanced_options: false`; each step is mapped to `form`, `menu`, `progress` (polled every 1.5 s, up to 40 times), `external` (URL), `done` or `abort`. Schema fields become typed fields (password detection by selector type and names matching password/token/secret; sections flattened to `section.field` and nested back on send; QR selector becomes the step's QR). Text uses HA's Spanish translations when it has them. A step type Alma does not know becomes an abort pointing to the advanced HA UI. Custom integrations (SonoffLAN) are not in HA's `flow_handlers`; they are found through the WebSocket `integration/descriptions`.

**Window messages.** Requests `home.status|install|start|stop|uninstall|connectExternal|advanced|snapshot|control|thing.update|thing.remove|integrations|entries|flow.start|flow.step|flow.abort|entry.remove` (full list in [ipc-messages.md](../references/ipc-messages.md)); events `home.engine`, `home.snapshot`, `home.flow`. The coordinator does these with no approval: the person is the actor.

### Part B: plan, cameras and rules

| File | Role |
|---|---|
| `src/coordinator/home/plan.ts` | Plan store (`plan.json`), `sanitizePlan`, operations (`add_room`, `place`, ...), `describePlan`, auto-placement. |
| `src/shared/home.ts` | Geometry (centroid, point-in-polygon), `planFromDrawing`, `planFromVision`, `extractJson`, rule types, `ruleMatches`, `inWindow`. |
| `src/shared/excalidraw.ts` | Reads `.excalidraw` content. |
| `src/coordinator/home/triggers.ts` | Judgment rules and camera watches, `rules.json`. |
| `src/coordinator/vision.ts` | `look()`, `loadPicture`, model choice. |
| `src/coordinator/index.ts` | `launchHomeRule` (wakes the agent), `notifyHome`, `saveInboxImage`. |
| `src/renderer/src/home/FloorPlan.tsx`, `RulesPanel.tsx` | Plan SVG and rules tab. |

**Plan.** Units are centimetres, x right, y down. Every read and write is sanitized (at least one floor, polygons of 3+ points, unique ids, one position per device, integer coordinates). The empty plan is one floor "Planta baja" (`piso-1`). Writes go to `plan.json.tmp` and are renamed over `plan.json`. When a plan is saved and the hub is connected, every room gets an HA area (found by name or created), a renamed room renames its area, and a device moved into a room with an area is moved to that area; failures there are swallowed. Removing a room never deletes its area. On every snapshot, devices whose HA area matches a room's `areaId` and that are not on the plan are placed in it (`autoPlace`); the rest wait in "Sin ubicar" (unplaced tray).

**Plan from a drawing.** Each rectangle, diamond or closed line becomes a room named by its bound text, or the text whose center falls inside; unnamed ones are «Habitación n». A shape containing two or more other shapes is dropped as the house outline. The result is scaled so the floor is 1200 cm on its longest side from 0,0. Replacing a floor replaces its rooms and doors; a new room with the same name keeps the old HA area.

**Plan from an image.** `vision.look` is asked (`PLAN_QUESTION`) for JSON polygons on a 0-100 grid; `extractJson` takes the first valid JSON object; x is stretched by width/height (read from PNG/GIF/WebP/JPEG headers) and the result scaled to 1200 cm.

**Vision.** `loadPicture` accepts a path only inside the inbox, the active vault root or the thread's working folder; JPG/JPEG/PNG/WebP/GIF only; at most 8 MB. The model that looks is, in order: the provider+model set in Settings → Casa; the model of the agent chosen for the house; the default agent; any agent whose provider has a key; the first agent. It is called once, effort `low`, no tools, a Spanish system prompt («Sos los ojos de Alma…»). The agent's conversation never carries the image, only the text answer.

**Cameras.** A still is HA's camera proxy, 20 s timeout, retried up to 5 more times 2 s apart (many cameras allow one video connection at a time); on failure the error advises closing the live view. `camera_look` saves the still to `<dataDir>/inbox/<entity>-<timestamp>.jpg`, asks the vision model and returns the answer; with `send_telegram` the photo goes to Telegram too. `camera_photo` sends the photo without vision. The device panel shows the live MJPEG picture.

**Watches.** `camera_watch start` creates a watch in `rules.json`; the first look is 1 s later. At each look the still goes to the vision model with the condition and it must answer `{"match": true|false, "note": "…"}`. On a match the person gets a desktop notification and a Telegram message with the photo; without `repeat` the watch ends, with `repeat` it waits at least 120 s and five times the interval. Saved watches resume 5 s after app start.

**Judgment rules.** `triggers.ts` listens to hub state changes. A rule fires only if enabled, same entity, the state really changed, the new state equals `to` (when set), the time is in the window (may cross midnight), and the last firing is older than the cooldown. Last-fired is saved before the agent starts. Firing creates a new conversation "Casa · <rule> · <dd/mm hh:mm>" for the agent chosen in Settings → Casa (the default agent otherwise), tells it which device changed from what to what, the rule's prompt, and to notify with `send_telegram` only if it matters. In that run `camera_look` is auto-approved (the person approved the rule's text when creating it); every other tool follows the agent's normal approval policy. A failing run notifies «La regla name falló» ("The rule «name» failed") linked to the conversation. Nothing fires when the engine is off, the hub is disconnected, or Alma is closed.

**Simple rules and modes.** `home_rules create_automation` and `home_modes create` write HA automations and scenes through the REST config API (ids `alma_<base36 time>`), which only load because the generated `configuration.yaml` includes those files. A simple rule runs inside HA and spends no tokens.

## Tools for agents

Offered only when the feature is on and the agent is not working in a company; `look_at_image` is offered to every agent. A `home` risk never asks (it is blocked only in the read-only approval mode); `write` follows the approval mode and "always allow"; `publish` asks on every call. Source: `src/coordinator/tools/home.ts`. See also [tools.md](../references/tools.md).

| Tool | Risk | Asks approval | Purpose |
|---|---|---|---|
| `home_overview` | read | no | Things grouped by room with state, plus modes and rule counts. |
| `home_find` | read | no | Search things by name, room or kind. |
| `home_history` | read | no | Last changes of a device (1-168 h, last 40 per entity). |
| `home_control` | home | no | On/off/toggle, brightness, color, temperature, fan, climate, cover, volume, media. Refuses sensitive things. |
| `home_secure_control` | publish | every call | Lock/unlock, open/close gate, arm/disarm alarm, siren. |
| `home_call_service` | write | per approval mode | Any HA service; refuses domains `lock`, `alarm_control_panel`, `siren`. |
| `home_add_device` | write | per approval mode | Start/continue a config flow. |
| `home_edit_device` | write | per approval mode | Rename or change room. |
| `home_remove_device` | write | per approval mode | Remove or hide a device. |
| `home_plan` | read | no | Describe the plan. |
| `home_plan_edit` | home | no | Edit floors, rooms, doors, device placement. |
| `home_plan_from_drawing` | home | no | Build a floor from a vault `.excalidraw`. |
| `home_plan_from_image` | home | no | Build a floor from a picture via vision. |
| `look_at_image` | read | no | Answer a question about a picture. |
| `camera_look` | write | per approval mode | Still + vision answer, optional Telegram. |
| `camera_photo` | write | per approval mode | Send a still to Telegram without vision. |
| `camera_watch` | write | per approval mode | `start`, `list`, `stop` a timed watch. |
| `home_scene` | home | no | Activate a mode. |
| `home_modes` | write | per approval mode | `create`, `list`, `show`, `delete` modes. |
| `home_rules` | write | per approval mode | `create_automation`, `create_judgment`, `list`, `toggle`, `delete`. |

## Settings and data

Setting `home` (defaults in `src/shared/defaults.ts`; merged in `src/main/settings.ts`). Reference: [settings.md](../references/settings.md).

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Feature on/off. Turning it off stops the engine. |
| `mode` | `managed` | `managed` (Alma's WSL engine) or `external`. |
| `externalUrl` | `''` | URL of the external HA. |
| `mirrored` | `false` | WSL mirrored networking. Defined but nothing reads it (see below). |
| `agentId` | `''` | Agent that answers judgment rules (default agent if empty or removed). |
| `visionProvider`, `visionModel` | `''` | Model that looks at pictures; empty falls back as described above. |

Data (reference: [data.md](../references/data.md)):

| Where | What |
|---|---|
| `<data>/home/auth.json` | Mode, URL, token and owner password, the last two sealed with the OS keychain via main. Settings never hold the token. |
| `<data>/home/engine.json` | Chosen port. |
| `<data>/home/crane.exe`, `<data>/home/vm/` | Downloaded tool; the distro's disk. Temporary `rootfs.tar`, `crane.tgz` during install. |
| `<data>/home/plan.json` | The floor plan (pretty JSON, atomic write). |
| `<data>/home/rules.json` | `{ judgment: [], watches: [] }`. |
| `<data>/inbox/` | Camera stills and received pictures. |
| inside the distro `/config` | HA's own data: devices, areas, scenes, automations (ids `alma_*`). |
| browser local storage `alma.home.tab` | Last Casa tab (per-viewer convenience). |

Uninstall removes the distro, `vm/`, `auth.json` and `engine.json`, and keeps `crane.exe`, the plan and the rules.

## Limits and rules

| Rule | Value |
|---|---|
| Managed HA version | 2026.10.1 (`HA_VERSION`) |
| Free disk to install | 6.5 GB (`NEEDED_BYTES`); UI says about 1.2 GB download, about 3 GB on disk, about 10 minutes |
| Ports | 8123, else 18123 |
| Boot timeout | 8 minutes |
| Automatic restarts | 3 in 10 minutes, then `error` |
| WebSocket / REST / command timeout | 30 s (history 45 s) |
| Snapshot / registry debounce | 300 ms / 500 ms |
| Reconnect backoff | 1 s x 2^n, max 30 s |
| Flow progress poll | 1.5 s x 40 |
| Pause before reporting state after control | 700 ms (900 ms secure) |
| Owner account | `alma`, 48-hex password, token 3650 days |
| Plan size | longest side 1200 cm; snapping 5 cm (devices), 10 cm (corners); new room 300x300 cm |
| Picture | JPG/JPEG/PNG/WebP/GIF, at most 8 MB |
| Camera still | 20 s timeout, up to 6 tries 2 s apart |
| Camera watch | every 10-900 s (default 60), lasts 1-360 min (default 60), always at least 10 s / 1 min whatever is asked |
| Judgment rule cooldown | at least 1 min, default 10 |
| History | 1-168 h (default 24), last 40 changes |

Plumbing integrations not listed as connected accounts: sun, radio_browser, google_translate, met, backup, hassio, cloud, go2rtc, shopping_list.

## Security and privacy

- **Asks first:** locks, alarms, sirens and garage/gate/door covers, on every call (`home_secure_control` is `publish`). Camera, add/edit/remove, modes and rules tools follow the approval mode. The Casa window asks with a native `confirm` before operating a lock or alarm.
- **Blocks:** `home_control` refuses sensitive things and calls nothing, not even for the other matches; `home_call_service` refuses the `lock`, `alarm_control_panel` and `siren` domains. Company agents get no `home_*` tools.
- **Stores:** the HA token and owner password are sealed with the OS keychain (`auth.json`). Pictures from cameras stay in `<data>/inbox/`; `erasePersonalFiles` empties it ([security.md](security.md)).
- **Leaves the machine:** camera stills and plan photos go to the configured vision provider (a third party) and, when asked or when a watch matches, to Telegram. The engine downloads crane and SonoffLAN from GitHub and the HA image from `ghcr.io`. Brand accounts (Tuya code, eWeLink password) travel from the person to HA; when an agent drives `home_add_device`, the tool says the person types them in chat, so they pass through the model provider.
- **Network:** HA listens on all interfaces inside WSL, reachable from the Windows host; LAN exposure depends on WSL networking.
- **Unattended runs:** a judgment-rule run has nobody watching. Only `home`, `read`, `memory` tools and `camera_look` run unasked; other `write` tools wait for an approval.
- The spec flags the HA engine, the downloads, and the stored owner credentials as items for `docs/security/` ([RISKS.md](../security/RISKS.md), [CONTROLS.md](../security/CONTROLS.md), [PRIVACY.md](../security/PRIVACY.md)).

## How it is tested

- `tests/home.test.ts` (31 cases) covers the pure parts: thing building, search, sensitivity, `home_control` and `home_secure_control` behavior, `home_overview`, flow field translation, plan sanitizing/operations/geometry/persistence, drawing and vision to plan, header sizes, `extractJson`, rule matching and time windows, `camera_photo`, disabled/disconnected messages.
- `tests/home-live.test.ts` (3 cases) talks to a real HA; skipped unless `ALMA_HA_URL` is set. The install, start, stop, restart, uninstall case also needs `ALMA_HOME_INSTALL=1`; onboarding needs `ALMA_HA_ONBOARD`.
- Not covered: the real install path in CI, engine recovery and adoption, hub reconnect, config flow mapping beyond field translation, vision picture loading, camera stills and watches, judgment-rule launching, HA area sync, and the whole renderer (no component tests).
- By hand: Settings → Casa in every engine state (off, missing, installing, error); Casa → Dispositivos with the demo engine (`ALMA_HOME_DEMO=1` adds HA's `demo:`); drag devices, rooms and corners in edit mode and reload; add a Tuya device and scan the QR; start a watch from chat and stop it in Reglas; paste a picture in chat and ask «¿qué ves?» (see Known limits before trusting this).
- Per the design note, the real Tuya, eWeLink and Tapo devices were not tested with the user's accounts at the time (design note); everything else was checked against HA's demo integration.

## Known limits

1. **Pasted and Telegram pictures probably cannot be read.** `saveInboxImage` in `src/coordinator/index.ts:352` uses `name.replace(/[^w.-]+/g, '_')` (no backslash before `w`), which turns almost every character into `_` and loses the extension; `loadPicture` then rejects the file. Confirmed still present in the code.
2. **No periodic health check.** The plan promised a check every 30 s with automatic restart. Recovery happens only when the HA process exits, plus WebSocket backoff; an HA that hangs without exiting is never restarted.
3. **Sensitive devices can be reached around `home_secure_control`.** `home_call_service` description claims locks/gates ask like `home_secure_control`, but only three domains are blocked and the risk stays `write`; a garage `cover.open_cover` can run unasked in "always allow". Scenes made with `home_modes` can store a lock and `home_scene` (risk `home`) activates them without asking. Product decision.
4. **Brand passwords can pass through the chat** and the model provider when an agent drives `home_add_device`. Product decision.
5. **Owner password shown in clear** under "Abrir Home Assistant (avanzado)".
6. **Engine state after "Detener" is `missing`**, so Settings offers "Instalar el motor" (which just restarts the distro) and the Casa card repeats the 1.2 GB text; any later settings change restarts a stopped engine; switching `mode` while `ready` does nothing until restart.
7. **Connecting an external HA overwrites the managed account** in the single `auth.json`; a managed engine then refuses to adopt.
8. **Judgment rules and watches have no global ceiling.** Only each rule's cooldown throttles them; `to` empty fires on any change, including "unavailable"; no cap on concurrent watches; a watch whose looks keep failing runs until it expires.
9. **A woken run may wait for an approval no one gives** (for example `camera_photo` with Telegram, risk `write`).
10. **`loadPicture` root check is a plain `startsWith`** (no separator, no real path), so `C:\work-secret` passes for root `C:\work`.
11. **"Sacar del plano" is undone** by the next state change when the device's area matches a room.
12. **Smaller items:** `home_control` with an unknown `temperature` word sends NaN instead of failing; `home_secure_control` does not check the action against the thing's domain; the removal result («Quedó oculto.») is never seen because the panel closes; an agent's QR step does not switch the window to Casa; inconsistent size numbers 1.2 / 6.5 / 3 GB, and the plan said about 2 GB; `mirrored` is dead. In 014: replacing a floor deletes its doors, the end-of-watch text always says «No pasó nada.», plan icons are not keyboard/gamepad focusable, any window edit sets `source` to `manual` and `rename_room` allows duplicates.

### What `docs/HOME-AUTOMATION-PLAN.md` promised and is not built

The plan's own status block already records some deviations (no mirrored network, no HA floors, vision model chosen in Settings → Casa). Comparing the rest against the specs and code:

| Promised in the plan | State today |
|---|---|
| Health check every 30 s with automatic restart (§4.1, H1.2) | **Not built.** Only restart on process exit. |
| Update HA without losing devices; backup before updating (§4.1, H1.5, stage 4) | **Not built.** Neither the specs nor the code have an upgrade or backup flow. Version is fixed at `HA_VERSION`. Rationale for leaving it out is not documented. |
| Settings → Casa with "reparar, reiniciar, actualizar", backups (§4.5) | Engine card has install, retry, stop, start, uninstall, advanced; no repair, update or backups. |
| `mirrored` networking switch (§4.1) | Setting exists, nothing reads it; documented in the plan status as not implemented. |
| HA floors synced (§4.2) | Not built (plan status says so); only rooms/areas sync. |
| Cost tracking: «el gasto queda registrado» for judgment rules, estimated cost on the `camera_watch` approval card, cut-off button from the plan (H5.3, H6.3, §4.4) | **Not built.** `look()` returns token usage but nothing records it for the house; the approval card has no cost estimate. Watches can be stopped from chat and from «Reglas». |
| Camera thumbnails refreshing on the plan (§4.5) | Not built; cameras are icons only. Live MJPEG exists in the device panel. |
| Keyboard and gamepad navigation on the plan (§4.5) | Not built. |
| Door editing in the window | Not built; doors come from a photo or `home_plan_edit`. (The plan did list doors in edit mode.) |
| Camera PTZ («mirá hacia la ventana», H5.5) | Not built; no tool for it. |
| Photos in `send_telegram` / `send_whatsapp` (stage 3) | Telegram has `image_path` (and camera tools send photos). WhatsApp not verified here; check [whatsapp.md](whatsapp.md). |
| Audio: `home_speak`, microphones, voice satellites (stage 5, H7) | Not built, deliberately deferred until hardware exists. |
| `home_edit_device` can "ocultar" (hide) | Removal falls back to hiding when the integration refuses; no explicit hide action. |
| Triggers stored in `home/triggers.json` | Stored in `home/rules.json` (`{ judgment, watches }`). |
| Tapo Control custom component, decision in "stage 0" | Only SonoffLAN is installed. Tapo goes through the official `tplink` or `onvif`. |
| Install "about 7 minutes", "about 2 GB" | UI says about 10 minutes and about 3 GB on disk; disk check needs 6.5 GB. |
| `HomeEngine` in `main/home/engine.ts` (§4 diagram) | Lives in `src/coordinator/home/engine.ts`; main only seals secrets. |

## See also

- [approvals.md](approvals.md) for how `home`, `write` and `publish` are treated.
- [settings.md](settings.md) for the Settings dialog and where settings are stored.
- [telegram.md](telegram.md) and [whatsapp.md](whatsapp.md) for where photos and alerts go; [voice.md](voice.md) for voice control.
- [agents.md](agents.md) and [companies.md](companies.md) (company agents get no home tools); [routines.md](routines.md) for time-based wake-ups.
- [vault-and-knowledge.md](vault-and-knowledge.md) and [office-and-drawings.md](office-and-drawings.md) for `.excalidraw` files; [images.md](images.md); [providers.md](providers.md) for the vision model; [security.md](security.md).
- Reference: [tools.md](../references/tools.md), [settings.md](../references/settings.md), [data.md](../references/data.md), [ipc-messages.md](../references/ipc-messages.md), [limits.md](../references/limits.md).
- [HOME-AUTOMATION-PLAN.md](../HOME-AUTOMATION-PLAN.md) (original plan and build status).
