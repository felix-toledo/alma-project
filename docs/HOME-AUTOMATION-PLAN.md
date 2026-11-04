# Plan: home automation module («Casa»)

> Status: **stages 1 to 4 built and tested** with a real Home Assistant (with HA's demo) and with the engine installed from scratch. What is left depends on your real devices: see "To test with your devices" at the end. The audio stages (speakers and microphones per room) wait until there is hardware.

## What got built (and where it departs from this plan)

- **Engine**: Home Assistant 2026.10.1 in a hidden WSL2 distro (`alma-home`), exported from the official image with `crane` (no Docker) in about 7 minutes the first time. The owner's account is created by Alma itself and the token is kept encrypted with the system keychain. External mode (URL + token) also works.
- "Tested for real": install from scratch, start, account creation, clean shutdown, a second start with the same account and uninstall (`tests/home-live.test.ts`, with `ALMA_HOME_INSTALL=1`). Control of lights, scenes, automations, cameras with vision, a judgment rule triggered by a state change, a plan from a photo, from Excalidraw and by hand.
- **Mirrored network**: not implemented. Automatic network discovery through mDNS does not work on WSL's NAT network: each brand is added on its own (Tuya, eWeLink) or by IP (Tapo), which is what is needed to get started.
- **Home Assistant floors**: not synchronized; only the rooms (areas).
- "Vision model": chosen in «Configuración → Casa»; by default it uses the agent's (or the first agent with a key). Tested with DeepSeek Flash.
- **Judgment rules**: the camera they ask for (`camera_look`) is already approved because the user approved the rule when creating it.
- **Custom brands** (SonoffLAN) appear in the brand list thanks to `integration/descriptions`.


## 1. What we want

A **Casa** (Home) section in Alma where:

- You show Alma what your house is like (a drawing in Excalidraw, a photo of a plan or sketch, or photos of each room) and Alma builds its own **professional plan**, in 2D seen from above.
- In that plan live the **devices** of each room: lights, plugs, relays, cameras, speakers, microphones, sensors.
- "Everything can be done in two ways": from the app (buttons, forms, dragging) or by asking Alma («agregá la cámara nueva al living» — add the new camera to the living room, «renombrá el foco Moes a Luz de la cocina» — rename the Moes bulb to «Luz de la cocina»).
- Alma controls the house by chat, voice, Telegram and WhatsApp: «prendeme la luz de la cocina» (turn on the kitchen light for me), «¿qué se ve en la cámara del living?» (what does the living room camera show?), «vigilá la puerta la próxima hora» (watch the door for the next hour).
- There are **modes** («Noche», «Me fui», «Cine») and **triggers** («si hay movimiento de noche, prendé la luz y mandame una foto» — if there is motion at night, turn on the light and send me a photo).

Devices to test with: a **Sonoff A19** bulb (eWeLink), a **Moes** bulb (Tuya) and a **Tapo C200C** camera (TP-Link).

## 2. Decisions taken

| Topic | Decision |
|---|---|
| Engine | **Home Assistant (HA)** embedded. It runs in a **hidden WSL2 distro** that Alma installs, starts, configures and updates by itself. You never see HA. If a PC cannot run WSL, Alma connects to an HA that already exists (URL + token). |
| Who rules | **HA** is the source of truth for devices, entities, areas (rooms), floors, scenes and automations. **Alma** owns the plan (geometry and position of each icon) and the intelligence. |
| Initial brands | Tuya (HA's official integration, linked with the QR of the Smart Life app), eWeLink (SonoffLAN, preinstalled), Tapo (to be defined in stage 1: see §8). Any other brand HA supports is available from «Agregar dispositivo». |
| Where it runs | A fixed PC, always on, on the same Wi-Fi as the devices. Alma lives in the system tray. |
| Plan | Excalidraw and photos are only the **input**. The view is its own **top-down 2D plan** (SVG, Umbra style). Isometric may come later. |
| Cameras | A photo on request + vision, live video in the app, motion as a trigger and AI surveillance for a **limited time**. Alma uses whatever fits what you ask. |
| Rules | **Mixed**: the simple ones go as an HA automation (reliable, spends no tokens). What needs judgment wakes Alma with the event. |
| Permissions | Lights, plugs, fans, music and scenes: **free**. Viewing cameras, watching, creating/deleting rules, adding/deleting devices: «ask for approval» (with «Siempre» available). Locks, alarms and gates: **always** ask for approval. |
| Audio | Speakers (Alma talks and plays music) and microphones per room: the data model allows for them, they are implemented when you have one. |
| HA UI | Hidden, with an «Abrir Home Assistant (avanzado)» button in «Configuración → Casa». |
| Order | 1) engine + control → 2) plan and Casa view → 3) cameras → 4) modes and triggers. |

