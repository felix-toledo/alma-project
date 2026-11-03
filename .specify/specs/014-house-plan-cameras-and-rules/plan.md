# 014 — Plan

## 1. Approach
Alma keeps its own plan (`plan.json`) next to the Home Assistant engine instead of using Home Assistant's floor/area model as the map: HA areas have no geometry, so the plan stores rooms as polygons in centimetres and only mirrors each room as an HA area on save. All plan building (drawing, vision answer, edit operations) is pure code in `src/shared/home.ts` and `src/coordinator/home/plan.ts`; the window only edits a plan and sends it back whole. Rules are split by cost: simple ones become HA automations (no model call), the ones that need judgment are stored by Alma and wake an agent with the event. Rejected: running every rule as an agent loop, because it spends tokens on every state change; and a plan kept only in HA areas, see [ADR 0007](../../../docs/adr/0007-home-assistant-in-hidden-wsl2.md). The approval consequences follow [ADR 0012](../../../docs/adr/0012-approval-model.md).

## 2. Layers touched
| Layer | Files (new / changed) | Why it lives there |
|---|---|---|
| shared | `src/shared/home.ts` (plan types, geometry, `planFromDrawing`, `planFromVision`, `extractJson`, `JudgmentRule`, `CameraWatch`, `inWindow`, `ruleMatches`), `src/shared/excalidraw.ts`, `src/shared/types.ts` (requests and events) | Pure logic and types used by coordinator and renderer; testable without Electron |
| coordinator | `src/coordinator/home/plan.ts` (`sanitizePlan`, `PlanStore`, `applyPlanOp`, `replaceFloorShape`, `autoPlace`, `describePlan`), `src/coordinator/home/triggers.ts` (`HomeTriggers`: judgment rules and watches), `src/coordinator/home/index.ts` (`HomeService`), `src/coordinator/home/hub.ts` (snapshot, scenes, automations, `cameraSnapshot`), `src/coordinator/vision.ts`, `src/coordinator/tools/home.ts`, `src/coordinator/tools/telegram.ts`, `src/coordinator/agent.ts`, `src/coordinator/index.ts` | Files, Home Assistant and model calls happen here; `electron` stays out |
| main | none (requests pass through to the coordinator) | |
| renderer | `src/renderer/src/home/HomeView.tsx`, `FloorPlan.tsx`, `RulesPanel.tsx`, `DevicePanel.tsx`, `useHome.ts`, `homeLib.ts`, `home.css` | The plan view, edit mode and the Reglas tab |

Arrows stay `shared` ← `coordinator` / `renderer`; the renderer only uses shared types and IPC.

## 3. Contracts
- Types: `HomePlan`, `PlanFloor`, `PlanRoom`, `PlanDoor`, `PlanItem`, `Point`; `JudgmentRule`, `CameraWatch`, `HomeRules`; `Picture` (vision).
- Plan operations: `PlanOp` (`add_floor`, `rename_floor`, `remove_floor`, `add_room`, `rename_room`, `set_room_shape`, `remove_room`, `add_door`, `place`, `unplace`) applied by `applyPlanOp(plan, op, things): HomePlan`; invalid ones throw `PlanError`.
- Pure functions: `sanitizePlan(raw)`, `planFromDrawing(elements, target)`, `planFromVision(data, aspect, target)`, `extractJson(text)`, `inWindow(between, now)`, `ruleMatches(rule, change, now)`, `describePlan(plan, things)`, `autoPlace(plan, things)`, `replaceFloorShape(...)`.
- Vision: `visionModel(settings)`, `loadPicture(path, roots)`, `look(settings, pictures, question, signal)`, `PLAN_QUESTION(hint)`, `imageSize(bytes)`.
- Requests: `home.plan.get`, `home.plan.set`, `home.plan.fromDrawing`, `home.camera.snapshot`, `home.rules`, `home.rule.toggle`, `home.rule.delete`. Events: `home.plan`, `home.rules`.
- Tools (name → `ToolRisk`): `home_plan` read; `home_plan_edit`, `home_plan_from_drawing`, `home_plan_from_image`, `home_scene` home; `camera_look`, `camera_photo`, `camera_watch`, `home_modes`, `home_rules` write; `look_at_image` read.
- Hub calls used: `snapshot`, `onChange`, `cameraSnapshot(entityId)`, `ensureArea(name)`, `saveScene(name, entities, id?)`, `saveAutomation(config, id?)`.

## 4. Data and persistence
- `<dataDir>/home/plan.json`: pretty JSON, units in cm (x right, y down), written to `plan.json.tmp` then renamed; read through `sanitizePlan`, a missing or broken file gives `emptyPlan()`.
- `<dataDir>/home/rules.json`: `{ judgment: [], watches: [] }`, same atomic write, lenient read.
- `<dataDir>/inbox/<entity>-<timestamp>.jpg`: camera stills and pictures the person sent.
- Scenes (`alma_<base36 time>`) and simple automations live in Home Assistant, not in Alma's files.
- No migration: the plan is new; old or damaged files are repaired when read.