## 3. What Alma already has and is reused

| Already exists | Where | How Casa uses it |
|---|---|---|
| Tool system with risk and approvals (`read`/`write`/`exec`/`memory`/`publish`, «Siempre permitir», auto-review) | [src/coordinator/tools/types.ts](../src/coordinator/tools/types.ts), [src/coordinator/approval.ts](../src/coordinator/approval.ts) | The `home_*` tools are registered the same way as mail or WhatsApp in `appTools()` of [agent.ts](../src/coordinator/agent.ts). |
| Approval card with an image (`preview.imageDataUrl`) | [ToolCard.tsx](../src/renderer/src/components/ToolCard.tsx) | Show the camera photo in the chat. |
| Coordinator in `utilityProcess` + live events to the renderer | [src/coordinator/index.ts](../src/coordinator/index.ts), `LiveEvent` in [shared/types.ts](../src/shared/types.ts) | HA client (WebSocket) and live states towards the Casa view. |
| Routines and reminders (by schedule) | [routines.ts](../src/coordinator/routines.ts), [tools/routines.ts](../src/coordinator/tools/routines.ts) | "Launch an agent in a new conversation" is reused for the triggers with judgment. |
| Telegram, WhatsApp, voice | `channels/`, `voice/` | Control by voice and chat already works because they are the same tools. Photos are missing (see below). |
| Excalidraw in the vault (`excalidraw_read` / `excalidraw_draw`) and `describeDrawing` | [knowledge/tools.ts](../src/coordinator/knowledge/tools.ts), [shared/excalidraw.ts](../src/shared/excalidraw.ts) | Read the drawing of the house you made to turn it into a plan. |
| Encrypted settings (`safeStorage`) and the settings tabs | [main/settings.ts](../src/main/settings.ts), [SettingsDialog.tsx](../src/renderer/src/components/SettingsDialog.tsx) | HA token and the owner's password. A new **Casa** tab. |
| Sidebar modes (chat / vault / companies) | [Sidebar.tsx](../src/renderer/src/components/Sidebar.tsx), [App.tsx](../src/renderer/src/App.tsx) | A fourth mode: **Casa**. |
| Umbra / console design system | skill `umbra-ui` | All the new UI. |
| Native WebSocket (Electron 44 → Node 24) | — | HA client with no new dependencies. |

### What is missing and has to be built

1. "Vision": today the models "do not receive images" (the blocks are text, thinking and tools). Without it there is no "photo of the plan → map" and no «¿qué se ve en la cámara?».
2. **Photos in Telegram/WhatsApp**: today only text is sent and received (and audio on Telegram).
3. **Event triggers**: routines are only by schedule.
4. "WSL management" and the whole HA engine.
5. The Casa view, plan, editor, device panel, form to add devices.

## 4. Architecture

```
┌──────────────────────── Alma (Electron) ────────────────────────┐
│ Renderer                                                         │
│  Casa view: SVG plan · device panel · live cameras               │
│  "Add device" (dynamic form) · Modes and rules                   │
│  Settings → Casa                                                 │
│        ▲ live events / requests                                  │
│ Coordinator (utilityProcess)                                     │
│  home/hub.ts     HA WebSocket + REST client, state cache         │
│  home/plan.ts    plan (JSON) ↔ HA areas and floors               │
│  home/triggers.ts triggers with judgment → wake Alma             │
│  tools/home.ts   the agent's home_* tools                        │
│  vision.ts       "look at this image and answer X"               │
│        ▲                                                         │
│ Main                                                             │
│  home/engine.ts  installs / starts / stops / updates the distro  │
└──────────────┬───────────────────────────────────────────────────┘
               │ http://localhost:8123 (REST + WebSocket)
┌──────────────▼──────── WSL2: distro "alma-home" ─────────────────┐
│ Home Assistant (+ go2rtc, ffmpeg)                                │
│ custom_components: SonoffLAN (+ Tapo Control if needed)          │
└──────────────┬───────────────────────────────────────────────────┘
               │ Wi-Fi / manufacturer cloud
     Moes (Tuya)   ·   Sonoff A19 (eWeLink)   ·   Tapo C200C
```

### 4.1 Engine: Home Assistant inside WSL

"How it is installed" (preferred option, to be validated in stage 1):

1. Alma downloads `crane` (a single Google binary for container images, version pinned) and exports the **official image** `ghcr.io/home-assistant/home-assistant:<pinned version>` (amd64) as a single `.tar`. Docker is not needed.
2. `wsl --import alma-home %APPDATA%\Alma\home\vm <tar>`. That tar already carries Python, HA, go2rtc and ffmpeg exactly as HA publishes them.
3. Alma copies the `custom_components` pinned by version (SonoffLAN; Tapo Control if chosen) into `/config`.
4. Alma starts HA as a child process: `wsl.exe -d alma-home -- python3 -m homeassistant -c /config`. It does not use the container's `/init`.
5. "Automatic onboarding" through the API: it creates the owner user with a random password (stored encrypted), gets a long-lived token, sets language, time zone and units, and turns analytics off.

- **Plan B**: a minimal Ubuntu distro + `uv` + Python 3.14 + `pip install homeassistant` (the documented "Core" install). It is slower and more fragile.
- **Plan C**: external HA (URL + token) for PCs without WSL.

**Life cycle**

- It starts with Alma and stops when the app exits.
- A health check every 30 s, with automatic restart.
- A screen «motor apagado / instalando / listo» (engine off / installing / ready) in «Configuración → Casa».

**Updating HA**

1. Export the new version to a new distro.
2. Copy `/config`.
3. Check that it starts.
4. Switch over and delete the old one.

Before updating, a backup is made with HA's API.

**Network**

- By default WSL uses NAT. That is how Tuya (cloud), eWeLink (cloud, and LAN when it can) and the Tapo by fixed IP work.
- Automatic network discovery (mDNS/SSDP) needs WSL's `mirrored` mode. That mode is configured in `%USERPROFILE%\.wslconfig` and **affects all your distros** (Ubuntu, docker-desktop).
- That is why it stays as an explicit switch in «Configuración → Casa», off by default.

**Requirements**: Windows 10/11 with WSL2 and virtualization enabled. About 2 GB of disk and between 300 and 600 MB of RAM.

### 4.2 Data: what HA stores and what Alma stores

**HA** stores:

- devices, entities and their names;
- areas (rooms) and floors;
- scenes (modes);
- automations (simple rules), tagged `alma_*`.

**Alma** stores in `%APPDATA%\Alma\home\plan.json`:

```jsonc
{
  "floors": [{
    "floorId": "planta_baja",            // = HA floor
    "rooms": [{
      "areaId": "cocina",                // = HA area
      "polygon": [[0,0],[420,0],[420,350],[0,350]],   // cm
      "doors": [{ "from": [120,350], "to": [200,350] }]
    }],
    "items": [{ "deviceId": "…", "entityId": "light.foco_moes", "x": 210, "y": 175, "icon": "bulb" }]
  }],
  "source": { "kind": "excalidraw" | "photo" | "manual", "path": "…" }
}
```

- A new room creates an area in HA. Renaming on one side renames on the other.
- A device that is not in the plan appears in a «Sin ubicar» (unplaced) tray.

Alma's **triggers with judgment** go in `home/triggers.json`:

```jsonc
{ "id": "…", "when": { "entityId": "binary_sensor.tapo_motion", "to": "on" },
  "onlyBetween": ["22:00","07:00"], "cooldownMin": 10,
  "prompt": "Look at the patio camera. If there is a person you do not know, tell me on Telegram with the photo.",
  "agentId": "…", "enabled": true }
```