## 5. Dependency injection
- `HomeService` receives `HomeDeps` (`dataDir`, `settings()`, `host`, `emit`, `launchRule`, `notify`, `readVault`, `look`); `HomeTriggers` receives `TriggerDeps` (`hub`, `launch`, `notify`, `look`, `onChange`). Tests fake the hub, the vision call and Telegram.
- Tools take the house and `sendTelegramPhoto` / `inboxDir` from `ToolContext` (`home`, `sendTelegramPhoto`, `inboxDir`).
- Time is passed as `now: Date` to `inWindow` / `ruleMatches`; `PlanStore` takes a temp directory in tests.

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-10.1 | `tests/home.test.ts` → "sanitizePlan arregla lo roto y siempre deja un piso" | polygons under 3 points, empty names, non-finite coordinates |
| AC-10.3 | `tests/home.test.ts` → "persiste entre arranques" | |
| AC-3.1 | `tests/home.test.ts` → "agrega, renombra, ubica y quita" | accents, case, re-placing a device |
| AC-3.2 | `tests/home.test.ts` → "rechaza lo inválido con mensajes claros" | duplicate name, last floor |
| AC-3.4 | `tests/home.test.ts` → "spotIn reparte varios dispositivos sin amontonarlos" | several devices in one room |
| AC-3.6 | `tests/home.test.ts` → "centroide y punto en polígono" | |
| AC-3.7 | `tests/home.test.ts` → "reemplazar las habitaciones conserva el área de HA de las que siguen con el mismo nombre" | |
| AC-3.9 | `tests/home.test.ts` → "ubica solo los dispositivos que ya tienen habitación" | no change returns same object |
| AC-4.1 | `tests/home.test.ts` → "agrega, renombra, ubica y quita" | empty floor |
| AC-2.1 | `tests/home.test.ts` → "un dibujo de Excalidraw se vuelve habitaciones con su nombre y la silueta de la casa se descarta" | house outline, unnamed rooms |
| AC-2.6 | `tests/home.test.ts` → "un plano leído de una imagen se escala y exige habitaciones" | no valid room, invalid doors |
| AC-2.7 | `tests/home.test.ts` → "un plano leído de una foto apaisada conserva las proporciones" | |
| AC-2.8 | `tests/home.test.ts` → "extractJson saca el JSON de una respuesta con texto y vallas" | prose, fence, no JSON |
| AC-2.11 | `tests/home.test.ts` → "lee el tamaño de PNG, GIF y JPEG por la cabecera" | unknown format |
| AC-6.5 | `tests/home.test.ts` → "camera_photo manda la foto por Telegram sin pasar por la visión" | |
| AC-6.7 | `tests/home.test.ts` → "con la domótica apagada o sin conexión explica qué hacer" | |
| AC-9.2 | `tests/home.test.ts` → "despierta solo con el cambio, la franja, el estado y fuera del enfriamiento" | disabled, same state, cooldown |
| AC-9.3 | `tests/home.test.ts` → "la franja horaria cruza la medianoche" | 12:00 outside |
| AC-10.2, 10.4, 10.5, 3.3, 3.5, 3.8, 3.10–3.13, 2.2–2.4, 2.9, 2.10, 5.1–5.4, 5.6, 6.1–6.4, 6.6, 6.9–6.16, 7.1–7.4, 8.1–8.3, 9.1, 9.4–9.9, 9.11 | [gap] | backlog: stills retry, watch lifecycle, scene and rule tools |
| AC-1.1–1.4, 2.5, 2.12, 3.14–3.17, 5.5, 6.8, 6.17, 7.5, 8.4, 9.10 | [manual] | the renderer has no tests; checked in Casa with the demo devices, a Tapo camera and a photo of a hand-drawn plan, as each AC says |

Pure logic extracted from the window (`homeLib.ts`) stays free of React so it can be tested later.

## 7. Security and privacy impact
- `camera_look`, `camera_photo`, `camera_watch`, `home_modes`, `home_rules` are `write` (ask per approval mode); `home_scene` and the plan-editing tools are `home` (never ask, blocked in read-only mode); `look_at_image` and `home_plan` are `read`.
- A still or plan photo goes to the vision provider chosen in Configuración → Casa; pictures are read only from the inbox, the vault root or the working folder, at most 8 MB, and never enter an agent's conversation.
- A rule's run auto-approves only `camera_look`; every other tool follows the agent's normal policy.
- Stills go to Telegram only on request or when a watch matches.
- Docs: `docs/security/PRIVACIDAD.md` (cameras and vision provider) and `docs/security/CONTROLES.md` updated in the same change.

## 8. Rollout
Everything sits behind the house switch in Configuración → Casa (default off); the plan tools need it on, the camera, scene and rule tools also need the hub connected. First run: an empty "Planta baja" with an empty-state card offering the three ways to build the plan. Turning the house off removes the tools; `plan.json` and `rules.json` stay on disk.