### 4.3 Vision (a cross-cutting requirement)

**`vision.ts`** exposes `look(images, question) → text`. A "vision model" is configured in «Configuración → Proveedores»: by default the agent's if it accepts images, and if not, a chosen one (Claude, Grok or the Vercel Gateway).

It was chosen this way so as not to change the message format of every provider. The tools that need to "see" call `look()` and hand the agent back the text and the image to show you in the chat.

It is used by:

- `look_at_image(path, question)`: photos you attach in the chat, Telegram or WhatsApp, or from the vault.
- `camera_look`: a camera photo + a question.
- The conversion of a photo into a plan: vision returns the JSON of rooms.

### 4.4 Agent tools

| Tool | What it does | Risk |
|---|---|---|
| `home_overview` | Floors, rooms, devices and current state (summarized). | read |
| `home_find` | Looks up devices by name, room or type («las luces de arriba» — the upstairs lights). | read |
| `home_control` | Turn on/off, brightness, color, volume, play/pause, activate a scene. Only lights, plugs, switches, fans, media and scenes. | **home** (new: free except in read-only mode) |
| `home_secure_control` | Locks, alarms, gates, motorized curtains. | publish (always asks) |
| `home_call_service` | Calls any HA service: the "back door" to handle everything HA knows how to do. | write |
| `home_add_device` | Starts HA's flow for a brand ("tuya", "sonoff", "onvif"…) and moves forward step by step asking you for the missing data. It shows a QR or links when the flow asks for it. | write |
| `home_edit_device` | Rename, change room, hide. | write |
| `home_remove_device` | Remove from HA. | write |
| `home_plan_edit` | Create/edit floors, rooms (polygons), doors and place devices on the plan. | home |
| `home_plan_from_drawing` | Reads an `.excalidraw` from the vault and proposes the plan (rectangles and texts → rooms). | home |
| `look_at_image` | Looks at a photo (plan, sketch, room) and answers. | read |
| `camera_look` | Takes a photo from a camera and answers the question («¿hay alguien?» — is anyone there?). | write |
| `camera_watch` | Watches for N minutes, every X seconds, looking for something specific. On acceptance it shows the estimated cost and it can be cut from the chat or the Casa view. | write |
| `home_modes` | Create/edit/delete modes (HA scenes). | write |
| `home_rules` | Create/edit/delete/activate rules: simple → HA automation; with judgment → Alma trigger. | write |
| `home_history` | «¿A qué hora se apagó la luz?» (what time did the light go off?), «¿hubo movimiento anoche?» (was there motion last night?) | read |
| `home_speak` | (When there are speakers) Speaks or plays on a speaker in the house. | home |

`send_telegram` and `send_whatsapp` gain the option to **attach an image**.

### 4.5 UI

"Casa" mode in the sidebar (Umbra):

- **Plan**:
  - tabs per floor;
  - rooms as named polygons;
  - lit lights bathe the room in a warm halo (the bulb's real color and brightness);
  - icons by type, and the ones that are off are dimmed;
  - cameras show a thumbnail that refreshes.
- "Interaction":
  - tapping a device turns it on or off;
  - pressing and holding or right-click opens its panel (brightness, temperature, color, or live video if it is a camera);
  - keyboard and gamepad navigation, like the rest of Umbra.
- **Edit mode**: drag devices, move room vertices, add rooms, doors, rename, the «Sin ubicar» tray.
- **Mode bar**: the modes as big buttons («Noche», «Me fui»).
- **«Agregar dispositivo»**:
  - a brand search (all the HA integrations);
  - a form that builds itself from what HA asks for (text, password, lists, QR, external links);
  - at the end, choose the room and place it on the plan.
- **Rules**: a list of rules (HA's and Alma's) with a switch, a natural-language description and "created by you / by Alma". At first they are created by talking to Alma; a visual editor is left for later.
- "Live cameras": MJPEG first (`/api/camera_proxy_stream`, it is an `<img>`, zero extra code). WebRTC with go2rtc only if latency or CPU use become a nuisance.
- «Configuración → Casa»:
  - engine state: install, repair, restart, update;
  - `mirrored` network (optional);
  - external HA (URL + token);
  - backups;
  - «Abrir Home Assistant (avanzado)».

## 5. User stories

Format: *As [who], I want [what], so that [what for].* Under each one, the acceptance criteria (**AC**).

### E1 · Engine

- **H1.1** As a user, I want Alma to install the home automation engine with a button, so that I do not have to know what Home Assistant is.
  - AC: from «Casa» with no engine, «Instalar motor» appears.
  - AC: it shows the progress (downloading, importing, configuring).
  - AC: when done, HA answers on `localhost:8123` and Alma has a token.
  - AC: if WSL is missing, it explains what to do (admin and restart) and launches it.
- **H1.2** As a user, I want the engine to start and stop with Alma and to recover on its own if it goes down.
  - AC: the HA process is killed and within 1 minute it is back, with no intervention.
- **H1.3** As a user with an HA of my own, I want to connect Alma to it by URL and token.
- **H1.4** As an advanced user, I want to open HA's interface from «Configuración → Casa».
- **H1.5** As a user, I want to update the engine without losing my devices.
  - AC: after updating, the same devices, rooms, scenes and rules are still there.

### E2 · Devices

- **H2.1** As a user, I want to add my Moes bulb from the app by scanning the QR with Smart Life.
  - AC: the entity appears and can be turned on and off.
- **H2.2** As a user, I want to add my Sonoff bulb with my eWeLink account.
  - AC: same result as H2.1.
  - AC: it warns that a second eWeLink account with the shared devices is advisable (see §8).
- **H2.3** As a user, I want to add my Tapo C200C camera.
  - AC: the photo and live video are visible, and the motion sensor appears.
- **H2.4** As a user, I want to ask Alma «agregá el foco Moes» (add the Moes bulb) and have her guide me.
  - AC: Alma uses `home_add_device`, asks me in the chat for the missing data and ends the same way as H2.1.
- **H2.5** As a user or as Alma, I want to rename, change the room of or remove a device.
  - AC: the change is seen in HA and in the plan.
- **H2.6** As a user, I want to add any other brand HA supports from the same screen.

### E3 · Control

- **H3.1** As a user, I want to say «prendeme la luz de la cocina» (chat, voice, Telegram or WhatsApp) and have it turn on without asking me for permission.
- **H3.2** As a user, I want «poné la luz del living al 30 % y cálida» (set the living room light to 30 % and warm).
- **H3.3** As a user, I want «¿qué luces quedaron prendidas?» (which lights were left on?) and «apagá todo» (turn everything off).
- **H3.4** As a user, I want to tap a bulb on the plan to turn it on, and to see the real state live even if I change it from another app.
- **H3.5** As a user, I want sensitive things (locks, alarms) to always ask me for confirmation, even in «Permitir todo» mode.

### E4 · Plan

- **H4.1** As a user, I want to send Alma the photo of a plan or sketch and have her build the rooms.
  - AC: Alma proposes the plan.
  - AC: I see it in the Casa view and can correct it before accepting.
- **H4.2** As a user, I want to draw my house in Excalidraw and have Alma turn it into a plan.
- **H4.3** As a user, I want to send photos of each room so that Alma recognizes which room it is and what is in it (lamps, TV, speakers), and asks me how they are connected.
- **H4.4** As a user, I want to edit the plan by hand: move walls or vertices, add rooms and doors, drag devices.
- **H4.5** As a user, I want several floors.
- **H4.6** As Alma, I want to read the plan to understand «la luz de al lado de la puerta» (the light next to the door) or «la de arriba» (the one upstairs).

### E5 · Cameras

- **H5.1** As a user, I want to ask «¿qué se ve en la cámara del living?» and receive the answer with the photo.
  - AC: it asks for approval the first time, unless I set «Siempre».
- **H5.2** As a user, I want to see the camera live in the Casa view.
- **H5.3** As a user, I want «vigilá la puerta la próxima hora y avisame si llega un paquete» (watch the door for the next hour and tell me if a package arrives), with an estimated cost and the possibility of cutting it.
- **H5.4** As a user, I want the photo to reach me on Telegram when a rule asks for it.
- **H5.5** (If the camera allows it) As a user, I want to move the camera: «mirá hacia la ventana» (look toward the window).

### E6 · Modes and rules

- **H6.1** As a user, I want to create a «Noche» mode (turn everything off except the hallway at 10 %) from the app or by asking Alma, and activate it with a button or by voice.
- **H6.2** As a user, I want simple rules («a las 23 activá Noche» — at 23:00 activate Noche, «si hay movimiento en el pasillo de noche, prendé la luz 2 minutos» — if there is motion in the hallway at night, turn on the light for 2 minutes) that work without spending tokens.
  - AC: they remain as an HA automation and are seen in the rules list.
- **H6.3** As a user, I want rules with judgment («si la cámara del patio detecta movimiento, que Alma mire y me avise solo si es una persona» — if the patio camera detects motion, have Alma look and tell me only if it is a person).
  - AC: the event wakes Alma with the photo.
  - AC: it respects the time window and the cooldown.
  - AC: the spend is recorded.
- **H6.4** As a user, I want to see, turn on, turn off and delete the rules, whoever created them.
- **H6.5** As a user, I want to ask «¿qué reglas hay?» (what rules are there?) and have Alma explain them to me.

### E7 · Audio (later)

- **H7.1** As a user, I want Alma to speak through the speaker of the room I am in.
- **H7.2** As a user, I want to talk to Alma from the kitchen with a voice satellite.
- **H7.3** As a user, I want to control the music.

## 6. Stages

Each stage ends with a test with your real devices and your OK before going on.

### Stage 0 · Feasibility test of the engine (½ day)

- Validate the path `crane export` → `wsl --import` → HA starts → onboarding through the API.
- Measure time, disk and RAM.
- Try Tuya, SonoffLAN and the Tapo (official vs ONVIF vs Tapo Control) on NAT.
- **Output**: the install method confirmed (or we move to plan B) and the Tapo integration chosen.

### Stage 1 · Engine + devices + control by chat

- `main/home/engine.ts`: install, start, health, stop.
- `coordinator/home/hub.ts`: WebSocket, state cache, registries of areas, devices and entities.
- New risk `home` in the approvals.
- Tools: `home_overview`, `home_find`, `home_control`, `home_secure_control`, `home_call_service`, `home_add_device`, `home_edit_device`, `home_remove_device`.
- «Configuración → Casa»: state, install, external HA, open HA.
- "Minimal Casa view": a list per room with switches and «Agregar dispositivo» with the dynamic form.
- Stories: H1.1–H1.4, H2.1–H2.6, H3.1–H3.5 (H3.4 in the list; on the plan it arrives in stage 2).

### Stage 2 · Vision + plan + Casa view

- `vision.ts` + `look_at_image`, and incoming photos from Telegram and WhatsApp.
- `plan.json`, synchronized with areas and floors.
- `home_plan_edit`, `home_plan_from_drawing`.
- SVG plan view with live states and edit mode.
- Stories: H4.1–H4.6 and H3.4 in full.

### Stage 3 · Cameras

- `camera_look`, `camera_watch` (with estimated cost and a cut button), live MJPEG video and PTZ if it exists.
- Images in `send_telegram` and `send_whatsapp`.
- Stories: H5.1–H5.5.

### Stage 4 · Modes and rules

- `home_modes`, `home_rules`, `alma_*` automations in HA.
- `home/triggers.ts`: event subscription, time window, cooldown, launching the agent, spend.
- Rules panel and mode bar.
- Stories: H6.1–H6.5, H1.5.

### Stage 5 · Audio (when there is hardware)

- `home_speak`, music assistant, voice satellites.
- Stories: H7.x.

## 7. How I will work

- Branch `feat/domotica` from `feat/alma-deepsek` (or `main`, as you prefer). One commit per stage or per coherent part, with no co-author line.
- **Before each stage**: I read the code it touches and validate what is doubtful with a small test (stage 0 is that for the engine).
- **While programming**:
  - I follow the repo's style (comments in English, zod, `defineTool`, one function per file when that is enough);
  - no abstractions for a single case;
  - **no new npm dependency planned** (Node 24's native WebSocket, SVG by hand). If one turns out to be unavoidable, I pin it to a version more than 2 weeks old.
- **Tests**:
  - `vitest` for the pure logic: plan geometry, mapping of HA forms, whether a rule applies or not, conversion of Excalidraw into rooms;
  - `npm run typecheck`;
  - an end-to-end test in an isolated profile (`ALMA_USER_DATA=<dir>`) with a cheap model;
  - I restart the app after touching the coordinator, because `pnpm dev` does not reload it.
- **When closing each stage**: I show you what works, with screenshots, and what was left out. I update this document and the README.
- The UI is done with the **umbra-ui** skill.

## 8. Risks and open topics

| Risk | Mitigation |
|---|---|
| WSL not available on other PCs (no virtualization, old Windows Home). | A clear message + the external HA option. |
| The `mirrored` mode changes the network of **all** your WSL distros. | Off by default. It is only needed to discover devices on their own; everything can be added by IP or cloud. |
| **Tapo C200C**: it is not clear whether HA's official TP-Link integration supports this camera. The alternative proven by the community is [Tapo: Cameras Control](https://community.home-assistant.io/t/custom-component-tapo-cameras-control/231795) (custom; it brings motion and PTZ) or [ONVIF](https://community.tp-link.com/en/smart-home/forum/topic/501994). | Decided in stage 0. In every case a "camera account" has to be created in the Tapo app. |
| **eWeLink**: using the same account on several systems logs you out. The author of SonoffLAN [recommends a second account](https://gitee.com/dlcmirrors/SonoffLAN) with your devices shared. | We explain it in the form. You create the second account. |
| **Tuya**: the bulb has to be in the Smart Life or Tuya Smart app (not only in the Moes app) for the QR. | If it is in the Moes app, move it to Smart Life first. |
| HA is Python. It is an exception to the "no Python" rule, but it stays isolated in WSL and you do not touch it. | — |
| HA changes often and may break custom components. | HA and component versions are pinned. It is updated on purpose, with a backup. |
| Watching with AI costs tokens (~1–1.6 thousand tokens per photo). 1 photo per minute for 1 hour is ~60 photos. | Always limited in time, with an estimated cost before accepting, a cheap configurable vision model, and it only fires on motion if the camera detects it. |
| The photo of a room does not say how it connects to the others. | Alma asks, or it is combined with the sketch. |
| HA inside WSL depends on Alma: if you close Alma, the house does not run rules. | Alma stays in the tray. It is an always-on PC. |

## 9. What I need from you to get started

1. **An OK to this plan**, or the changes you want.
2. For stage 0/1:
   - being able to create a new WSL distro (`alma-home`, about 2 GB);
   - the Moes bulb in **Smart Life** and the app's *User Code* («Yo → Configuración → Cuenta y seguridad → Código de usuario»);
   - a **second eWeLink account** with the Sonoff bulb shared;
   - a "camera account" in the Tapo app («Configuración de la cámara → Avanzado → Cuenta de cámara») and the **IP** of the C200C (ideally a fixed IP in the router).
3. A new branch from `feat/alma-deepsek` or from `main`?

## To test with your devices

Everything is done from «Casa → Agregar dispositivo» (or by asking Alma):

1. **Install the engine**: «Casa → Instalar el motor» (the first time it downloads ~1.2 GB and takes about 7 minutes).
2. **Moes (Tuya)**: the bulb has to be in the Smart Life or Tuya Smart app. Add → Tuya → the user code («Ajustes → Cuenta y seguridad») → scan the QR with the app.
3. **Sonoff (eWeLink)**: Add → Sonoff → user and password. A second eWeLink account with the shared bulb is advisable (with the same account it gets logged out elsewhere).
4. "Tapo C200C camera": create the "camera account" in the Tapo app («Cámara → Ajustes → Avanzado») and set a fixed IP in the router. Add → TP-Link/Tapo, or ONVIF if you prefer (IP, port 2020, that account).
5. **Plan**: «Casa → Plano» → from an Excalidraw drawing, or paste a photo of the plan in the chat and ask her «armá el plano» (build the plan), or draw it by hand with «Editar plano».
